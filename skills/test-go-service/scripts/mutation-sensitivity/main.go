// mutation-sensitivity proves that one exact compiling mutant is rejected by a named focused Go test.
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const (
	disposableMarkerName = ".mutation-sensitivity-disposable"
	provedVerdict        = "PROVED_BY_SENSITIVITY"
	unresolvedVerdict    = "UNRESOLVED"
	blockedSetupVerdict  = "BLOCKED_SETUP"
)

type configuration struct {
	checkout       string
	expectedHash   string
	patch          string
	compileCommand string
	testCommand    string
	expectedTest   string
	output         string
	timeout        time.Duration
}

type result struct {
	Verdict            string `json:"verdict"`
	Reason             string `json:"reason"`
	BaselineExit       int    `json:"baseline_exit"`
	CompileExit        int    `json:"compile_exit"`
	MutantExit         int    `json:"mutant_exit"`
	ExpectedTestFailed bool   `json:"expected_test_failed"`
	Restored           bool   `json:"restored"`
	StartHash          string `json:"start_hash,omitempty"`
	EndHash            string `json:"end_hash,omitempty"`
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "prepare" {
		os.Exit(prepare(os.Args[2:], os.Stdout, os.Stderr))
	}
	os.Exit(run(os.Args[1:], os.Stderr))
}

func prepare(args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("mutation-sensitivity prepare", flag.ContinueOnError)
	flags.SetOutput(stderr)
	checkoutArgument := flags.String("checkout", "", "disposable linked worktree or standalone clone")
	sourceArgument := flags.String("source", "", "authoritative source required for a standalone clone")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if *checkoutArgument == "" || flags.NArg() != 0 {
		fmt.Fprintln(stderr, "-checkout is required and positional arguments are unsupported")
		return 2
	}
	checkout, err := filepath.Abs(*checkoutArgument)
	if err != nil {
		fmt.Fprintf(stderr, "resolve checkout: %v\n", err)
		return 2
	}
	gitMetadata, err := os.Lstat(filepath.Join(checkout, ".git"))
	if err != nil {
		fmt.Fprintln(stderr, "prepare requires Git metadata in the disposable checkout")
		return 2
	}
	if gitMetadata.IsDir() {
		if *sourceArgument == "" {
			fmt.Fprintln(stderr, "a standalone clone requires -source")
			return 2
		}
		source, err := filepath.Abs(*sourceArgument)
		if err != nil {
			fmt.Fprintf(stderr, "resolve source: %v\n", err)
			return 2
		}
		if source == checkout {
			fmt.Fprintln(stderr, "standalone clone and authoritative source must differ")
			return 2
		}
		timeout := 10 * time.Second
		checkoutHead := runGit(configuration{checkout: checkout, timeout: timeout}, "rev-parse", "HEAD")
		sourceHead := runGit(configuration{checkout: source, timeout: timeout}, "rev-parse", "HEAD")
		if checkoutHead.exit != 0 || sourceHead.exit != 0 || !bytes.Equal(bytes.TrimSpace(checkoutHead.output), bytes.TrimSpace(sourceHead.output)) {
			fmt.Fprintln(stderr, "standalone clone must match the authoritative source HEAD")
			return 2
		}
	} else if !gitMetadata.Mode().IsRegular() {
		fmt.Fprintln(stderr, "unsupported Git metadata in disposable checkout")
		return 2
	}
	hash, err := treeHash(checkout)
	if err != nil {
		fmt.Fprintf(stderr, "hash checkout: %v\n", err)
		return 2
	}
	if err := os.WriteFile(filepath.Join(checkout, disposableMarkerName), []byte(hash+"\n"), 0o600); err != nil {
		fmt.Fprintf(stderr, "write disposable marker: %v\n", err)
		return 2
	}
	fmt.Fprintln(stdout, hash)
	return 0
}

func run(args []string, stderr io.Writer) int {
	config, err := parseConfiguration(args, stderr)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}

	report := result{Verdict: blockedSetupVerdict, BaselineExit: -1, CompileExit: -1, MutantExit: -1}
	finish := func(code int) int {
		if err := writeResult(config.output, report); err != nil {
			fmt.Fprintf(stderr, "write result: %v\n", err)
			return 2
		}
		return code
	}

	startHash, err := validateSetup(config)
	if err != nil {
		report.Reason = err.Error()
		return finish(2)
	}
	report.StartHash = startHash

	baseline := runCommand(config, config.testCommand)
	report.BaselineExit = baseline.exit
	if baseline.exit != 0 {
		report.Verdict = unresolvedVerdict
		report.Reason = "focused baseline is not green"
		report.EndHash, _ = treeHash(config.checkout)
		report.Restored = report.EndHash == report.StartHash
		return finish(1)
	}

	if command := runGit(config, "apply", "--check", config.patch); command.exit != 0 {
		report.Verdict = unresolvedVerdict
		report.Reason = "exact patch does not apply to the starting snapshot"
		report.EndHash, _ = treeHash(config.checkout)
		report.Restored = report.EndHash == report.StartHash
		return finish(1)
	}
	if command := runGit(config, "apply", config.patch); command.exit != 0 {
		report.Verdict = unresolvedVerdict
		report.Reason = "exact patch could not be applied"
		report.EndHash, _ = treeHash(config.checkout)
		report.Restored = report.EndHash == report.StartHash
		return finish(1)
	}

	compile := runCommand(config, config.compileCommand)
	report.CompileExit = compile.exit
	if compile.exit == 0 {
		mutant := runCommand(config, config.testCommand)
		report.MutantExit = mutant.exit
		report.ExpectedTestFailed = namedTestFailed(mutant.output, config.expectedTest)
		switch {
		case mutant.exit == 0:
			report.Reason = "mutant survived the focused test"
		case !report.ExpectedTestFailed:
			report.Reason = "mutant failed without evidence from the expected test"
		default:
			report.Verdict = provedVerdict
			report.Reason = "compiling mutant was rejected by the expected focused test"
		}
	} else {
		report.Reason = "mutant does not compile"
	}

	restore := runGit(config, "apply", "-R", config.patch)
	report.EndHash, err = treeHash(config.checkout)
	report.Restored = restore.exit == 0 && err == nil && report.EndHash == report.StartHash
	if !report.Restored {
		report.Verdict = unresolvedVerdict
		report.Reason = "checkout was not restored to the starting snapshot"
	}
	if report.Verdict == provedVerdict {
		return finish(0)
	}
	report.Verdict = unresolvedVerdict
	return finish(1)
}

func parseConfiguration(args []string, stderr io.Writer) (configuration, error) {
	var config configuration
	flags := flag.NewFlagSet("mutation-sensitivity", flag.ContinueOnError)
	flags.SetOutput(stderr)
	flags.StringVar(&config.checkout, "checkout", "", "marked disposable checkout")
	flags.StringVar(&config.expectedHash, "expected-hash", "", "expected starting tree hash")
	flags.StringVar(&config.patch, "patch", "", "exact unified patch")
	flags.StringVar(&config.compileCommand, "compile-command", "", "command that compiles the mutant")
	flags.StringVar(&config.testCommand, "test-command", "", "focused go test -json command")
	flags.StringVar(&config.expectedTest, "expected-test", "", "focused test expected to fail")
	flags.StringVar(&config.output, "output", "", "JSON result path outside the checkout")
	flags.DurationVar(&config.timeout, "timeout", 2*time.Minute, "timeout for each command")
	if err := flags.Parse(args); err != nil {
		return configuration{}, err
	}
	if flags.NArg() != 0 {
		return configuration{}, errors.New("unexpected positional arguments")
	}
	if config.checkout == "" || config.expectedHash == "" || config.patch == "" || config.compileCommand == "" || config.testCommand == "" || config.expectedTest == "" || config.output == "" {
		return configuration{}, errors.New("all flags are required")
	}
	if config.timeout <= 0 {
		return configuration{}, errors.New("timeout must be positive")
	}
	return config, nil
}

func validateSetup(config configuration) (string, error) {
	checkout, err := filepath.Abs(config.checkout)
	if err != nil {
		return "", fmt.Errorf("resolve checkout: %w", err)
	}
	output, err := filepath.Abs(config.output)
	if err != nil {
		return "", fmt.Errorf("resolve output: %w", err)
	}
	relativeOutput, err := filepath.Rel(checkout, output)
	if err != nil || relativeOutput == "." || (relativeOutput != ".." && !strings.HasPrefix(relativeOutput, ".."+string(filepath.Separator))) {
		return "", errors.New("output must be outside the disposable checkout")
	}
	if info, err := os.Stat(config.patch); err != nil || !info.Mode().IsRegular() {
		return "", errors.New("patch must be a readable regular file")
	}
	marker, err := os.ReadFile(filepath.Join(checkout, disposableMarkerName))
	if err != nil {
		return "", errors.New("disposable checkout marker is missing")
	}
	if strings.TrimSpace(string(marker)) != config.expectedHash {
		return "", errors.New("disposable marker does not match the expected hash")
	}
	actualHash, err := treeHash(checkout)
	if err != nil {
		return "", fmt.Errorf("hash checkout: %w", err)
	}
	if actualHash != config.expectedHash {
		return "", errors.New("checkout does not match the expected starting hash")
	}
	return actualHash, nil
}

type commandResult struct {
	exit   int
	output []byte
}

func runCommand(config configuration, command string) commandResult {
	context, cancel := context.WithTimeout(context.Background(), config.timeout)
	defer cancel()
	process := exec.CommandContext(context, "/bin/sh", "-c", command)
	process.Dir = config.checkout
	output, err := process.CombinedOutput()
	return commandResult{exit: exitCode(err), output: output}
}

func runGit(config configuration, arguments ...string) commandResult {
	context, cancel := context.WithTimeout(context.Background(), config.timeout)
	defer cancel()
	allArguments := append([]string{"-C", config.checkout}, arguments...)
	process := exec.CommandContext(context, "git", allArguments...)
	output, err := process.CombinedOutput()
	return commandResult{exit: exitCode(err), output: output}
}

func exitCode(err error) int {
	if err == nil {
		return 0
	}
	var exitError *exec.ExitError
	if errors.As(err, &exitError) {
		return exitError.ExitCode()
	}
	return -1
}

func namedTestFailed(output []byte, expected string) bool {
	scanner := bufio.NewScanner(bytes.NewReader(output))
	for scanner.Scan() {
		var event struct {
			Action string `json:"Action"`
			Test   string `json:"Test"`
		}
		if json.Unmarshal(scanner.Bytes(), &event) == nil && event.Action == "fail" && event.Test == expected {
			return true
		}
	}
	return false
}

func treeHash(root string) (string, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	var paths []string
	err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if relative == ".git" {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if relative == "." || relative == disposableMarkerName || entry.IsDir() {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("symbolic links are unsupported: %s", relative)
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("unsupported file type: %s", relative)
		}
		paths = append(paths, filepath.ToSlash(relative))
		return nil
	})
	if err != nil {
		return "", err
	}
	writer := sha256.New()
	for _, relative := range paths {
		data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(relative)))
		if err != nil {
			return "", err
		}
		fmt.Fprintf(writer, "%d:%s:%d:", len(relative), relative, len(data))
		if _, err := writer.Write(data); err != nil {
			return "", err
		}
	}
	return hex.EncodeToString(writer.Sum(nil)), nil
}

func writeResult(path string, report result) error {
	data, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".mutation-sensitivity-*.json")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryPath, path)
}

// Command coverage-gaps reports exact uncovered blocks from one Go coverage profile.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"os"
	"sort"
	"strconv"
	"strings"
)

const reportSchema = "ai-harness/go-coverage-gaps/v1"

type coverageProfile struct {
	Mode   string
	Blocks []profileBlock
}

type blockLocation struct {
	File        string `json:"file"`
	StartLine   uint64 `json:"start_line"`
	StartColumn uint64 `json:"start_column"`
	EndLine     uint64 `json:"end_line"`
	EndColumn   uint64 `json:"end_column"`
}

type profileBlock struct {
	blockLocation
	Statements uint64
	Count      uint64
}

type report struct {
	Schema              string        `json:"schema"`
	Mode                string        `json:"mode"`
	TotalBlocks         uint64        `json:"total_blocks"`
	CoveredBlocks       uint64        `json:"covered_blocks"`
	UncoveredBlocks     uint64        `json:"uncovered_blocks"`
	TotalStatements     uint64        `json:"total_statements"`
	CoveredStatements   uint64        `json:"covered_statements"`
	UncoveredStatements uint64        `json:"uncovered_statements"`
	Gaps                []coverageGap `json:"gaps"`
}

type coverageGap struct {
	blockLocation
	Statements uint64 `json:"statements"`
}

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("coverage-gaps", flag.ContinueOnError)
	flags.SetOutput(stderr)
	profilePath := flags.String("profile", "", "fresh Go coverage profile")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if *profilePath == "" || flags.NArg() != 0 {
		fmt.Fprintln(stderr, "usage: coverage-gaps -profile <path>")
		return 2
	}

	profileFile, err := openRegularFile(*profilePath)
	if err != nil {
		fmt.Fprintf(stderr, "coverage profile: %v\n", err)
		return 2
	}
	defer profileFile.Close()

	parsed, err := parseProfile(profileFile)
	if err != nil {
		fmt.Fprintf(stderr, "parse coverage profile: %v\n", err)
		return 2
	}
	merged, err := mergeBlocks(parsed.Mode, parsed.Blocks)
	if err != nil {
		fmt.Fprintf(stderr, "merge coverage profile: %v\n", err)
		return 2
	}
	result, err := summarizeProfile(parsed.Mode, merged)
	if err != nil {
		fmt.Fprintf(stderr, "summarize coverage profile: %v\n", err)
		return 2
	}
	payload, err := json.Marshal(result)
	if err != nil {
		fmt.Fprintf(stderr, "encode coverage report: %v\n", err)
		return 2
	}
	payload = append(payload, '\n')
	if written, err := stdout.Write(payload); err != nil || written != len(payload) {
		if err == nil {
			err = io.ErrShortWrite
		}
		fmt.Fprintf(stderr, "write coverage report: %v\n", err)
		return 2
	}
	return 0
}

func openRegularFile(path string) (*os.File, error) {
	pathInfo, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !pathInfo.Mode().IsRegular() {
		return nil, errors.New("path must name a regular non-symlink file")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	fileInfo, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, err
	}
	if !fileInfo.Mode().IsRegular() || !os.SameFile(pathInfo, fileInfo) {
		file.Close()
		return nil, errors.New("file identity changed while opening profile")
	}
	return file, nil
}

func parseProfile(reader io.Reader) (coverageProfile, error) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	parsed := coverageProfile{}
	lineNumber := 0
	for scanner.Scan() {
		lineNumber++
		line := strings.TrimSuffix(scanner.Text(), "\r")
		if lineNumber == 1 {
			const prefix = "mode: "
			if !strings.HasPrefix(line, prefix) {
				return coverageProfile{}, errors.New("first line must declare mode")
			}
			parsed.Mode = strings.TrimPrefix(line, prefix)
			switch parsed.Mode {
			case "set", "count", "atomic":
			default:
				return coverageProfile{}, fmt.Errorf("unsupported mode %q", parsed.Mode)
			}
			continue
		}
		block, err := parseRecord(parsed.Mode, line)
		if err != nil {
			return coverageProfile{}, fmt.Errorf("line %d: %w", lineNumber, err)
		}
		parsed.Blocks = append(parsed.Blocks, block)
	}
	if err := scanner.Err(); err != nil {
		return coverageProfile{}, err
	}
	if lineNumber == 0 {
		return coverageProfile{}, errors.New("profile is empty")
	}
	return parsed, nil
}

func parseRecord(mode, line string) (profileBlock, error) {
	locationAndStatements, countText, err := splitLastField(line, "count")
	if err != nil {
		return profileBlock{}, err
	}
	location, statementsText, err := splitLastField(locationAndStatements, "statement count")
	if err != nil {
		return profileBlock{}, err
	}
	count, err := parseUnsigned("count", countText)
	if err != nil {
		return profileBlock{}, err
	}
	if mode == "set" && count > 1 {
		return profileBlock{}, fmt.Errorf("set count must be 0 or 1, got %d", count)
	}
	statements, err := parseUnsigned("statement count", statementsText)
	if err != nil {
		return profileBlock{}, err
	}
	colon := strings.LastIndexByte(location, ':')
	if colon <= 0 || colon == len(location)-1 {
		return profileBlock{}, errors.New("location must be file:start,end")
	}
	file := location[:colon]
	rangeText := location[colon+1:]
	if strings.Count(rangeText, ",") != 1 {
		return profileBlock{}, errors.New("location must contain one range separator")
	}
	parts := strings.SplitN(rangeText, ",", 2)
	startLine, startColumn, err := parsePosition("start", parts[0])
	if err != nil {
		return profileBlock{}, err
	}
	endLine, endColumn, err := parsePosition("end", parts[1])
	if err != nil {
		return profileBlock{}, err
	}
	if endLine < startLine || (endLine == startLine && endColumn < startColumn) {
		return profileBlock{}, errors.New("end position precedes start position")
	}
	return profileBlock{
		blockLocation: blockLocation{
			File:        file,
			StartLine:   startLine,
			StartColumn: startColumn,
			EndLine:     endLine,
			EndColumn:   endColumn,
		},
		Statements: statements,
		Count:      count,
	}, nil
}

func splitLastField(value, label string) (string, string, error) {
	separator := strings.LastIndexByte(value, ' ')
	if separator <= 0 || separator == len(value)-1 {
		return "", "", fmt.Errorf("missing %s", label)
	}
	return value[:separator], value[separator+1:], nil
}

func parsePosition(label, value string) (uint64, uint64, error) {
	if strings.Count(value, ".") != 1 {
		return 0, 0, fmt.Errorf("%s position must be line.column", label)
	}
	parts := strings.SplitN(value, ".", 2)
	line, err := parseUnsigned(label+" line", parts[0])
	if err != nil {
		return 0, 0, err
	}
	column, err := parseUnsigned(label+" column", parts[1])
	if err != nil {
		return 0, 0, err
	}
	if line == 0 || column == 0 {
		return 0, 0, fmt.Errorf("%s position must be positive", label)
	}
	return line, column, nil
}

func parseUnsigned(label, value string) (uint64, error) {
	parsed, err := strconv.ParseUint(value, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid %s %q", label, value)
	}
	return parsed, nil
}

func mergeBlocks(mode string, blocks []profileBlock) ([]profileBlock, error) {
	merged := make([]profileBlock, 0, len(blocks))
	indexes := make(map[blockLocation]int, len(blocks))
	for _, block := range blocks {
		key := block.blockLocation
		index, exists := indexes[key]
		if !exists {
			indexes[key] = len(merged)
			merged = append(merged, block)
			continue
		}
		if merged[index].Statements != block.Statements {
			return nil, fmt.Errorf("inconsistent statement count for %s:%d.%d,%d.%d", block.File, block.StartLine, block.StartColumn, block.EndLine, block.EndColumn)
		}
		if mode == "set" {
			merged[index].Count |= block.Count
			continue
		}
		count, err := checkedAdd(merged[index].Count, block.Count)
		if err != nil {
			return nil, fmt.Errorf("count overflow for %s:%d.%d,%d.%d", block.File, block.StartLine, block.StartColumn, block.EndLine, block.EndColumn)
		}
		merged[index].Count = count
	}
	sort.Slice(merged, func(left, right int) bool {
		return blockLess(merged[left], merged[right])
	})
	return merged, nil
}

func blockLess(left, right profileBlock) bool {
	if left.File != right.File {
		return left.File < right.File
	}
	if left.StartLine != right.StartLine {
		return left.StartLine < right.StartLine
	}
	if left.StartColumn != right.StartColumn {
		return left.StartColumn < right.StartColumn
	}
	if left.EndLine != right.EndLine {
		return left.EndLine < right.EndLine
	}
	return left.EndColumn < right.EndColumn
}

func summarizeProfile(mode string, blocks []profileBlock) (report, error) {
	result := report{
		Schema:      reportSchema,
		Mode:        mode,
		TotalBlocks: uint64(len(blocks)),
		Gaps:        make([]coverageGap, 0),
	}
	for _, block := range blocks {
		var err error
		result.TotalStatements, err = checkedAdd(result.TotalStatements, block.Statements)
		if err != nil {
			return report{}, errors.New("total statement count overflows uint64")
		}
		if block.Count > 0 {
			result.CoveredBlocks++
			result.CoveredStatements, err = checkedAdd(result.CoveredStatements, block.Statements)
			if err != nil {
				return report{}, errors.New("covered statement count overflows uint64")
			}
			continue
		}
		result.UncoveredBlocks++
		result.UncoveredStatements, err = checkedAdd(result.UncoveredStatements, block.Statements)
		if err != nil {
			return report{}, errors.New("uncovered statement count overflows uint64")
		}
		result.Gaps = append(result.Gaps, coverageGap{
			blockLocation: block.blockLocation,
			Statements:    block.Statements,
		})
	}
	if result.TotalStatements == 0 {
		return report{}, errors.New("profile contains zero statements")
	}
	return result, nil
}

func checkedAdd(left, right uint64) (uint64, error) {
	if math.MaxUint64-left < right {
		return 0, errors.New("uint64 overflow")
	}
	return left + right, nil
}

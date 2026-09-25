package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunReportsUncoveredBlocksAsStableJSON(t *testing.T) {
	profile := writeProfile(t, "mode: set\n"+
		"example/b.go:5.1,5.9 1 0\n"+
		"example/a.go:20.1,21.2 3 0\n"+
		"example/a.go:10.2,12.3 2 1\n")

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := run([]string{"-profile", profile}, &stdout, &stderr)

	if code != 0 {
		t.Fatalf("run() code = %d, want 0; stderr=%s", code, stderr.String())
	}
	if stderr.Len() != 0 {
		t.Fatalf("stderr = %q, want empty", stderr.String())
	}
	want := "{\"schema\":\"railguard/go-coverage-gaps/v1\",\"mode\":\"set\",\"total_blocks\":3,\"covered_blocks\":1,\"uncovered_blocks\":2,\"total_statements\":6,\"covered_statements\":2,\"uncovered_statements\":4,\"gaps\":[{\"file\":\"example/a.go\",\"start_line\":20,\"start_column\":1,\"end_line\":21,\"end_column\":2,\"statements\":3},{\"file\":\"example/b.go\",\"start_line\":5,\"start_column\":1,\"end_line\":5,\"end_column\":9,\"statements\":1}]}\n"
	if stdout.String() != want {
		t.Fatalf("stdout = %q, want %q", stdout.String(), want)
	}
}

func TestRunMergesDuplicateBlocksForEveryOfficialMode(t *testing.T) {
	tests := []struct {
		name   string
		mode   string
		counts []string
	}{
		{name: "set", mode: "set", counts: []string{"0", "1"}},
		{name: "count", mode: "count", counts: []string{"1", "2"}},
		{name: "atomic", mode: "atomic", counts: []string{"2", "3"}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			profile := writeProfile(t, "mode: "+test.mode+"\n"+
				"example/a.go:1.1,1.8 2 "+test.counts[0]+"\n"+
				"example/a.go:1.1,1.8 2 "+test.counts[1]+"\n")

			result, code, stderr := runJSON(t, profile)

			if code != 0 {
				t.Fatalf("run() code = %d, want 0; stderr=%s", code, stderr)
			}
			if result.Mode != test.mode || result.TotalBlocks != 1 || result.CoveredBlocks != 1 {
				t.Fatalf("report = %#v, want one covered %s block", result, test.mode)
			}
			if result.TotalStatements != 2 || result.CoveredStatements != 2 || len(result.Gaps) != 0 {
				t.Fatalf("statement summary = %#v, want two covered statements", result)
			}
		})
	}
}

func TestRunReportsNoGapsAsAnEmptyArray(t *testing.T) {
	profile := writeProfile(t, "mode: atomic\r\nexample/a.go:1.1,1.8 1 4\r\n")

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := run([]string{"-profile", profile}, &stdout, &stderr)

	if code != 0 {
		t.Fatalf("run() code = %d, want 0; stderr=%s", code, stderr.String())
	}
	if !strings.HasSuffix(stdout.String(), "\"gaps\":[]}\n") {
		t.Fatalf("stdout = %q, want a stable empty gaps array", stdout.String())
	}
}

func TestRunAcceptsZeroStatementBlocksWhenTheProfileHasStatements(t *testing.T) {
	profile := writeProfile(t, "mode: set\n"+
		"example/a.go:1.1,1.8 0 0\n"+
		"example/a.go:2.1,2.8 1 1\n")

	result, code, stderr := runJSON(t, profile)

	if code != 0 {
		t.Fatalf("run() code = %d, want 0; stderr=%s", code, stderr)
	}
	if result.TotalBlocks != 2 || result.CoveredBlocks != 1 || result.UncoveredBlocks != 1 {
		t.Fatalf("block summary = %#v, want one covered and one uncovered block", result)
	}
	if result.TotalStatements != 1 || result.CoveredStatements != 1 || result.UncoveredStatements != 0 {
		t.Fatalf("statement summary = %#v, want one covered statement", result)
	}
	if len(result.Gaps) != 1 || result.Gaps[0].Statements != 0 {
		t.Fatalf("gaps = %#v, want the uncovered zero-statement block", result.Gaps)
	}
}

func TestRunRejectsMalformedOrInconsistentProfiles(t *testing.T) {
	max := "18446744073709551615"
	tests := []struct {
		name       string
		contents   string
		diagnostic string
	}{
		{name: "empty", contents: "", diagnostic: "profile is empty"},
		{name: "missing mode declaration", contents: "set\n", diagnostic: "first line must declare mode"},
		{name: "unsupported mode", contents: "mode: branch\n", diagnostic: "unsupported mode"},
		{name: "header only", contents: "mode: set\n", diagnostic: "zero statements"},
		{name: "missing record fields", contents: "mode: set\nexample/a.go:1.1,1.2\n", diagnostic: "missing count"},
		{name: "negative count", contents: "mode: count\nexample/a.go:1.1,1.2 1 -1\n", diagnostic: "invalid count"},
		{name: "negative statement count", contents: "mode: count\nexample/a.go:1.1,1.2 -1 0\n", diagnostic: "invalid statement count"},
		{name: "negative coordinate", contents: "mode: count\nexample/a.go:-1.1,1.2 1 0\n", diagnostic: "invalid start line"},
		{name: "invalid set count", contents: "mode: set\nexample/a.go:1.1,1.2 1 2\n", diagnostic: "set count must be 0 or 1"},
		{name: "backward range", contents: "mode: count\nexample/a.go:2.1,1.2 1 0\n", diagnostic: "end position precedes start position"},
		{
			name: "inconsistent duplicate statements",
			contents: "mode: count\n" +
				"example/a.go:1.1,1.2 1 0\n" +
				"example/a.go:1.1,1.2 2 0\n",
			diagnostic: "inconsistent statement count",
		},
		{
			name: "duplicate count overflow",
			contents: "mode: atomic\n" +
				"example/a.go:1.1,1.2 1 " + max + "\n" +
				"example/a.go:1.1,1.2 1 1\n",
			diagnostic: "count overflow",
		},
		{
			name: "statement total overflow",
			contents: "mode: count\n" +
				"example/a.go:1.1,1.2 " + max + " 0\n" +
				"example/a.go:2.1,2.2 1 0\n",
			diagnostic: "total statement count overflows",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			assertRunFailure(t, []string{"-profile", writeProfile(t, test.contents)}, test.diagnostic)
		})
	}
}

func TestRunRejectsInvalidArgumentsAndFileKinds(t *testing.T) {
	assertRunFailure(t, nil, "usage:")
	assertRunFailure(t, []string{"-unknown"}, "flag provided but not defined")
	assertRunFailure(t, []string{"-profile", writeProfile(t, "mode: set\nexample/a.go:1.1,1.2 1 1\n"), "extra"}, "usage:")
	assertRunFailure(t, []string{"-profile", filepath.Join(t.TempDir(), "missing.out")}, "no such file")
	assertRunFailure(t, []string{"-profile", t.TempDir()}, "regular non-symlink file")

	target := writeProfile(t, "mode: set\nexample/a.go:1.1,1.2 1 1\n")
	symlink := filepath.Join(t.TempDir(), "coverage-link.out")
	if err := os.Symlink(target, symlink); err != nil {
		t.Fatalf("create symlink: %v", err)
	}
	assertRunFailure(t, []string{"-profile", symlink}, "regular non-symlink file")

	unreadable := writeProfile(t, "mode: set\nexample/a.go:1.1,1.2 1 1\n")
	if err := os.Chmod(unreadable, 0); err != nil {
		t.Fatalf("make profile unreadable: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(unreadable, 0o600) })
	if file, err := os.Open(unreadable); err == nil {
		_ = file.Close()
		t.Log("filesystem privilege bypasses unreadable-file permissions")
	} else {
		assertRunFailure(t, []string{"-profile", unreadable}, "permission denied")
	}
}

func assertRunFailure(t *testing.T, args []string, diagnostic string) {
	t.Helper()
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := run(args, &stdout, &stderr)
	if code != 2 {
		t.Fatalf("run() code = %d, want 2; stderr=%s", code, stderr.String())
	}
	if stdout.Len() != 0 {
		t.Fatalf("stdout = %q, want empty on failure", stdout.String())
	}
	if !strings.Contains(strings.ToLower(stderr.String()), strings.ToLower(diagnostic)) {
		t.Fatalf("stderr = %q, want diagnostic containing %q", stderr.String(), diagnostic)
	}
}

func runJSON(t *testing.T, profile string) (report, int, string) {
	t.Helper()
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := run([]string{"-profile", profile}, &stdout, &stderr)
	var result report
	if code == 0 {
		if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
			t.Fatalf("decode report: %v\n%s", err, stdout.String())
		}
	}
	return result, code, stderr.String()
}

func writeProfile(t *testing.T, contents string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "coverage.out")
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatalf("write profile: %v", err)
	}
	return path
}

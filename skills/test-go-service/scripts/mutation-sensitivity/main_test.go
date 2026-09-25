package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

type sensitivityFixture struct {
	checkout     string
	output       string
	expectedHash string
}

// TestPrepareMarksAStandaloneClone supports sandboxes that cannot update source-repository worktree metadata.
//
// Expected: an independent clone at the same commit can be marked when its authoritative source is explicit.
func TestPrepareMarksAStandaloneClone(t *testing.T) {
	// Given: an authoritative repository and an independent clone with the same HEAD.
	source := t.TempDir()
	mustGit(t, source, "init")
	mustGit(t, source, "config", "user.email", "test@example.com")
	mustGit(t, source, "config", "user.name", "Test")
	writeFile(t, filepath.Join(source, "limit.go"), limitSource)
	mustGit(t, source, "add", "limit.go")
	mustGit(t, source, "commit", "-m", "seed")
	checkout := filepath.Join(t.TempDir(), "clone")
	command := exec.Command("git", "clone", "--no-hardlinks", source, checkout)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("clone standalone checkout: %v\n%s", err, output)
	}
	var output strings.Builder

	// When: the caller identifies both the disposable clone and its source.
	status := prepare(
		[]string{"-checkout", checkout, "-source", source},
		&output,
		&strings.Builder{},
	)

	// Then: preparation returns a governed hash and writes the matching marker.
	if status != 0 {
		t.Fatalf("prepare() status = %d, want 0", status)
	}
	directory, err := os.OpenRoot(checkout)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := directory.Close(); err != nil {
			t.Error(err)
		}
	})
	marker, err := directory.ReadFile(disposableMarkerName)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(marker)) != strings.TrimSpace(output.String()) {
		t.Fatalf("marker = %q, output = %q", marker, output.String())
	}
}

// TestPrepareMarksALinkedWorktree exposes the governed hash without duplicating its algorithm in the caller.
//
// Expected: only a checkout with linked-worktree metadata receives the disposable marker and returns its hash.
func TestPrepareMarksALinkedWorktree(t *testing.T) {
	// Given: a source checkout carrying the regular .git pointer of a linked worktree.
	checkout := t.TempDir()
	writeFile(t, filepath.Join(checkout, ".git"), "gitdir: /tmp/administrative-only\n")
	writeFile(t, filepath.Join(checkout, "limit.go"), limitSource)
	var output strings.Builder

	// When: the caller explicitly prepares that disposable checkout.
	status := prepare([]string{"-checkout", checkout}, &output, &strings.Builder{})

	// Then: the returned governed hash and marker agree.
	if status != 0 {
		t.Fatalf("prepare() status = %d, want 0", status)
	}
	want := strings.TrimSpace(output.String())
	directory, err := os.OpenRoot(checkout)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := directory.Close(); err != nil {
			t.Error(err)
		}
	})
	marker, err := directory.ReadFile(disposableMarkerName)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(marker)) != want || len(want) != 64 {
		t.Fatalf("marker = %q, output hash = %q", strings.TrimSpace(string(marker)), want)
	}
}

// TestPrepareRefusesThePrimaryCheckout prevents convenience setup from weakening disposable authority.
//
// Expected: a normal .git directory cannot be marked by the preparation command.
func TestPrepareRefusesThePrimaryCheckout(t *testing.T) {
	// Given: a checkout shaped like a primary Git worktree.
	checkout := t.TempDir()
	if err := os.Mkdir(filepath.Join(checkout, ".git"), 0o700); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(checkout, "limit.go"), limitSource)

	// When: preparation is attempted on the authoritative checkout shape.
	status := prepare([]string{"-checkout", checkout}, &strings.Builder{}, &strings.Builder{})

	// Then: it is rejected before a marker is created.
	if status == 0 {
		t.Fatal("prepare() unexpectedly marked a primary checkout")
	}
	if _, err := os.Stat(filepath.Join(checkout, disposableMarkerName)); !os.IsNotExist(err) {
		t.Fatalf("disposable marker exists or cannot be inspected: %v", err)
	}
}

// TestRunProvesAnExactBehavioralMutant verifies the complete supplemental proof.
//
// Expected: a compiling mutant that fails the named focused test produces PROVED_BY_SENSITIVITY and restores the checkout.
func TestRunProvesAnExactBehavioralMutant(t *testing.T) {
	// Given: a green disposable Go checkout and an exact limit-changing mutant.
	fixture := newSensitivityFixture(t, validTestSource)
	patchPath := fixture.writePatch(t, "1 << 3", "1 >> 3")

	// When: the helper evaluates the mutant through compilation and the focused test.
	status := run(fixture.arguments(patchPath), &strings.Builder{})

	// Then: the behavioral failure proves sensitivity and every governed byte is restored.
	if status != 0 {
		t.Fatalf("run() status = %d, want 0", status)
	}
	assertVerdict(t, fixture.output, provedVerdict)
	fixture.assertRestored(t)
}

// TestRunRejectsASurvivingMutant verifies that a behavior-preserving patch cannot masquerade as sensitivity.
//
// Expected: a mutant whose focused test stays green produces UNRESOLVED and restores the checkout.
func TestRunRejectsASurvivingMutant(t *testing.T) {
	// Given: a mutation that changes syntax without changing the configured limit.
	fixture := newSensitivityFixture(t, validTestSource)
	patchPath := fixture.writePatch(t, "1 << 3", "8")

	// When: the helper evaluates the semantically surviving mutant.
	status := run(fixture.arguments(patchPath), &strings.Builder{})

	// Then: no sensitivity proof is issued and the checkout returns to its starting hash.
	if status == 0 {
		t.Fatal("run() unexpectedly proved a surviving mutant")
	}
	assertVerdict(t, fixture.output, unresolvedVerdict)
	fixture.assertRestored(t)
}

// TestRunRejectsANonCompilingMutant separates an invalid program from a behavioral failure.
//
// Expected: compilation failure produces UNRESOLVED without running a successful sensitivity claim.
func TestRunRejectsANonCompilingMutant(t *testing.T) {
	// Given: an exact patch that makes the Go source invalid.
	fixture := newSensitivityFixture(t, validTestSource)
	patchPath := fixture.writePatch(t, "const Limit = 1 << 3", "const Limit =")

	// When: the helper evaluates the invalid mutant.
	status := run(fixture.arguments(patchPath), &strings.Builder{})

	// Then: compilation failure remains unresolved and cleanup restores the source.
	if status == 0 {
		t.Fatal("run() unexpectedly proved a non-compiling mutant")
	}
	assertVerdict(t, fixture.output, unresolvedVerdict)
	fixture.assertRestored(t)
}

// TestRunRejectsAMismatchedPatch verifies exact mutation application.
//
// Expected: a patch whose original text is absent produces UNRESOLVED without changing the checkout.
func TestRunRejectsAMismatchedPatch(t *testing.T) {
	// Given: a patch for a different source expression.
	fixture := newSensitivityFixture(t, validTestSource)
	patchOriginal := strings.Replace(limitSource, "1 << 3", "1 << 4", 1)
	patchMutated := strings.Replace(patchOriginal, "1 << 4", "1 >> 4", 1)
	patchPath := filepath.Join(t.TempDir(), "mutant.patch")
	writeFile(t, patchPath, unifiedPatch(patchOriginal, patchMutated))

	// When: the helper attempts to apply the inapplicable patch.
	status := run(fixture.arguments(patchPath), &strings.Builder{})

	// Then: the proof fails closed and the checkout remains identical.
	if status == 0 {
		t.Fatal("run() unexpectedly accepted a mismatched patch")
	}
	assertVerdict(t, fixture.output, unresolvedVerdict)
	fixture.assertRestored(t)
}

// TestRunRejectsAFailingBaseline prevents existing failures from being attributed to a mutant.
//
// Expected: a red non-mutated focused test produces UNRESOLVED and the patch is never accepted as proof.
func TestRunRejectsAFailingBaseline(t *testing.T) {
	// Given: a disposable checkout whose focused test is already red.
	fixture := newSensitivityFixture(t, failingTestSource)
	patchPath := fixture.writePatch(t, "1 << 3", "1 >> 3")

	// When: the helper evaluates the baseline before applying the mutant.
	status := run(fixture.arguments(patchPath), &strings.Builder{})

	// Then: the pre-existing failure cannot prove sensitivity and nothing changes.
	if status == 0 {
		t.Fatal("run() unexpectedly accepted a failing baseline")
	}
	assertVerdict(t, fixture.output, unresolvedVerdict)
	fixture.assertRestored(t)
}

// TestRunRequiresADisposableMarker protects an authoritative checkout from mutation.
//
// Expected: a checkout without the explicit marker produces BLOCKED_SETUP before applying the patch.
func TestRunRequiresADisposableMarker(t *testing.T) {
	// Given: an otherwise valid checkout with its disposable marker removed.
	fixture := newSensitivityFixture(t, validTestSource)
	if err := os.Remove(filepath.Join(fixture.checkout, disposableMarkerName)); err != nil {
		t.Fatal(err)
	}
	patchPath := fixture.writePatch(t, "1 << 3", "1 >> 3")

	// When: the helper validates checkout authority.
	status := run(fixture.arguments(patchPath), &strings.Builder{})

	// Then: it refuses to mutate the unmarked checkout.
	if status == 0 {
		t.Fatal("run() unexpectedly accepted an unmarked checkout")
	}
	assertVerdict(t, fixture.output, blockedSetupVerdict)
	fixture.assertRestored(t)
}

// TestRunRequiresTheExpectedStartingHash prevents proof against a different snapshot.
//
// Expected: marker and argument hash disagreement produces BLOCKED_SETUP without applying the patch.
func TestRunRequiresTheExpectedStartingHash(t *testing.T) {
	// Given: a marked checkout and a caller claim for a different snapshot.
	fixture := newSensitivityFixture(t, validTestSource)
	patchPath := fixture.writePatch(t, "1 << 3", "1 >> 3")
	arguments := fixture.arguments(patchPath)
	arguments[3] = strings.Repeat("0", 64)

	// When: the helper validates the expected starting identity.
	status := run(arguments, &strings.Builder{})

	// Then: it fails before mutation and preserves the actual snapshot.
	if status == 0 {
		t.Fatal("run() unexpectedly accepted a mismatched starting hash")
	}
	assertVerdict(t, fixture.output, blockedSetupVerdict)
	fixture.assertRestored(t)
}

// TestTreeHashIgnoresLinkedWorktreeMetadata keeps Git's administrative pointer outside the governed source snapshot.
//
// Expected: adding the .git file used by a linked worktree does not change the source tree hash.
func TestTreeHashIgnoresLinkedWorktreeMetadata(t *testing.T) {
	// Given: a source tree before Git attaches linked-worktree metadata.
	checkout := t.TempDir()
	writeFile(t, filepath.Join(checkout, "limit.go"), limitSource)
	want, err := treeHash(checkout)
	if err != nil {
		t.Fatal(err)
	}

	// When: Git's administrative pointer is added as a regular .git file.
	writeFile(t, filepath.Join(checkout, ".git"), "gitdir: /tmp/administrative-only\n")
	got, err := treeHash(checkout)
	if err != nil {
		t.Fatal(err)
	}

	// Then: only governed checkout content contributes to the identity.
	if got != want {
		t.Fatalf("treeHash() = %s after .git metadata, want %s", got, want)
	}
}

func newSensitivityFixture(t *testing.T, testSource string) sensitivityFixture {
	t.Helper()
	checkout := t.TempDir()
	writeFile(t, filepath.Join(checkout, "go.mod"), "module example.com/sensitivity\n\ngo 1.26\n")
	writeFile(t, filepath.Join(checkout, "limit.go"), limitSource)
	writeFile(t, filepath.Join(checkout, "limit_test.go"), testSource)

	expectedHash, err := treeHash(checkout)
	if err != nil {
		t.Fatalf("hash fixture: %v", err)
	}
	writeFile(t, filepath.Join(checkout, disposableMarkerName), expectedHash+"\n")

	return sensitivityFixture{
		checkout:     checkout,
		output:       filepath.Join(t.TempDir(), "result.json"),
		expectedHash: expectedHash,
	}
}

func mustGit(t *testing.T, directory string, arguments ...string) {
	t.Helper()
	command := exec.Command("git", append([]string{"-C", directory}, arguments...)...)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", arguments, err, output)
	}
}

func (fixture sensitivityFixture) arguments(patchPath string) []string {
	return []string{
		"-checkout", fixture.checkout,
		"-expected-hash", fixture.expectedHash,
		"-patch", patchPath,
		"-compile-command", "go test . -run '^$' -count=1",
		"-test-command", "go test -json . -run '^TestExactLimit$' -count=1",
		"-expected-test", "TestExactLimit",
		"-output", fixture.output,
		"-timeout", "30s",
	}
}

func (fixture sensitivityFixture) writePatch(t *testing.T, oldText, newText string) string {
	t.Helper()
	mutated := strings.Replace(limitSource, oldText, newText, 1)
	if mutated == limitSource {
		t.Fatalf("fixture source does not contain %q", oldText)
	}
	patch := unifiedPatch(limitSource, mutated)
	path := filepath.Join(t.TempDir(), "mutant.patch")
	writeFile(t, path, patch)
	return path
}

func (fixture sensitivityFixture) assertRestored(t *testing.T) {
	t.Helper()
	actualHash, err := treeHash(fixture.checkout)
	if err != nil {
		t.Fatalf("hash restored checkout: %v", err)
	}
	if actualHash != fixture.expectedHash {
		t.Fatalf("checkout hash = %s, want %s", actualHash, fixture.expectedHash)
	}
}

func assertVerdict(t *testing.T, outputPath, want string) {
	t.Helper()
	data, err := os.ReadFile(outputPath)
	if err != nil {
		t.Fatalf("read result: %v", err)
	}
	var result struct {
		Verdict string `json:"verdict"`
	}
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	if result.Verdict != want {
		t.Fatalf("verdict = %q, want %q", result.Verdict, want)
	}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func unifiedPatch(original, mutated string) string {
	return "--- a/limit.go\n+++ b/limit.go\n@@ -1,7 +1,7 @@\n" + linePatch(original, mutated)
}

func linePatch(original, mutated string) string {
	originalLines := strings.Split(strings.TrimSuffix(original, "\n"), "\n")
	mutatedLines := strings.Split(strings.TrimSuffix(mutated, "\n"), "\n")
	var result strings.Builder
	for index := range originalLines {
		switch {
		case originalLines[index] == mutatedLines[index]:
			result.WriteString(" " + originalLines[index] + "\n")
		default:
			result.WriteString("-" + originalLines[index] + "\n")
			result.WriteString("+" + mutatedLines[index] + "\n")
		}
	}
	return result.String()
}

const limitSource = `package sample

const Limit = 1 << 3

func Within(value int) bool {
	return value <= Limit
}
`

const validTestSource = `package sample

import "testing"

func TestExactLimit(t *testing.T) {
	if !Within(8) {
		t.Fatal("exact limit must be accepted")
	}
}
`

const failingTestSource = `package sample

import "testing"

func TestExactLimit(t *testing.T) {
	if Within(8) {
		t.Fatal("pre-existing failure")
	}
}
`

// TestValidateSetupRejectsMarkerOutsideCheckout prevents a valid external marker from authorizing the checkout.
func TestValidateSetupRejectsMarkerOutsideCheckout(t *testing.T) {
	checkout := t.TempDir()
	expected, err := treeHash(checkout)
	if err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	marker := filepath.Join(outside, "marker")
	writeFile(t, marker, expected)
	if err := os.Symlink(marker, filepath.Join(checkout, disposableMarkerName)); err != nil {
		t.Fatal(err)
	}
	patch := filepath.Join(outside, "change.patch")
	writeFile(t, patch, "patch")
	_, err = validateSetup(configuration{checkout: checkout, expectedHash: expected, patch: patch, output: filepath.Join(outside, "result.json")})
	if err == nil {
		t.Fatal("external marker must not authorize the checkout")
	}
}

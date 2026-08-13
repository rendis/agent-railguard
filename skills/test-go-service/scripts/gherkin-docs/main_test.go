package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var testConfig = analyzerConfig{
	contextType:    "godog.ScenarioContext",
	handlerMarker:  "implements the Gherkin step",
	behaviorMarker: "Behavior:",
}

// TestRunRequiresExplicitRoot prevents the reusable analyzer from assuming a repository layout.
//
// Expected: invoking the CLI without -root fails with an actionable usage diagnostic.
func TestRunRequiresExplicitRoot(t *testing.T) {
	t.Parallel()

	// Given: a CLI invocation without a project-derived steps root.
	var stderr strings.Builder

	// When: the analyzer parses the incomplete invocation.
	status := run(nil, &stderr)

	// Then: it rejects the invocation instead of scanning a fixed or implicit harness path.
	if status == 0 {
		t.Fatal("expected missing root to fail")
	}
	if !strings.Contains(stderr.String(), "-root is required") {
		t.Fatalf("stderr = %q, expected required root diagnostic", stderr.String())
	}
}

// TestVerifyRoot accepts exact documentation across multiple capability packages.
//
// Expected: complete handler and package indexes across production and test files pass validation.
func TestVerifyRoot(t *testing.T) {
	t.Parallel()

	// Given: capability packages with exact bindings, handler GoDoc and step indexes.
	root := t.TempDir()
	writeStepPackage(t, root, "inventory", validStepSource("a valid delivery", "aValidDelivery"), packageDoc("Given a valid delivery"), "steps.go")
	writeStepPackage(t, root, "eligibility", validStepSource("an eligible offer", "aValidDelivery"), packageDoc("Then an eligible offer"), "steps_test.go")

	// When: the complete Gherkin documentation surface is verified.
	err := verifyRoot(root, testConfig)

	// Then: the consistent packages produce no violation.
	if err != nil {
		t.Fatalf("verify valid documentation: %v", err)
	}
}

// TestVerifyRootReportsMissingHandlerAndIndexDocumentation rejects stale glue documentation.
//
// Expected: missing behavior text, missing index entries and stale entries are all reported.
func TestVerifyRootReportsMissingHandlerAndIndexDocumentation(t *testing.T) {
	t.Parallel()

	// Given: a capability with stale index entries and a missing behavior marker.
	root := t.TempDir()
	steps := strings.Replace(validStepSource("a valid delivery", "aValidDelivery"), "Behavior:", "Contract:", 1)
	writeStepPackage(t, root, "inventory", steps, packageDoc("Given a stale delivery"), "steps.go")

	// When: the inconsistent capability is verified.
	err := verifyRoot(root, testConfig)

	// Then: every missing and stale documentation relation is reported.
	assertErrorContains(t, err, "must have GoDoc", "Step index must contain", "Step index contains stale entry")
}

// TestVerifyRootRejectsAStaleDeclaredPhraseEvenWhenCurrentTextAppearsElsewhere prevents substring-only matches.
//
// Expected: stale declared phrases fail even when the current binding text appears elsewhere in GoDoc.
func TestVerifyRootRejectsAStaleDeclaredPhraseEvenWhenCurrentTextAppearsElsewhere(t *testing.T) {
	t.Parallel()

	// Given: a handler declaring a stale phrase while mentioning the current binding elsewhere.
	root := t.TempDir()
	source := strings.Replace(validStepSource("a valid delivery", "aValidDelivery"),
		`implements the Gherkin step "a valid delivery".`,
		`implements the Gherkin step "a stale delivery".
//
// Note: the current binding contains a valid delivery.`, 1)
	writeStepPackage(t, root, "inventory", source, packageDoc("Given a valid delivery"), "steps.go")

	// When: exact handler-to-binding correspondence is verified.
	err := verifyRoot(root, testConfig)

	// Then: the unrelated mention cannot satisfy the declared phrase contract.
	assertErrorContains(t, err, `must have GoDoc declaring exact phrase "a valid delivery"`)
}

// TestVerifyRootQualifiesHandlersByReceiver rejects stale docs without colliding equal method names.
//
// Expected: an unregistered method is reported by its qualified receiver and name.
func TestVerifyRootQualifiesHandlersByReceiver(t *testing.T) {
	t.Parallel()

	// Given: registered and stale handlers that share a method name on different receivers.
	root := t.TempDir()
	source := validStepSource("a valid delivery", "aValidDelivery") + `

type staleSteps struct{}

// aValidDelivery implements the Gherkin step "a stale delivery".
//
// Behavior: it is not registered.
func (staleSteps) aValidDelivery() {}
`
	writeStepPackage(t, root, "inventory", source, packageDoc("Given a valid delivery"), "steps.go")

	// When: handlers are matched against bindings.
	err := verifyRoot(root, testConfig)

	// Then: the stale handler is reported with its receiver-qualified identity.
	assertErrorContains(t, err, "staleSteps.aValidDelivery has no Step binding")
}

// TestVerifyRootIgnoresUnrelatedStepMethods accepts non-Godog Step calls.
//
// Expected: a same-named method on an unrelated context does not create a false binding.
func TestVerifyRootIgnoresUnrelatedStepMethods(t *testing.T) {
	t.Parallel()

	// Given: a valid Godog binding and an unrelated same-named Step method.
	root := t.TempDir()
	source := validStepSource("a valid delivery", "aValidDelivery") + `

type builder struct{}
func (builder) Step(string, any) {}
func configure(current builder, steps steps) { current.Step("^not a Godog binding$", steps.aValidDelivery) }
`
	writeStepPackage(t, root, "inventory", source, packageDoc("Given a valid delivery"), "steps.go")

	// When: the package is inspected using the configured Godog context type.
	err := verifyRoot(root, testConfig)

	// Then: the unrelated method does not create a false binding.
	if err != nil {
		t.Fatalf("ignore unrelated Step method: %v", err)
	}
}

// TestVerifyRootRejectsDuplicateBindings detects ambiguous registrations.
//
// Expected: registering the same Gherkin expression twice produces a deterministic violation.
func TestVerifyRootRejectsDuplicateBindings(t *testing.T) {
	t.Parallel()

	// Given: one Gherkin expression registered twice in the same capability.
	root := t.TempDir()
	source := strings.Replace(validStepSource("a valid delivery", "aValidDelivery"),
		`scenario.Step("^a valid delivery$", current.aValidDelivery)`,
		"scenario.Step(\"^a valid delivery$\", current.aValidDelivery)\n\tscenario.Step(\"^a valid delivery$\", current.aValidDelivery)", 1)
	writeStepPackage(t, root, "inventory", source, packageDoc("Given a valid delivery"), "steps.go")

	// When: binding uniqueness is verified.
	err := verifyRoot(root, testConfig)

	// Then: the duplicated expression and registration count are reported.
	assertErrorContains(t, err, "duplicate binding expression", "registered 2 times")
}

// writeStepPackage creates a representative capability package for analyzer tests.
func writeStepPackage(t *testing.T, root, capability, steps, documentation, stepsFile string) {
	t.Helper()

	directory := filepath.Join(root, capability)
	if err := os.MkdirAll(directory, 0o750); err != nil {
		t.Fatalf("create package: %v", err)
	}
	for name, content := range map[string]string{stepsFile: steps, "doc.go": documentation} {
		if err := os.WriteFile(filepath.Join(directory, name), []byte(content), 0o600); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
}

// assertErrorContains requires every diagnostic fragment in one analyzer error.
func assertErrorContains(t *testing.T, err error, expected ...string) {
	t.Helper()
	if err == nil {
		t.Fatal("expected documentation violations")
	}
	for _, fragment := range expected {
		if !strings.Contains(err.Error(), fragment) {
			t.Errorf("expected %q in %v", fragment, err)
		}
	}
}

// validStepSource returns a minimal Godog package with one qualified handler.
func validStepSource(expression, handler string) string {
	return `package inventory

import "github.com/cucumber/godog"

type steps struct{}

func (current steps) register(scenario *godog.ScenarioContext) {
	scenario.Step("^` + expression + `$", current.` + handler + `)
}

// ` + handler + ` implements the Gherkin step "` + expression + `".
//
// Behavior: prepares the scenario's observable state.
func (steps) ` + handler + `() {}
`
}

// packageDoc returns a searchable package Step index.
func packageDoc(entry string) string {
	return `// Package inventory implements inventory steps.
//
// Step index:
//
//   - ` + entry + `
package inventory
`
}

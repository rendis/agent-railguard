# Critical Go Code Assurance

## Enforce three independent signals

When repository policy declares a package scope critical/core, require all three axes:

1. **Reachability:** exactly 100% of instrumentable statements covered by tests owned by that scope (see [coverage-gap-analysis.md](coverage-gap-analysis.md) for the three coverage tiers kept separate).
2. **Sensitivity:** every applicable mutation resolved, with every operator family the pinned engine supports enabled (see [advanced-testing.md](advanced-testing.md) for classification).
3. **Semantics:** tests derive expectations independently and discriminate plausible wrong behavior.

`railguard verify` also requires overall production coverage strictly greater than 85% under the standard baseline — a separate gate that E2E or adapter execution may help but cannot substitute for critical-scope-owned tests.

## Build semantic tests

For constructors, commands, results, mappers, and port propagation:

- use distinct non-default values for every independent field so omissions and swaps are observable;
- assert every contractually preserved property, including booleans in their non-default state;
- cover each invariant boundary, malformed input, stable error category, and state transition;
- observe both the result and required effects or their absence;
- use `errors.Is`/`errors.As` for stable error contracts instead of text equality;
- prove nil or missing capabilities when constructors accept dependencies;
- keep one coherent behavioral reason per test rather than one test per statement.

Never reference a constant, getter, branch, or error solely to move coverage — a test earns its place by naming the defect class it would detect.

## Complement operator mutation

Token mutation cannot expose every semantic defect. Add complementary evidence for named risks:

- discriminating examples or properties for field propagation and formulas;
- fuzz seeds and invariants for parsers and validators;
- race and lifecycle tests for concurrency;
- contract tests for substitutable boundaries;
- E2E for assembly, process lifecycle, and public journeys.

A 100% mutation score does not close a missing error case, a default-value propagation gap, or an unsupported mutation class — return those semantic gaps independently.

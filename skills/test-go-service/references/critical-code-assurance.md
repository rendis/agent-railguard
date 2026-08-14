# Critical Go Code Assurance

## Enforce three independent signals

When repository policy declares a package scope critical/core, require all three axes:

1. **Reachability:** exactly 100% of instrumentable statements are covered by tests owned by that critical scope.
2. **Sensitivity:** every applicable mutation is resolved, with all operator families supported by the pinned engine enabled.
3. **Semantics:** tests derive expectations independently and discriminate plausible wrong behavior.

Overall production coverage remains a separate gate and must be strictly greater than 85% under the standard service baseline. E2E or adapter execution may improve overall evidence but cannot substitute for critical-scope-owned tests.

## Keep the three coverage tiers separate

Treat exact critical/core reachability, zero unclassified gaps in the authorized changed or audited production scope, and the adopted whole-product percentage as three independent decisions. The critical scope requires `covered == total`; the changed/audited scope requires each uncovered block to be proved, removed, concretely non-applicable, or retained as a visible non-closing limitation; the overall percentage remains a mechanical regression floor. A block introduced or changed by the candidate cannot become `out_of_scope`.

Generate and inspect fresh matching profiles after production or test edits. A passing core count or overall floor never closes another tier and never proves branch sensitivity or oracle independence.

## Build semantic tests

For constructors, commands, results, mappers, and port propagation:

- use distinct non-default values for every independent field so omissions and swaps are observable;
- assert every contractually preserved property, including booleans in their non-default state;
- cover each invariant boundary, malformed input, stable error category, and state transition;
- observe both the result and required effects or absence of effects;
- use `errors.Is` or `errors.As` for stable error contracts instead of text equality;
- prove nil or missing capabilities when constructors accept dependencies;
- retain one coherent behavioral reason per test rather than one test per statement.

Do not add references to constants, getters, branches, or errors solely to move coverage. A test earns its place by naming the defect class it would detect.

## Make mutation diverse

Enable every compatible operator family in the pinned engine. With Gremlins 0.6 this includes arithmetic, conditional boundary and negation, increment/decrement, assignment, bitwise, bitwise-assignment, logical, loop-control, negative, and self-assignment removal mutations. Confirm names from the pinned binary rather than copying this list across versions.

Report both configured and actually exercised operator families. Source without a loop or bitwise expression legitimately produces no mutation from those families; never change production syntax to increase an operator-count metric.

An adopted aggregate mutation scope that produces no mutants supplies no sensitivity evidence and cannot pass. Treat it as a scope, configuration, or applicability result to resolve explicitly; do not call `0/0` perfect mutation efficacy.

Classify every non-resolved result:

- `LIVED`: test gap, semantically equivalent mutation, or dead code;
- `NOT COVERED`: reachability gap or incorrectly selected scope;
- `TIMED OUT`: possible mutant loop, flaky test, or invalid timeout calibration;
- `SKIPPED` or unfinished: incomplete campaign;
- `NOT VIABLE`: compilation rejected the mutation; preserve it as an engine limitation and decide contextually whether it represents a semantically testable change.

Only `KILLED` is an automatic pass. `NOT VIABLE`, `NOT COVERED`, a possible equivalent, or any other unresolved status needs code-level reasoning outside the automatic verdict; never add an assertion that exposes implementation detail merely to change the score.

If instrumentation cannot execute a compile-time or otherwise behaviorally meaningful mutant, classify it as a tool limitation rather than equivalent or killed. Keep the clear production expression and prove its observable boundary with an independent oracle. The automatic gate remains unresolved unless the adopted engine or a separately approved narrow central tool can represent the decision; do not add a consumer-repository exception ledger.

Compare source and report changes during remediation. Never rewrite equivalent production syntax merely to reduce the generated-mutant count. Contextual review must challenge a disappearing unresolved mutant even though generated inventories are not versioned.

## Complement operator mutation

Token mutation cannot expose every semantic defect. Select complementary evidence for named risks:

- discriminating examples or properties for field propagation and formulas;
- fuzz seeds and invariants for parsers and validators;
- race and lifecycle tests for concurrency;
- contract tests for substitutable boundaries;
- E2E for assembly, process lifecycle, and public journeys.

A 100% mutation score does not close a missing error case, default-value propagation gap, or unsupported mutation class. Return those semantic gaps independently.

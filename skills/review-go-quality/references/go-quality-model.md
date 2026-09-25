# Go Quality Model

## Dimensions

| Dimension | Questions |
|---|---|
| Request and acceptance | Is every requirement, constraint, and exclusion implemented and proven without added scope? |
| Correctness | Can inputs, states, or errors produce a wrong result, panic, or loss? |
| Contract | Do APIs, events, data, compatibility, or semantics change without explicit handling? |
| Architecture | Do dependencies point toward the core, and does every decision have an owner? |
| Simplicity | Is complexity essential, or is the abstraction speculative? |
| Reuse | Was the existing semantic owner extended, or was code duplicated or shared from superficial similarity? |
| Modularization | Are modules cohesive and deep, or are there catch-alls and boundaryless fragments? |
| Patterns | Does each pattern solve observed variation or coupling better than a direct solution? |
| Optimization | Does performance complexity respond to measurement, budget, or observed material risk? |
| Errors and context | Are categories, cancellation, and deadlines preserved without provider leakage? |
| Concurrency | Are there races, deadlocks, leaks, premature closure, or undrained work? |
| Security | Are secrets exposed, inputs trusted, or privilege and supply-chain risk expanded? |
| Dependencies | Is each library necessary, pinned, maintained, and compatible? |
| Tests | Do new behavior and risks have an independent, discriminating signal rather than coverage-only execution? |
| Operations | Are timeout, retry, observability, health, and shutdown bounded? |
| Documentation | Do orchestrators expose their flow without narrating simple functions or drifting from code? |
| Naming | Does every name identify owner, concept, state, unit, or effect without plausible ambiguity at its use site? |

Most of this is what `railguard verify --changed` cannot check: it proves the mechanical gate is green, not that the design, naming, or test is right. Judge these dimensions from the code and the diff.

## Interpret metrics

`go-metrics` reports inclusive declaration-to-close length, named or unnamed parameters, results, basic cyclomatic complexity, location, and receiver. A high value opens contextual inspection: decisions and states, function cohesion, contract clarity, test difficulty, local baseline difference, and the cost and risk of splitting. Recommend extraction when it reduces decisions or isolates responsibility without fragmenting linear reading or exposing details; group parameters only when they form one concept with shared invariants or evolution.

Keep `max-lines` and `max-params` at zero by default; enforce a threshold only when versioned configuration exists, the user explicitly approves it for a declared scope, or CI already treats it as a gate. Without a limit, report distributions and outliers — a requested limit supports a mechanical violation, but findings still need contextual evidence.

## Verify coverage and mutation claims beyond the gate

`railguard verify --changed` enforces 100% changed-line coverage on core and 80% elsewhere, plus mutation on changed lines — a passing number is a starting point, not proof the claim is real. Keep exact critical/core reachability, zero unclassified gaps in the authorized scope, and the adopted whole-product floor as three separate decisions. Close each unclassified in-scope block, checked against the diff and behavior inventory, with a named proof, a removal, concrete non-applicability, or a visible limitation; no block the change introduced or touched may be marked `out_of_scope`. Reject rounded 100%, a global test hiding a core gap, a live or unfinished mutant, and a default-only fixture that cannot detect an omitted assignment. Compare the mutation report against the source diff, not only the latest ratio: reject a "perfect" score obtained by rewriting an equivalent expression so an unresolved mutant no longer generates, and verify a boundary expectation does not depend on the production constant it constrains.

A tool-unexecutable mutant stays visible in the native report, never silently killed or excepted. If the change claims that limitation is independently proved, verify that proof yourself against the same standard as any other finding — exact mutant, green baseline, compiling patch, and the named test actually failing before restoration — rather than accepting the claim at face value.

## Review functional simplicity and documentation

- Value pure transformations, boundary effects, values treated as data, and explicit control; judge idiomatic code by demonstrated complexity or coupling, not by the presence of functional abstractions.
- Challenge documentation against the development contract: one ownership description per package; exported types, fields, commands, results, interfaces, enum values, and stable errors documented by meaning, not identifier; contextual GoDoc only for real private seams, not every helper or incidental DTO; `Expected flow:`/`Flow:` markers synchronized with the code they describe. Prefer `godoclint` in `golangci-lint` as mechanical evidence, and never classify comment validation as unit, integration, or E2E behavior.
- Challenge over-documentation that narrates trivial mechanics, repeats statements, or compensates for code that should be simplified.

## Review naming quality

- Review names at contracts and call sites; a name is insufficient when two reasonable interpretations remain for owner, unit, state, direction, or effect.
- Verify consistent domain vocabulary, noun types, verb operations, consumer-capability interfaces, positive boolean predicates, and plural collections.
- Challenge generic names such as `Client`, `Handler`, `Service`, `Manager`, `Processor`, `Data`, `Info`, or `Item` when the package and call site do not remove ambiguity.
- Accept idiomatic short names only in narrow scopes; reject invented abbreviations, numeric suffixes, and names derived only from type.
- Treat clean `staticcheck`/`gocritic` output as mechanical evidence only — it does not by itself establish semantic naming quality.

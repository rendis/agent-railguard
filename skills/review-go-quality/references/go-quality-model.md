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

## Interpret metrics

`go-metrics` reports inclusive declaration-to-close length, named or unnamed parameters, results, basic cyclomatic complexity, location, and receiver. A high value opens contextual inspection; evaluate decisions and states, function cohesion, contract clarity, test difficulty, local baseline difference, and the cost and risk of splitting.

Recommend extraction when it reduces decisions or isolates responsibility without fragmenting linear reading or exposing details. Group parameters only when they form one concept with shared invariants or evolution.

Keep `max-lines` and `max-params` at zero by default. Enforce a threshold only when versioned configuration exists, the user explicitly approves it for a declared scope, or CI already treats it as a gate. Without a limit, report distributions and outliers. A requested limit supports mechanical violations; findings still need contextual evidence.

For a declared critical/core policy, verify exact covered and total statements, the owning test scope, every unresolved mutation and exercised operator family, and contrastive assertions over propagated fields. Reject rounded 100%, global tests hiding a core gap, mutation scores with live or unfinished mutants, and default-only fixtures that cannot detect omitted assignments. Passing these gates still does not prove the oracle matches the business contract.

Keep three coverage decisions separate: exact critical/core reachability, zero unclassified gaps in the authorized changed or audited scope, and the adopted whole-product floor. A passing floor with an unclassified in-scope block is not complete evidence. Inspect each block against the candidate diff and behavior inventory; require a named proof, removal/simplification, concrete non-applicability, or a visible non-closing limitation. Never accept `out_of_scope` for a block introduced or changed by the candidate.

Compare mutation reports and source diffs, not only the latest ratio. Reject a “perfect” score obtained by rewriting an equivalent expression so an unresolved mutant is no longer generated. Verify boundary expectations are independent of the production constant or helper they constrain. Accept a semantically equivalent representation only when it remains at least as clear and preserves observable boundaries, error categories, and discriminating evidence; never infer a syntax ban from tool support.

A tool-unexecutable case remains visible in the native report and is neither killed nor silently resolved. Inspect a supplemental `PROVED_BY_SENSITIVITY` only as separate per-run evidence: require the exact native mutant, a green baseline, compiling patched source, failure of the named focused behavioral test, and equal restored hashes in a caller-marked disposable checkout. Classify the skill-side result as `SATISFIED_WITH_PROVED_TOOL_LIMITATION` only when every native unresolved mutant has that proof and no other native failure exists. A survivor is `FAILED`; missing authority, identity, tooling, or restoration is `BLOCKED_SETUP`. Do not require a consumer-repository exception ledger merely to preserve history.

## Review functional simplicity and documentation

- Value pure transformations, boundary effects, values treated as data, and explicit control; judge idiomatic code by demonstrated complexity or coupling, not the presence of functional abstractions.
- Require one package ownership description and contract-focused documentation for exported types, fields, commands, results, interfaces, enum values, and stable errors.
- Require contextual GoDoc for meaningful private seams, integration contracts, lifecycle, error, or security policies, domain vocabulary, and non-obvious orchestrators—not every helper, closure, double, or incidental DTO.
- Evaluate mechanical GoDoc evidence from the repository's maintained declarative linter, preferably `godoclint` in `golangci-lint`. Configuration and adoption belong to `configure-go-quality`; specialized AST analyzers remain with their owning skill. Never classify comment validation as unit, integration, or E2E behavior.
- For interfaces, use cases, and ports, ensure `Expected flow:` describes observable expectations, results, and stable errors without implementation pseudocode.
- For multi-phase orchestrators, ensure `Flow:` lists stable intent and each `// N. ...` marks the corresponding block in synchronized order.
- Challenge over-documentation that narrates trivial mechanics, repeats statements, or compensates for code that should be simplified.

## Review naming quality

- Review names at contracts and call sites. A name is insufficient when two reasonable interpretations remain for owner, unit, state, direction, or effect.
- Verify consistent domain vocabulary, noun types, verb operations, consumer-capability interfaces, positive boolean predicates, and plural collections.
- Challenge generic names such as `Client`, `Handler`, `Service`, `Manager`, `Processor`, `Data`, `Info`, or `Item` when package and call site do not remove ambiguity.
- Accept idiomatic short names only in narrow scopes; reject invented abbreviations, numeric suffixes, and names derived only from type.
- Use `staticcheck` and `gocritic` as mechanical evidence, but do not claim semantic naming quality from clean linters or identifier-length limits.

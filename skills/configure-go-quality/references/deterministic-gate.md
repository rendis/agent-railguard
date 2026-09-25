# Native Deterministic Go Gates

## Encode only decidable policy

Classify every adopted requirement:

- **Mechanical:** a stable command over an explicit scope that fails non-zero with a useful diagnostic.
- **Contextual:** evidence and a decision question for a reviewer — never a numeric proxy standing in for judgment.
- **Exploratory:** a probe (fuzzing, mutation-sensitivity) whose useful failures get promoted into a deterministic regression.

`railguard check` and `railguard verify` (with `--changed` for change scope) are the only public commands. Do not add a second DAG, alias layer, report renderer, or runner application. Canonical commands must run from a clean clone with repository pins and explicit configs — never a developer-home file, `.agents`, `.codex`, or an installed skill path. Repository-specific scope lives in selected profile inputs, not hand-written Make rules (this repository has none).

## Coverage and mutation are the tool's math, not yours

`railguard verify --changed` already computes changed-line coverage against the 100%-core/80%-elsewhere bar and runs Gremlins on changed lines, failing on any `LIVED` or `NOT_COVERED` mutant (see [default-go-service-profile.md](default-go-service-profile.md)). Do not re-derive these numbers by hand or accept a rounded display percentage as a substitute for the tool's verdict. What configuration still owns:

- the exact scope each threshold applies to (which packages are "core", which are "changed");
- treating the whole-product percentage as a mechanical regression floor only: it does not classify uncovered behavior or prove that a changed or critical scope is semantically complete, and mutation score never substitutes for an independent oracle;
- classifying an engine limitation. When the pinned engine reports an exact, semantically testable mutant it cannot schedule, `test-go-service` may run its supplemental `mutation-sensitivity` proof in a caller-marked disposable checkout. Keep the native report and exit code unchanged; return `SATISFIED_WITH_PROVED_TOOL_LIMITATION` only when every native unresolved mutant has its own successful proof and no other native failure exists, otherwise `FAILED` or `BLOCKED_SETUP`. Never mark a mutant killed or add a blanket exception.

Prefer independently expressed behavioral oracles and clear idiomatic source; do not ban an operator or rewrite an expression merely to make a mutant disappear, nor restructure source to make more operator families applicable. A `KILLED` result is evidence for review, not proof that the test asserts the right product behavior.

## Preserve replicability, not byte identity

Formatting, module verification, static analysis, exact coverage counts, and fixed regression suites give a pure verdict for the same snapshot. Race, bounded fuzz, mutation ordering, timings, and E2E traces may vary in noisy bytes — require the same verdict class, scope, seed/budget, and invariants, not identical output. Version only what reproduces the decision; keep coverage, mutation, fuzz, and trace artifacts under ignored paths or CI artifacts.

## Require the external SonarQube verdict

When repository scanner properties are owned, set `sonar.qualitygate.wait=true` and a bounded `sonar.qualitygate.timeout` so the scanner cannot report success before the server gate is known. Keep that invocation in the same blocking CI path as `railguard verify`, and record the analyzed revision plus observed Quality Gate identity/status. Local `gocognit`, `dupl`, coverage, and similar analyzers are complementary preflight signals — never translate a local pass into a SonarQube pass. Missing credentials or unavailable server evidence is `BLOCKED_SETUP`, not local success.

---
name: test-go-service
description: Produce Go-specific test evidence. Use for standalone Go tests, coverage-gap analysis, or hardening such as fuzz, race, mutation, or flakiness.
---

# Test Go Service

`railguard check --changed` and `railguard verify --changed` already gate formatting, `go vet`, tests, lint on new lines, race, changed-line coverage, mutation, and bounded fuzz on every finish and every commit. This skill supplies what those gates cannot: choosing the right level and doubles, designing a sensitive proof, and reading an unresolved result.

## Choose evidence for a named risk

1. **Route.** Read authority, contracts, baseline, and risk; a read-only run or diagnosis may enter directly. `develop-go-hexagonal-service`, when already active, remains the outer edit owner — behavior RED/GREEN stays in `tdd`, placement in development, configuration in `configure-go-quality`, public journeys in `build-e2e-test-suite`. Complete when owner, defect class, and allowed files are explicit.
2. **Proof.** When creating or materially redesigning a test, load `design-tests` once (unless already active) for its seam, independent oracle, context/action/outcome, and sensitivity decisions — a green suite and clean lint do not substitute. Complete when the proof contract is explicit or already active.
3. **Level.** Read [go-test-levels.md](references/go-test-levels.md) and pick the lowest faithful Go level for the risk; add another only when it detects a distinct defect class. Complete when each level has a focused command and expected signal.
4. **Shape.** Read [go-test-style.md](references/go-test-style.md), and [test-doubles-and-contracts.md](references/test-doubles-and-contracts.md) when doubles or contract suites are needed. Use behavior-focused names, native Go structure, and deterministic helpers; document only where it adds contract information or project policy requires it. Complete when names, structure, and doubles match the selected level and proof contract.
5. **Coverage.** When production changed, closure is claimed, or an audit is requested, read [coverage-gap-analysis.md](references/coverage-gap-analysis.md) and route every uncovered in-scope block by named defect; for a declared critical/core scope also read [critical-code-assurance.md](references/critical-code-assurance.md). Complete when every in-scope gap is classified or a truthful limitation is recorded.
6. **Harden.** Pass the focused suite before the first governed edit to existing behavior, and preserve that baseline. Beyond what `railguard verify --changed` already runs, read [advanced-testing.md](references/advanced-testing.md) for concurrency, mutation, lifecycle, or flakiness probes, and [test-code-quality.md](references/test-code-quality.md) for test-specific lint. For an exact mutant the native engine cannot schedule, run `scripts/mutation-sensitivity`; complete this route only on `PROVED_BY_SENSITIVITY` with matching restored hashes. A missing pin, config, or command is a `configure-go-quality` gap, not something to route around. Complete when each selected technique has observed reachability, sensitivity, and semantic evidence, or an honest gap owned by configuration.
7. **Return.** Report proof, level, seam, commands, profile scope, exact gap facts, observed result, sensitivity evidence, and unresolved states. Classify a production defect for development and TDD; if only tests were authorized, keep product code intact and do not claim the complete Definition of Done. Complete when the report names proof, commands, results, and unresolved states without a delivery-closure claim.

## Composition contract

| Situation | Load or owner |
| --- | --- |
| `develop-go-hexagonal-service` already active | That workflow remains the outer edit owner |
| Creating or redesigning a test | `design-tests` once |
| Ordinary behavior RED/GREEN | `tdd` |
| Missing pins, configs, or canonical commands | `configure-go-quality` |
| Public journeys | `build-e2e-test-suite` |
| Go/Godog selected by the E2E owner | [go-e2e-gherkin.md](references/go-e2e-gherkin.md) for runner layout only |
| Read-only coverage review from `review-go-quality` | Diagnosis only; stop after Coverage; no Harden edits |

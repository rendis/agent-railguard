---
name: develop-go-hexagonal-service
description: Deliver a Go change spanning hexagonal boundaries, from discovery through TDD, acceptance, verification, and review. Use for production behavior, architecture, or runtime-boundary changes needing coordinated implementation.
---

# Develop Go Hexagonal Service

## Close one verified delivery

1. **Route.** Read governing instructions and any active spec or handoff, then [change-routing.md](references/change-routing.md). Use this workflow for production behavior, an architecture or runtime boundary, or a full delivery; leave standalone test, E2E, configuration, or read-only review work to its own skill, and skip entirely for documentation- or explanation-only requests. Note the boundary and applicable focused skills, and check `configure-go-quality` readiness. Complete when routing and configuration readiness are both stated.
2. **Discover.** Read [implementation-analysis.md](references/implementation-analysis.md) and the [design lens](references/design-lens.md). Search behavior (not just names): tests, consumers, dependencies, configured capabilities, library types, public contracts, persistence, and baseline failures. Classify the request as verify, extend, reuse, extract, replace, or create, and record capability, ownership, deterministic-transformation/effect split, simplest end-to-end slice, compatibility evidence, debt class, and a falsifiable test strategy. Complete when these are recorded, and stop without editing if the request is already satisfied.
3. **Contract.** Trace actor → entry → application → external capability → composition. Read all matching rows:

   | Change class | Reference |
   | --- | --- |
   | Crossed hexagonal boundaries | [architecture-contract.md](references/architecture-contract.md) |
   | Go production idiom | [go-design-practices.md](references/go-design-practices.md) |
   | Inbound or outbound HTTP stack | [REST stack selection](references/rest-stack-selection.md) |
   | New or changed runtime configuration | [runtime configuration](references/runtime-configuration.md) |
   | Changed error contracts | [error-management.md](references/error-management.md) |

   Present options when REST selection, or compatibility, data, architecture, migration, external consumers, or cost, needs a user decision; otherwise pick the simplest durable solution, replace obsolete internal paths atomically, and add no fallback, alias, or speculative abstraction. Complete when the selected contracts are explicit and any obsolete-path replacement is decided.
4. **Develop.** Load `tdd` for a feature, fix, or behavior-preserving refactor; load `design-tests` once only when a proof is created or materially redesigned. Implement the smallest working vertical slice and refactor while green: features and fixes need a discriminating RED→GREEN, refactors need a green safety net and must not manufacture RED. Complete when the slice's behavior contract closes through observed FAIL→PASS or an explicit green safety net.
5. **Accept.** Load `build-e2e-test-suite` when a public journey or runtime boundary applies, or `test-go-service` for test-only work. Route a functional failure to its smallest behavioral owner and rerun the journey. Setup, dependency, readiness, or cleanup failure is `BLOCKED_SETUP` — preserve diagnostics; it is neither pass nor product failure. Complete when applicable journeys show `PASS`, `FAIL`, or `BLOCKED_SETUP`, or none applies.
6. **Verify.** Read [verification.md](references/verification.md) and run `railguard verify --changed` (or the repository's equivalent gate) with exact pins and configs. Route every failure to behavior, tests, E2E, or configuration; never weaken a threshold or assertion to pass it. Rerun after each fix. Complete when the command is green or a blocked prerequisite is honestly recorded.
7. **Challenge.** Load `review-go-quality` read-only over that fixed change: alignment, correctness, simplicity, reuse, effect isolation, pattern need, compatibility, debt, naming, documentation, and test sensitivity. A fix creates a new change and needs a new review. Complete when the review returns findings or states none exist.
8. **Harden.** Load `test-go-service` for risk- or policy-selected signals beyond what `railguard verify --changed` already covers (race, coverage, mutation, `govulncheck`, E2E) — integration, contract, fuzz, benchmark, flakiness. `configure-go-quality` owns missing reproducibility inputs; the behavioral owner handles product findings. A hardening edit starts a new verify-and-review cycle. Complete when every selected signal has a result or an honestly reported gap.
9. **Deliver.** Run affected signals and the final `railguard verify --changed`, inspect the diff, and report discovery, design-lens answers, compatibility, debt, TDD/refactor evidence, E2E classification, configuration state, review, hardening, commands, results, and anything unobserved. Complete when [verification.md](references/verification.md) is satisfied.

## Composition contract

| Situation | Load or owner |
| --- | --- |
| Production behavior, architectural or runtime boundary, or complete delivery | This workflow |
| Standalone test-only work | `test-go-service` |
| E2E-only work | `build-e2e-test-suite` |
| Configuration-only work | `configure-go-quality` |
| Configuration readiness check during delivery | `configure-go-quality` in `Assess` mode |
| Read-only review | `review-go-quality` |
| Creating or redesigning a proof | `design-tests` once |
| Feature, fix, or behavior-preserving refactor | `tdd` |

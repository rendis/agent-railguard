# Verification and Definition of Done

## Preserve the development loop

1. **Focused behavior:** observe RED→GREEN for features/fixes or a green safety net for refactors; broaden to immediate consumers.
2. **Public acceptance:** when applicable, run the existing E2E journey. Functional failure returns to focused TDD; setup failure is `BLOCKED_SETUP`.
3. **Candidate:** run the native standard gate with repository pins and configs and fix a stable snapshot for review.
4. **Challenge:** review that snapshot read-only. Any accepted edit invalidates it and returns to candidate formation.
5. **Hardening:** run applicable mutation, race, fuzz, vulnerability, integration, contract, and E2E signals after review. Any governed edit creates a new candidate and review.
6. **Delivery:** repeat affected signals, run the final canonical command, inspect the diff, and report gaps.

Fix the review snapshot with observable Git identity plus the exact worktree diff when dirty. No proprietary attestation is required; the reviewer must stop if source or configuration changes. A crash, timeout, broken setup, missing tool, skipped required stage, or partial artifact is not pass and is not behavioral RED.

## Route failures to their owners

- behavior or functional E2E assertion → `tdd` through development;
- test implementation, sensitivity, race, fuzz, mutation, contract, or flakiness → `test-go-service`;
- pins, native configs, commands, CI, scopes, or ignore rules → `configure-go-quality`;
- E2E setup, readiness, journey, or cleanup → `build-e2e-test-suite`;
- contextual design or semantic finding → development after read-only review.

Do not silence analyzers, lower thresholds, expand exclusions, weaken assertions, add coverage-only calls, or rewrite equivalent syntax to make a tool stop reporting. Prove a false positive or correct the owning behavior/design.

## Select distinct evidence

| Observed change or risk | Additional signal |
|---|---|
| Critical invariant, branch, classification, mapper | Exact declared coverage plus mutation and semantic oracle review |
| Parser, decoder, untrusted input | Bounded fuzz with seeds and invariants |
| Goroutines, channels, lifecycle, shared state | Race plus coordination/shutdown tests |
| Driver, query, broker, serialization, real protocol | Integration or contract suite |
| Substitutable implementations | Shared contract plus technology-specific tests |
| Changed dependency or runtime graph | Pinned compatibility and reachable vulnerabilities |
| Performance requirement | Benchmark/profile against a declared budget |
| Public entry, assembled runtime, observable journey | Canonical E2E |
| Inter-service contract, persistence, real topology | Full-stack or faithful environment when isolated E2E cannot prove it |

A secondary signal must detect a distinct defect class. Policy-declared core assurance applies to every executable candidate: exact 100% critical/core statements, strictly more than 85% overall production statements, non-empty mutation campaigns with no unresolved statuses, and independent semantic tests. These are separate claims.

## Resolve project commands

Inspect instructions, native task surface, configs, and CI to identify the standard gate, hardening command, E2E profiles, and non-executable exceptions. Prefer direct pinned tools and native task dependencies. Generated artifacts remain under ignored paths; native exit codes and diagnostics are authoritative. Do not require installed skills, developer-home configuration, a custom runner, or a proprietary aggregate report.

## Definition of Done

Delivery closes only when:

- discovery proves what existed and why the change verifies, extends, reuses, extracts, replaces, or creates;
- the design lens identifies owner, direct alternative, effects, compatibility, debt, and falsifying evidence;
- every behavioral change has observed discriminating RED→GREEN, or a truthful green-safety-net route;
- boundaries, errors, absence of improper effects, and affected public journeys are proven according to risk;
- configuration readiness is `READY` or product findings have been remediated and reassessed;
- the standard gate passes with repository pins and exact scopes;
- adversarial review has no unresolved in-scope finding;
- every policy- or risk-selected hardening signal passes and every non-applicable signal has a concrete reason;
- final diff has no accidental edits, metric gaming, consumerless abstractions, compatibility debris, or unrelated cleanup;
- commands, scopes, results, setup blockers, and unobserved dimensions are reported honestly.

A required unavailable or blocked signal keeps delivery partial unless the user explicitly accepts that limitation. Passing development gates is not deployment or operational approval.

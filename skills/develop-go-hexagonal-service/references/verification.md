# Verification and Definition of Done

## The gate

A change is done when `railguard verify --changed` passes: gofmt, `go vet`, tests of changed packages, `golangci-lint` on new lines, `go-architecture` boundary checks, race tests, changed-line coverage (100% core, 80% elsewhere), mutation testing on changed lines, `govulncheck` when dependencies change, and E2E. `railguard check --changed` is the lighter subset the Stop hook and git hooks already run automatically. Treat the exit code as the authority on these thresholds; do not re-derive or restate them by hand. Once per module, `railguard verify` without `--changed` also checks the whole-module floor (100% core, 85% overall) and reports pre-existing debt outside the change.

## Route every failure to its owner

- behavior or functional E2E assertion → `tdd` through development;
- test implementation, sensitivity, race, fuzz, mutation, or flakiness → `test-go-service`;
- pins, native configs, commands, CI, scopes, or ignore rules → `configure-go-quality`;
- E2E setup, readiness, journey, or cleanup → `build-e2e-test-suite`;
- contextual design or semantic finding → development, after read-only review.

Never silence an analyzer, lower a threshold, expand an exclusion, weaken an assertion, add a coverage-only call, or rewrite equivalent syntax just to stop a tool reporting. Prove a false positive, or fix the behavior or design behind it.

## Choose signal the gate cannot give you

`railguard verify --changed` proves what it measures; a risk beyond that still needs a deliberately chosen signal that detects a distinct defect class:

| Observed change or risk | Additional signal |
|---|---|
| Critical invariant, branch, classification, mapper | Semantic oracle review beyond the mutation score |
| Parser, decoder, untrusted input | Bounded fuzz with seeds and invariants |
| Goroutines, channels, lifecycle, shared state | Coordination and shutdown tests beyond `-race` |
| Driver, query, broker, serialization, real protocol | Integration or contract suite |
| Substitutable implementations | Shared contract plus technology-specific tests |
| Performance requirement | Benchmark or profile against a declared budget |
| Inter-service contract, persistence, real topology | Full-stack or faithful environment when isolated E2E cannot prove it |

## Fix the reviewed snapshot

Fix the change under review to a Git identity plus the exact worktree diff when dirty; review stops if source or configuration changes underneath it. A crash, timeout, broken setup, missing tool, skipped stage, or partial artifact is not a pass and not behavioral RED.

## Resolve project commands

When a repository lacks `railguard` or layers native gates on top of it, inspect instructions, the native task surface, configs, and CI to find the standard gate, hardening command, E2E profiles, and non-executable exceptions. Prefer direct pinned tools and native task dependencies over a custom runner or a proprietary aggregate report.

## Report honestly

Delivery closes when: discovery states what existed and why the change verifies, extends, reuses, extracts, replaces, or creates; the design-lens answers are recorded; `railguard verify --changed` (or its repository-native equivalent) passes; adversarial review has no unresolved finding; every selected hardening signal has a result; the authorized changed or audited scope has zero unclassified gaps, with no required item left `planned`, `blocked`, or `unavailable` unless the user accepts that named limitation; a block the change created or touched cannot be reclassified as `out_of_scope`, while visible pre-existing gaps stay reported without expanding edit scope; the diff carries no accidental edits, metric gaming, unused abstractions, compatibility debris, or unrelated cleanup; and commands, results, blockers, and unobserved dimensions are reported plainly. A required signal that stays unavailable or blocked keeps delivery partial unless the user explicitly accepts that limit. Passing these gates is not deployment or operational approval.

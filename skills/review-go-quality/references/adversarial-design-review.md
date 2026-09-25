# Adversarial Design Review

## Try to refute the change

Review the diff against requirements, prior code, and current consumers. Ask not "how could this improve?" but "which decision introduces avoidable cost or risk, and what evidence proves a better alternative?"

When possible, give a fresh reviewer only the specification, baseline, diff, and gate results, without the author's defense or expected finding. Without a separate reviewer, perform this pass after closing the change and reconstruct its assumptions from evidence.

## Apply six lenses

**Request alignment.** Trace every requirement, acceptance criterion, explicit constraint, and exclusion to code and evidence. Detect missing behavior, unauthorized added scope, contradictions, and unvalidated assumptions. Verify the requested observable outcome, not merely internal correctness, and do not reinterpret intent or turn optional improvements into requirements.

**Simplicity.** Identify layers, types, branches, configuration, or lifecycle not essential to the requirement. Prefer the smallest direct flow that preserves the contract and hides a relevant decision. Raise complexity only with a demonstrable cost: more states, coupling, API surface, failure paths, or maintenance.

**Reuse.** Search existing capabilities, contracts, and libraries first. Distinguish semantic identity from textual or structural resemblance; share only when current consumers match in meaning, invariants, errors, ownership, and reason for change. Challenge both real duplication and premature abstractions that force distinct consumers to evolve together.

**Modularization.** Evaluate cohesion, dependency direction, exposed API, and change ownership. Detect catch-all modules, mixed responsibilities, and packages, interfaces, or files separated without a stable boundary. Prefer deep modules with narrow APIs over fragmentation by type, endpoint, or pattern.

**Design patterns.** Require the observed problem a pattern solves and compare it with a direct function, composition, or type. Accept a pattern when it reduces current variation or coupling and makes stable policy explicit; reject ceremonial patterns, generic names, and extensibility without consumers.

**Optimization.** Separate obvious algorithm or resource corrections from micro-optimization. Require a benchmark, profile, budget, or observed volume before claiming a performance improvement. Review I/O, limits, pooling, dominant allocations, concurrency, and algorithmic complexity first, and confirm the optimization preserves cancellation, safety, determinism, and behavior.

## Verify evidence integrity

Compare Git identity, exact worktree diff, configs, commands, and artifacts — do not review a moving target or evidence produced for different content. Inspect source-only rewrites made in response to mutation output: a lower mutant count is not remediation unless the behavior or obsolete code actually changed and the delta is explicitly justified. Treat unresolved or engine-limited mutations as visible contextual evidence, never silently killed or excepted, and verify the independent oracle does not reuse the production value under test.

## Convert challenge into evidence

An adversarial finding needs: the exact decision and location; a requirement, consumer, or path proving cost; the minimum architecture-compatible alternative; the impact of keeping the change; and verification distinguishing the options. Discard tastes, preferred patterns, and hypothetical optimization — if the change is already the simplest option satisfying observed contracts, say so without inventing work.

## Hand remediation back to development

Keep the reviewed snapshot immutable. Return validated findings to `develop-go-hexagonal-service`, which selects TDD, `test-go-service`, `configure-go-quality`, or E2E without expanding into adjacent redesign. After a new change exists, reproduce the finding and rerun the affected gates once, not in an unlimited review cycle.

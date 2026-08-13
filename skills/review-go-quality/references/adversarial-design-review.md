# Adversarial Design Review

## Try to refute the candidate

Review the diff against requirements, prior code, and current consumers. Ask not "how could this improve?" but "which decision introduces avoidable cost or risk, and what evidence proves a better alternative?"

When possible, give a fresh reviewer only the specification, baseline, diff, and gate results. Do not disclose the author's defense or expected finding. Without a separate reviewer, perform this pass after closing the candidate and reconstruct its assumptions from evidence.

## Apply six lenses

### Request alignment

- Trace every requirement, acceptance criterion, explicit constraint, and exclusion to code and evidence.
- Detect missing behavior, unauthorized added scope, contradictions, and unvalidated assumptions.
- Verify the requested observable outcome, not merely internal correctness.
- Do not reinterpret user intent or turn optional improvements into requirements without authority.

### Simplicity

- Identify layers, types, branches, configuration, or lifecycle that are not essential to the requirement.
- Prefer the smallest direct flow that preserves the contract and hides a relevant decision.
- Raise complexity only with a demonstrable cost: more states, coupling, API surface, failure paths, or maintenance.

### Reuse

- Search existing capabilities, contracts, and libraries first.
- Distinguish semantic identity from textual or structural resemblance.
- Share only when current consumers match in meaning, invariants, errors, ownership, and reason for change.
- Challenge both real duplication and premature abstractions that force distinct consumers to evolve together.

### Modularization

- Evaluate cohesion, dependency direction, exposed API, and change ownership.
- Detect catch-all modules and mixed responsibilities, as well as packages, interfaces, or files separated without a stable boundary.
- Prefer deep modules with narrow APIs over fragmentation by type, endpoint, or pattern.

### Design patterns

- Require the observed problem a pattern solves and compare it with a direct function, composition, or type.
- Accept a pattern when it reduces current variation or coupling and makes stable policy explicit.
- Reject ceremonial patterns, generic names, and extensibility without consumers.

### Optimization

- Separate obvious algorithm or resource corrections from micro-optimization.
- Require a benchmark, profile, budget, or observed volume before claiming performance improvement.
- Review I/O, limits, pooling, dominant allocations, concurrency, and algorithmic complexity first.
- Confirm optimization preserves cancellation, safety, determinism, and behavior.

### Evidence integrity

- Compare Git identity, exact worktree diff, configs, commands, and artifacts; do not review a moving target or evidence produced for different content.
- Inspect source-only rewrites made in response to mutation output. A lower mutant count is not remediation unless the behavior or obsolete code actually changed and the inventory delta is explicitly justified.
- Treat unresolved or engine-limited mutations as visible contextual evidence, never silently killed or automatically excepted. Verify the independent oracle does not reuse the production value under test.

## Convert challenge into evidence

An adversarial finding needs: exact decision and location; requirement, consumer, or path proving cost; minimum architecture-compatible alternative; impact of keeping the candidate; and verification distinguishing the options.

Discard tastes, preferred patterns, and hypothetical optimization. If the candidate is already the simplest option satisfying observed contracts, say so without inventing work.

## Hand remediation back to development

Keep the reviewed snapshot immutable. Return validated findings to `develop-go-hexagonal-service`, which preserves the original authority and selects TDD, `test-go-service`, `configure-go-quality`, or E2E without expanding into adjacent redesign. After a new candidate exists, repeat the finding reproduction and affected gates, then perform one focused confirmation instead of unlimited review cycles.

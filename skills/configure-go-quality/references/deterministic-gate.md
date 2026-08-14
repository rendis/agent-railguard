# Native Deterministic Go Gates

## Encode only decidable policy

Classify every adopted requirement:

- **Mechanical:** execute a stable command over an explicit scope and fail non-zero with a useful location or diagnostic.
- **Contextual:** give a reviewer evidence and a decision question; do not invent a numeric proxy.
- **Exploratory:** retain seed and input, then promote a useful failure into a deterministic regression.

Every mechanical `MUST` belongs in the repository's native task or CI graph. Skill prose and agent promises are not gates.

## Use the existing task graph

Compose direct tool targets with Make dependencies, Taskfile dependencies, native build tasks, or independent CI jobs. Continue independent checks with the task runner's native capability such as `make -k`; do not implement another DAG, schema, report renderer, fingerprint service, or runner application.

Each producer removes its previous artifact before execution and creates output below an ignored temporary directory. A failed producer invalidates its partial artifact. Consumers depend on the successful producer rather than interpreting stale files. Native exit codes and diagnostics are authoritative; a skill-side summary is optional presentation only.

Canonical commands must run from a clean clone with repository pins and explicit configs. They must not invoke developer-home files, `.agents`, `.codex`, or an installed skill path.

## Compare coverage exactly

Declare production and critical scopes in the repository task surface. For the approved Go service baseline:

- critical/core instrumentable statements: `covered == total`;
- overall governed production statements: `covered * 100 > total * 85`;
- `total == 0` is failure;
- profiles are fresh, generated with fixed tags and `-count=1`;
- tests, tools, generated code, and package-scope changes are explicit.

Parse statement counts from the Go coverage profile or use an approved pinned coverage CLI. Do not compare rounded display percentages. Coverage proves reachability only.

Treat the configured whole-product percentage as a mechanical regression floor. It does not classify uncovered behavior or prove that changed, audited, or critical scopes are semantically complete. Configuration owns the producer command, exact scope, freshness, and numeric decision; testing and review own contextual gap disposition.

## Make mutation verdicts exact

For every adopted campaign:

1. Run a green non-mutated baseline.
2. Use the pinned engine, owned package scopes, fixed workers/test CPU/tags/timeout policy, and all compatible operator families.
3. Write each native machine report below the ignored evidence directory.
4. Require the aggregate governed campaigns to produce at least one mutant.
5. Accept only `KILLED` automatically. Locate and fail every `NOT_VIABLE`, `LIVED`, `NOT_COVERED`, `TIMED_OUT`, `SKIPPED`, runnable, or unfinished mutation. An engine classification is evidence for contextual review, not proof that product behavior was exercised.
6. Report configured operator families separately from those applicable to current syntax; never change source merely to increase operator diversity.

Use the engine's native exit code when it expresses this decision exactly. Otherwise query its native structured output with a maintained, centrally available pinned JSON CLI. Do not add a consumer-repository mutation ledger or generic checker source.

An engine limitation remains visible and outside the repository's automatic pass logic. When the pinned engine cannot schedule one exact semantically testable mutant, an agent may use the narrow supplemental proof owned by `test-go-service` in a caller-marked disposable checkout. Keep the native report and exit code unchanged. The skill-side aggregate may return `SATISFIED_WITH_PROVED_TOOL_LIMITATION` only when every native unresolved mutant has its own successful exact proof and no other native failure exists; otherwise return `FAILED` or `BLOCKED_SETUP`. Never call the mutant killed, silently remove it, or create a universal exception. Improve or replace the engine when CI itself requires an automated exception model.

Prefer independently expressed behavioral oracles and preserve clear idiomatic source. Do not prohibit operators or rewrite an expression merely to make a mutant disappear. A semantically equivalent representation is acceptable only when its public boundaries, errors, and discriminating evidence remain unchanged.

## Preserve replicability, not byte identity

Formatting, module verification, static analysis, exact coverage counts, and fixed regression suites should give pure deterministic verdicts for the same snapshot and environment. Race, bounded fuzz, mutation ordering, timings, logs, and E2E traces may contain noise; require the same verdict class, scope, seed or budget, and invariants rather than identical bytes.

Version only the inputs needed to reproduce the decision. Store coverage, mutation output, fuzz artifacts, logs, traces, reports, and temporary fixtures under ignored paths or as CI artifacts.

# Advanced Go Testing

## Fuzzing, race, and benchmarks

- Use fuzzing for parsers, decoders, mappers, validators, and formats with hard-to-enumerate combinations. Keep representative seeds and assert invariants such as no panic, round-trip, stable classification, bounds, or absence of loss. Turn useful crashes into regression cases. Run bounded fuzzing during development and the CI budget when configured; report the explored scope exactly.
- Run `go test -race` over genuinely exercised concurrent paths when goroutines, channels, caches, lifecycle, or shared state change. It observes only reached executions and does not replace coordination or shutdown tests.
- Add benchmarks for a concrete performance decision with a reproducible dataset, metrics, and baseline. Use repository-pinned comparison tooling such as `benchstat` when present, optimize only from repeatable measurements, and keep a separate functional signal.

## Mutation testing

Apply mutation to a stable suite to expose insensitive assertions and unobserved branches:

1. Confirm normal tests pass and the scope contains mutable owned logic.
2. Detect repository-versioned tooling and configuration first.
3. When editable hardening is authorized and tooling is absent, compare maintained options, licensing, compatibility, cost, effective stable version, release and commit recency, archive state, issue and pull-request activity, supported Go version, SemVer policy, and pinning. Prefer Gremlins for a new Go service only while that evidence remains favorable; its `0.x` series does not guarantee minor-version compatibility.
4. Keep native configuration separate from production code and reports below ignored temporary paths. Never use `latest`. When the adopted technique lacks a pinned repository command or configuration, return that need to the development owner, which composes `configure-go-quality` in `Apply` or `Repair`; do not load a sibling workflow recursively. Resume test evidence only after readiness is validated.
5. Bound packages, files, and time; exclude tests, generated code, dependencies, and trivial glue. Enable every compatible operator family supported by the pinned engine and report which families were actually applicable; do not demand syntax solely to increase diversity.
6. Run the non-mutated baseline, then an informative campaign with fixed canonical workers, test CPU, tags, and timeout policy. Infrastructure timeouts invalidate the baseline, while excessive timeout may hide mutated loops. Never claim universal optimality.
7. Classify every `LIVED`, `NOT COVERED`, `TIMED OUT`, `SKIPPED`, or unfinished result as a test gap, possible equivalent, dead code, tool limitation, or infrastructure issue. Treat only configured terminal resolved states as automatic pass; contextual classifications remain visible and cannot silently turn the native gate green.
8. Reject an aggregate campaign with zero produced mutants as absent sensitivity evidence; do not confuse that with an individual operator family being legitimately inapplicable.
9. Improve tests by behavior, not call counts or score alone; remove dead code when authorized.
10. Record scope, tool, version, total, killed, lived, uncovered, timed out, efficacy, exclusions, and maintenance or versioning risk.
11. Use native exit codes plus the repository-pinned structured-output query as the blocking decision; a raw efficacy percentage never overrides an unresolved mutant. Revalidate health, operator names, and compatibility before each minor upgrade of a `0.x` tool.

### Prove a native scheduling limitation without changing valid source

Use `scripts/mutation-sensitivity` only when the pinned engine reports an exact semantically testable mutant but cannot schedule it and its current CLI and source expose no native execution path. Preserve the native status and production representation. Do not ban valid syntax such as `<<` or `>>`; tool analyzability breaks a tie only between representations that are equally clear, idiomatic, and behaviorally equivalent.

Prepare one explicit unified patch and a caller-owned disposable checkout. Prefer a detached linked worktree and run `go run <skill-root>/scripts/mutation-sensitivity prepare -checkout <worktree>`. When the sandbox cannot update source-repository worktree metadata, create a standalone local clone, overlay the governed working-tree content without `.git`, and run `prepare -checkout <clone> -source <authoritative-checkout>`; the helper requires both repositories at the same HEAD. Preparation writes `.mutation-sensitivity-disposable` and returns the governed hash. Then run the helper with that same `-expected-hash`, the patch, a mutant compile command, a focused `go test -json` command, the exact test name, and an ignored output path outside the checkout. Accept `PROVED_BY_SENSITIVITY` only when this command exits zero, the baseline is green, the patch applies exactly, the mutant compiles, the named behavioral test fails, the reverse patch succeeds, and the final hash equals the initial hash. A surviving or non-compiling mutant is `UNRESOLVED`; absent disposable authority or snapshot mismatch is `BLOCKED_SETUP`. A different mutation route remains diagnostic evidence, not this proof.

Keep the helper report in an ignored per-run path. It is supplemental agent evidence, not a mutation engine, repository gate, exception ledger, inventory, or persistent disposition. Never relabel native `NOT COVERED` as `KILLED`.

In read-only review or without dependency authority, do not install or modify the module; report `unavailable` or `not evaluated` and propose reproducible adoption. Use affected or diff scope for frequent feedback and complete campaigns periodically when automated.

## Lifecycle and flakiness

- Test closure of goroutines, bodies, timers, servers, and resources under success, error, cancellation, and timeout. Prefer observable signals and bounded deadlines over sleeps; use leak detectors only when pinned by the project.
- Reproduce flakiness with seed, repetition, and evidence. Replace sleeps with readiness or bounded polling; isolate clocks, randomness, ports, and data. Change timeouts only after identifying the condition. Use retries solely as visible diagnosis and preserve the first failure and every attempt.

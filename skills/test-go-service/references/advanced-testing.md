# Advanced Go Testing

`railguard verify --changed` already runs race tests, bounded fuzz cases, and a Gremlins mutation campaign on changed lines, failing on any `LIVED` or `NOT_COVERED` mutant. This reference covers the judgment those runs still need: which paths deserve the probe, and how to read an unresolved result.

## Fuzzing, race, and benchmarks

- Fuzz parsers, decoders, mappers, validators, and formats with hard-to-enumerate combinations. Keep representative seeds and assert invariants such as no panic, round-trip, stable classification, bounds, or no loss. Turn a useful crash into a regression case.
- Concurrent paths (goroutines, channels, caches, lifecycle, shared state) need genuine exercise, not just the race flag — a race detector only observes what the test actually reaches.
- Add benchmarks for a concrete performance decision with a reproducible dataset and baseline. Use repository-pinned comparison tooling (e.g. `benchstat`) and keep a separate functional signal.

## Reading a mutation result

Gremlins is `0.x`: its SemVer does not guarantee minor-version compatibility. Before adopting it and before each minor upgrade, recheck release recency, archive state, issue and pull-request activity, supported Go version, and operator names.

Only `KILLED` is an automatic pass. Classify every other result with code-level reasoning — never add an assertion that exposes an implementation detail merely to move the score:

- `LIVED`: test gap, semantically equivalent mutation, or dead code;
- `NOT COVERED`: reachability gap or wrong scope;
- `TIMED OUT`: mutant loop, flaky test, or bad timeout calibration;
- `SKIPPED`/unfinished: incomplete campaign;
- `NOT VIABLE`: compilation rejected the mutation — an engine limitation, not equivalence or a kill.

A campaign that produces zero mutants supplies no sensitivity evidence; treat it as a scope or applicability problem, never `0/0` perfect efficacy. Improve tests by behavior, not by call count or score alone, and never rewrite clear production syntax just to make a mutant disappear or to raise an operator-diversity count — report which operator families were actually exercised, since source without a loop or bitwise expression legitimately produces none from those families.

Missing pins, config, or a canonical command for mutation is a gap owned by `configure-go-quality` (`Apply`/`Repair`), not something to work around locally.

## Prove a native scheduling limitation without changing valid source

Use `scripts/mutation-sensitivity` only when the pinned engine reports an exact, semantically testable mutant it cannot schedule, and no native CLI/source path can run it. Do not ban valid syntax such as `<<`/`>>` — tool analyzability breaks a tie only between representations that are equally clear and behaviorally equivalent.

Prepare one explicit unified patch and a caller-owned disposable checkout (prefer a detached linked worktree):

```sh
go run <skill-root>/scripts/mutation-sensitivity prepare -checkout <worktree>
```

If the sandbox cannot update worktree metadata, create a standalone clone, overlay the working-tree content without `.git`, and run `prepare -checkout <clone> -source <authoritative-checkout>` (both repositories at the same HEAD). Preparation writes `.mutation-sensitivity-disposable` and returns the governed hash. Then run the helper with that `-expected-hash`, the patch, a mutant compile command, a focused `go test -json` command, the exact test name, and an ignored output path. It exits `PROVED_BY_SENSITIVITY` only when the baseline is green, the patch applies exactly, the mutant compiles, the named test fails, the reverse patch succeeds, and the final hash equals the initial hash. A surviving or non-compiling mutant is `UNRESOLVED`; missing disposable authority or a hash mismatch is `BLOCKED_SETUP`.

Keep the helper report in an ignored per-run path — it is supplemental evidence, not a mutation engine, gate, or persistent exception. Never relabel a native `NOT COVERED` as `KILLED`. In read-only review, or without dependency authority, report `unavailable`/`not evaluated` and propose reproducible adoption instead.

## Lifecycle and flakiness

- Test closure of goroutines, bodies, timers, servers, and resources under success, error, cancellation, and timeout. Prefer observable signals and bounded deadlines over sleeps; use a leak detector only when the project already pins one.
- Reproduce flakiness with seed, repetition, and evidence. Replace sleeps with readiness polling; isolate clocks, randomness, ports, and data. Change a timeout only after identifying the condition. Use retries solely as visible diagnosis, and preserve the first failure and every attempt.

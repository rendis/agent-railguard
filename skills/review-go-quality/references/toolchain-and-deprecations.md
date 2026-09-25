# Toolchain and Deprecations

## Evidence states

Every skill in this repository reports one of these states for a claimed dimension — this is the single definition; other files point here instead of restating it.

| State | Meaning |
|---|---|
| pass | The command ran over the declared snapshot and scope and completed successfully |
| fail | The command ran and reported defects or an execution/configuration error |
| not evaluated | The dimension was not run or does not apply |
| unavailable | An applicable tool or prerequisite is not reproducibly accessible |

Keep `unavailable` and `not evaluated` distinct from `pass`.

## Consume reproducible gates

- Prefer `railguard check --changed` and `railguard verify --changed`: they already run gofmt, `go vet`, changed-package tests, `golangci-lint` on new lines, `go-architecture`, race, changed-line coverage, mutation, `govulncheck`, and E2E over a pinned, reproducible configuration.
- Run any additional tool only against the fixed snapshot, without mutating the module, task surface, configuration, or dependency graph, and record its version, effective configuration, packages, flags, exit code, and relevant environmental constraints.
- An unpinned global binary may provide local diagnosis, but it cannot prove a reproducible gate.
- When configuration state is unclear enough to affect a claim, consume `configure-go-quality` in `Assess` mode — it owns adoption, pins, profiles, migration, and analyzer de-duplication; review owns interpretation.

## Interpret signals beyond the harness

- `go test` proves behavior only for executed paths and assertions; `go vet` supplies heuristic diagnostics, not a correctness proof; `go test -race` detects races only in concurrency paths the run executes.
- Inspect `golangci-lint`'s effective linters, exclusions, tests setting, version, and scope before attributing a result to it, and consolidate overlapping diagnostics under one cause — do not report the same Staticcheck, `gosec`, or `gocritic` result twice.
- `govulncheck` reports vulnerability reachability from module and package graphs; keep its evidence distinct from lint.
- `go-metrics` complexity values are descriptive candidates; do not add or require a second complexity gate merely to confirm a number.

## Review deprecations

Use Staticcheck SA1019 or an existing configured equivalent. Confirm the symbol is reached in the reviewed scope, inspect the authoritative replacement documentation for the effective dependency version, and evaluate compatibility and migration impact. When no reproducible analyzer is available, inspect `Deprecated` comments in touched APIs as partial evidence, mark automated coverage unavailable, and do not claim a clean pass.

## Review vulnerabilities and failures

Distinguish a reachable vulnerability, a vulnerable but unexercised dependency, an outdated version, and unavailable advisory evidence. Record whether test binaries were included, and respect network, cache, privacy, and source constraints.

A crash, timeout, invalid configuration, non-compiling package, or unavailable advisory source is not a clean result. Classify it from the cause, preserve the first useful diagnosis, and repeat only after the snapshot or cause changes.

# Toolchain and Deprecations

## Evidence states

| State | Meaning |
|---|---|
| pass | The command ran over the declared snapshot and scope and completed successfully |
| fail | The command ran and reported defects or an execution/configuration error |
| not evaluated | The dimension was not run or does not apply |
| unavailable | An applicable tool or prerequisite is not reproducibly accessible |

Keep `unavailable` and `not evaluated` distinct from `pass`.

## Consume reproducible gates

- Run only tools available to the fixed snapshot without mutating the module, task surface, configuration, or dependency graph.
- Prefer repository-owned pinned commands and record version, effective configuration, packages, flags, exit code, and relevant environmental constraints.
- An unpinned global binary may provide explicitly local diagnosis, but it cannot prove a reproducible gate.
- When configuration state is unclear enough to affect a claim, consume `configure-go-quality` in `Assess` mode. That skill owns adoption, pins, profiles, migration, and analyzer de-duplication; review owns interpretation.

## Interpret standard signals

- `gofmt -l` reports formatting differences; expect no output for a passing declared scope.
- `go test` proves behavior only for executed paths and assertions.
- `go vet` supplies heuristic diagnostics, not a correctness proof.
- `go test -race` detects races only in concurrency paths the run executes.
- configured `golangci-lint` aggregates analyzers; inspect its effective linters, exclusions, tests setting, version, and scope before attributing a result.
- `govulncheck` reports vulnerability reachability from module and package graphs; keep its evidence distinct from lint.

Consolidate overlapping diagnostics under one cause. Do not report the same Staticcheck, `gosec`, or `gocritic` result twice when the configured aggregator already produced it. `go-metrics` complexity values are descriptive candidates; do not add or require a second complexity gate merely to confirm a number.

## Review deprecations

Use Staticcheck SA1019 or an existing configured equivalent. Confirm the symbol is reached in the reviewed scope, inspect the authoritative replacement documentation for the effective dependency version, and evaluate compatibility and migration impact. When no reproducible analyzer is available, inspect `Deprecated` comments in touched APIs as partial evidence, mark automated coverage unavailable, and do not claim a clean pass.

## Review vulnerabilities and failures

Distinguish a reachable vulnerability, a vulnerable but unexercised dependency, an outdated version, and unavailable advisory evidence. Record whether test binaries were included. Respect network, cache, privacy, and source constraints.

A crash, timeout, invalid configuration, non-compiling package, or unavailable advisory source is not a clean result. Classify it from the cause, preserve the first useful diagnosis, and repeat only after the snapshot or cause changes.

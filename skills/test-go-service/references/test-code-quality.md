# Test Code Quality

## Separate implementation from sensitivity

Evaluate two independent dimensions:

- **Test implementation:** compilable, idiomatic, readable, deterministic code without unsafe patterns or defective helpers.
- **Suite sensitivity:** ability to fail on the relevant defect or behavior change, demonstrated through useful RED, mutation, negative cases, fuzz, race, or contracts according to risk.

Clean lint does not prove sensitivity, and a mutation score does not make test code maintainable.

## Use the configured aggregator

- Run repository-pinned `golangci-lint` with test analysis enabled.
- Consume `staticcheck`, `gosec`, and `gocritic` through that aggregator; do not duplicate standalone binaries over the same version and scope.
- Enable `thelper` for required `t.Helper()` and `usetesting` for testing primitives covering temporary paths, environment, and lifecycle.
- Add `testifylint` only with Testify. Add `tparallel` or `paralleltest` only after agreeing on parallelism and proving isolation.
- Keep `govulncheck` separate. Use `-test` only as an explicit additional scope for vulnerabilities reachable from test binaries.

Name each entry point by observable behavior and condition. In tables, distinguish contractual variations and use role-based fields such as `wantOutcome` and `wantErr`. Give helpers and doubles responsibility-based names such as `recordingStockUpdater` or `failingReceiver`; use Stub, Fake, or Spy only when accurate. Apply [go-test-style.md](go-test-style.md); comments and GoDoc remain optional unless they add contract information or repository policy adopts them.

Report command, version, `_test.go` scope, exit code, and effective linters. An absent analyzer is `unavailable`, not `pass`. Consolidate overlapping diagnostics under one cause and fix behavior or design rather than merely suppressing the message.

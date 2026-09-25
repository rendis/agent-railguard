# Test Code Quality

## Separate implementation from sensitivity

Evaluate two independent dimensions:

- **Test implementation:** compilable, idiomatic, readable, deterministic code without unsafe patterns or defective helpers.
- **Suite sensitivity:** ability to fail on the relevant defect or behavior change, demonstrated through useful RED, mutation, negative cases, fuzz, race, or contracts according to risk.

Clean lint does not prove sensitivity, and a mutation score does not make test code maintainable.

## Use the configured aggregator

`golangci-lint` (via `railguard check`/`verify`) covers `staticcheck`, `gosec`, and `gocritic` over test code too — do not run standalone binaries over the same scope. Test-specific analyzers worth enabling: `thelper` for required `t.Helper()`, `usetesting` for temp paths/environment/lifecycle primitives, `testifylint` with Testify, and `tparallel`/`paralleltest` only after agreeing on parallelism and proving isolation. An absent analyzer is `unavailable`, not a pass; a missing pin is a `configure-go-quality` gap.

Name each entry point by observable behavior and condition. In tables, use role-based fields such as `wantOutcome`/`wantErr`. Give helpers and doubles responsibility-based names such as `recordingStockUpdater` or `failingReceiver`; use Stub, Fake, or Spy only when accurate (see [go-test-style.md](go-test-style.md)).

Consolidate overlapping diagnostics under one cause and fix behavior or design rather than suppressing the message.

# Go Quality Profiles

## Start from an owned baseline

[default-go-service-profile.md](default-go-service-profile.md) is the generic `railguard check`/`verify` baseline. Preserve any stronger valid policy by selecting its managed profile and exact inputs — a profile is a reproducible decision surface, not a wish list of tools. Every additional signal needs:

- a named defect class and governed source scope;
- a repository-owned pin or standard Go command, with native configuration and a non-zero decision rule;
- a local or CI consumer at proportional cost;
- an owner that can materialize and repair its files and commands.

Missing any of these means the profile stays unselected and is reported `MISSING` — never inferred from a generic quality request.

## Selecting extensions

- **Lint, security:** `verification-profile:go-assurance` adds golangci-lint on changed lines and `govulncheck` on dependency changes. See [tool-policy.md](tool-policy.md) for analyzer composition and thresholds.
- **Coverage:** the changed-line coverage bars in `go-assurance` are mechanical; configuration's job is declaring which packages count as core vs. everything else, not re-deriving the percentage. Readiness such as `READY`/`READY_WITH_FINDINGS` proves reproducible inputs and execution, never semantic test completeness (see [deterministic-gate.md](deterministic-gate.md)).
- **Concurrency, fuzz, mutation:** race runs inside the baseline `verify`. Select `verification-profile:go-fuzz` only for named seeded invariants with a bounded budget, and `verification-profile:go-mutation` only after a stable suite and explicit owned scopes.
- **E2E and full-stack:** select `verification-profile:go-e2e` with the E2E owner's public packages, harness, readiness, and cleanup already in place. `BLOCKED_SETUP` from E2E is an acceptance state owned by `build-e2e-test-suite`, not a configuration-readiness failure.
- **SonarQube:** when adopted, require the actual SonarQube Quality Gate to complete and pass in CI (see [deterministic-gate.md](deterministic-gate.md)). Local analyzers are preflight evidence, never server parity.
- **Specialized extensions** (benchmarks, database checks, licenses, architecture rules): add only with an observed defect class or policy consumer, at cost proportional to the evidence it adds beyond the baseline.

## Keep profiles honest

Use repository-native tasks and native exit codes; store volatile evidence under ignored paths. No profile decides whether an abstraction is necessary, a name is unambiguous, or a test oracle is independent — those stay contextual review decisions for `test-go-service` and `review-go-quality`.

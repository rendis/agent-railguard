# Go Quality Profiles

## Start from an owned baseline

The generic AI Harness baseline is the managed `make check` and `make verify` contract in [default-go-service-profile.md](default-go-service-profile.md). Preserve any stronger valid repository profile and its existing task owner. A profile describes a reproducible decision surface, not a universal list of tools.

Every additional signal requires:

- a named defect class and governed source scope;
- a repository-owned pin or standard Go command;
- native configuration and a non-zero decision rule;
- a local or CI consumer and proportional execution cost;
- an owner that can materialize and repair its files and commands.

If one item is absent, report the capability as not adopted or `MISSING`; do not infer it from a generic quality request.

## Add extensions by evidence

### Lint, security, and documentation

Use one pinned `golangci-lint` configuration for compatible analyzers over production and tests. Run `govulncheck` separately for reachable dependency vulnerabilities. Mechanical exported-contract rules may use a maintained GoDoc linter; semantic naming and documentation remain review decisions.

### Coverage assurance

Adopt coverage thresholds only from explicit repository policy or an approved advanced baseline. Declare production and critical scopes, generate fresh profiles, compare integer statement counts, and keep reachability distinct from oracle quality.

Treat an adopted overall threshold as a mechanical regression floor. Configuration readiness such as `READY` or `READY_WITH_FINDINGS` proves reproducible inputs and execution, not semantic test completeness or closure of individual uncovered blocks. Return those blocks to testing and review without changing the configured threshold.

### Concurrency, fuzz, and mutation

Run race only over suites that exercise concurrency. Fuzz selected invariants with seeds and a bounded budget. Adopt mutation only after a stable normal suite and explicit owned scopes; require a non-empty campaign and fail every unresolved native status.

### E2E and full-stack execution

Reuse the E2E owner's public journey, harness, readiness, cleanup, and command. Select a full-stack profile only for an explicit request, adopted acceptance policy, or distinct topology risk. E2E `BLOCKED_SETUP` remains an acceptance state, not configuration readiness.

### Specialized extensions

Benchmarks, database checks, licenses, architecture rules, and other analyzers require an observed defect class or policy consumer. Each extension must add evidence unavailable from the baseline at proportional cost.

## Keep profiles honest

Use repository-native tasks and native exit codes. Store volatile evidence under ignored paths. No profile can decide whether an abstraction is necessary, a name is unambiguous, documentation is useful, or a test oracle is independent; those remain contextual review decisions.

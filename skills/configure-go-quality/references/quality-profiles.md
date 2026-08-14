# Go Quality Profiles

## Start from an owned baseline

The generic AI Harness baseline is the managed `make check` and `make verify` contract in [default-go-service-profile.md](default-go-service-profile.md). Preserve any stronger valid policy by selecting its managed profiles and exact inputs. A profile describes a reproducible decision surface, not a universal list of tools.

Every additional signal requires:

- a named defect class and governed source scope;
- a repository-owned pin or standard Go command;
- native configuration and a non-zero decision rule;
- a local or CI consumer and proportional execution cost;
- an owner that can materialize and repair its files and commands.

If one item is absent, leave the profile unselected or report it as `MISSING`; do not infer it from a generic quality request. Selected profiles contribute only namespaced implementation targets. Callers and CI use the same public `check` and `verify` commands.

## Add extensions by evidence

### Lint, security, and documentation

Use one pinned `golangci-lint` configuration for compatible analyzers over production and tests. Run `govulncheck` separately for reachable dependency vulnerabilities. Mechanical exported-contract rules may use a maintained GoDoc linter; semantic naming and documentation remain review decisions.

For explicitly adopted strict AI-generated code assurance, select `verification-profile:go-assurance` and use the bundled analyzer policy with governed suppressions. Apply per-function complexity and local duplicate, repeated-literal, and unfinished-work rules; never replace them with a repository-total score. These analyzers reduce predictable defects but do not reproduce SonarQube rule or duplication engines.

### Coverage assurance

Adopt coverage thresholds only from explicit repository policy or an approved advanced baseline. Declare production and critical scopes, generate fresh profiles, compare integer statement counts, and keep reachability distinct from oracle quality.

Treat an adopted overall threshold as a mechanical regression floor. Configuration readiness such as `READY` or `READY_WITH_FINDINGS` proves reproducible inputs and execution, not semantic test completeness or closure of individual uncovered blocks. Return those blocks to testing and review without changing the configured threshold.

### Concurrency, fuzz, and mutation

Run race through the baseline delivery operation. Select `verification-profile:go-fuzz` only for named seeded invariants with a bounded budget. Select `verification-profile:go-mutation` only after a stable normal suite and explicit owned scopes; require a non-empty campaign and fail every unresolved native status.

### E2E and full-stack execution

Select `verification-profile:go-e2e` with the E2E owner's public packages, harness, readiness, and cleanup. Run full-stack topology directly or through a future separate managed profile only for an explicit request, adopted acceptance policy, or distinct topology risk. E2E `BLOCKED_SETUP` remains an acceptance state, not configuration readiness.

### SonarQube delivery

When SonarQube is adopted, require the actual SonarQube Quality Gate to complete and pass in the CI delivery graph. Preserve the analyzed revision and observed gate identity/status. Local lint, coverage, duplication, or complexity results are complementary preflight evidence and cannot be reported as server parity. Server-side profile and gate thresholds require their own authority and reproducible configuration; do not invent them from repository metrics.

### Specialized extensions

Benchmarks, database checks, licenses, architecture rules, and other analyzers require an observed defect class or policy consumer. Each extension must add evidence unavailable from the baseline at proportional cost.

## Keep profiles honest

Use repository-native tasks and native exit codes. Store volatile evidence under ignored paths. No profile can decide whether an abstraction is necessary, a name is unambiguous, documentation is useful, or a test oracle is independent; those remain contextual review decisions.

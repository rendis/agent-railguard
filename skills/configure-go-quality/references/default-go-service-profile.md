# Default Go Service Quality Profile

Use this profile only when the repository has no stronger valid adopted policy. It is a reproducible starting point for Go 1.26 services, not a reason to overwrite project-specific scopes, tags, platforms, or E2E topology.

For a generic request to configure a missing Go service quality environment, treat this as **one adopted baseline**, not a menu of independent suggestions. A signal may be omitted only after recording why it is non-applicable to the observed repository. Do not report `READY` while a required pin, native config, target, scope, ignore rule, or readiness probe from this baseline is absent.

This workflow configures and evaluates the environment; it does not make the current product comply. Stop after preserving the first canonical product diagnostics and classify them as `READY_WITH_FINDINGS`. **Any product or test edit invalidates** an Apply or Repair result, even when the edit would make coverage, mutation, lint, or E2E green. Return that remediation to the development workflow under separate authority.

## Pin the validated tool set

Resolve tools through Go's repository-owned `tool` directives. Do not query `latest` or replace an exact version because the network is unavailable.

Materialize the validated set in one Go module transaction so Minimal Version Selection chooses one coherent build list instead of persisting intermediate partial graphs:

```sh
go get -tool \
  github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.12.2 \
  golang.org/x/vuln/cmd/govulncheck@v1.6.0 \
  github.com/go-gremlins/gremlins/cmd/gremlins@v0.6.0 \
  github.com/itchyny/gojq/cmd/gojq@v0.12.19
```

Do not accept or publish a partial tool set. If this transaction cannot materialize every exact pin and its checksums, configuration remains `MISSING` or `BROKEN`; an absent repository-owned pin is not converted to `BLOCKED_SETUP` merely because dependency access failed. `BLOCKED_SETUP` applies after the reproducibility inputs are complete and a required external execution prerequisite is unavailable.

Copy `../assets/golangci.yml` to `.golangci.yml` and `../assets/gremlins.yaml` to `.gremlins.yaml`, then validate both with the pinned tools. Preserve a stronger valid configuration. Change only evidence-backed source scopes or build tags; never reconstruct a partial configuration, neutralize a gate, or disable a check to fit the current code.

The Gremlins thresholds remain neutral only because the paired native task applies the stricter non-empty and `KILLED`-only decision over its JSON output. Never install that configuration without the paired `mutation-verdict` target.

## Materialize transparent native targets

Read `../assets/Makefile.quality` as the native target baseline and adapt the declared package, source, core, mutation, E2E, fuzz, and full-stack scopes from observed repository evidence; do not reference the installed asset at runtime. When `Makefile` contains the AI Harness marker for `verification.go-quality`, express those targets and scopes as desired configuration for `verification-profile:go-quality` and let the CLI regenerate the owned block after Review. Merge the fragment into an existing Make owner only when that owner is not governed by AI Harness. The fragment is executable configuration, not a repository-local quality application.

Preserve the asset's override contract while adapting scopes. Start from its target bodies and assignment operators exactly, and change only the documented repository scopes or genuinely non-applicable capabilities. In particular, keep environment- or CI-supplied prerequisite knobs such as `VULN_DB` as `?=` defaults; do not replace them with unconditional `:=` or `=` assignments. Fixed tool versions remain repository pins, while execution prerequisites must stay replaceable by an explicit CI environment or command-line value. After materialization, exercise one non-default value to prove the canonical target consumes the override.

Keep `test-race` in the default maintained-service aggregate. Configure `FUZZ_PACKAGE`, `FUZZ_TARGET`, and a bounded `FUZZ_TIME` when a meaningful existing fuzz proof is present. When none exists, retain the failing `test-fuzz` capability probe and classify the missing behavioral proof as a product finding; configure must not invent or edit a fuzz test. Omit the dimension only when observed repository evidence makes it genuinely non-applicable, and include that reason in the final per-dimension assessment.

Leave Go's standard `GOPROXY`, `GOSUMDB`, `GOTOOLCHAIN`, and cache variables to the invoking environment. Do not invent Make aliases such as `GO_PROXY` or `GO_SUM_DB`, and do not prefix canonical recipes with hard-coded Go environment values. Clean-clone CI, private-module consumers, offline proxies, and the poisoned-home probe must all be able to inject the standard variables without editing the Makefile.

When this profile creates or updates CI, use the repository's native aggregate as the single command authority. With the default Make surface, CI invokes `make verify-hardening`; do not reproduce `make check`, vulnerability, race, mutation, and E2E as ordinary sequential steps in one job because the first failure suppresses later evidence. Existing CI may instead use independent jobs only when every dimension still runs after another fails and one final result remains non-zero when any required job failed.

Gremlins v0.6 requires concrete owned directories for report-producing campaigns; do not pass recursive `...` package patterns merely because `go test` accepts them. It has no parser-only configuration command: `--version` and `--help` do not load the selected YAML. Therefore `quality-readiness` proves the pin, owned YAML path, and explicit native command structurally, while one independently observed `mutation` execution is the authoritative proof that the configuration and governed scope work together. Do not add a redundant engine dry-run or substitute a readiness-only fixture for the repository's governed producer.

Make `mutation-run` depend on a fresh green non-mutated `go test -count=1` baseline over the same governed packages. Keep the engine's concrete `MUTATION_SCOPE` separate from `MUTATION_BASELINE_PACKAGES` when Go requires a recursive package pattern; the default pair is `./internal/core` for Gremlins and `./internal/core/...` for `go test`. Keep this prerequisite narrower than the complete `check` target so configuration assessment can still execute and classify mutation independently when an unrelated coverage or lint policy reports a product finding.

A maintained Go service baseline exposes direct targets for:

- formatting check and module verification;
- normal tests, fresh critical/core coverage, fresh overall coverage, vet, and pinned lint;
- a standard `check` target using exact 100% critical/core statements and strictly more than 85% governed production statements;
- `quality-readiness`, which resolves every pin, validates configurations through native parser-only commands where available, checks the Gremlins config path and native producer structurally, verifies ignored evidence paths, and exercises a disposable negative probe;
- reachable vulnerability scan, race over exercised concurrency, bounded fuzz over selected invariants, non-empty mutation campaigns with only `KILLED` automatically accepted, and applicable isolated E2E;
- a hardening aggregate that invokes the existing native targets with Make's keep-going behavior, observes every independent dimension even after an earlier failure, and exits non-zero when any target fails.

Put coverage, mutation JSON, fuzz output, logs, and reports below ignored `tmp/` paths. Remove a previous artifact before its producer and leave no final artifact after producer failure. Canonical targets must call `go tool <name>` with explicit configs and must not reference a skill path or global binary.

Configuration is complete only when all four pins resolve, every available native parser-only validator succeeds, `make quality-readiness` succeeds, `make -n check verify-hardening` resolves the complete task graph, ignored evidence paths are proven, the negative probe fails for the expected analyzer, and every applicable direct dimension—including the real `mutation` producer—has been observed once. A version probe establishes pin resolution only; it does not validate Gremlins YAML or prove the corresponding product scan passed. Keep wiring/readiness probes separate from real product gates: do not make `quality-readiness` depend on `check`, vulnerability, race, fuzz, mutation, or E2E merely to prove that those gates were later executed. Prove a prerequisite override is consumed with the native command surface, then execute the real direct target independently and classify its first observed result.

After readiness, run every applicable canonical dimension once to classify the environment: execute `make check`, execute `make vuln`, and execute the configured race, fuzz, mutation, and E2E targets independently or with the task runner's keep-going mode. A dry run or version probe is not a substitute for executing the real governed command. Preserve each first result without retrying or remediating product/tests. Enumerate every baseline dimension in the final assessment as passed, product finding, blocked prerequisite, or non-applicable with evidence; absence is not a result. Any unavailable required prerequisite makes the final state `BLOCKED_SETUP`, which takes precedence over simultaneous product findings.

Do not reconstruct a partial target set from memory. After the CLI regenerates an AI Harness block or the fragment is merged into an unmanaged owner, require make -n test-race test-fuzz to resolve and inspect the expanded make -n verify-hardening output for both -race and -fuzz. Missing wiring is incomplete configuration even when the repository has no existing fuzz function; retain the capability probe so its first direct result can be classified honestly.

## Adapt by evidence

Discover production, critical/core, mutation, fuzz, race, and E2E scopes from the repository. An absent meaningful fuzz target or E2E journey is an explicit non-applicable or missing-capability result, not permission to invent a dummy check. Configuration is `READY_WITH_FINDINGS` when these reproducibility inputs execute and product checks fail; do not repair the product from this skill. If a required external prerequisite such as the vulnerability database, Docker, credentials, or a platform capability cannot be exercised, finish the reproducibility inputs and return `BLOCKED_SETUP` with the exact unobserved signal—never `READY`.

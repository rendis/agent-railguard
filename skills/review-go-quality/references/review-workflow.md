# Go Review Workflow

## Fix the scope

Choose and declare one: worktree changes, commit or range, merge base with a branch, concrete paths, or the complete repository for a baseline. Capture the SHA or initial state. Stop and fix it again if the comparison point changes.

## Read authority

Read applicable instructions, acceptance criteria, contracts, ADRs, documentation, and tests. Separate two questions:

1. Does the change satisfy the specification without breaking behavior?
2. Is the implementation safe, simple, and maintainable?

Turn an observation into a requirement only when supported by authority or demonstrable impact.

## Run mechanical gates

Reuse observed results only for the same snapshot, command, and scope. Use project-established commands for absent or invalidated evidence. As a Go fallback, consider from narrow to broad: `gofmt -l` on changed files; `go test` and `go vet` on affected packages; the project task surface or CI suite; `go test -race` for executed concurrency; and pinned vulnerability, deprecation, and lint analyzers.

If the review concerns an `Apply` or `Repair` candidate or a configuration-readiness classification, use `configure-go-quality` in read-only `Assess` mode once to resolve its state contract. Otherwise use it only when the effective configuration is missing, invalid, inherited, unpinned, or unclear enough to affect a claim. Record the resulting limitation; do not repair tooling or change the fixed snapshot. A valid pinned canonical gate with no readiness claim needs no separate configuration load.

Inspect the repository-native task graph and direct pinned commands. Require explicit configs and scopes, fresh producer artifacts, and non-zero failure semantics. A failed test, mutation, scanner, or E2E producer invalidates its partial output even when a file exists. Native tool output or retained CI logs are sufficient evidence; a proprietary aggregate schema, runner, attestation, or skill-installed command is neither required nor preferred. Record command, version, exit code, scope, and artifact path, and diagnose before repeating.

Before reporting a missing mutation oracle, search the complete relevant test corpus by behavior, unit, boundary, error, and outcome—not only by the mutated symbol or the nearest test. Read the whole matching test, then run the narrow named test when a broad package command is blocked by unrelated setup. An independent oracle is stronger when it derives the expected boundary from the external contract and does not reference the production constant or helper. Do not infer a test gap merely because the mutation engine cannot instrument a compile-time expression or because another test in the package needs unavailable infrastructure.

Verify the candidate's claimed outcome against those results. For a configuration candidate, apply `configure-go-quality`'s state precedence to the whole adopted surface: a passing wiring/readiness subtarget cannot turn an unavailable required real dimension into `READY` or `READY_WITH_FINDINGS`. A supported `BLOCKED_SETUP`, `unavailable`, or `not evaluated` dimension is an honest limitation, not a defect in otherwise correct configuration or code. Record it separately and pass the review when no actionable candidate defect remains. Issue a finding only when the candidate caused the blocker, could resolve it within its granted authority, omitted or misclassified it, or claimed stronger evidence than was observed.

Judge configuration evidence as a complete set, not by forcing every product gate into one readiness recipe. A wiring target may validate pins, configs, isolation, task resolution, overrides, and negative probes while the same snapshot's direct `check`, vulnerability, race, fuzz, mutation, and E2E commands provide the execution evidence used by the classifier. Do not report a missing readiness dependency when the canonical direct command was independently observed with the relevant override. Do report a baseline dimension that is neither executed nor explicitly classified as non-applicable, a dry/version probe presented as product evidence, or an override that the real recipe does not consume.

Preserve the ownership boundary when a configuration-only candidate exposes an absent behavioral proof. If the repository now has a pinned, reachable direct target, the aggregate retains it, its stable non-zero diagnostic says that no meaningful fuzz test or E2E journey exists, and the candidate reports that exact result as `READY_WITH_FINDINGS`, the configuration has done its job. The missing test or journey belongs to development/testing; configure is forbidden to invent it. Do not call this broken wiring, recommend deleting the failing target, or demand that CI turn green. A configuration finding exists only when the command itself is invalid, unreachable, unpinned, silently omitted, mis-scoped, non-deterministic by design, or misclassified.

## Review from architecture to detail

1. Complete traceability of request, acceptance, constraints, and exclusions.
2. Public contracts and persistence.
3. Dependency direction and layer ownership.
4. Correctness, errors, cancellation, and timeouts.
5. Concurrency, lifecycle, and idempotency.
6. Security, sensitive data, and dependencies.
7. Simplicity, semantic reuse, modularization, and real pattern need.
8. Evidence-based optimization, APIs, naming, and tests.

Use `go-metrics` to locate outliers. Read the code before turning a metric into a finding.

## Reduce false positives

For every candidate, verify the exact line, demonstrate an observable path or cost, confirm it is in scope, search for a test or contract that invalidates it, distinguish a current defect from an optional improvement, and remove preferences without impact. Make a second reading from the author's perspective. Report only findings whose correction can be verified through a test, command, or concrete contract inspection.

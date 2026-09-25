# Go Review Workflow

## Fix the scope

Choose and declare one: worktree changes, commit or range, merge base with a branch, concrete paths, or the complete repository for a baseline. Capture the SHA or initial state, and fix it again if the comparison point changes.

## Read the requirements

Read applicable instructions, acceptance criteria, contracts, ADRs, documentation, and tests. Separate two questions: does the change satisfy the specification without breaking behavior, and is the implementation safe, simple, and maintainable? Turn an observation into a requirement only when supported by a stated contract or demonstrable impact.

## Run the mechanical gate

Run `railguard verify --changed` (or `check --changed` for the lighter subset) as the primary mechanical gate — gofmt, vet, tests of changed packages, lint on new lines, `go-architecture` boundaries, race, changed-line coverage, mutation, `govulncheck`, and E2E. Reuse observed results only for the same snapshot, command, and scope; run project-native commands for anything the harness doesn't cover, and record command, version, exit code, scope, and artifact path per [toolchain-and-deprecations.md](toolchain-and-deprecations.md)'s evidence states. A failed test, mutation, scanner, or E2E producer invalidates its partial output even when a file exists.

If the change is an `Apply`/`Repair` configuration change, or claims a readiness classification, load `configure-go-quality` in `Assess` mode once — it owns that state contract; do not re-derive it here. Otherwise load it only when the effective configuration is missing, invalid, inherited, unpinned, or unclear enough to affect a claim. A valid pinned canonical gate with no readiness claim needs no separate configuration load. Verify the change's claimed outcome against the observed results; a supported `BLOCKED_SETUP`/`unavailable`/`not evaluated` dimension is an honest limitation, not a defect, unless the change caused it, could have resolved it, misclassified it, or claimed stronger evidence than was observed.

When Step 4's coverage-review branch applies, use `test-go-service`'s gap-analysis contract, matching the fresh profile to the snapshot, producer command, module, tags, `coverpkg`, and owning test packages before interpreting it. A passing percentage does not close an unclassified in-scope block. Treat a task-local parser as report-only: repository commands and configuration must never depend on its installed path.

Before reporting a missing mutation oracle, search the complete relevant test corpus by behavior, unit, boundary, error, and outcome — not only by the mutated symbol or the nearest test. Read the whole matching test, then run the narrow named test when a broad package command is blocked by unrelated setup. An independent oracle is stronger when it derives the expected boundary from the external contract rather than the production constant or helper under test. Do not infer a test gap merely because the mutation engine cannot instrument a compile-time expression, or because another test in the package needs unavailable infrastructure.

Preserve the ownership boundary when a configuration-only change exposes an absent behavioral proof: if a pinned, reachable direct target exists, its stable diagnostic truthfully reports no fuzz test or E2E journey, and the change reports that result as `READY_WITH_FINDINGS`, the configuration has done its job. That missing test or journey belongs to development, not to `configure-go-quality` — do not call it broken wiring or demand the target turn green. A configuration finding exists only when the command itself is invalid, unreachable, unpinned, silently omitted, mis-scoped, non-deterministic by design, or misclassified.

## Review from architecture to detail

1. Complete traceability of request, acceptance, constraints, and exclusions.
2. Public contracts and persistence.
3. Dependency direction and layer ownership.
4. Correctness, errors, cancellation, and timeouts.
5. Concurrency, lifecycle, and idempotency.
6. Security, sensitive data, and dependencies.
7. Simplicity, semantic reuse, modularization, and real pattern need.
8. Evidence-based optimization, APIs, naming, and tests.

Use `go-metrics` to locate outliers, and read the code before turning a metric into a finding.

## Reduce false positives

For every candidate finding, verify the exact line, demonstrate an observable path or cost, confirm it is in scope, search for a test or contract that invalidates it, distinguish a current defect from an optional improvement, and drop preferences without impact. Make a second reading from the author's perspective, and report only findings whose correction can be verified through a test, command, or concrete contract inspection.

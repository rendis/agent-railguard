# Go Quality Profiles

## Use a stable core and evidence-based overlays

Profiles describe responsibilities, not universal command names or directories. Preserve a repository's equivalent stronger contract and adapt modules, workspaces, generated code, tags, platforms, and CI constraints.

### Core profile

- formatting over declared project Go sources;
- module integrity;
- normal deterministic tests;
- `go vet`;
- one pinned `golangci-lint` configuration with tests enabled, explicit analyzers, and cognitive complexity for production code;
- one repository-native standard command that composes the adopted core targets.

### Coverage assurance

Declare production and critical package scopes. The approved maintained-service baseline is exact 100% critical/core statement coverage and strictly more than 85% overall production statement coverage. Generate fresh profiles and compare integer statement counts. Coverage is reachability, not a semantic score.

### Test-code overlay

Keep tests inside lint scope. Enable `thelper` and `usetesting` when applicable; enable framework-specific analyzers only when that framework is present. Test names and native structure should make context, action, and outcome discoverable. Literal comment markers or GoDoc on every test are project options, not universal gates. Sensitivity remains with `design-tests`, `test-go-service`, mutation, and review.

### Security and documentation overlays

Consume `gosec` and Staticcheck through the aggregator and `govulncheck` separately. Use a maintained GoDoc linter for mechanical exported-contract rules. Semantic usefulness, private-seam value, naming, and over-documentation remain contextual; never make product tests inspect comments.

### Concurrency, fuzz, and mutation overlays

Run race only over suites that exercise concurrency. Fuzz selected parsers or validators with seeds, invariants, and a bounded budget, then promote failures to regression corpus. Adopt mutation only after a stable normal suite and explicit owned scopes; require non-empty campaigns, all compatible operator families, and no unresolved status.

### E2E and optional full-stack

Reuse the E2E owner's public journey, harness, readiness, cleanup, and command. A full-stack profile is required only by request, acceptance, existing policy, or a distinct topology/wiring risk. `BLOCKED_SETUP` is not pass or product failure.

### Specialized overlays

Benchmarks, database checks, licenses, architecture rules, and other analyzers require an observed defect class or policy consumer. Every overlay must add distinct evidence at proportional cost.

## Keep profiles honest

A standard command may compose direct targets with the repository's task runner. It need not emit a proprietary aggregate report. Native diagnostics, exit codes, and ignored tool artifacts are sufficient mechanical evidence; an optional skill collector may summarize them without becoming policy authority.

No profile can decide whether an abstraction is needed, a design pattern reduces current cost, names are unambiguous, documentation is useful, or a test oracle is independent. Those remain contextual review decisions.

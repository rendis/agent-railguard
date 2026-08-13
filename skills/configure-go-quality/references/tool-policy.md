# Go Quality Tool Policy

## Choose the narrowest distribution class

| Class | Use | Consumer repository |
|---|---|---|
| Standard Go or maintained ecosystem tool | Default for formatting, modules, tests, vet, lint, vulnerabilities, coverage production, mutation, JSON queries, race, fuzz, and E2E runners. | Pin exact compatible versions and version native configs/commands. |
| Central mandatory CLI | Only when no approved standard tool can express one required deterministic CI decision. Keep one defect class, one small input/output contract, native exit status, releases, and independent tests. | Pin the published CLI; never copy its source into each repository. |
| Agent-only skill helper | Discovery, descriptive metrics, optional summaries, or contextual preparation that CI does not require. | No canonical command may depend on its installed path. |

Before adding or upgrading a tool, inspect its official release, license, supported Go version and platforms, archive status, and effective behavior. Pin an exact version through the repository's Go tool or established package mechanism. Never use `latest`, an unpinned global binary, `$HOME`, `.agents`, `.codex`, or an absolute developer path in a canonical command.

## Aggregate overlapping analyzers once

Use one pinned `golangci-lint` configuration for same-scope Staticcheck, `gosec`, `gocritic`, `gocognit`, GoDoc, and applicable test analyzers. Keep tests enabled. Configure cognitive complexity for production code with the approved baseline maximum of 15 unless repository policy is stronger.

Do not add standalone Staticcheck or gosec over the same scope. Do not add `gocyclo` when cognitive complexity is the mechanical gate and cyclomatic outliers are contextual diagnostics. Evaluate `dupl` against a clean baseline, but treat duplication as shared knowledge or policy—not automatically similar syntax—and do not enable it merely to increase tool count. Reject CRAP as a universal gate; coverage and complexity already provide its mechanical inputs without proving oracle quality.

Run `govulncheck` separately because it evaluates reachable dependency vulnerabilities. Keep deprecation evidence in Staticcheck and inspect the authoritative replacement before remediation.

## Configure mutation without a second framework

Pin Gremlins or the selected maintained engine, declare owned scopes, enable every compatible operator family, and fix workers, test CPU, build tags, and timeout policy. Preserve its native JSON reports under ignored temporary output.

If native thresholds cannot express the exact repository policy, use a pinned standard JSON query tool to assert non-empty campaigns and allowed terminal statuses. Do not introduce neutral thresholds without another blocking native query, a repository-local parser, a persistent exception ledger, or a second mutation engine for score volume.

## Keep helpers optional

Skill analyzers may produce descriptive metrics or validate an explicitly adopted specialized convention. Resolve them from the installed skill root at agent runtime, never from a guessed path. If a helper becomes mandatory in CI, publish it as a separate narrow versioned CLI or replace it with a maintained standard tool before adoption.

A mutation-sensitivity helper is justified only after the pinned engine demonstrably cannot schedule one exact semantically testable mutant. It may apply a caller-supplied patch in a marked disposable checkout and emit ignored supplemental evidence; it must not discover campaigns, implement operators, change the native status or exit code, supply a repository exception mechanism, or become a canonical command. Keep production representation and independent behavioral evidence authoritative; checker compatibility alone never justifies a syntax ban.

Atomic replacement is the default when no external consumer requires compatibility. Remove obsolete paths, commands, aliases, schemas, and readers in the same verified change.

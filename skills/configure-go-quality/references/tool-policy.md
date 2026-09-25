# Go Quality Tool Policy

## Choose the narrowest distribution class

| Class | Use | Consumer repository |
|---|---|---|
| Standard Go or maintained ecosystem tool | Default for formatting, modules, tests, vet, lint, vulnerabilities, coverage, mutation, JSON queries, race, fuzz, E2E runners | Pin exact compatible versions and version native configs/commands |
| Central mandatory CLI | Only when no standard tool expresses one required deterministic CI decision. One defect class, one small input/output contract, native exit status, maintained releases and tests | Pin the published CLI; never copy its source into each repository |
| Agent-only skill helper | Discovery, descriptive metrics, or contextual prep that CI does not require | No canonical command may depend on its installed path |

Before adding or upgrading a tool, check its release, license, supported Go version, and archive status. Pin an exact version through the repository's Go tool mechanism — never `latest`, an unpinned global binary, or an absolute developer path in a canonical command.

## Aggregate overlapping analyzers once

Use one pinned `golangci-lint` configuration for Staticcheck, `gosec`, `gocritic`, complexity, GoDoc, and test analyzers over the same scope — do not add any of these standalone. The strict AI-code profile applies per-function production limits: cyclomatic complexity `5`, cognitive complexity `6`, function length `80` lines / `40` statements, maintainability index `20`, nesting `4`, at most `7` arguments. Exclude these structural limits from tests so fixtures stay direct.

The bundled strict profile also enables `durationcheck`, `fatcontext`, `nilerr`, `nilnil`, `wastedassign` for concrete defects, and `loggercheck`/`sloglint`/`musttag`/`testifylint` when their APIs are present. `goconst` catches repeated production literals (`goconst.ignore-tests=true`, since repeated fixture values are test evidence, not duplication to extract), `dupl` at threshold 100 is a local duplication proxy, `godox` flags `TODO`/`FIXME`, and a narrow `revive` rule set applies. These are preventive signals, not equivalents of SonarQube's duplication or rule engines — inspect each finding. `nolintlint` requires every suppression to name its linter and reason; a suppression is policy evidence, not a way to silence AI-authored code.

Do not add a whole-repository aggregate complexity budget: it grows with legitimate functionality and can be gamed without improving a function. Reject CRAP as a gate — coverage and complexity already supply its inputs without proving oracle quality. Run `govulncheck` separately; it evaluates reachable dependency vulnerabilities, a different question from Staticcheck's deprecation findings.

## Configure mutation without a second framework

Pin Gremlins (or the selected maintained engine), declare owned scopes, enable every compatible operator family, and fix workers, test CPU, tags, and timeout policy. If native thresholds cannot express the exact policy, use a pinned standard JSON query tool to assert non-empty campaigns and allowed terminal statuses — never add a neutral threshold, a repository-local parser, a persistent exception ledger, or a second mutation engine.

## Keep helpers optional

Resolve skill analyzers from the installed skill root at agent runtime, never a guessed path. If a helper becomes mandatory in CI, publish it as a separate versioned CLI or replace it with a maintained standard tool first. The mutation-sensitivity helper (owned by `test-go-service`) is justified only after the pinned engine demonstrably cannot schedule an exact mutant; it applies a caller-supplied patch in a disposable checkout and never changes the native status, exit code, or becomes a canonical command.

Atomic replacement is the default when no external consumer needs compatibility: remove obsolete paths, commands, and readers in the same change.

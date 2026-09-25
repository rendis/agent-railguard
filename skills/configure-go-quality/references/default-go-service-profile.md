# Go Service Quality Profiles

## Baseline

Use `verification-profile:go-quality` for a generic request when no stronger valid policy is adopted. The engine runs it through two commands:

- `railguard check` checks formatting, runs `go vet` and runs the tests;
- `railguard verify` also runs the tests with the race detector and a shuffled order.

With `--changed` every check judges only what the change touched since the merge-base with the default branch (or `--base <ref>`): changed files for formatting, packages containing changes for vet and tests. Pre-existing debt elsewhere does not block the change. Without `--changed` every detected Go module is checked completely. Git gates are separate selections and are never activated by a profile.

Profiles write no files. Their selection and inputs live in `.railguard/project.yaml` and change only through `Resolve -> Plan -> Review -> Apply` (`railguard plan --add … --set …`, then `railguard apply`).

Prove the baseline with the real commands:

1. run `railguard check --changed` and `railguard verify --changed` on the change;
2. run `railguard verify` once without `--changed` to record the existing debt of the module;
3. compare CI and Git-gate consumers with the same commands;
4. after Apply, require a second plan to contain no repository mutation.

A failing check is `READY_WITH_FINDINGS` after the complete task surface executes. Missing or invalid inputs are `MISSING` or `BROKEN`. A check reported as `unavailable` (missing tool pin or config) is `BLOCKED_SETUP`; it never counts as a pass.

## Explicit assurance

Keep `verification-profile:go-quality` as the portable baseline, then select only the profiles justified by repository evidence:

| Profile | `check` | `verify` | Inputs |
|---|---|---|---|
| `verification-profile:go-assurance` | `go mod verify` when dependencies change; golangci-lint on issues introduced by the change | changed-line coverage (100% core, 80% elsewhere; full mode 100% core, 85% overall); govulncheck when dependencies change | `tool_modfile`, `test_packages`, `core_packages`, `core_cover_packages`, `overall_cover_packages` |
| `verification-profile:go-fuzz` | — | each case whose package changed | `package:FuzzName:duration` cases |
| `verification-profile:go-mutation` | — | Gremlins on changed packages; any LIVED or NOT_COVERED mutant on a changed line fails | `tool_modfile`, `packages` scope |
| `verification-profile:go-e2e` | — | `e2e`-tagged packages whenever the module changed | E2E package patterns |

A profile whose inputs keep the default `disabled` sentinel is intentionally incomplete and is classified `MISSING` until explicit inputs replace it.

Strict assurance also requires repository-owned supporting inputs:

- [golangci.yml](../assets/golangci.yml) as `.golangci.yml` in each module root;
- [gremlins.yaml](../assets/gremlins.yaml) as `.gremlins.yaml` for mutation configuration;
- exact Go tool pins in the `tool_modfile`.

Pin the validated tool set atomically through repository `tool` directives:

```sh
go get -tool \
  github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.12.2 \
  golang.org/x/vuln/cmd/govulncheck@v1.6.0 \
  github.com/go-gremlins/gremlins/cmd/gremlins@v0.6.0
```

Adapt only observed test, core, cover, mutation, fuzz, and E2E inputs. Require bounded fuzz, explicit E2E ownership and one observed `railguard verify --changed` run. When Sonar is adopted, require the CI scanner to wait for the actual Quality Gate and retain its analysis identity; repository-side proxies cannot replace that verdict. A missing behavioral proof remains a product finding; this skill configures its signal without inventing the proof.

# Go Service Quality Profiles

## Managed AI Harness v1 baseline

Use `verification-profile:go-quality` for a generic request when no stronger valid policy is adopted. It owns two repository entrypoints:

- `make check` verifies formatting, runs normal tests, and runs `go vet` for every selected Go module;
- `make verify` runs `make check` and race-enabled tests for the same modules.

The profile accepts module roots derived from project units and explicit test-package patterns. `SCOPE=<module-root>` may select one known module; an unknown scope must fail. The repository's Go version and standard tools remain authoritative. Git gates are separate selections and are never activated by the profile or skill.

When `Makefile` contains `# ai-harness:managed:start id="verification.go-quality"`, the marked block and the `check`/`verify` entrypoints belong to AI Harness. Assess them in place. Apply or Repair only through `Resolve -> Plan -> Review -> Apply`, using inputs declared by the selected profile. Do not reconstruct the block, copy an asset over it, or claim it can materialize targets absent from the catalog definition.

Prove this baseline with the exact generated commands:

1. require the managed profile and entrypoint markers once each;
2. require `make -n check verify` to resolve for the default scope;
3. run `make check` and `make verify` once over the adopted scope;
4. when multiple modules exist, prove one valid `SCOPE` and one unknown scope;
5. compare CI or Git-gate consumers with the same entrypoints;
6. after Apply, require a second plan to contain no repository mutation.

A failing test, vet, formatting, or race command is `READY_WITH_FINDINGS` after the complete task surface executes. Missing or invalid managed inputs are `MISSING` or `BROKEN`. An unavailable required executable or platform after complete inputs is `BLOCKED_SETUP`.

## Explicit managed assurance

Use one public `make check` and `make verify` interface for every adopted level. Keep `verification-profile:go-quality` as the portable baseline, then select only the managed profiles justified by repository evidence:

| Profile | `check` contribution | `verify` contribution | Required inputs |
|---|---|---|---|
| `verification-profile:go-assurance` | module verification and configured lint | exact core/overall coverage and reachable vulnerabilities | test, core, and cover packages |
| `verification-profile:go-fuzz` | explicit case/scope readiness | each selected fuzz case | `package:FuzzName:duration` cases |
| `verification-profile:go-mutation` | explicit package/scope readiness | non-empty KILLED-only campaigns | production package scopes |
| `verification-profile:go-e2e` | explicit package/scope readiness | `e2e`-tagged acceptance packages | E2E package scopes |

The projector composes selected private `ai-harness-*` targets behind the same two public commands. Apply inputs through `.ai-harness/project.yaml` and the CLI transaction; never copy, reconstruct, or extend the generated Make sections manually. A selected profile with its default `disabled` sentinel is intentionally incomplete and must be classified `MISSING` until explicit inputs replace it.

Strict assurance also requires repository-owned supporting inputs:

- [golangci.yml](../assets/golangci.yml) for the pinned analyzer policy;
- [gremlins.yaml](../assets/gremlins.yaml) for mutation configuration;
- ignored `tmp/ai-harness` evidence paths and exact Go tool pins.

Pin the validated tool set atomically through repository `tool` directives:

```sh
go get -tool \
  github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.12.2 \
  golang.org/x/vuln/cmd/govulncheck@v1.6.0 \
  github.com/go-gremlins/gremlins/cmd/gremlins@v0.6.0 \
  github.com/itchyny/gojq/cmd/gojq@v0.12.19
```

Adapt only observed test, critical, cover, mutation, fuzz, and E2E inputs. Require non-empty mutation campaigns, bounded fuzz, explicit E2E ownership, ignored volatile output, native config paths, and one observed `make verify` run. When Sonar is adopted, require the CI scanner to wait for the actual Quality Gate and retain its analysis identity; repository-side proxies cannot replace that verdict. A missing behavioral proof remains a product finding; this skill configures its signal without inventing the proof.

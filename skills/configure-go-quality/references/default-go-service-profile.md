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

## Explicit advanced unmanaged baseline

Lint, coverage thresholds, vulnerability scanning, fuzzing, mutation, E2E, and other hardening are not implicit parts of the managed v1 profile. Adopt them only when the repository already owns them or the user explicitly selects them with a compatible task owner. A managed repository requires an explicit provider that declares the additional files, inputs, targets, and lifecycle; without one, the requested capability is `MISSING`.

For an explicitly approved advanced baseline under an unmanaged Make owner, use the bundled files as one coherent template:

- [Makefile.quality](../assets/Makefile.quality) for native targets and decision wiring;
- [golangci.yml](../assets/golangci.yml) for the pinned aggregator;
- [gremlins.yaml](../assets/gremlins.yaml) for mutation configuration.

Pin the validated tool set atomically through repository `tool` directives:

```sh
go get -tool \
  github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.12.2 \
  golang.org/x/vuln/cmd/govulncheck@v1.6.0 \
  github.com/go-gremlins/gremlins/cmd/gremlins@v0.6.0 \
  github.com/itchyny/gojq/cmd/gojq@v0.12.19
```

Adapt only observed package, source, critical, mutation, fuzz, race, and E2E scopes. Preserve overrideable external prerequisites such as `VULN_DB` with `?=` assignments. Require non-empty mutation campaigns, bounded fuzz, explicit E2E ownership, ignored volatile output, native config paths, keep-going hardening execution, and one observed direct run per adopted dimension. A missing behavioral proof remains a product finding; this skill configures its signal without inventing the proof.

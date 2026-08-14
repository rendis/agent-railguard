---
name: configure-go-quality
description: Assess, apply, or repair reproducible Go quality configuration. Use when canonical checks, scopes, pins, native configs, or CI wiring are missing, invalid, inherited, unpinned, or being adopted. Use read-only Assess during review; remediation of product and test findings belongs to behavioral workflows.
---

# Configure Go Quality

## Establish one readiness state

1. **Authority.** Declare `Assess`, `Apply`, or `Repair`, the repository owner, requested signals, and scope. `Assess` is read-only. When a delivery workflow is already active, it retains edit ownership; during review, inspect only the fixed snapshot. Complete when mode, owner, scope, and allowed files are explicit.
2. **Assess.** Read [configuration-lifecycle.md](references/configuration-lifecycle.md). Inspect the Go workspace, `.ai-harness/project.yaml`, every `verification.*` managed section, repository pins and native configs, generated-evidence ignores, CI consumers, scopes, and external prerequisites. Run non-mutating probes and classify every adopted dimension. Complete with inputs `ready`, `missing`, or `broken`, plus preserved blocker and product-finding labels.
3. **Select.** Read [default-go-service-profile.md](references/default-go-service-profile.md). Use `verification-profile:go-quality` for the portable baseline. For strict AI-generated or AI-modified Go assurance, add `verification-profile:go-assurance` and each applicable `verification-profile:go-fuzz`, `verification-profile:go-mutation`, and `verification-profile:go-e2e` with explicit repository inputs. Read [quality-profiles.md](references/quality-profiles.md), [deterministic-gate.md](references/deterministic-gate.md), and [tool-policy.md](references/tool-policy.md); require a named defect class, governed scope, decision rule, proportional cost, materialization owner, and consumer. An applicable capability without complete inputs remains `MISSING`.
4. **Materialize.** In `Apply` or `Repair`, update selected profiles and inputs through `Resolve -> Plan -> Review -> Apply`; the root Makefile's managed sections and public `check`/`verify` entrypoints are never edited directly. Add or repair repository-owned Go tool pins, `.golangci.yml`, `.gremlins.yaml`, generated-evidence ignores, scanner properties, and CI wiring as declared prerequisites. Keep Git gates separately selected. Product code, tests, E2E scenarios, assertions, and thresholds remain unchanged.
5. **Prove.** Validate native configs, resolve repository-owned pins, run `make -n check verify`, then execute `make check` and `make verify`. Preserve the first product finding or unavailable prerequisite from every selected profile. Compare local and CI entrypoints, require CI to consume `make verify`, and require the actual blocking SonarQube Quality Gate when Sonar is adopted. Apply the same desired state again and require `NO_CHANGES`. Complete when every selected dimension is passed, a product finding, a blocked prerequisite, or explicitly non-applicable.
6. **Classify.** Run `node scripts/classify-readiness.mjs` from this installed skill with `--inputs ready|missing|broken`, one `--blocked-prerequisite` per unavailable required cause, and one `--product-finding` per executed product failure. Its JSON is the only final readiness verdict. Complete when prose `state` and any structured `status` copy the JSON without translation.
7. **Return.** Report mode, state, snapshot, adopted profile and signals, changed or proposed inputs, versions, scopes, commands, exit codes, idempotency, product findings, blocked prerequisites, and unobserved dimensions. For Sonar, report the analyzed revision and observed server gate identity/status or state that server evidence is unavailable; never infer parity from local analyzers. Route behavior remediation to development, test sensitivity to `test-go-service`, E2E behavior to `build-e2e-test-suite`, and contextual findings to `review-go-quality`.

## Composition contract

- Consume an existing valid canonical gate directly; load this skill when its configuration or readiness claim is in scope.
- Reuse one assessment until pins, configs, scopes, commands, CI, authority, or snapshot changes.
- `Repair` restores reproducibility inputs. A product failure is not broken configuration.
- Treat `check` and `verify` as the complete public Make interface; selected profiles own only `ai-harness-*` implementation targets.
- Replace obsolete internal configuration atomically unless an observed external contract requires compatibility.
- Configuration proves reproducible execution, not semantic correctness, architecture, naming, documentation quality, or test sensitivity.

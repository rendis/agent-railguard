---
name: configure-go-quality
description: Assess, apply, or repair reproducible Go quality configuration. Use when canonical checks, scopes, pins, native configs, or CI wiring are missing, invalid, inherited, unpinned, or being adopted. Use read-only Assess during review; remediation of product and test findings belongs to behavioral workflows.
---

# Configure Go Quality

## Establish one readiness state

1. **Authority.** Declare `Assess`, `Apply`, or `Repair`, the repository owner, requested signals, and scope. `Assess` is read-only. When a delivery workflow is already active, it retains edit ownership; during review, inspect only the fixed snapshot. Complete when mode, owner, scope, and allowed files are explicit.
2. **Assess.** Read [configuration-lifecycle.md](references/configuration-lifecycle.md). Inspect the Go workspace, adopted pins and native configs, canonical task and CI commands, scopes, ignore policy, prerequisites, and any `verification.go-quality` managed marker. Run non-mutating probes and classify every adopted dimension. Complete with repository inputs `ready`, `missing`, or `broken`, plus preserved blocker and product-finding labels.
3. **Select.** For a generic missing Go quality surface, read [default-go-service-profile.md](references/default-go-service-profile.md) and use its managed v1 baseline. Preserve a stronger valid repository policy. For an explicitly requested or already adopted extension, read [quality-profiles.md](references/quality-profiles.md), [deterministic-gate.md](references/deterministic-gate.md), and [tool-policy.md](references/tool-policy.md); require a named defect class, scope, decision rule, cost, owner, and consumer. A capability without a materialization owner or catalog provider remains `MISSING`.
4. **Materialize.** In `Apply` or `Repair`, change only reproducibility inputs owned by the selected provider. For an AI Harness-managed profile, use its `Resolve -> Plan -> Review -> Apply` route and submit only declared inputs; the marked block is never edited directly. For an unmanaged task owner, add or repair exact pins, native configs, canonical commands, scopes, CI wiring, documentation, and generated-evidence ignores as one coherent change. Keep Git gates separately selected. Product code, tests, E2E scenarios, assertions, and thresholds remain unchanged.
5. **Prove.** Validate changed configs with native parsers when available, resolve repository-owned pins, exercise each changed canonical command, compare local and CI entrypoints, and prove a second `Apply` is a no-op. Execute every adopted dimension once; preserve its first product failure or unavailable prerequisite. For the managed v1 baseline, run `make check` and `make verify` over the adopted scope. Complete when every adopted dimension is passed, a product finding, a blocked prerequisite, or explicitly non-applicable.
6. **Classify.** Run `node scripts/classify-readiness.mjs` from this installed skill with `--inputs ready|missing|broken`, one `--blocked-prerequisite` per unavailable required cause, and one `--product-finding` per executed product failure. Its JSON is the only final readiness verdict. Complete when prose `state` and any structured `status` copy the JSON without translation.
7. **Return.** Report mode, state, snapshot, adopted profile and signals, changed or proposed inputs, versions, scopes, commands, exit codes, idempotency, product findings, blocked prerequisites, and unobserved dimensions. Route behavior remediation to development, test sensitivity to `test-go-service`, E2E behavior to `build-e2e-test-suite`, and contextual findings to `review-go-quality`.

## Composition contract

- Consume an existing valid canonical gate directly; load this skill when its configuration or readiness claim is in scope.
- Reuse one assessment until pins, configs, scopes, commands, CI, authority, or snapshot changes.
- `Repair` restores reproducibility inputs. A product failure is not broken configuration.
- Replace obsolete internal configuration atomically unless an observed external contract requires compatibility.
- Configuration proves reproducible execution, not semantic correctness, architecture, naming, documentation quality, or test sensitivity.

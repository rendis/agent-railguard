---
name: configure-go-quality
description: Assess, apply, or repair reproducible Go quality configuration. Use when canonical checks, tool pins, native configs, scopes, or CI wiring are missing, broken, or newly adopted.
---

# Configure Go Quality

`railguard check`/`verify --changed` are the deterministic gates (see [default-go-service-profile.md](references/default-go-service-profile.md) for exactly what they run). This skill makes those commands runnable and correctly scoped — it never re-implements what they already enforce.

## Establish one readiness state

1. **Authority.** Declare `Assess`, `Apply`, or `Repair`, the repository owner, and scope. `Assess` is read-only. A delivery workflow already active keeps edit ownership; a review keeps this skill to the fixed snapshot. Complete when mode, owner, and allowed files are explicit.
2. **Assess.** Read [configuration-lifecycle.md](references/configuration-lifecycle.md). Inspect the Go workspace, `.railguard/project.yaml`, tool pins, native configs, CI consumers, and external prerequisites. Classify every adopted dimension as `ready`, `missing`, or `broken`. Complete when every adopted dimension is classified.
3. **Select.** Use the baseline `verification-profile:go-quality`. For strict AI-generated or AI-modified Go assurance, add `verification-profile:go-assurance` and each applicable `verification-profile:go-fuzz`, `verification-profile:go-mutation`, and `verification-profile:go-e2e` only with a named defect class and complete repository inputs; an incomplete profile is `MISSING`. Read [quality-profiles.md](references/quality-profiles.md) only when selecting or changing a strict assurance profile, [deterministic-gate.md](references/deterministic-gate.md) for a profile's decision rule or cost, and [tool-policy.md](references/tool-policy.md) when choosing analyzer, scanner, or mutation tooling. Complete when each selected profile has complete inputs or is `MISSING`.
4. **Materialize.** In `Apply` or `Repair`, update selected profiles and inputs through `Resolve -> Plan -> Review -> Apply` (`railguard plan`, then `railguard apply`); never edit `.railguard/` files directly. Add or repair repository-owned tool pins, `.golangci.yml`, `.gremlins.yaml`, scanner properties, and CI wiring. Leave product code, tests, E2E scenarios, and thresholds unchanged. Complete when planned inputs match the selected profiles, or the mode is `Assess`.
5. **Prove.** Run `railguard check --changed` and `verify --changed`, and compare local and CI entrypoints — require CI to call `verify --changed` too. When SonarQube is adopted, require the CI scanner to wait for the real server Quality Gate and record its analyzed revision and gate status. Apply the same desired state again and require `NO_CHANGES`. Complete when every selected dimension has passed, produced a finding, or reported a blocked prerequisite.
6. **Classify.** Run `node scripts/classify-readiness.mjs` with `--inputs ready|missing|broken`, one `--blocked-prerequisite` per unavailable cause, and one `--product-finding` per executed failure. Its JSON is the only final readiness verdict. Complete when prose `state` and any structured `status` copy the JSON without translation.
7. **Return.** Report mode, state, adopted profiles, changed inputs, versions, commands, exit codes, idempotency, product findings, and blocked prerequisites. Route behavior findings to development, test sensitivity to `test-go-service`, E2E behavior to `build-e2e-test-suite`, and contextual findings to `review-go-quality`. Complete when the report copies the classifier JSON and names every finding or blocker.

## Composition contract

| Situation | Load or owner |
| --- | --- |
| Existing valid canonical gate | Consume it; load this skill only when configuration or readiness is in scope |
| Delivery workflow already active | That workflow remains the edit owner |
| Review of a fixed snapshot | `Assess` only |
| Product or test finding | Behavioral owner (`tdd` / development or `test-go-service`) |
| E2E behavior | `build-e2e-test-suite` |
| Contextual design, architecture, or documentation-quality finding | `review-go-quality`; configuration proves reproducible execution, not semantic correctness |

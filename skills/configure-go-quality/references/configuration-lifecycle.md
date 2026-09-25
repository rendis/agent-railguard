# Go Quality Configuration Lifecycle

## Return one readiness state

| State | Meaning | Next owner |
|---|---|---|
| `MISSING` | An adopted pin, config, scope, command, or CI entry does not exist. | `Apply` |
| `BROKEN` | An adopted input exists but is invalid, inherited, unpinned, or disagrees with CI. | `Repair` |
| `BLOCKED_SETUP` | Complete repository-owned inputs cannot reach a required external prerequisite, credential, or dependency artifact. | Report the prerequisite |
| `READY_WITH_FINDINGS` | All readiness inputs work and `railguard check`/`verify` reports a finding. | Behavioral or review owner |
| `READY` | All readiness inputs and exercised commands pass. | Caller continues |

Repository input state precedes execution state: an absent or partial pin, config, or command stays `MISSING`/`BROKEN` even if a dependency is also unreachable. Once inputs are complete, an unavailable prerequisite takes precedence over a simultaneous product finding. Never compute the final state by hand — preserve the cause labels and run `scripts/classify-readiness.mjs` (see [SKILL.md](../SKILL.md)).

## Keep modes disjoint

- **Assess:** inspect effective files and run non-mutating probes only.
- **Apply:** add the minimum approved reproducibility inputs.
- **Repair:** restore adopted inputs while preserving their scopes, thresholds, and consumers.

Production code, tests, E2E scenarios, and product configuration stay outside every mode.

## Run readiness probes

1. Confirm repository root, `go.mod`/`go.work`, effective Go version, and build tags.
2. Read `.railguard/project.yaml` and every `verification.*` marker before proposing writes.
3. Confirm each adopted tool is a repository pin or standard Go command, with its effective version.
4. Validate native configs with parser-only commands when available; otherwise the first real `railguard` execution is the proof.
5. Confirm the public `check`/`verify` commands, selected profile inputs, and generated-output ignores are in place.
6. Confirm no developer-home file (`.agents`, `.codex`, ambient tool config) can change the effective command.
7. Compare local and CI commands, versions, flags, and scopes.
8. Run each adopted dimension once and preserve its first product finding or unavailable prerequisite — no blind retry.

When a declarative analyzer config changes, prove it with a disposable ignored fixture carrying one known violation, then delete it. `railguard check`/`verify` remain the authoritative commands.

## Prove idempotency

After `Apply` reaches `READY`, `READY_WITH_FINDINGS`, or `BLOCKED_SETUP`, plan the same operation again and require no repository diff and the same state. `Repair` is complete when a following `Assess` no longer returns `BROKEN`; product findings and external blockers stay visible.

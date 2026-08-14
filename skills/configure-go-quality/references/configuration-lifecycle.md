# Go Quality Configuration Lifecycle

## Return one readiness state

| State | Deterministic meaning | Next owner |
|---|---|---|
| `MISSING` | One or more adopted pins, configs, scopes, commands, CI entries, ignore rules, or providers do not exist. | `Apply`. |
| `BROKEN` | An adopted input exists but is invalid, inherited, unpinned, inconsistent, non-resolvable, or disagrees with CI. | `Repair`. |
| `BLOCKED_SETUP` | Complete repository-owned inputs cannot execute a required external prerequisite, platform capability, credential, advisory source, or dependency artifact. | Configuration reports the prerequisite. |
| `READY_WITH_FINDINGS` | All readiness inputs work and an executed product or quality command reports a finding. | Behavioral or review owner. |
| `READY` | All readiness inputs and exercised adopted commands pass. | Caller continues. |

Repository input state precedes execution state. An absent or partial pin, config, command, or provider remains `MISSING` or `BROKEN`; dependency access cannot convert it to `BLOCKED_SETUP`. After inputs are complete, a required unavailable prerequisite takes precedence over simultaneous product findings.

Do not calculate the final state conversationally. Preserve cause labels, then run `node scripts/classify-readiness.mjs` from the installed skill. Copy its `state` into prose and its `status` into structured output.

## Keep modes disjoint

- **Assess:** inspect effective files and execute non-mutating probes. Never install, generate, or repair.
- **Apply:** add the minimum approved reproducibility inputs under the selected owner.
- **Repair:** restore adopted inputs while preserving scopes, thresholds, exclusions, and consumers.

Production, tests, E2E scenarios, behavioral fixtures, assertions, and product configuration remain outside every mode.

## Execute readiness probes

1. Confirm repository root, `go.mod` or `go.work`, effective Go version, platforms, and build tags.
2. Identify `.ai-harness/project.yaml`, every `verification.*` managed marker, and the selected profile owner before proposing writes.
3. Verify every adopted tool is a repository pin or standard Go command and record its effective version.
4. Validate native configs with parser-only commands when available; otherwise prove the explicit path structurally and use the first real execution as runtime proof.
5. Confirm the public `check`/`verify` commands, selected profile inputs, non-zero semantics, fresh producer artifacts, and generated-output ignores.
6. Prove developer-home configuration cannot change the effective command when the tool searches ambient paths.
7. Compare local and CI commands, versions, flags, scopes, prerequisites, and environment differences.
8. Execute every adopted dimension once. Preserve its first product finding or unavailable prerequisite without remediation or blind retry.

When a declarative analyzer configuration changes, use a disposable ignored fixture to prove one known violation is detected and cleanup succeeds. Managed profile targets remain private; the real `make check` and `make verify` commands are authoritative.

## Prove idempotency

After Apply reaches `READY`, `READY_WITH_FINDINGS`, or `BLOCKED_SETUP`, prepare the same operation again and require no repository diff plus the same state. Repair is complete when a following Assess no longer returns `BROKEN`; product findings and external blockers remain visible.

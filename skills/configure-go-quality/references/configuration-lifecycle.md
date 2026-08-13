# Go Quality Configuration Lifecycle

## Return one readiness state

Apply this precedence after the required probes:

| State | Deterministic meaning | Next owner |
|---|---|---|
| `BLOCKED_SETUP` | Complete repository-owned pins, configs, scopes, and commands cannot execute a required external prerequisite, platform capability, credential, advisory source, or dependency artifact in the current environment. | Configuration reports the prerequisite; no product verdict. |
| `BROKEN` | An adopted input exists but is invalid, unpinned, inherited, inconsistent, non-resolvable, or local and CI commands disagree. | `Repair`. |
| `MISSING` | One or more adopted pins, native configs, scopes, commands, CI entries, or ignore rules do not exist. | `Apply`. |
| `READY_WITH_FINDINGS` | Every readiness probe passes and a canonical product command executes to a quality or behavioral failure. | Development/test/E2E/review according to the finding. |
| `READY` | Every readiness probe passes and the exercised canonical commands pass. | Caller continues its workflow. |

Do not collapse a setup blocker into `BROKEN`, a product finding into `BROKEN`, or an unexecuted signal into `READY`.

`BLOCKED_SETUP` never excuses an absent or partial repository-owned input. If an exact pin, checksum, native config, scope, task, CI entry, or ignore rule could not be materialized, the configuration is still `MISSING` or `BROKEN` and must not be delivered as a valid blocked setup. Apply a validated tool set atomically; only after the complete declarative inputs exist may unavailable dependency bytes or external services be classified as blockers.

The final state classifies the observed ability to execute the whole adopted quality surface, not only whether its files and commands are wired. Passing the wiring-only readiness target does not override an unavailable required canonical dimension. When any adopted required prerequisite is unavailable, the structured status must be `BLOCKED_SETUP`; report that same state in prose and never emit `READY_WITH_FINDINGS` alongside blocked evidence.

Do not calculate this precedence conversationally. After identifying causes, run `scripts/classify-readiness.py` from the installed skill. Use `--inputs missing` or `--inputs broken` before configuration is materialized; otherwise use `--inputs ready` and pass the preserved blocker and product-finding labels. The helper returns one JSON object with canonical `state` and lower-case `status` fields. Copy `state` into prose and `status` into any structured result without translating or reconciling them yourself. This helper is agent-side policy support; never copy it into a consumer repository or make repository/CI commands depend on the installed skill.

## Keep modes disjoint

- **Assess:** read files and effective configuration, run non-mutating validators and commands, and classify. Do not install, pin, generate, rewrite, or repair.
- **Apply:** add the minimum reproducibility inputs for newly adopted signals under development authority. Initial thresholds and scopes come from explicit repository policy or the approved baseline, never from the current score.
- **Repair:** restore missing or invalid reproducibility inputs while preserving adopted scopes, thresholds, exclusions, and consumers. A schema replacement is atomic; do not ship compatibility readers or dual commands.

Allowed writes for Apply or Repair are exact toolchain and tool pins, native configuration files, task/CI commands, source-scope declarations, concise execution documentation, and ignore rules for generated evidence. Production, tests, E2E scenarios, fixtures that define behavior, assertions, product configuration, and quality thresholds are outside this skill.

## Execute the readiness probes

1. Confirm the repository root, `go.mod` or `go.work`, effective Go version, supported platforms, and declared build tags.
2. Verify module integrity and that tool dependencies are exact repository pins, not binaries discovered only from `PATH`.
3. Resolve each pinned command through the repository mechanism and record its effective version.
4. Run each parser-only native validator that the pinned tool actually provides and inspect effective linters, exclusions, mutation operators, scopes, and flags. When a tool such as Gremlins v0.6 has no parser-only validator, prove its pin and explicit config path structurally here, then treat the first real direct execution in step 9 as the authoritative config/runtime proof; never claim that `--version` parsed the YAML.
5. Confirm canonical task commands exist, use explicit repository configuration, have non-zero failure semantics, remove stale producer artifacts, and never reference `$HOME`, `.agents`, `.codex`, or an installed skill location.
6. Prove a deliberately poisoned developer home cannot change the effective command. Prefer an isolated temporary home; an explicit config flag is required when the tool otherwise searches parent or home paths.
7. Confirm generated coverage, mutation, fuzz, trace, E2E, log, and report paths are ignored while pins, configs, tasks, tests, corpus, and fixtures remain visible to Git.
8. Compare local and CI commands, versions, flags, scopes, prerequisites, and environment differences. An absent CI owner is reported; do not invent a platform merely for symmetry.
9. Run the changed validators, then execute every applicable canonical dimension once—including the actual vulnerability, race, fuzz, mutation, and E2E commands—to classify the snapshot. Version output, dry runs, and `make -n` prove wiring but not execution readiness. Preserve the first result; do not remediate product/tests or retry blindly. Any unavailable required prerequisite yields `BLOCKED_SETUP` before considering product findings.

## Prove detection without touching the product

Create a disposable fixture below an ignored temporary directory or in a detached temporary worktree. Introduce one known violation selected by the adopted configuration—for example a missing exported Go contract for `godoclint`—and require the pinned canonical analyzer to fail with the expected diagnostic. Remove the fixture and verify cleanup. The probe must not edit production, tests, E2E, thresholds, or exclusions.

Also test an invalid native configuration in a disposable copy when schema validation changed. A negative probe proves the signal is wired; it does not prove the real product is correct.

## Prove idempotency

After `Apply` finishes materializing the configuration and reaches `READY`, `READY_WITH_FINDINGS`, or `BLOCKED_SETUP`, record the governed diff, run `Apply` again, and require no repository diff plus the same readiness state. `Repair` is complete when a following `Assess` no longer returns `BROKEN`; any product diagnostics or blocked prerequisites remain unchanged.

Report every probe with command, version, scope, exit code, and classification. Preserve the first useful failure instead of rerunning blindly.

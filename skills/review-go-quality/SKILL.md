---
name: review-go-quality
description: Review a fixed Go change without editing it. Use for diff audits, baseline investigations, or adversarial pre-delivery review of correctness, architecture, and verification evidence.
---

# Review Go Quality

## Refute or validate a fixed change

1. **Snapshot.** Read instructions, specifications, contracts, and [review-workflow.md](references/review-workflow.md). Fix the base, scope, Git identity, and exact worktree diff; stop if the reviewed source or configuration changes underneath you. Complete when the reviewed set and applicable requirements are enumerated.
2. **Configuration.** Inspect repository pins, native configs, scopes, commands, and CI. Load `configure-go-quality` in `Assess` mode once when reviewing an `Apply` or `Repair` change or any configuration-readiness classification — it owns that state contract. Otherwise load it only when readiness is missing, invalid, inherited, unpinned, or unclear enough to affect a claim. Never apply or repair during review. Complete when readiness is classified or recorded as not required.
3. **Signals.** Prefer `railguard check --changed` and `railguard verify --changed` as the mechanical gate; reuse their results only when snapshot, command, and scope match, and run project-native commands for anything they don't cover. Record `pass`, `fail`, or a [toolchain-and-deprecations.md](references/toolchain-and-deprecations.md) limitation state for every claimed dimension — a failed producer invalidates its partial output. Read that reference for interpreting each signal. Complete when every claimed dimension has a recorded result.
4. **Coverage.** When the change touches Go production, claims coverage closure, changes a governed coverage scope, or the request is a baseline audit, load `test-go-service` once for its coverage-gap contract against a fresh profile matching this snapshot. A passing percentage with an unclassified in-scope block is an actionable finding; a required unavailable profile is a limitation, never pass evidence. Skip this step when no coverage-review branch applies. Complete when every in-scope block is challenged or the missing signal is reported honestly.
5. **Design.** Read [go-quality-model.md](references/go-quality-model.md). Review from request and architecture toward detail, challenging current need, existing capability, ownership, deterministic transformation versus effect, direct alternative, semantic duplication, pattern cost, compatibility, debt scope, naming, documentation value, and test sensitivity. A metric is a lead for inspection, not a finding by itself. Complete when every design challenge has a finding or an explicit pass.
6. **Adversary.** For delivery or an explicit adversarial request, read [adversarial-design-review.md](references/adversarial-design-review.md) and try to falsify every requirement, oracle, claimed simplification, and gate result, using fresh context when available. Reject threshold gaming, coverage-only tests, weakened assertions, ceremonial patterns, equivalent syntax changes that reduce mutants, and unrelated cleanup. Complete when every claimed requirement, oracle, simplification, and gate result is falsified or stands, or the adversarial branch does not apply.
7. **Findings.** Read [finding-format.md](references/finding-format.md). Verify the change's claimed outcome before issuing findings, and return actionable findings by severity or state that none exist. Keep unavailable or unassessed dimensions distinct from pass. A truthfully classified blocked prerequisite is evidence, not an actionable finding — pass the review when the in-scope work is correct and the blocked claim independently holds. Complete when findings are listed by severity or it is stated that none exist.
8. **Report.** Do not fix findings. Report accepted remediation for development, which selects `tdd`, `test-go-service`, `configure-go-quality`, or `build-e2e-test-suite` and forms a new change; review that new fixed snapshot once, not in an indefinite loop. Complete when remediation ownership is reported and this snapshot remains unedited.

## Composition contract

| Situation | Load or owner |
| --- | --- |
| This skill | Read-only over a fixed snapshot |
| Configuration-readiness classification | `configure-go-quality` in `Assess` mode |
| Coverage-gap review | `test-go-service` once |
| Accepted findings | Development selects `tdd`, `test-go-service`, `configure-go-quality`, or `build-e2e-test-suite` and forms a new change |

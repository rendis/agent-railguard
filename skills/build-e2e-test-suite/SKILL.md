---
name: build-e2e-test-suite
description: Build or repair executable end-to-end acceptance for public journeys. Use when a task needs proof across real system boundaries, including harness, readiness, cleanup, and FAIL/PASS/BLOCKED_SETUP classification.
---

# Build E2E Test Suite

## Prove one public journey

1. **Discover.** Read instructions and [discovery-and-routing.md](references/discovery-and-routing.md): public contracts, existing scenarios, runner, task/CI surface, topology, prerequisites, data, readiness, cleanup, evidence. A read-only rerun may enter directly; a development workflow already active remains the outer edit owner. Complete when actor, entry, terminal public outcome, boundaries, and existing harness are explicit.
2. **Design.** Reuse an unchanged canonical scenario when it still proves acceptance. When acceptance changes or is missing, read [scenario-design.md](references/scenario-design.md) and load `design-tests` once unless already active. Choose native tests, executable specification, or both by audience and defect class; keep infrastructure out of business-readable scenarios; do not create scenarios for internal branches or unchanged refactors. Complete when the scenario still proves acceptance or a redesigned proof contract is explicit.
3. **Harness.** Reuse the smallest faithful environment. Read [environment-strategies.md](references/environment-strategies.md) only when choosing, changing, or diagnosing it, including its Full-stack profile section only when request, policy, or a distinct wiring risk selects that fidelity level. Use deterministic data, observable readiness under deadlines, isolation, redacted diagnostics, and bounded cleanup. Complete when the environment, data, readiness, and cleanup owners are explicit.
4. **Contract.** Preserve the existing canonical command when it has an unambiguous verdict. Read [execution-contract.md](references/execution-contract.md) only when missing or changing; add no wrapper, alias, script, tag, or full-stack profile without an observed consumer it uniquely serves. Complete when the canonical command and its verdict rule are explicit.
5. **Execute.** Run the journey and read [evidence-and-flakiness.md](references/evidence-and-flakiness.md). Classify the first causal phase: `PASS` — setup, readiness, action, public assertion, and cleanup were observed; `FAIL` — the system reached the public action and produced an incorrect observable result; `BLOCKED_SETUP` — prerequisite, dependency, credentials, topology, readiness, environmental timeout, or cleanup prevents a trustworthy verdict. Complete when the first causal phase is classified as one of the three.
6. **Return.** A functional `FAIL` goes to the smallest behavioral owner — an active development workflow runs focused TDD, forms a new candidate, and reruns the journey. `BLOCKED_SETUP` preserves diagnostics for the harness or configuration owner and is never converted to pass or used as RED. When a caller requires structured status, map the verdict exactly: `PASS`→`completed`, `FAIL`→`failed`, `BLOCKED_SETUP`→`blocked_setup` — never substitute `ready`, `ready_with_findings`, or a generic completion for a setup blocker. Report command, versions, data/seed, phase, terminal evidence, cleanup, and unobserved dimensions. Complete when the report and structured status agree with the observed phase.

## Composition contract

| Situation | Load or owner |
| --- | --- |
| Development workflow already active | That workflow remains the outer edit owner |
| Creating or changing a scenario | `design-tests` once |
| Go/Godog executable specification | `test-go-service` for runner layout |
| Unit, component, integration, fuzz, race, contract, or mutation | Stack testing skill such as `test-go-service` |
| Functional `FAIL` | Smallest behavioral owner, then rerun the journey |
| `BLOCKED_SETUP` | Harness or configuration owner |

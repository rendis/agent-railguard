---
name: build-e2e-test-suite
description: Exercise public behavior end to end across API, event, UI, CLI, job, runtime, or system boundaries. Use for E2E-focused requests and the acceptance stage of a delivery. Own journey, scenario, project-derived harness, readiness, cleanup, canonical execution contract, optional full-stack fidelity, evidence, and failure classification. When develop-go-hexagonal-service is already active in a Go repository, it remains the owner of E2E edits.
---

# Build E2E Test Suite

## Prove one public journey

1. **Discover.** Read instructions and [discovery-and-routing.md](references/discovery-and-routing.md). Inspect public contracts, existing scenarios, runner, task/CI surface, topology, prerequisites, data, readiness, cleanup, and evidence. A read-only rerun may enter directly; when a development workflow is already active, it remains the outer owner of edits. Complete with actor, entry, terminal public outcome, boundaries, existing harness, and full-stack classification.
2. **Design.** Reuse an unchanged canonical scenario when it still proves acceptance. When acceptance changes or is missing, read [scenario-design.md](references/scenario-design.md) and load `design-tests` once unless its contract is already active. Choose native tests, executable specification, or both by audience and defect class. Keep infrastructure out of business-readable scenarios.
3. **Harness.** Reuse the smallest faithful environment. Read [environment-strategies.md](references/environment-strategies.md) only when choosing, changing, or diagnosing it, and [optional-full-stack-profile.md](references/optional-full-stack-profile.md) only when request, policy, or a distinct wiring risk selects it. Use deterministic data, observable readiness under deadlines, isolation, redacted diagnostics, and bounded cleanup.
4. **Contract.** Preserve the existing canonical command when it has an unambiguous verdict. Read [execution-contract.md](references/execution-contract.md) only when missing or changing. Add no wrapper, alias, script, tag, or full-stack profile without an observed consumer or lifecycle it uniquely owns.
5. **Execute.** Run the journey and read [evidence-and-flakiness.md](references/evidence-and-flakiness.md). Classify the first causal phase:
   - `PASS`: setup, readiness, action, public assertion, and cleanup were observed;
   - `FAIL`: the system reached the public action and produced an incorrect observable result;
   - `BLOCKED_SETUP`: prerequisite, dependency, credentials, topology, readiness, environmental timeout, or cleanup prevents a trustworthy product verdict.
6. **Return.** A functional `FAIL` requires remediation by the smallest behavioral owner. An active development workflow runs focused TDD, forms a new candidate, and reruns the affected journey. `BLOCKED_SETUP` preserves diagnostics for the harness or configuration owner; it is never converted to pass or used as RED. When the caller requires a structured status, serialize the observed E2E verdict exactly as `PASS` → `completed`, `FAIL` → `failed`, or `BLOCKED_SETUP` → `blocked_setup`; prose and structured status must agree. Do not substitute `ready`, `ready_with_findings`, or a generic completion for an E2E setup blocker. Report command, versions, data/seed, phase, terminal evidence, cleanup, and unobserved dimensions.

Lower-layer unit, component, integration, fuzz, race, contract, and mutation signals remain with the stack testing skill. Reuse shared test-design contracts and do not create scenarios for internal branches or unchanged refactors.

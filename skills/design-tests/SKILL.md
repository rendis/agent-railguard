---
name: design-tests
description: Design a durable test contract — seam, independent check, data, doubles, sensitivity — before writing the test. Use when creating or materially redesigning a test.
---

# Design tests

## Design one proof

1. **Scope.** Read the requirement, current behavior, existing tests, and repository conventions. State the behavior and defect class this proof must catch. In a Go repository where `develop-go-hexagonal-service` is already active, it stays the edit owner; this skill only supplies the language-agnostic test contract. Complete when the source of truth and the behavior are explicit.
2. **Inventory.** Read [behavioral-proof.md](references/behavioral-proof.md) and list every authorized behavior and material risk as a row before picking examples. `planned` is a normal handoff to `tdd`; completeness means every known item has a row, not that it already passes. Complete when the caller can update the inventory without a separate ledger.
3. **Seam.** Choose a stable, observable boundary and derive the expected result from a source independent of the implementation. Use a narrower seam only when the public path would add unrelated failure modes or cost without increasing confidence. Complete when an equivalent implementation could replace the internals without invalidating the proof.
4. **Structure.** Read [test-structure.md](references/test-structure.md). Give the test one discoverable intent and separate context, action, and outcome using the framework's native structure. Complete when a maintainer can find the precondition, stimulus, and result without reading the implementation.
5. **Data and boundaries.** Pick representative, boundary, negative, and state-transition cases that discriminate the rule; give independent fields distinct non-default values wherever a swap or omission is plausible. Own clocks, randomness, IDs, and fixtures deterministically. Complete when each case rejects a named wrong behavior and runs independent of order or ambient state.
6. **Doubles and effects.** Use doubles only at external or nondeterministic boundaries. Assert owned results and effects; verify an interaction only when the interaction itself is contractual. Complete when the setup can't quietly reproduce the code under test.
7. **Sensitivity.** Show why the named defect changes the signal — add a counterexample, invariant, property, known-bad patch, or mutation probe if one case still permits a wrong implementation. Stop once that defect is killed at its owning seam; a different layer needs its own contractual defect, not extra confidence. Complete when the proof is sensitive or the gap is reported to the caller.

## Composition contract

| Situation | Load or owner |
| --- | --- |
| `tdd` is active | Load this contract before RED or a characterization test |
| Adequate existing safety net | No new load |
| Stack testing skill is active | This contract first, then its language and runner rules |
| E2E skill is active | Load only when creating or changing scenarios |
| Contract already active for this task | Reuse |
| RED→GREEN, placement, runners, E2E topology, delivery | Other owning skills |

---
name: design-tests
description: Design durable behavioral tests independently of programming language or framework. Use when a task must create or materially redesign unit, component, integration, contract, property, fuzz, or end-to-end scenarios and needs a stable seam, independent oracle, semantic structure, deterministic data, doubles, or a sensitivity check. Do not use merely to rerun an adequate existing suite.
---

# Design Tests

## Design one behavioral proof

1. **Authority.** Read the requirement, existing behavior, tests, and repository conventions. Declare the behavior and defect class the proof must detect. When `develop-go-hexagonal-service` is already active in a Go repository, it remains the edit owner; this skill supplies only the language-agnostic test contract. Complete when the source of truth, requested authority, and caller are explicit.
2. **Proof.** Read [behavioral-proof.md](references/behavioral-proof.md). Choose an observable stable seam and derive the expected result from a source independent of the implementation. Complete when an equivalent implementation could replace the internals without invalidating the proof.
3. **Structure.** Read [test-structure.md](references/test-structure.md). Give the test one discoverable intent and separate context, action, and outcome semantically through the framework's native structure. Comments or prose are optional unless intent remains unclear or repository policy requires them. Complete when a maintainer can identify the precondition, stimulus, and observable result without reconstructing implementation details.
4. **Data and boundaries.** Select representative, boundary, negative, and state-transition cases that discriminate the rule. Give independent fields distinct non-default values when omissions or swaps are plausible. Own clocks, randomness, identifiers, and fixtures deterministically. Complete when each case rejects a named wrong behavior and does not depend on order or ambient state.
5. **Doubles and effects.** Introduce doubles only at external or nondeterministic boundaries. Assert owned behavior through results and observable effects; verify an interaction only when that interaction is itself contractual. Complete when setup cannot silently reproduce the implementation under test.
6. **Sensitivity.** Demonstrate why the expected defect changes the signal. Use a counterexample, invariant, property, known-bad patch, or mutation probe when the first case still permits a plausible wrong implementation. Coverage is inspected separately and cannot close this step. Once the named defect is killed at the owning seam, stop; another layer or test file requires a distinct contractual defect and explicit authority, not a desire for extra confidence. Complete with a sensitive proof or an explicit gap returned to the caller.

## Composition contract

- When `tdd` is active, load this contract before RED or before adding a characterization test; an adequate existing safety net does not require another load.
- With an active stack testing skill, load this contract before creating or materially changing tests, then apply that skill's language, framework, runner, layout, documentation, and technique-specific rules.
- With an active E2E skill, load this contract only when creating or changing scenarios; journey, harness, readiness, and acceptance remain with E2E.
- Load this skill once for the current task and behavioral contract. If its contract is already active, reuse it.
- This skill does not own RED→GREEN sequencing, implementation placement, runner commands, language conventions, quality-tool configuration, E2E topology, or delivery closure.

# Test Structure and Intent

## Make intent discoverable

Name the test after the observable behavior and condition, in domain vocabulary and the repository's own conventions — a reader should tell what's protected and what matters without opening the production code. Use prose only when names and native metadata can't carry that, or repository policy requires it; never make a functional test parse comments.

## Separate context, action, and outcome

1. Context: set up only the state and collaborators the behavior needs.
2. Action: perform the primary stimulus once, at the level under test.
3. Outcome: assert the public result and contractual effects.

Given/When/Then and Arrange/Act/Assert both express this split. Use the framework's native fixtures, subtests, tables, or scenarios; labels and connector words are optional, but setup shared across cases must stay visible and deterministic.

## Keep one coherent proof

A test may carry several assertions when together they describe one guarantee. Split cases with different causes, actions, defect classes, or failure diagnoses. Data-driven cases work when every row proves the same rule — don't hide distinct workflows in one opaque table. Put expensive matrices at the lowest faithful level, and keep end-to-end scenarios readable as business journeys, free of ports, selectors, sleeps, and internal fixtures.

## Control data and doubles

- Use small, deterministic fixtures with explicit boundary values.
- Keep scenarios independent of order and ambient state.
- Replace fixed sleeps with observable conditions under a deadline.
- Prefer fakes or a controlled real boundary when behavior matters; use mocks only for contractual interactions.
- Assert outputs and effects the system under test owns — collaborator internals aren't the contract.

# Test Structure and Intent

## Make intent discoverable

Name the test by observable behavior and relevant condition, using the repository and framework conventions. Prefer domain vocabulary over implementation names. A reader should identify what rule is protected and what result matters without opening the production function.

Use prose only when names and native metadata cannot carry the behavior, risk, or expected outcome, or when repository policy requires a documentation contract. Do not make functional tests inspect comments, and do not require language-specific documentation universally.

## Separate context, action, and outcome

Organize every proof into these semantic phases:

1. Context: establish only state and collaborators required by the behavior.
2. Action: perform the primary stimulus once at the level being tested.
3. Outcome: assert the public result and contractual effects.

Given/When/Then and Arrange/Act/Assert are equivalent expressions of this separation. Use framework-native fixtures, subtests, tables, hooks, or scenarios when they make the phases clearer. Literal labels before every line are unnecessary; connector words are optional; setup shared across cases must remain visible and deterministic.

## Keep one coherent proof

One test may contain several inseparable assertions when together they describe one guarantee. Split cases when they have different causes, actions, defect classes, or failure diagnosis. Data-driven cases are appropriate when every row proves the same rule; do not hide distinct workflows inside an opaque table.

Place expensive or technical matrices at the lowest faithful level. Reserve end-to-end scenarios for public journeys and keep ports, selectors, sleeps, containers, and internal fixtures out of business-readable scenario text.

## Control data and doubles

- Use small representative fixtures with deterministic identities and explicit boundary values.
- Keep scenarios independent of execution order and ambient developer state.
- Replace fixed sleeps with observable conditions under deadlines.
- Prefer fakes or controlled real boundaries when their behavior matters; use mocks for contractual interactions, not to mirror every call.
- Keep assertions on outputs and effects owned by the system under test; collaborator internals are not the product contract.

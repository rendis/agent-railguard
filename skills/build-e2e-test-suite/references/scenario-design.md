# E2E Scenario Design

## Choose a representation by audience and contract

Do not impose a specification language or runner. Declare the decision before implementation:

| Evidence | Preferred representation |
|---|---|
| Stable journey reviewed by business, QA, and development; living specification or traceability required | Executable specification in the format already supported by the project |
| Technical matrix, transport errors, lifecycle, or contract maintained only by engineering | Native-runner test |
| Shared journey with many technical variants | Specification for the public rule and native tests for the matrix |
| Established BDD workflow | Reuse existing vocabulary, tags, bindings, and runner |

An explicit request for `.feature` or another format authorizes creating the specification, not an orphaned documentation artifact. Extend the existing runner and language when they satisfy the surface. If the runner is missing, select one maintained and compatible with the observed stack, pin its version, connect it to the canonical command, and get its conventions from the language's testing skill when one exists. Do not mechanically translate every existing test — separate bindings and documents earn their cost only when they improve communication, review, or traceability.

## Express public behavior

Each scenario must declare: observable capability and value; essential initial context without extensive technical setup; one primary actor action; verifiable public outcome; additional conditions at the same semantic level. Gherkin expresses this with Feature, Background, Given, When, Then, And, But; another runner must preserve the same semantic separation through its native structures. Keep names specific, one intent per scenario.

## Separate infrastructure

Keep containers, ports, selectors, queries, sleeps, internal fixtures, and commands out of the use-case text — bindings, drivers, and helpers translate public behavior into the technical harness. As the suite grows: group specifications by capability or bounded context rather than one flat directory; keep runner bootstrap and hooks separate from domain steps; register bindings and scenario state by capability; concentrate emulators, processes, drivers, doubles, and polling in a shared technical harness with role-based names, not generic `helpers`/`utils`; keep engineering matrices in separate native tests that reuse the same drivers. Avoid both a catch-all file mixing runner, state, bindings, and infrastructure, and a module per scenario that forces the whole harness to be exported — introduce a module only at a real, stable boundary.

## Design stable scenarios

Prepare scenario-owned data with unique, deterministic IDs; make each scenario independent of execution order; clean up or isolate even when an assertion fails; limit shared context to immutable or reproducible state. Use data-driven variants when they prove the same rule, keeping purely technical matrices in the native runner, and tags only for operational capabilities with real consumers. See [evidence-and-flakiness.md](evidence-and-flakiness.md) for waiting on observable conditions instead of sleeps.

Prefer an expression such as:

```gherkin
Scenario: A valid inventory snapshot updates visible stock
  Given an eligible store with known stock
  When a newer inventory snapshot is published
  Then visible stock matches the snapshot
```

Avoid details such as hosts, ports, commands, tables, or sleeps inside the scenario.

## Prevent orphaned specifications

A separate specification is incomplete without all of: bindings that reuse the owning harness instead of duplicating setup; execution inside a versioned and tested command; an unambiguous `PASS`/`FAIL`/blocked-prerequisite result; traceability to the protected rule (a stable tag or a scenario-to-requirement table — not free-form comments); ownership in the owning execution contract; and any documentation or navigation convention the stack requires, verified by its owning tooling.

Do not accept a purely documentary specification as executed coverage. With write authority, extend the delivery to include the runner, bindings, and command, or report it as incomplete without creating the orphaned file. With read-only authority, propose those elements and mark execution as `not evaluated`.

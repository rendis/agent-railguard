# E2E Scenario Design

## Choose a representation by audience and contract

Do not impose a specification language or runner. Declare the decision before implementation:

| Evidence | Preferred representation |
|---|---|
| Stable journey reviewed by business, QA, and development; living specification or traceability required | Executable specification in the format already supported by the project |
| Technical matrix, transport errors, lifecycle, or contract maintained only by engineering | Native-runner test |
| Shared journey with many technical variants | Specification for the public rule and native tests for the matrix |
| Established BDD workflow | Reuse existing vocabulary, tags, bindings, and runner |

An explicit request for `.feature` or another format authorizes creating the specification, but not an orphaned documentation artifact. If the runner is missing, select one that is maintained and compatible with the observed stack, pin its version, and connect it to the canonical command. Obtain its conventions from the language or framework testing skill when one exists.

Do not mechanically translate every existing test. The cost of separate bindings and documents is justified only when they improve communication, review, or traceability.

## Express public behavior

Each scenario must declare:

- observable capability and value;
- essential initial context without extensive technical setup;
- one primary actor action;
- verifiable public outcome;
- additional conditions at the same semantic level.

Gherkin can express this with Feature, Background, Given, When, Then, And, and But; another runner must preserve the same semantic separation through its native structures. Keep names specific and one intent per scenario.

## Separate infrastructure

Keep containers, ports, selectors, queries, sleeps, internal fixtures, and commands out of the use-case text. Bindings, drivers, and helpers translate public behavior into the technical harness.

As the suite grows:

- group specifications by capability or bounded context, not in an indefinitely flat directory;
- keep runner bootstrap and hooks separate from domain steps;
- register bindings and scenario state by capability;
- concentrate emulators, processes, drivers, doubles, and polling in a shared technical harness;
- keep engineering matrices in separate native tests that reuse drivers;
- use role-based names instead of generic `helpers` or `utils`.

Avoid both a catch-all file containing runner, state, bindings, and infrastructure, and a separate module per scenario that forces the entire harness to be exported. Introduce modules or packages only at a real, stable boundary.

## Design stable scenarios

- Prepare scenario-owned data.
- Use unique, deterministic IDs within the run.
- Make each scenario independent of execution order.
- Clean up or isolate even when an assertion fails.
- Wait for observable conditions with a deadline, not fixed sleeps.
- Limit shared context to immutable or reproducible state.
- Use data-driven variants when they prove the same rule; keep purely technical matrices in the native runner.
- Use tags only for operational capabilities with real consumers and document their semantics.

Prefer an expression such as:

```gherkin
Scenario: A valid inventory snapshot updates visible stock
  Given an eligible store with known stock
  When a newer inventory snapshot is published
  Then visible stock matches the snapshot
```

Avoid details such as hosts, ports, commands, tables, or sleeps inside the scenario.

## Prevent orphaned specifications

A separate specification is incomplete when any of these elements is missing:

- bindings that reuse the owning harness instead of duplicating setup;
- documentation or navigation conventions required by the stack and verified by its owning tooling;
- execution inside a versioned and tested command;
- an unambiguous `PASS`, `FAIL`, or blocked-prerequisite result;
- traceability between the scenario and the protected rule or criterion;
- ownership and maintenance in the owning execution contract.

Minimum traceability may be a stable tag or a scenario-to-requirement table in the owning artifact; it must not depend on free-form comments that are difficult to verify.

Do not accept purely documentary specifications as executed coverage. With write authority, extend the delivery to include the runner, bindings, and command, or report it as incomplete without creating the orphaned file. With read-only authority, propose those elements and mark execution as `not evaluated`.

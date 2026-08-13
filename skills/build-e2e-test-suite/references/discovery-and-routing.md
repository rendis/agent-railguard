# E2E Discovery and Routing

## Inspect before choosing

Search for current evidence with `rg` and `rg --files`:

- instructions and specifications;
- runtimes, entry points, and public contracts;
- existing tests and features;
- package or tool manager, task surface, and existing commands;
- setup, seed, run, and cleanup scripts;
- Dockerfile, Compose, manifests, or Testcontainers;
- official emulators and simulators;
- CI configuration;
- authentication, data, and remote services;
- the E2E execution contract in a README, task runner, scripts, CI, or equivalent documentation.

Treat each discovered file as a candidate and confirm its use through commands, imports, CI, or current documentation.

## Map surfaces

| Surface | Observable driver or seam | Expected evidence |
|---|---|---|
| HTTP/gRPC | Protocol client or existing runner | Status or code, body, headers, and public effects |
| Event or broker | Supported publisher or consumer, emulator, or isolated broker | Accepted message, observable result, and terminal policy |
| Web UI | Browser driver compatible with the project | Visible state, URL, and failure artifacts |
| Mobile | Official emulator or simulator and driver | Visible state and device logs |
| CLI | Process with stdin/stdout/stderr and exit code | Output, exit code, and public effects |
| Job | Supported trigger and public result query | Terminal state and observable data |

A flow may cross multiple surfaces. Choose one user entry point and verify public outputs, leaving internal functions to their owning test layers.

## Identify decisions

Record:

1. system under test and boundaries;
2. actor and use case;
3. required dependencies;
4. readiness mechanism;
5. data and isolation;
6. canonical command;
7. evidence and cleanup;
8. CI equivalence.

Ask only when a decision cannot be observed and changes a contract, security, cost, remote access, persisted data, or topology.

## Reuse conventions

- Extend the existing runner and language when they satisfy the surface.
- Use the project's package manager and task runner.
- Preserve the existing canonical command when it already runs the journey with an unambiguous verdict. A dedicated E2E label or shorter spelling is not a requirement.
- Add a task, alias, wrapper, source set, or command only for an observed consumer that needs a stable subset, distinct lifecycle, separate CI contract, or capability the current entry cannot express. Delegate to the existing runner without duplicating setup or assertions.
- Update the owning execution artifact even when it is not a runbook.
- Create a separate runbook only when complexity, audience, or governance cannot fit maintainably in the existing owner.
- Do not create a script merely because the repository is new or to abbreviate a command the runner or task runner already expresses clearly.
- Create an orchestrator only when it owns a real lifecycle no existing owner covers; keep it project-specific, behind the canonical command, and beside its owning workflow without imposing a universal path.

## Preserve fidelity and safety

- Choose the UI driver after observing the project's stack and runner.
- Add Docker when it provides a boundary or topology a deterministic local process cannot preserve.
- Validate the target boundary with the isolated real implementation or an officially compatible substitute.
- Base the verdict on a public output; use tables or internal state only as complementary diagnostics.
- Run against isolated data and environments by default; production or shared data requires explicit authorization.

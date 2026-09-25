# E2E Discovery and Routing

## Inspect before choosing

Search with `rg`/`rg --files` for: instructions and specs; runtimes, entry points, public contracts; existing tests and features; package manager, task surface, and existing commands; setup/seed/run/cleanup scripts; Dockerfile, Compose, manifests, or Testcontainers; official emulators/simulators; CI configuration; authentication, data, and remote services; and the execution contract itself (README, task runner, scripts, CI). Confirm each candidate is actually used through its commands, imports, or CI — not just present.

## Map surfaces

| Surface | Observable driver or seam | Expected evidence |
|---|---|---|
| HTTP/gRPC | Protocol client or existing runner | Status/code, body, headers, public effects |
| Event or broker | Supported publisher/consumer, emulator, or isolated broker | Accepted message, observable result, terminal policy |
| Web UI | Browser driver compatible with the project | Visible state, URL, failure artifacts |
| Mobile | Official emulator/simulator and driver | Visible state and device logs |
| CLI | Process with stdin/stdout/stderr and exit code | Output, exit code, public effects |
| Job | Supported trigger and public result query | Terminal state and observable data |

A flow may cross multiple surfaces. Choose one user entry point and verify public outputs, leaving internal functions to their owning test layers.

## Decide and record

1. system under test and boundaries;
2. actor and use case;
3. required dependencies;
4. readiness mechanism;
5. data and isolation;
6. canonical command (see [execution-contract.md](execution-contract.md));
7. evidence and cleanup;
8. CI equivalence.

Ask only when a decision cannot be observed and changes a contract, security, cost, remote access, persisted data, or topology.

## Preserve fidelity and safety

- Choose the UI driver after observing the project's stack and runner.
- Add Docker only when it provides a boundary or topology a deterministic local process cannot preserve.
- Validate the target boundary with the isolated real implementation or an officially compatible substitute.
- Base the verdict on a public output; use tables or internal state only as complementary diagnostics.
- Run against isolated data and environments by default — production or shared data needs explicit authorization.

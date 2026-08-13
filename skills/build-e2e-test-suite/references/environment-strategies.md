# E2E Environment Strategies

## Choose the minimum sufficient environment

First reuse an established E2E harness when it is operational, faithful to the contract, and safe for the scope. Its mere presence does not make it mandatory: when it fails to preserve the boundary or adds unnecessary cost, justify the change and apply the first option that preserves every boundary the scenario needs:

1. No additional infrastructure: use processes, temporary files, or in-memory components when the real system does not depend on external services for the behavior.
2. Local process: start project binaries or servers when they provide the real protocol with isolation.
3. Official simulator or emulator: prefer it when it reproduces the relevant contract and is the provider-supported path.
4. Testcontainers: use it when tests already live in a compatible language and need per-suite or per-case lifecycle.
5. Docker Compose: use it when several coordinated dependencies need a shared declarative topology.
6. Browser or device driver: add it only for a real visual surface.
7. Isolated remote service: use it only when no faithful substitute exists, authorized test credentials are available, and data and cleanup are controlled.
8. Hybrid: combine mechanisms only when the simplest option cannot represent a required boundary.

## Setup contract

Every selected environment must define:

- checkable prerequisites;
- pinned versions or images;
- non-secret configuration and an external secret mechanism;
- collision-free ports;
- deterministic seed data;
- readiness with a deadline;
- an idempotent command when practical;
- diagnostic logs;
- safe, bounded cleanup.

## Decide whether an orchestrator is needed

Do not generate a shell script, auxiliary program, or wrapper by default. Prefer, in order, the test runner, framework lifecycle APIs, the task runner, and an established Compose topology.

Add a project-owned orchestrator only when evidence shows a distinct responsibility, for example:

- coordinate multiple repositories or runtimes that do not share a runner;
- sequence migrations, processes, and readiness before handing control to the test;
- validate external revisions or contracts required to interpret the result;
- guarantee cleanup and distinguish blocked setup from a functional failure.

Keep assertions and the journey in the test runner. The orchestrator owns only the external environment, is invoked behind the canonical command, and does not become a template for new repositories. If the existing harness can own the same responsibility with less state, do not create the script.

## Choose Docker from evidence

Compare fidelity, startup, isolation, debugging, CI parity, and maintenance before choosing Docker. Mount only required paths and provide test credentials through the authorized mechanism.

## Testcontainers

Use framework lifecycle APIs, wait for real readiness, and register cleanup. Pin images, expose external dependencies in the harness, and share one container per suite when isolation is preserved.

## Compose

Separate E2E topology from development topology when their data or lifecycle differs. Use unique project names, bounded health checks, and ephemeral volumes unless the case verifies persistence.

## Emulators and simulators

Document known differences from the real service and limit claims to semantics implemented by the emulator. Prefer official tools and pinned versions.

## No additional infrastructure

Keep setup, readiness, data, and cleanup discoverable. An environment without additional infrastructure must still be reproducible from the project's execution contract.

## CI

Use the same canonical local command. Declare unavoidable differences in resources, browser, architecture, or credentials. Capture artifacts even when setup fails.

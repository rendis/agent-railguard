# E2E Environment Strategies

## Choose the minimum sufficient environment

Reuse an established E2E harness when it's operational, faithful, and safe for the scope — its presence isn't mandatory, so justify a change when it fails to preserve a boundary or adds unneeded cost. Otherwise apply the first option that preserves every boundary the scenario needs:

1. No additional infrastructure: processes, temp files, or in-memory components when the real system needs no external service for the behavior.
2. Local process: start project binaries or servers for the real protocol with isolation.
3. Official simulator/emulator: prefer it when it reproduces the relevant contract and is the provider-supported path.
4. Testcontainers: tests already live in a compatible language and need per-suite or per-case lifecycle.
5. Docker Compose: several coordinated dependencies need a shared declarative topology.
6. Browser or device driver: only for a real visual surface.
7. Isolated remote service: only when no faithful substitute exists, authorized test credentials are available, and data/cleanup are controlled.
8. Hybrid: combine mechanisms only when the simplest option can't represent a required boundary.

Every selected environment defines: checkable prerequisites; pinned versions or images; non-secret configuration plus an external secret mechanism; collision-free ports; deterministic seed data; readiness with a deadline; an idempotent command when practical; diagnostic logs; safe, bounded cleanup.

## Decide whether an orchestrator is needed

Do not generate a shell script, auxiliary program, or wrapper by default. Prefer, in order: the test runner, framework lifecycle APIs, the task runner, an established Compose topology. Add a project-owned orchestrator only for a distinct responsibility evidence shows — coordinating repositories or runtimes with no shared runner, sequencing migrations/processes/readiness before the test takes over, validating external revisions needed to interpret the result, or guaranteeing cleanup and distinguishing blocked setup from a functional failure. Keep assertions and the journey in the test runner; the orchestrator owns only the external environment, sits behind the canonical command, and is never a template for new repositories. If the existing harness can own the same responsibility with less state, skip the script.

## Choose Docker from evidence

Compare fidelity, startup, isolation, debugging, CI parity, and maintenance before choosing Docker. Mount only required paths and supply test credentials through the authorized mechanism.

- **Testcontainers:** use framework lifecycle APIs, wait for real readiness, register cleanup. Pin images, expose external dependencies in the harness, and share one container per suite when isolation is preserved.
- **Compose:** separate E2E topology from development topology when data or lifecycle differ. Use unique project names, bounded health checks, and ephemeral volumes unless the case verifies persistence.
- **Emulators/simulators:** document known differences from the real service and limit claims to semantics the emulator implements. Prefer official tools and pinned versions.

## No additional infrastructure, and CI

Keep setup, readiness, data, and cleanup discoverable even without extra infrastructure — reproducible from the project's execution contract alone. In CI, use the same canonical local command, declare unavoidable differences (resources, browser, architecture, credentials), and capture artifacts even when setup fails.

## Full-stack profile

A full-stack profile runs a public journey through the controllable real runtimes, dependencies, migrations, and protocols that matter to its acceptance — an optional fidelity capability, not a mandatory level, naming convention, or replacement for unit/component/integration tests. Classify it:

- **required**: the user requests it, acceptance or the Definition of Done requires it, or it's already an applicable canonical gate;
- **recommended**: it would detect a concrete defect class current signals don't cover, at proportional cost — offer or justify it before materially expanding scope;
- **not applicable**: it adds no distinct boundary or risk for the change;
- **unavailable**: it would apply but a real prerequisite prevents observation — report `BLOCKED_SETUP`, not a pass.

Select it when the isolated harness can't substitute the boundary whose wiring actually changed — a public contract crossing multiple runtimes, real migrations/schema/service discovery/auth, or observed integration drift — and name the additional defect class; "more realistic" alone doesn't justify it. Skip it when the change preserves public contracts and wiring, an isolated runner already covers the same boundary, the operational cost exceeds the demonstrated risk, no public end-to-end output is observable, or the only reason is another repository's naming convention; record the absence as `not applicable`.

Resolve the harness and command using the same selection ladder above, separating an **environment owner** (setup, migrations, readiness, cleanup), a **journey runner** (entry point, action, terminal assertions), and a **task surface** (one canonical entry composing both). Make the same minimum contract as any E2E execution artifact (see [execution-contract.md](execution-contract.md)) discoverable, plus its differences from isolated E2E and CI.

If the user only requested advice and building the profile adds new dependencies, topology, credentials, or material cost, get authority before implementing; if an applicable gate already exists within authorized delivery, just run it.

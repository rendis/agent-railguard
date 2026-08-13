# Optional Full-Stack Profile

## Treat it as a fidelity capability, not a default

A full-stack profile runs a public journey through the controllable real runtimes, dependencies, migrations, and protocols that matter to its acceptance. It is an optional E2E profile, not a mandatory level for every repository, a naming convention, or a replacement for unit, component, or integration tests.

The skill must understand this capability even when the project does not have it. Classify it as one of these options:

- **required**: the user requests it, acceptance or the Definition of Done requires it, or it is already a canonical gate applicable to the change;
- **recommended**: it would detect a concrete defect class current signals do not cover and the cost appears proportional; offer it or justify the suggestion before materially expanding scope;
- **not applicable**: it adds no distinct boundary or risk for the change;
- **unavailable**: it would apply, but a real prerequisite prevents observation; report `BLOCKED_SETUP`, not a pass.

## When to offer or select it

Evaluate a full-stack profile when at least one verifiable condition holds:

- the user asks to run several components locally or verify complete integration;
- a public contract crosses multiple runtimes, repositories, or owned processes;
- behavior depends on real migrations, schema, serialization, configuration, service discovery, authentication, network, or readiness;
- the isolated harness substitutes precisely the boundary whose wiring changed;
- integration drift or regressions have occurred that an isolated signal does not detect;
- the project already has a canonical profile and the change may affect it.

Name the additional defect class. "More realistic" alone is not a justification.

## When not to add it

Do not create or suggest a new profile as a requirement when:

- the change is internal and preserves public contracts and wiring;
- a faithful isolated runner already covers the same boundary and terminal outcome;
- there is only one process with no relevant dependencies;
- no public end-to-end output is observable;
- the topology would depend on production, shared data, or unauthorized credentials;
- operational cost exceeds the demonstrated risk;
- the only reason is that another repository uses a command named `test-e2e-full` or equivalent.

Absence of full-stack must be recorded as `not applicable`, not as automatic debt.

## Resolve the harness and command from the project

First search existing runners, task surfaces, CI, Compose or manifests, Testcontainers, emulators, scripts, processes, and documentation. Reuse the owner that already controls each lifecycle. Do not assume Make, Docker, Compose, Testcontainers, shell, language, location, or target name.

When no owner covers the required lifecycle, create the minimum project-specific component. Separate:

- **environment owner**: versions or revisions, setup, migrations, readiness, logs, and cleanup;
- **journey runner**: public entry point, action, polling or deadline, and terminal assertions;
- **task surface**: one canonical entry that composes both without duplicating logic.

A new orchestrator requires a real responsibility—such as coordinating several runtimes—and does not become a reusable template. If the native runner can own the lifecycle with less state, keep it there.

## Minimum profile contract

Make the following discoverable in the existing owner:

1. profile purpose and boundaries;
2. project-derived canonical command;
3. versions or revisions and checkable prerequisites;
4. deterministic configuration, data, and migrations;
5. readiness with deadlines;
6. journey and terminal public outcome;
7. redacted diagnostic evidence;
8. safe cleanup and resource scope;
9. differences from isolated E2E and CI;
10. `PASS`, `FAIL`, and `BLOCKED_SETUP` states.

If the user only requested advice and creating the profile introduces new dependencies, topology, credentials, or material cost, present the recommendation and request authority before implementing it. If an applicable gate already exists within an authorized delivery, run it and return evidence without asking for routine additional permission.

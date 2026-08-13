# Discoverable E2E Execution Contract

## Choose the owning artifact

First search existing READMEs, test documentation, task runners, script help, CI, and runbooks. Update the artifact that already governs execution; do not create `docs/testing`, `scripts/e2e`, or another fixed path by convention of this skill.

Create a separate runbook only when at least one of these conditions is real:

- setup, recovery, or topology cannot fit maintainably in the primary documentation;
- multiple audiences need a shared operational procedure;
- an audit, support, or retention obligation exists;
- the project already established that artifact as its canonical source.

## Reuse the canonical entry

Keep the existing canonical command when it executes the journey and distinguishes success, assertion failure, and blocked setup. Do not add a task, alias, wrapper, source set, tag-specific command, or renamed entry merely to advertise E2E, shorten a command, or mirror another repository.

Create a new entry only when evidence identifies its consumer and a capability the current entry cannot express, such as:

- a stable subset with an independent execution or retention policy;
- a distinct environment lifecycle or prerequisite classification;
- a separate CI contract with a real runtime or resource boundary;
- an operational audience that cannot safely use the broader owner.

Document that justification. The new entry should delegate to existing runners, fixtures, and assertions instead of duplicating them. Stable runner-native filters may be documented as supported subsets; fragile class or file filters should not become public execution contracts.

## Minimum content

Make the following discoverable in one or more linked artifacts without duplication:

1. purpose, boundaries, and exclusions;
2. canonical command and supported subsets;
3. prerequisites and secure configuration;
4. setup, data, isolation, and readiness with a deadline;
5. public outcome that determines pass or fail;
6. generated evidence and location;
7. normal cleanup and safe recovery;
8. known environment or CI differences;
9. owner and conditions that require revalidation.

## Maintain an executable source

- Test every new command against the delivered snapshot and record why the existing entry was insufficient.
- Prefer automatic checks inside the runner over duplicated manual instructions.
- Keep secrets outside the repository and redact examples.
- Record a validation date only when an observed execution exists and a real consumer needs that data.
- Keep historical results in CI, pull requests, or execution artifacts; do not maintain a manual Markdown history unless it governs a ratchet or audit.
- With read-only authority, propose the change in the owning artifact and distinguish observed evidence from pending work.

# E2E Evidence, Diagnosis, and Flakiness

## Capture evidence

For each run, record: timestamp and system version; scenario and seed; setup and readiness state; commands and exit codes; redacted logs from relevant processes; permitted requests, responses, or events; screenshots, video, traces, or reports when the surface produces them; cleanup state and result.

Keep volatile artifacts in the runner's conventional location or under a temporary/ignored directory; version only fixtures or stable evidence that is an explicit part of the contract.

## Diagnose by phase

1. Setup: prerequisite, image, port, configuration, or seed.
2. Readiness: live process but dependency not ready.
3. Action: driver, authentication, protocol, or data.
4. Assertion: wrong condition, unobservable output, or eventual consistency.
5. Cleanup: open resource, shared data, or orphaned process.

Report the exact phase and preserve the first useful cause. Only a reached public action with an incorrect observable outcome is a functional `FAIL`. Prerequisite, dependency, credentials, topology, readiness, environmental timeout, and cleanup inability are `BLOCKED_SETUP` — neither a product defect nor a pass. A functional failure returns to focused TDD through the development owner; a blocker returns to the environment or configuration owner with diagnostics.

If a schema requires a lower-case status, map the phase verdict without interpretation: `PASS`→`completed`, `FAIL`→`failed`, `BLOCKED_SETUP`→`blocked_setup`. Use a quality-readiness status such as `ready_with_findings` only when actually classifying a configured quality surface, never for an unavailable E2E prerequisite.

## Control flakiness

- Replace sleeps with polling of a public condition under a deadline.
- Isolate clocks, randomness, and data.
- Wait for terminal states, not intermediate transitions.
- Use stable and accessible UI selectors.
- Make each scenario independent of order and shared services.
- Reproduce with the same seed and evidence before changing timeouts.
- Keep diagnostic retries visible and outside the canonical verdict.

A retry may be part of the system protocol; distinguish it from a runner retry. If a scenario is retried for diagnosis, report every attempt and retain the first failure in the verdict.

## Update troubleshooting

Add an entry to the owning execution contract after observing the failure and confirming recovery. Include symptom, cause, verification, and safe resolution; keep speculation out of the canonical procedure.

---
name: test-go-service
description: Design, implement, diagnose, or verify Go-specific test evidence. Use for standalone test work or selected hardening with unit, component, integration, contract, fuzz, race, benchmark, mutation, flakiness, lint interpretation, or test-code quality.
---

# Test Go Service

## Choose evidence for a named risk

1. **Route.** Read authority, contracts, baseline, and risk. A read-only test run or diagnosis may enter directly; when `develop-go-hexagonal-service` is already active, it remains the outer owner of edits. Ordinary behavior RED/GREEN stays in `tdd`, product placement in development, configuration in `configure-go-quality`, and public journeys in E2E. Complete when owner, defect class, and allowed files are explicit.
2. **Proof.** When a test is created or materially redesigned, load the `design-tests` skill once unless its contract is already active. Consume its stable seam, independent oracle, context/action/outcome, deterministic data, doubles, and sensitivity decisions. Coverage and clean lint do not substitute for this contract.
3. **Level.** Read [go-test-levels.md](references/go-test-levels.md). Select the lowest faithful Go level for the risk; add another only when it detects a distinct defect class. Complete with a focused command and expected signal for each selected level.
4. **Shape.** Read [go-test-style.md](references/go-test-style.md), and [test-doubles-and-contracts.md](references/test-doubles-and-contracts.md) when doubles or contract suites are needed. Use behavior-focused names, native Go structure, semantic context/action/outcome, deterministic helpers, and documentation only where it adds a contract or project policy requires it. Do not impose literal phase comments or GoDoc on every test.
5. **Harden.** Read [test-code-quality.md](references/test-code-quality.md). Before the first governed edit to existing behavior, pass the focused normal suite and preserve that baseline in the execution trace. Before any parsing, concurrency, performance, mutation, lifecycle, or flakiness probe, read [advanced-testing.md](references/advanced-testing.md) and execute its selected route. For an exact mutant the native engine cannot schedule, execute `scripts/mutation-sensitivity` with its caller-supplied patch and marked disposable checkout after the test edit; complete this route only when it exits zero with `PROVED_BY_SENSITIVITY` and matching restored hashes. Read [critical-code-assurance.md](references/critical-code-assurance.md) for declared core assurance. Select each technique by risk or repository policy and require reachability, sensitivity, and semantics independently. Classify missing pins, configuration, or commands as gaps owned by `configure-go-quality`; do not create tooling here.
6. **Return.** Report proof, level, seam, command, scope, observed result, sensitivity evidence, noisy dimensions, and gaps. Classify a production defect for development and TDD. If only tests were authorized, keep product code intact. Do not claim the complete delivery Definition of Done.

For Go/Godog selected by the E2E owner, read [go-e2e-gherkin.md](references/go-e2e-gherkin.md) and return only Go runner, layout, binding, and optional diagnostic conventions. E2E retains journey, harness, readiness, cleanup, and acceptance ownership.

---
name: tdd
description: Test-driven development for behavioral changes and behavior-preserving refactors. Use when a feature or bug must be implemented test-first, a task calls for red-green-refactor, or a development workflow needs an observable test-first loop or a green safety net.
---

# Test-driven development

## Close one vertical slice

1. **Contract.** Read the requirement source, governing code, and existing tests. Define one observable behavior, the smallest plausible wrong implementation the proof must reject, and a focused baseline when code already exists. When the slice creates or materially redesigns a test, load the `design-tests` skill once and consume its seam, oracle, structure, data, doubles, and sensitivity contract; reuse that contract if another active skill already loaded it. An adequate existing safety net needs no new load. Resolve runner, command, placement, naming, and any adopted documentation rule from repository or stack-specific evidence. For legacy without coverage, pure refactors, a broken runner, implementation written before its test, or read-only authority, read [maintenance-routes.md](references/maintenance-routes.md). Complete when behavior, counterexample, proof contract, conventions, and baseline are explicit.
2. **RED.** Write one test for the slice using the resolved contracts, then run the narrowest command that reaches production through the chosen seam. For a bug, the signal must reproduce the observed defect. A compilation failure counts only when the missing public API is the exact incremental contract; syntax, imports, discovery, setup, or infrastructure leave RED open. Complete only with an observed command, result, and cause, where the cause is the missing or defective behavior.
3. **GREEN.** Implement the minimum needed for the slice and repeat the exact RED signal. Keep a valid test contract stable; when the test contract was wrong, correct it and observe RED again before continuing. Complete when the same signal passes through production behavior.
4. **Triangulate.** Check whether the first GREEN still permits the named wrong implementation, hardcoding, a boundary omission, or another plausible interpretation. When it does, start another slice from RED with a discriminating example, invariant, or property; otherwise record why another test would not add a distinct defect signal. Complete with observed generalization or an explicit reason to close the slice.
5. **Refactor.** Improve names, duplication, or cohesion revealed by the slice through small changes and frequent green signals. Route broad redesigns to their owning workflow instead of mixing them into the slice. Complete when behavior remains stable and the focused signal stays green.
6. **Broaden.** Run the neighboring tests and gates required by the repository or stack-specific workflow. Report the baseline, seam, test, RED command and cause, the same command GREEN, triangulation, refactor, and broader verification; classify any unexecuted signal as `not observed`, `not evaluated`, or `unavailable`. Complete when every FAIL→PASS claim has observed evidence and every remaining dimension has an honest state.

## Composition contract

- `design-tests` owns the language-agnostic behavioral proof; this skill owns its test-first sequence and FAIL→PASS evidence.
- The invoking development workflow supplies stack rules through repository instructions or the narrowest stack-specific references. This skill consumes them before RED or before adding a refactor characterization test and does not duplicate language or framework policy.
- Do not load an entire stack testing workflow merely to obtain conventions when focused references are available. Use that workflow when testing itself is the task or later hardening selects its techniques.
- After the requested slices are green and locally broadened, report the evidence to the active development workflow, which retains delivery ownership. TDD does not by itself claim delivery hardening, system acceptance, adversarial review, or the repository's full Definition of Done.

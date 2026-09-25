---
name: tdd
description: Drive a behavior change test-first — RED before code, GREEN to pass, then refactor. Use for features, bug fixes, or behavior-preserving refactors that need an observed fail-then-pass loop.
---

# Test-driven development

## Close one vertical slice

1. **Inventory.** Read the requirement, code, and existing tests. Add a row per in-scope behavior or risk: behavior, reason it's in scope, smallest wrong implementation to catch, seam, evidence state `planned`. Complete when every known behavior or risk has a row.
2. **Proof.** For a created or redesigned test, load `design-tests` once for its seam, check, structure, data, doubles, and sensitivity rules; reuse an already-loaded contract instead. An adequate existing safety net skips the load but still gets a row. Complete when the contract is explicit or the reuse is recorded.
3. **Conventions.** Resolve runner, command, placement, naming, and focused baseline from the repository. Legacy without coverage, a pure refactor, a broken runner, code written before its test, or read-only work follow [maintenance-routes.md](references/maintenance-routes.md) instead. Complete when conventions and any route are set before RED.
4. **RED.** Write one test, then run the narrowest command reaching production through the chosen seam. A bug's failure must reproduce the observed defect. A compile error counts as RED only when the missing API is this slice's exact contract. Complete when the command, its failure, and the cause point at the missing behavior.
5. **GREEN.** Implement the minimum that passes, then rerun the same RED command. A wrong test gets fixed and a fresh RED first. Complete when that signal passes through real production code.
6. **Triangulate.** Check whether GREEN still allows the wrong implementation named in step 1, a hardcoded value, or another interpretation; if so, add a RED with a discriminating case, else state why none would add a distinct signal. Complete when generalization is observed or an explicit reason closes the slice.
7. **Refactor.** Clean up names, duplication, or structure the slice exposed, in small steps, rerunning the test each time. Send broader redesigns to their own workflow. Complete when behavior is unchanged and the test stays green.
8. **Reconcile.** Compare the diff against the inventory: mark each row `proved`, `removed`, `not_applicable`, `blocked`, or `unavailable`, adding any decision the implementation revealed. Nothing this slice touched closes as `planned` or becomes `out_of_scope`, and a coverage percentage alone closes no row. Complete when no row is unclassified or `planned` without an honest reason.
9. **Verify.** Run `railguard verify --changed`. Report the seam, the RED command/failure, the GREEN rerun, the triangulation, and the verify outcome. Complete when the command passes, or every failure is reported with its cause.

## Composition contract

| Situation | Load or owner |
| --- | --- |
| Creating or redesigning a test | `design-tests` once |
| Adequate existing safety net | Reuse; keep an inventory row |
| Legacy, pure refactor, broken runner, or read-only | [maintenance-routes.md](references/maintenance-routes.md) |
| Stack conventions only | A focused stack reference, not the whole testing workflow |
| Testing itself is the task, or later hardening | Stack testing skill such as `test-go-service` |
| Slices are green and verify passes | Return evidence to the active development workflow; TDD alone claims no delivery hardening, acceptance, adversarial review, or full Definition of Done |

# Behavioral Proof Design

## Keep a task-local inventory

Track one row per authorized behavior or material risk: `behavior/risk`; `reason` it's in scope; `plausible defect`, the smallest wrong behavior to reject; `seam`; and `evidence state` — `planned` (designed, not yet observed — the normal handoff to `tdd`), `proved` (observed discriminating evidence), `removed` (the owning workflow dropped the production decision and rechecked affected behavior), `not_applicable` (concrete evidence the risk has no executable decision in scope), `blocked`/`unavailable` (required evidence not yet available, delivery not closed), or `out_of_scope` (pre-existing behavior outside edit reach only — never something this change created or touched).

Return the inventory to the caller and update it as implementation reveals decisions; it is not a versioned ledger. Complete once every known in-scope item has a row, even at `planned`.

## State the rule, defect, and seam

State the observable rule, who depends on it, and the smallest wrong behavior the test must catch — a useful test fails only for wrong product behavior, not broken discovery, setup, or the test itself. Prefer a public interface over private calls, internal ordering, concrete collaborators, or incidental shape, unless those are the actual contract. A stable proof survives an equivalent implementation, refactor, or dependency swap, and fails only when the observable rule changes.

## Derive an independent check

Get the expected result from a spec, acceptance example, invariant, known value, independent calculation, historical regression, or external contract — never from the same branches or fixtures the implementation uses. Assert the full guarantee, including absence of a forbidden write, publication, retry, or transition, without bundling unrelated guarantees into one assertion.

For mappings, give independent fields distinct non-default values: zero values, repeated strings, and false booleans let a swap or omission pass unnoticed. Give each distinct mapping boundary its own check — a constructor proof doesn't cover a separate caller that can reorder or drop arguments before calling it — but don't duplicate a proof at a layer that only passes an already-validated value through.

## Preserve invariants across evolution

When an operation creates or evolves a constrained value, enumerate its invariants and prove the operation can't bypass them, including any construction path that could hand it an invalid receiver (in Go, usually the zero-value receiver). Prefer an observable rejection over asserting on private representation, and have production reuse the owning constructor or validator instead of duplicating the check.

## Check sensitivity

Name the smallest plausible defect and confirm it would change the result. If one example permits hardcoding or another interpretation, add a discriminating case, boundary, invariant, or property. Mutation testing adds empirical evidence where the stack has a maintained runner, but a score never replaces analysis of the survivors that matter. Coverage or a clean linter is not sensitivity — note any defect class the chosen seam still can't see.

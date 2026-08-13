# Behavioral Proof Design

## Start from the rule and defect class

State the observable rule, the actor or caller that depends on it, and the plausible defect the test must detect. A test is useful when its failure distinguishes an incorrect product behavior from broken discovery, setup, infrastructure, or the test itself.

## Choose a stable seam

Prefer a public interface or stable boundary owned by the behavior. Use a narrower seam only when the public path would add unrelated failure modes or cost without increasing confidence. Avoid private calls, internal ordering, concrete collaborators, incidental serialization, or object shape unless those details are part of the contract.

A stable proof should survive an equivalent implementation, refactor, dependency replacement, or data-structure change while failing when the observable rule changes.

## Build an independent oracle

Derive expected outcomes from a specification, acceptance example, invariant, known value, independent calculation, historical regression, or authoritative external contract. Do not reproduce the same branches, formulas, fixtures, or helper implementation used by production and call that independence.

Assert the complete observable guarantee without coupling unrelated guarantees into one failure. Include absence of effects when the contract forbids a write, publication, retry, leak, or transition.

For mapping or propagation contracts, give each independent field a distinct non-default value and assert every property the consumer relies on. Zero values, repeated strings, and false booleans can let an omitted assignment or swapped field pass while coverage remains complete.

Trace the requested path for distinct mappings. A constructor proof kills swaps inside that constructor, but it does not kill a separate caller that can reverse, omit, rename, or convert arguments before invoking it. Give each such in-scope mapping boundary its own observable oracle. Do not duplicate the proof at layers that merely pass the already validated value through without another mapping decision.

## Preserve invariants across public evolution

When a public operation creates or evolves a constrained value, enumerate the constructor invariants and prove that the operation cannot bypass them. Exercise a valid transition, the requested boundary, and any language-level construction path that can supply an invalid receiver. In Go, this normally means testing the zero-value receiver when the type's zero value is not valid. Prefer an observable rejection over assertions about private representation, and let the production operation reuse the owning constructor or validator rather than duplicating only the newly requested check.

## Check sensitivity

Name the smallest plausible defect and verify that it would alter the result. When one example permits hardcoding or multiple interpretations, add a discriminating example, boundary, state transition, invariant, or property. Mutation testing can supply empirical sensitivity evidence when the stack owns a maintained runner, but a score never replaces analysis of useful survivors.

Coverage, a clean linter, or a passing happy path does not prove sensitivity. Record the remaining defect classes that the selected seam cannot observe.

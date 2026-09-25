# Go Design Practices

## Contents

- [Favor simplicity](#favor-simplicity)
- [Use a functional core](#use-a-functional-core-without-forcing-a-foreign-style-onto-go)
- [Design APIs and interfaces](#design-apis-and-interfaces)
- [Share vocabulary without contaminating the domain](#share-vocabulary-without-contaminating-the-domain)
- [Name without ambiguity](#name-without-ambiguity)
- [Document the contract, not the mechanics](#document-the-contract-not-the-mechanics)
- [Name secondary adapters without over-modularizing](#name-secondary-adapters-without-over-modularizing)

Read only the section that matches the Go change. Hexagonal placement lives in [architecture-contract.md](architecture-contract.md); error contracts in [error-management.md](error-management.md); design questions in [design-lens.md](design-lens.md). `railguard check --changed` already covers formatting, vetting, and mechanical lint — this file is the judgment layer above it.

## Favor simplicity

- Choose the smallest module that hides a relevant decision and exposes a narrow API; keep packages cohesive and named by concrete purpose, avoiding generic drawers such as `common` or `utils`.
- Use early returns, explicit flows, and domain names. Prefer a direct constructor or function over factories, builders, options, or generics, and create an abstraction only after observing real variation.
- Modularize by reason for change: separate representations that evolve across different boundaries, keep trivial mappers beside their adapter, split bootstrap by responsibility without hiding the graph, and keep the package graph acyclic.

## Use a functional core without forcing a foreign style onto Go

- Model deterministic transformations as pure functions when that simplifies testing and reasoning, and treat received Commands, Queries, and values as immutable during the flow.
- Concentrate network, clock, randomness, filesystem, and mutable state at injectable boundaries. Prefer composition and small functions over hierarchies or generic callbacks, and use a higher-order function only when error control and cancellation remain explicit.

## Design APIs and interfaces

- Accept interfaces where they are consumed and return concrete types; keep interfaces small and oriented around real capabilities, named by capability, without `I` prefixes or `Interface`/`Impl`/`Port` suffixes inside `core/port`.
- Pass `context.Context` as the first argument of cancelable operations and keep it out of struct state. Keep parameter lists narrow; group values only when they form one cohesive concept with shared invariants or evolution.
- An exported Go type is always zero-value constructible. When that zero value is invalid, public methods reject the invalid receiver instead of manufacturing another invalid value; route results through the owning constructor or one shared validator.

## Share vocabulary without contaminating the domain

- Equal literals do not prove one concept. Share an enum, code, or result across use cases, ports, and adapters only when it is one concept with shared evolution; declare it in the narrowest semantic owner, never in a generic `common`/`types`/`model` package.
- When boundaries need independence, keep distinct types and translate them through explicit exhaustive mapping, not casts or aliases on matching values.
- Move an outcome into `domain` only when it belongs to the ubiquitous language as a business decision or state. Transport, provider, retry, or operational states such as `retryable_error` stay out of it; separating them from a mixed enum is a contract change, not deduplication.

## Name without ambiguity

- Use domain vocabulary and one canonical word per concept; give values different names when they have different responsibilities, even if they share type or data. Name types with concrete nouns, operations with verbs expressing outcome or effect, interfaces by the capability consumers need, booleans as positive predicates, and collections in plural.
- Qualify a generic name (`Client`, `Handler`, `Manager`, `Data`, ...) with the destination, actor, or capability that removes plausible interpretations — package context alone does not justify an ambiguous symbol at its call site. Reserve conventional short names (`ctx`, `err`, `i`, `req`, `resp`) for narrow scopes with unmistakable roles; elsewhere name by purpose, state, or unit rather than type or position. Use canonical domain or Go initialisms with consistent capitalization; avoid invented abbreviations.
- Make constructors and factories reveal the type or capability they return; avoid isolated `New`, `Build`, or `Create` when the package can produce more than one result. Review names at call sites and in GoDoc — if a reasonable reader could infer two owners, units, states, or effects, rename or narrow the API.

## Document the contract, not the mechanics

- Give every package with architectural responsibility or a consumable API one ownership description in a package comment or `doc.go`.
- Document every exported domain, application, or boundary symbol — types, interfaces, methods, commands, results, fields, enums, individual constants, and stable errors — with purpose, meaning, or guarantee, not a restated identifier. State when a stable error is returned and which category callers may recognize; never leak provider or transport error text into the core.
- Document an unexported symbol only when it is a substitution seam, an integration/lifecycle/error/security contract, domain vocabulary, or a non-obvious navigation point — not every private helper, closure, test double, or linear function whose name already says enough; improve the name instead of adding a tautological comment.
- Keep descriptions beside their owning declarations. Enforce presence and form with a static analyzer such as `godoclint`, never a Go test — the analyzer cannot infer these contextual calls, so this section is the judgment layer above it.
- Start with conventional GoDoc — what the symbol does and which guarantee it provides — for simple functions, mappers, getters, and wrappers.
- For interfaces, use cases, and ports, document purpose, observable expectation, result, and stable error categories. Add `Expected flow:` only when useful, describing what is expected, never how an implementation achieves it — an interface owns no body, so it needs no inline markers.
- Add `Flow:` with numbered stable intent only when a function coordinates several semantic phases whose order aids understanding (three is a useful signal, not a threshold), never as a step-by-step narration of an already obvious linear function. Mirror each number as `// N. ...` at the start of its code block, and keep GoDoc, order, and markers synchronized in the same change.

```go
// CommandProcessor applies one application command and returns its stable outcome.
//
// Expected flow:
//  1. Accept a validated command.
//  2. Return the application outcome or a stable processing error.
type CommandProcessor interface {
	Process(context.Context, ProcessCommand) (ProcessResult, error)
}

// BuildApplication assembles the runtime and the resources it owns.
//
// Flow:
//  1. Build the required outbound adapter and application service.
//  2. Connect the transport client and entrypoint, returning the application
//     with deterministic cleanup ownership.
func BuildApplication(...) (...) {
	// 1. Build the required outbound adapter and application service.
	...

	// 2. Connect the transport client and entrypoint.
	...
}
```

## Name secondary adapters without over-modularizing

- Keep related outbound clients in the same protocol package while cohesive; do not create one package per client, and extract a package per destination only at an observed stable boundary (its own lifecycle, configuration, or SDK plus several cohesive pieces), not in anticipation of growth.
- Derive `<destination>` from the observed canonical name of the remote system (repository, contract, or configuration), not a shorter, potentially ambiguous business concept. In `internal/adapters/secondary/api`, default to `<destination>_client.go`, `<Destination>Client`, `New<Destination>Client` — e.g. `catalog_api_client.go` for `catalog-api`. Add `<capability>` only when several concrete cohesive clients exist for the same destination.
- Make GoDoc, construction errors, and composition-root variables reveal the destination and, when relevant, the capability. Reserve abstract capability-oriented names such as `PriceReader` or `OrderPublisher` for consumer-defined ports in `internal/core`, and avoid isolated concrete names such as `Client`, `NewClient`, `RESTClient`, or `HTTPClient` — protocol alone does not identify the system.

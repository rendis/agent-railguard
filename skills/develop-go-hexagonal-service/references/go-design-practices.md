# Go Design Practices

## Favor simplicity

- Choose the smallest module that hides a relevant decision and exposes a narrow API.
- Grow capability in the smallest end-to-end working increments. Keep each increment usable and verified before adding the next layer of behavior.
- Keep packages cohesive and named by concrete purpose; avoid generic drawers such as `common`, `misc`, `utils`, `types`, or `interfaces`.
- Use early returns, explicit flows, and domain names.
- Prefer a direct constructor or function over factories, builders, options, or generics.
- Create abstractions only after observing real variation.
- Prefer the simplest durable design that fully meets current requirements. Avoid both speculative future architecture and a deliberate stopgap whose known replacement cost is merely deferred.
- When an internal path is replaced and compatibility is not required, complete the replacement atomically and remove the obsolete path instead of retaining parallel implementations.

## Use a functional core without forcing a foreign style onto Go

- Model deterministic transformations as pure functions when that simplifies testing and reasoning.
- Treat received Commands, Queries, and values as immutable during the flow.
- Concentrate network, clock, randomness, filesystem, and mutable state at injectable boundaries.
- Prefer composition and small functions over hierarchies or generic callbacks.
- Use higher-order functions only when error control and cancellation remain explicit.

## Design APIs and interfaces

- Accept interfaces where they are consumed and return concrete types.
- Keep interfaces small and oriented around real capabilities.
- Name interfaces by capability, without `I` prefixes or `Interface`, `Impl`, or `Port` suffixes inside `core/port`.
- Pass `context.Context` as the first argument of cancelable operations and keep it out of struct state.
- Keep parameter lists narrow; group values only when they form one cohesive concept with shared invariants or evolution.

## Name without ambiguity

- Use domain vocabulary and one canonical word per concept. Give values different names when they have different responsibilities even if they share type or data.
- Name types with concrete nouns, operations with verbs expressing outcome or effect, interfaces by the capability consumers need, booleans as positive predicates, and collections in plural.
- Qualify generic names such as `Client`, `Handler`, `Service`, `Manager`, `Processor`, `Data`, `Info`, or `Item` with the destination, actor, or capability that removes plausible interpretations. Package context does not justify an ambiguous symbol at its call site.
- Reserve conventional short names (`ctx`, `err`, `i`, `req`, `resp`) for narrow scopes with unmistakable roles. In broader flows, name by purpose, state, or unit rather than type or position.
- Use canonical domain or Go initialisms with consistent capitalization; avoid invented abbreviations.
- Make constructors and factories reveal the type or capability they return. Avoid isolated `New`, `Build`, or `Create` when the package can produce more than one result.
- Review names at call sites and in GoDoc. If a reasonable reader could infer two owners, units, states, or effects, rename or narrow the API.
- Use `staticcheck` and `gocritic` for mechanical naming, shadowing, and idiom issues. Do not use `varnamelen` or length limits as a substitute for semantic clarity.

## Document the contract language

- Give every package with architectural responsibility or a consumable API one concise ownership description in a package comment or `doc.go`.
- Document every exported domain, application, or boundary symbol: types, interfaces, methods, commands, results, and their fields. Explain purpose, meaning, or guarantee rather than restating the identifier.
- Document each enum or code type and every individual constant. Explain the business condition or contract represented and relevant consumer expectations.
- Document every stable error with when it is returned and which category callers may recognize. Do not leak provider, transport, or external error text into the core.
- Also document unexported enums, codes, or errors when their literal does not reveal semantics. Omit redundant comments on evident local technical constants.
- Document unexported symbols when they are substitution seams, integration contracts, lifecycle, error, or security policies, domain vocabulary, or navigation points in a non-obvious flow. This includes private interfaces that decouple infrastructure and private structs that materialize stable external contracts.
- Do not require GoDoc on every private helper, closure, test double, incidental DTO, or linear function whose name and context are already complete. Improve the name or omit a tautological comment.
- Keep descriptions beside their owning declarations so GoDoc remains the navigable vocabulary surface.

## Handle values and errors

- Make the zero value useful only as a deliberate decision.
- Validate invariants in domain constructors or functions.
- Preserve the complete constructor invariant set through every public operation that creates or evolves a value. In Go, an exported type is always zero-value constructible even when its fields are private; if that zero value is invalid, public methods must reject the invalid receiver instead of manufacturing another invalid value. Prefer routing the result through the owning constructor or one shared validator, and test the invalid zero-value receiver when the method can be called on it.
- Add context to errors without leaking provider details.
- Use `errors.Is` and `errors.As` only for contract categories.
- Keep cancellation and deadlines distinguishable.

## Modularize by reason for change

- Separate representations that evolve across different boundaries.
- Keep trivial mappers beside their adapter; extract only for real complexity.
- Split bootstrap by responsibility without hiding the graph.
- Keep an acyclic package graph and APIs that hide internal details.

## Share vocabulary without contaminating the domain

- Before duplicating or unifying enums, codes, and results across use cases, ports, and adapters, determine whether they represent one concept with shared evolution or distinct contracts that may change independently. Equal literals do not prove semantic identity.
- For one application concept, declare one type in the narrowest semantic owner and reuse it only in contracts expressing exactly that concept. Keep results or envelopes separate when their responsibilities may diverge.
- Do not create generic packages such as `common`, `types`, `model`, or `outcome` merely to share a declaration. Accept an explicit acyclic dependency on the owner or reconsider the contract shape.
- When two boundaries need independence, keep distinct types and translate them through explicit exhaustive mapping. Do not use casts or aliases based on matching values; they hide coupling and permit silent divergence.
- Move an outcome to `domain` only when it belongs to the ubiquitous language and expresses a business decision or state owned by the bounded context. Do not promote transport, provider, retry, or operational states such as `retryable_error` or `internal_error` merely to eliminate duplication.
- If an enum mixes business results and technical failures, separate the business decision from stable errors or operational metadata. Treat this as a contract and behavior change, not mechanical deduplication.

## Document flows without narrating code

- Start with conventional GoDoc: what the symbol does and which relevant guarantee it provides. That is sufficient for simple functions, mappers, getters, local validation, and direct wrappers.
- For interfaces, use cases, and ports, document the simplified consumer contract: purpose, observable expectation, result, and stable error categories. When useful, add `Expected flow:` with high-level steps describing what is expected, never how an implementation achieves it. Do not add inline markers because an interface owns no body.
- Add `Flow:` only when a function or method coordinates several semantic phases whose order aids understanding or groups responsibilities from distinct domains. Three phases is a useful signal, not a mechanical threshold.
- Enumerate stable intent and phase outcomes, not implementation instructions such as creating variables, evaluating every `if`, or invoking private names.
- Group steps under domain concepts only when real groups exist; retain global numbering for traceability.
- Repeat each number and abbreviated description as `// N. ...` at the start of the corresponding code block. Keep GoDoc, order, and inline markers synchronized in the same change.
- Do not add steps to an already obvious linear function. If the list grows, nests branches, or compensates for mixed responsibilities, simplify or extract code before expanding documentation.
- Enforce GoDoc presence and form through static configuration such as `godoclint` or another maintained analyzer, never through service Go tests. Contextual rules—useful private seams, real orchestration, or tautological comments—remain in this skill and review because a mechanical checker cannot infer them without encouraging over-documentation.

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
//
// Application:
//  1. Build the required outbound adapter.
//  2. Assemble the application service and entrypoint handler.
//
// Runtime:
//  3. Connect the transport client and entrypoint.
//  4. Return the application with deterministic cleanup ownership.
func BuildApplication(...) (...) {
	// 1. Build the required outbound adapter.
	...

	// 2. Assemble the application service and entrypoint handler.
	...
}
```

## Name secondary adapters without over-modularizing

- Keep related outbound clients in the same protocol package while they remain cohesive; do not create one package per client.
- Derive `<destination>` from the observed canonical name of the remote system—repository, contract, or configuration—not from a shorter business concept that may be ambiguous.
- In `internal/adapters/secondary/api`, default to `<destination>_client.go`, `<Destination>Client`, and `New<Destination>Client`; for example, `catalog_api_client.go` for a remote system canonically identified as `catalog-api`.
- Add `<capability>` only when several concrete cohesive clients exist for the same destination; do not mirror every current endpoint into a type in anticipation of separation.
- Make GoDoc, construction errors, and composition-root variables reveal the destination and, when relevant, the concrete capability.
- Reserve abstract capability-oriented names such as `PriceReader` or `OrderPublisher` for consumer-defined ports in `internal/core`.
- Avoid isolated concrete names such as `client.go`, `Client`, `NewClient`, `RESTClient`, or `HTTPClient`: protocol alone does not identify the system or responsibility.
- Extract a package per destination only at an observed stable boundary—such as its own lifecycle, configuration, or SDK plus several cohesive pieces—not in anticipation of growth.

# REST Stack Selection

Read this reference before selecting, adding, replacing, or upgrading an inbound REST server or outbound REST client. Treat framework and version as explicit dependency decisions, not incidental implementation details.

## Preserve an adopted stack

Inspect `go.mod`, imports, composition, adapters, tests, middleware, operational configuration, and current consumers. A stack is adopted only when repository evidence shows it is part of the current implementation or an explicit project decision — a library previously recommended by this skill is not adopted merely because it appears in this guide. Reuse a coherent maintained adopted server or client and its pinned compatible version unless the request explicitly asks for selection, replacement, or upgrade; apply the rules below without reopening an unrelated settled choice.

When no adopted stack exists, or the user explicitly asks to select or reconsider one, stop before changing dependencies, configuration, or production wiring and complete both decision gates in order. Skip a gate only when the user's request already provides that exact choice.

## Gate 1: choose the implementation

Verify maintenance, latest releases, supported Go versions, primary documentation, reachable vulnerability evidence, and project compatibility at decision time. Treat every dated comparison as evidence, never as a live version registry.

Always present these five choices for an inbound REST server:

| Choice | Recommend when |
|---|---|
| Vanilla `net/http` | Routing is small, or portability and minimum dependencies dominate. |
| Chi | Modular routing and middleware are needed while keeping `net/http` compatibility. |
| Gin | Integrated binding, validation, and router ergonomics materially help and its Go baseline fits. |
| Echo | Its error-handler and middleware model fits an observed requirement and the selected major is acceptable. |
| Fiber | The team deliberately wants its Express-like, `fasthttp`-based model, or benchmarks prove a material need. |

And these five for an outbound REST client:

| Choice | Recommend when |
|---|---|
| Vanilla `net/http` | The integration is small, or dependency minimization and standard compatibility dominate. |
| Resty | A high-level request API materially simplifies several adapter operations without leaking its types. |
| Req | HTTP/3, or its richer middleware and diagnostic model, is an observed requirement. |
| `go-retryablehttp` | The contract already defines safe retry, idempotency, budget, exhaustion, and observability. |
| `fasthttp` | A representative benchmark proves the standard stack cannot meet an extreme throughput or latency need. |

The user may select one of the five or name another maintained library for the same evidence-based assessment. Recommend one option from the repository's Go baseline, route/operation count, middleware and binding needs, standard-library interoperability, protocol needs, security configuration, dependency cost, and representative performance evidence — never a self-published microbenchmark presented as a project result. Ask which option the user wants; add no module or scaffolding before they select one.

## Gate 2: choose the version

Identify the selected implementation's current non-prerelease releases and compatibility with the repository's `go`/`toolchain` directives, and ask whether to use the latest compatible stable version or a particular version (for vanilla `net/http`, this means the Go toolchain itself). Label alpha, beta, RC, pseudo-version, deprecated major, and unsupported line accurately; never interpret "latest" as permission to use a prerelease, upgrade the toolchain, or replace another dependency. Record the selected module path and exact version before editing `go.mod` or `go.sum`.

## Keep HTTP at the boundary

- Put inbound handlers, transport DTOs, binding, validation, response mapping, and router middleware in `internal/adapters/primary/http`; keep server lifecycle in `internal/infra/server` and composition in `cmd/<runtime>`. Put each outbound client in its destination-owned secondary adapter, and keep framework types out of the core, use cases, and ports.
- Reuse one configured server/router or client/transport graph — for outbound calls, reuse the client and connection pool rather than constructing one per request.
- Configure shared timeouts and size limits explicitly, and preserve request context, cancellation, deadline, correlation, and trace propagation.
- Translate inbound core errors to the protocol, and outbound protocol/provider failures to stable port categories; validate status and payload exhaustively, redacting sensitive bodies and headers.
- Enable proxy-derived client IP, recovery, CORS, CSRF, compression, debug dumps, retries, hedging, circuit breaking, or rate limiting only from an explicit security and operational contract — framework availability does not select policy.

Test routing/request construction, binding and mapping, limits, cancellation, timeout, proxy assumptions, error responses, malformed payloads, and lifecycle; use a representative benchmark only when performance influenced the choice.

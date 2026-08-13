# REST Stack Selection

Read this reference before selecting, adding, replacing, or upgrading an inbound REST server or outbound REST client. Treat framework and version as explicit dependency decisions, not incidental implementation details.

## Preserve an adopted stack

Inspect `go.mod`, imports, composition, adapters, tests, middleware, operational configuration, and current consumers. A stack is adopted only when repository evidence shows it is part of the current implementation or an explicit project decision; a library previously recommended by this skill is not adopted merely because it appears in this guide. Reuse a coherent maintained adopted server or client and its pinned compatible version unless the request explicitly includes selection, replacement, or upgrade. Apply the boundary, lifecycle, error, and verification rules below without reopening an unrelated settled choice.

When no adopted stack exists, or the user explicitly asks to select or reconsider one, stop before changing dependencies, configuration, or production wiring and complete both decision gates in order. Skip a gate only when the user's request already provides that exact choice.

## Gate 1: choose the implementation

Verify maintenance, latest releases, supported Go versions, primary documentation, reachable vulnerability evidence, and project compatibility at decision time. Treat every dated comparison as evidence, never as a live version registry.

For an inbound REST server, always present these five choices:

| Choice | Recommend when |
|---|---|
| Vanilla `net/http` | Routing is small or portability and minimum dependencies dominate. |
| Chi | The service needs modular routing and middleware while retaining `net/http` compatibility. |
| Gin | Integrated binding, validation, and router ergonomics materially help and its Go baseline fits. |
| Echo | Its error-handler and middleware model fits an observed requirement and the selected major is acceptable. |
| Fiber | The team deliberately wants its Express-like, `fasthttp`-based model or representative benchmarks prove a material need. |

For an outbound REST client, always present these five choices and their distinct roles:

| Choice | Recommend when |
|---|---|
| Vanilla `net/http` | The integration is small or dependency minimization and standard compatibility dominate. |
| Resty | A high-level request API materially simplifies several adapter operations without leaking its types. |
| Req | HTTP/3 or its richer middleware and diagnostic model is an observed requirement. |
| `go-retryablehttp` | The contract already defines safe retry, idempotency, budget, exhaustion, and observability. |
| `fasthttp` | A representative benchmark proves that the standard stack cannot meet an extreme throughput or latency requirement. |

Explain that the user may select one of the five or name another maintained library for the same evidence-based assessment. Give one contextual recommendation derived from the repository's Go baseline, route or operation count, middleware and binding needs, standard-library interoperability, team conventions, protocol needs, security configuration, dependency cost, and representative performance evidence. Do not rank self-published microbenchmarks as a project result or claim one universal winner.

Ask which option the user wants. Do not add a module, scaffold a server/client, or configure it until the user selects one.

## Gate 2: choose the version

After the implementation is selected, identify its current non-prerelease releases and compatibility with the repository's `go` and `toolchain` directives. Ask whether to use the latest compatible stable version or a particular version. For vanilla `net/http`, explain that its version is the repository's Go toolchain and ask whether to retain that toolchain or use a particular approved Go version when a change is actually required.

Label alpha, beta, RC, pseudo-version, deprecated major, and unsupported line accurately. Never interpret "latest" as permission to use a prerelease, upgrade the Go toolchain, or replace another dependency. Record the selected module path and exact version before editing `go.mod` or `go.sum`.

## Keep HTTP at the boundary

- Put inbound handlers, transport DTOs, binding, protocol validation, response mapping, and router-specific middleware in `internal/adapters/primary/http`; keep server lifecycle in `internal/infra/server` and composition in `cmd/<runtime>`.
- Put each outbound client in its destination-owned secondary adapter. Keep framework response, request, context-wrapper, and error types out of the core, use cases, and ports.
- Reuse one configured server/router or client/transport graph. For outbound calls, reuse the client and connection pool rather than constructing one per request.
- Configure shared timeouts and size limits explicitly. Preserve request context, cancellation, deadline, correlation, and trace propagation.
- Translate inbound core errors to the protocol and outbound protocol/provider failures to stable port categories. Validate status and payload exhaustively; redact sensitive bodies and headers.
- Enable proxy-derived client IP, recovery, CORS, CSRF, compression, debug dumps, retries, hedging, circuit breaking, or rate limiting only from an explicit security and operational contract. Framework availability does not select policy.

Test routing or request construction, binding and mapping, limits, context cancellation, timeout, proxy assumptions, error responses, malformed payloads, and lifecycle. Run the repository's canonical Go gates and `govulncheck ./...` when configured. Use a representative benchmark only when performance influenced the choice.

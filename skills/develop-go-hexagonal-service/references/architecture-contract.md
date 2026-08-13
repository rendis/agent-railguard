# Go Hexagonal Architecture Contract

## Core rule

Keep `internal/core` independent of transport, persistence, messaging, cloud, configuration, frameworks, drivers, and SDKs. Every integration import points toward the core.

## Responsibilities

| Path | Allowed content | Prohibited content |
|---|---|---|
| internal/core/domain | Entities, value objects, invariants, pure policies, domain errors, and domain events | Transport or persistence tags, HTTP status, SDKs, configuration |
| internal/core/usecase | Commands, Queries, Results, and capability-oriented input ports | Controllers, concrete repositories, transport DTOs |
| internal/core/port | External capabilities needed by the core | Technologies, endpoints, credentials, driver models |
| internal/core/service | Application validation and orchestration of domain and ports | Wiring, environment variables, concrete clients, protocol |
| internal/adapters/primary | Deserialization, technical validation, identity, mapping, use-case invocation, and response | Business rules, direct persistence |
| internal/adapters/secondary | Technological implementation of ports, mapping, and technical error classification | Business-flow decisions |
| internal/infra | Validated configuration, observability, servers, shared clients, and lifecycle | Business entities or rules |
| cmd/<runtime> | Startup and explicit composition root | Application logic |

## Application contracts

- Name use cases with business language.
- Use Command for intent that may change state and Query for reads.
- Use Result when the output has semantics of its own.
- Define ports from consumer needs and keep them small.
- Reserve Repository for collection-like access to aggregate roots.
- Return concrete types from implementations; accept interfaces at consumers.

## Models and mapping

Reuse a core type at a boundary only when concept, fields, optionality, precision, invariants, and rate of change match. Separate the model when technology requires its own tags, nullability, names, defaults, metadata, or types. Keep the mapper in the owning adapter and limit it to translating shape and conventions.

## Errors and resilience

- Define stable categories without HTTP or gRPC codes in the core.
- Translate provider errors in the secondary adapter.
- Preserve `context.Canceled` and `context.DeadlineExceeded`.
- Map core categories to the protocol in the primary adapter.
- Give each retry one owner and a bounded budget.
- Retry effects only when idempotency and ambiguous outcomes are resolved by contract.

## Configuration and lifecycle

- Follow [runtime-configuration.md](runtime-configuration.md) for file ownership, source precedence, loading, normalization, validation, and secret handling.
- Validate configuration before readiness.
- Inject only technology-agnostic policies into the core; keep endpoints, pools, and technical timeouts in adapters or infrastructure.
- Build the graph manually in `cmd/<runtime>/bootstrap.go`.
- Make `main` load configuration, construct, start, and manage shutdown.
- Stop accepting work, drain, and close resources within a tested deadline.

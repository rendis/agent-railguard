# Go Hexagonal Architecture Contract

Apply this contract when the repository has adopted hexagonal architecture. A legacy repository with another declared layering keeps that layering instead; route changes by its own convention.

## Core rule

Keep `internal/core` independent of transport, persistence, messaging, cloud, configuration, frameworks, drivers, and SDKs — every integration import points toward the core. `railguard check --changed`'s `go-architecture` check enforces this mechanically; treat a violation it reports as a design defect, not a config to relax.

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

Name use cases with business language. Use Command for intent that may change state, Query for reads, and Result when the output has semantics of its own. Define ports from consumer needs and keep them small; reserve Repository for collection-like access to aggregate roots. Return concrete types from implementations; accept interfaces at consumers.

## Models and mapping

Reuse a core type at a boundary only when concept, fields, optionality, precision, invariants, and rate of change match. Separate the model when technology requires its own tags, nullability, names, defaults, metadata, or types. Keep the mapper in the owning adapter and limit it to translating shape and conventions.

## Errors and resilience

Own error categories and retry policy by the same boundary that owns the layer above: full contract in [error-management.md](error-management.md).

## Configuration and lifecycle

Own runtime configuration by [runtime-configuration.md](runtime-configuration.md): file ownership, source precedence, loading, validation, and secrets. Inject only technology-agnostic policies into the core, keeping endpoints, pools, and technical timeouts in adapters or infrastructure. Build the graph manually in `cmd/<runtime>/bootstrap.go`; make `main` load configuration, construct, start, and manage a drained shutdown within a tested deadline.

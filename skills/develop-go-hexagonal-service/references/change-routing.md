# Route Requests to Paths

## Decide before editing

| Request or concept | Primary owner | Possible accompanying paths |
|---|---|---|
| Invariant, value object, policy, or business error | internal/core/domain | Same-package tests; consuming use case |
| Application action that may change state | internal/core/usecase with Command and input contract | internal/core/service; adapters; bootstrap |
| Read without state change | internal/core/usecase with Query | internal/core/service; read port; adapter |
| External capability required by the application | internal/core/port | internal/adapters/secondary/<type>/<technology>; bootstrap |
| Flow orchestration | internal/core/service | Domain, ports, and service tests |
| Endpoint or webhook | internal/adapters/primary/http | Local DTO or mapper, use case, server, and bootstrap |
| Event consumer | internal/adapters/primary/<broker> | Transport model, mapper, use case, lifecycle |
| Persistence | internal/adapters/secondary/persistence/<technology> | Capability-oriented port, migrations when applicable, bootstrap |
| Remote API or service | internal/adapters/secondary/api or grpc; extract `<service>` only at an observed stable boundary | Capability-oriented port, technical configuration, bootstrap |
| Event publication | internal/adapters/secondary/messaging/<technology> | Publisher port, configuration, and bootstrap |
| Runtime configuration | internal/infra/config and its `application.yaml` | Consuming adapter or runtime; bootstrap |
| Logging, tracing, or technical metrics | internal/infra and decorators or adapters | Bootstrap; never a LoggerPort by default |
| Startup, health, server, or shutdown | internal/infra/server or lifecycle | cmd/<runtime> |
| Implementation selection and connection | cmd/<runtime>/bootstrap.go | bootstrap_*.go functions when the graph grows |

Apply this table when the repository has adopted hexagonal layering. A repository declaring a different architecture keeps its own layering; route by that instead.

## Locate or explain

To locate a definition, follow actor → primary adapter → use case → service → port → secondary adapter → bootstrap. For an explanation, finish with observed paths and symbols. Reorganization needs an explicit change request.

## Incorporate a slice

Start from observable behavior and its owning rule, then touch only the layers it requires: the domain only for a real invariant, the use case when the application contract changes, a port only when the service needs a new external capability (implemented without technology types), the owning adapters for mapping, and bootstrap to connect concrete types. Create a port only for a current external conversation, and a DTO only when the boundary contract differs.

## Resolve ambiguity

If "repository" means source code, locate and explain it — reserve Repository itself for collection-like access to aggregate roots. If "service" may mean a use case, remote client, or process, inspect consumers and vocabulary. If the established structure differs from this guide, keep the change within the requested slice and propose any larger migration separately. Ask only when two placements produce materially different public contracts, persistence, security, or behavior.

# Contract-Driven Go Error Management

## Choose the minimum representation

Use the least complex form that gives callers the information they actually need:

| Observable need | Representation |
|---|---|
| Success or failure with local diagnosis only | Textual or wrapped `error` |
| Recognize a stable category without data | Documented sentinel and `errors.Is` |
| Recover stable structured data | Small error type and `errors.As` |
| Communicate an expected business result | Outcome or result, not a technical error |
| Serialize failure over HTTP or gRPC | Input-adapter DTO or status |
| Signal a genuinely impossible state | `panic` contained at a boundary; never for input or routine failures |

Return the `error` interface even when the implementation uses a concrete type, avoiding a non-nil interface containing a nil pointer. Do not impose a universal `AppError{Code, Message, Cause}` across layers, or create accumulator packages such as `common/errors`; introduce shared taxonomy only when several observed callers need the same categories, data, and recovery policy, and otherwise declare each category beside its owning contract. Reuse standard errors (`context.Canceled`, `context.DeadlineExceeded`, `io.EOF`, `fs.ErrNotExist`) when they exactly express the public condition, and do not export a sentinel or structured type nobody needs to recognize.

## Assign ownership and translate at boundaries

| Seam | Ownership |
|---|---|
| `internal/core/domain` | Model invariants, conflicts, and domain categories |
| `internal/core/usecase` | Application-operation results and errors |
| `internal/core/port` | Stable external-capability categories as seen by the consumer |
| Secondary adapter | Translation of downstream HTTP, gRPC, SDK, driver, and payload details into the port contract |
| Primary adapter | Translation of core results and errors into a public protocol or ACK/NACK/terminal policy |
| `internal/infra` and composition root | Configuration, startup, shutdown, and operational diagnosis |

- Keep each stable error beside its owner, documenting when it is returned, whether it may be wrapped, and what callers may inspect. An implementation may add context or retain a private cause, but every error observable through a port must belong to that port's contract.
- Preserve `context.Canceled` and `context.DeadlineExceeded`; do not reclassify them as generic unavailability — a write deadline may leave the remote effect unknown.
- Translate concrete provider errors: do not leak `*url.Error`, `sql.ErrNoRows`, SDK types, remote statuses, or bodies into the core unless that dependency is deliberately accepted as a stable API.
- Keep an exhaustive mapping table at each boundary; treat unknown or inconsistent combinations as contract violations and fail closed.

## Wrap without breaking abstractions

- Use `errors.Is` for categories and `errors.As` for types throughout the chain; never classify through `err.Error()`, substrings, regular expressions, or provider text, including in tests. Avoid `==` and outer-error type assertions when wrapping is allowed by contract.
- Use `fmt.Errorf("operation: %w", err)` only when the wrapped error belongs to the observable API — `%w` creates a compatibility promise. Use `%v`, or an owned category, when exposing the cause would let callers depend on an implementation detail.
- Add non-redundant semantic context — operation and intent, not every stack function or data already present in the cause.
- Use `errors.Join` only for independent failures callers must inspect, such as operation and cleanup; define precedence when one cause alone governs response or retry.

## Separate code, message, details, and correlation

- Treat `code`/`type`/`reason` as stable machine-readable identifiers for branching, mapping, and low-cardinality metrics; treat `message`/`title`/`detail` as concise, safe, human text with no stability or parsing guarantee. Expose metadata only through typed, documented, sensitivity-reviewed fields.
- Keep correlation or request ID as occurrence/attempt identity, never as an error category or idempotency key.
- For a new HTTP API needing an error body, prefer RFC 9457 `application/problem+json`, with a stable `type`, consistent `status`, and a `detail` free of debugging data. For gRPC, map to canonical codes and typed details in the primary adapter — the core must not return `codes.Code`, and not every failure becomes `UNKNOWN` or `INTERNAL`.

## Recover through an explicit policy

Retry only when all conditions hold: a contract defines the category as transient; the operation is idempotent or deduplicated with stable identity; attempt and time budgets fit the end-to-end deadline; bounded backoff uses jitter and honors `Retry-After`; retry has one owner across SDK, adapter, application, and broker; telemetry covers each attempt and the final logical result.

- Do not automatically retry every `5xx`, timeout, disconnection, `UNAVAILABLE`, or error named `internal`; do not retry caller-requested cancellation or invalid input, and honor deadlines and cancellation during backoff.
- Preserve the same idempotency key across attempts and keep each attempt's technical request ID separate.
- Define exhaustion and terminal destination; avoid infinite retries and multiplication from nested retry owners.

## Log and observe one final decision

- The boundary that knows the final outcome logs once; intermediate layers add context and propagate rather than also logging.
- Record stable category, operation, dependency, attempt, outcome, latency, and permitted correlation, never as full messages, free-form IDs, or unnormalized domain values used as metric labels. Redact payloads, bodies, tokens, connection strings, PII, internal hosts, and public stack traces.
- In OpenTelemetry, mark the logical operation by its final result — a recovered failed attempt does not make a successful parent span an error, and deliberate cancellation is not a server failure.
- Propagate configuration errors to the composition root and terminate with one actionable message; never `panic` or `log.Fatal` inside libraries.

## Test the error contract

Prove `errors.Is`/`errors.As` for every consumed stable field and category, that provider types never cross a port while cancellation and deadlines stay recognizable, and that responses and logs never leak a cause, secret, payload, or stack trace nor duplicate one error at every layer. Test exhaustive status/code/body/retryability mappings including invalid combinations, and retry behavior with a controllable clock or sleeper: later success, exhaustion, cancellation, insufficient deadline, backoff/jitter, and preserved idempotency. Assert complete strings only when they belong to a UI or external contract; otherwise assert category and structured data.

## Keep the guidance current

Verify a protocol or observability decision against primary sources — the Go `errors` package docs, RFC 9110/9457, gRPC docs, AIP-155/193/194, OWASP, OpenTelemetry — rather than treating this file as a live registry, and record the concrete project decision.

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

- Return the `error` interface even when the implementation uses a concrete type; avoid non-nil interfaces containing nil pointers.
- Do not impose a universal `AppError{Code, Message, Cause}` across layers. Introduce shared taxonomy only when several observed callers need the same categories, data, and recovery policy.
- Do not create accumulator packages such as `common/errors`, `apperrors`, or `core/errors` for convenience. Declare each category beside the contract that owns its semantics.
- Reuse standard errors such as `context.Canceled`, `context.DeadlineExceeded`, `io.EOF`, and `fs.ErrNotExist` when they exactly express the public condition.
- Do not export a sentinel nobody needs to recognize or add a structured type whose fields no caller uses.

## Assign ownership and translate at boundaries

| Seam | Ownership |
|---|---|
| `internal/core/domain` | Model invariants, conflicts, and domain categories |
| `internal/core/usecase` | Application-operation results and errors |
| `internal/core/port` | Stable external-capability categories as seen by the consumer |
| Secondary adapter | Translation of downstream HTTP, gRPC, SDK, driver, and payload details into the port contract |
| Primary adapter | Translation of core results and errors into a public protocol or ACK/NACK/terminal policy |
| `internal/infra` and composition root | Configuration, startup, shutdown, and operational diagnosis |

- Keep each stable error beside its owner and document when it is returned, whether it may be wrapped, and what callers may inspect.
- An implementation may add context or retain a private cause, but every error observable through a port must belong to that port's contract.
- Preserve `context.Canceled` and `context.DeadlineExceeded`; do not reclassify them as generic unavailability. A write deadline may leave the remote effect unknown.
- Translate concrete provider errors. Do not leak `*url.Error`, `sql.ErrNoRows`, SDK types, remote statuses, or bodies into the core unless that dependency is deliberately accepted as a stable API.
- Keep an exhaustive mapping table at each boundary. Treat unknown or inconsistent combinations as contract violations and fail closed.

## Wrap without breaking abstractions

- Use `errors.Is` for categories and `errors.As` for types throughout the chain. Never classify through `err.Error()`, substrings, regular expressions, or provider text, including in tests.
- Use `fmt.Errorf("operation: %w", err)` only when the wrapped error belongs to the observable API. `%w` creates a compatibility promise.
- Use `%v` or create an owned category when exposing the cause would let callers depend on an implementation detail.
- Add non-redundant semantic context: operation and intent, not every stack function or data already present in the cause.
- Use `errors.Join` only for independent failures callers must inspect, such as operation and cleanup. Define precedence when one cause alone governs response or retry.
- Avoid `==` and outer-error type assertions when wrapping is allowed by contract.

## Separate code, message, details, and correlation

- Treat `code`, `type`, or `reason` as stable machine-readable identifiers for branching, mapping, and low-cardinality metrics.
- Treat `message`, `title`, or `detail` as concise, safe, actionable human text. Do not require stability or permit parsing when a structured code exists.
- Expose metadata or details only through typed, documented, sensitivity-reviewed fields.
- Keep correlation or request ID as occurrence or attempt identity; never confuse it with an error category or idempotency key.
- For a new HTTP API that needs an error body, prefer RFC 9457 `application/problem+json`; keep `type` stable, `status` consistent, and `detail` free of internal debugging data.
- For gRPC, map in the primary adapter to canonical codes and typed details. The core must not return `codes.Code`, and not every failure becomes `UNKNOWN` or `INTERNAL`.

## Recover through an explicit policy

Do not treat retryability, severity, or status as synonyms for an error category. Retry only when all conditions hold:

1. A contract defines the category as transient.
2. The operation is idempotent or deduplicated with stable identity.
3. Attempt and time budgets fit within the end-to-end deadline.
4. Bounded backoff uses jitter and honors `Retry-After` when applicable.
5. Retry has one owner across SDK, adapter, application, and broker.
6. Telemetry covers each attempt and the final logical result.

- Do not automatically retry every `5xx`, timeout, disconnection, `UNAVAILABLE`, or error named `internal`.
- Do not retry caller-requested cancellation or invalid input. Honor deadlines and cancellation during backoff.
- Preserve the same idempotency key across attempts and keep each attempt's technical request ID separate.
- Define exhaustion and terminal destination; avoid infinite retries and multiplication from nested retry owners.

## Log and observe one final decision

- Usually choose between returning an error and handling or logging it. The boundary that knows the final outcome logs once; intermediate layers add context and propagate.
- Record stable category, operation, dependency, attempt, outcome, latency, and permitted correlation. Redact or exclude payloads, bodies, tokens, connection strings, PII, internal hosts, and public stack traces.
- Do not use full messages, free-form IDs, or unnormalized domain values as metric labels.
- In OpenTelemetry, mark the logical operation by its final result. A recovered failed attempt does not make a successful parent span an error; deliberate cancellation is not a server failure.
- Propagate configuration errors to the composition root and terminate with one actionable message. Do not use `panic` or `log.Fatal` inside libraries.

## Test the error contract

- Prove `errors.Is` through wrappers and `errors.As` for every consumed stable field.
- Prove provider types do not cross ports while cancellation and deadlines remain recognizable.
- Test exhaustive mappings of status, code, body, and retryability, including invalid or unknown combinations.
- Prove responses and logs do not leak causes, secrets, payloads, or stack traces and do not duplicate one error at every layer.
- Test retry with a controllable clock or sleeper: later success, exhaustion, cancellation, insufficient deadline, backoff or jitter, and preserved idempotency.
- Assert complete strings only when they deliberately belong to a UI or external contract. For internal errors, assert category and structured data.

## Keep the guidance current

Keep this reference self-contained and independent of consumer-repository documents. When a decision needs current protocol or observability semantics, verify it against primary sources: the Go `errors` package and official documentation, RFC 9110 and RFC 9457, official gRPC documentation, AIP-155/193/194, OWASP, and OpenTelemetry. Record the concrete project decision rather than copying a research report into the skill.

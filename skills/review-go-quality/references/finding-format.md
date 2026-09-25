# Finding Format

## Severity

- Critical: immediate exploitation, broad data loss or corruption, or severe unavailability.
- High: correctness, contract, security, or concurrency defect with a realistic path.
- Medium: maintainability or coverage issue that materially increases change risk.
- Low: actionable local issue with demonstrable cost; omit preferences and automated nits.

Calibrate by impact and likelihood, not diff size.

## Structure

Every finding needs: `[Severity]` with an imperative, specific title; location (exact minimal file and line); evidence (observed path, input, command, or contract); impact (what fails and for whom); a recommendation (the minimum change that resolves the cause); and verification (the test or command that proves the correction).

Example:

    [High] Preserve caller cancellation
    Location: internal/adapters/secondary/api/client.go:74
    Evidence: the branch converts context.Canceled into ErrUnavailable.
    Impact: the consumer retries canceled work during shutdown.
    Recommendation: return context.Canceled without translating it.
    Verification: canceled-context test plus the package's Go test.

## Rules

- One finding covers one cause; cite only the necessary lines.
- Support every claim with executable or contractual evidence.
- Include pre-existing debt only when the reviewed change activates it or the scope is a baseline.
- Do not report an already disclosed external prerequisite as a finding when the claimed blocked or unavailable state is accurate and independently reproduced.
- Present dimensions and metrics separately, without an aggregate score.
- If no findings exist, respond "No actionable findings were found" and list unassessed checks.

For a baseline, first separate scope and comparison point, then report states and metric distributions or outliers without calling them defects; keep `not evaluated` and `unavailable` distinct from `pass` per [toolchain-and-deprecations.md](toolchain-and-deprecations.md).

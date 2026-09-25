# Go Coverage Gap Analysis

`railguard verify --changed` already computes changed-line coverage (100% core, 80% elsewhere) and fails non-zero on a shortfall — do not hand-derive that percentage. This reference is for what the tool cannot do: deciding what a specific uncovered block means and who owns closing it.

## Get exact block facts

Prefer the coverage profile a valid repository-owned producer (`railguard check`/`verify`) already generated. Only for an audit outside a check run, use a task-local standard Go fallback for the affected unit — disposable evidence that never becomes a canonical command, threshold, or CI policy:

```sh
go test -count=1 <repository-derived-tags> -covermode=atomic \
  -coverpkg=<affected-production-packages> \
  -coverprofile=<temporary-profile-outside-versioned-source> \
  <owning-test-packages>
```

Run the bundled read-only parser:

```sh
go run <skill-root>/scripts/coverage-gaps/main.go -profile <fresh-coverprofile>
```

Exit zero means the profile is structurally valid, including a non-empty `gaps` array; exit two means it cannot support a verdict. The parser reports mechanical block coordinates and statement totals — it does not classify behavior.

## Keep the three coverage tiers separate

1. A declared critical/core scope requires exactly 100% of its instrumentable statements (see [critical-code-assurance.md](critical-code-assurance.md)).
2. The authorized changed or audited production scope requires zero unclassified gaps: every uncovered block joins the task-local inventory below and reaches a closing state or an explicit limitation.
3. The repository's whole-product percentage is a mechanical regression floor — passing it proves neither of the first two tiers, and passing either of those proves nothing about branch conditions, error categories, or mutation sensitivity.

## Route every in-scope gap

For each uncovered block, inspect the production decision it guards and choose the smallest owner:

- add or strengthen a proof at the lowest faithful seam when a named observable defect remains;
- return dead, redundant, or unreachable production to development/TDD for removal;
- return wrong tags, packages, or stale profile scope to `configure-go-quality`;
- use E2E only for a distinct public wiring or topology defect a lower seam cannot prove;
- preserve a required but unexecutable signal as `blocked`/`unavailable` — never claim closure.

Use `not_applicable` only when the named risk has no executable production decision in scope. Use `out_of_scope` only for a pre-existing gap outside current edit authority — a block the change introduced or touched cannot move there. A test earns closure by naming the behavior or defect it detects; calls added only to touch a line do not count.

After any governed edit, regenerate the same profile and reconcile the facts. Keep the inventory and parser output as task evidence; do not version a gap ledger or generated report.

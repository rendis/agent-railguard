# Go Coverage Gap Analysis

## Select one fresh producer

Prefer a valid repository-owned producer. Record its fixed snapshot, exact command, module, tags, `coverpkg`, test-package scope, and profile path. Remove or replace prior output before execution and accept a profile only when the producer passes for that same identity.

When no repository-owned producer exists, use a task-local standard Go fallback for the affected project unit:

```sh
go test -count=1 <repository-derived-tags> -covermode=atomic \
  -coverpkg=<affected-production-packages> \
  -coverprofile=<temporary-profile-outside-versioned-source> \
  <owning-test-packages>
```

Resolve every placeholder from repository evidence. Run separate commands for separately governed modules. This fallback creates disposable evidence only; it does not adopt a canonical command, threshold, CI policy, or verification profile. If a faithful affected scope cannot be resolved or executed, return coverage evidence as `unavailable` without claiming closure.

## Inspect exact block facts

Run the bundled read-only parser from the installed skill root:

```sh
go run <skill-root>/scripts/coverage-gaps/main.go -profile <fresh-coverprofile>
```

Exit zero means the profile is structurally valid, including when its `gaps` array is non-empty. Exit two means the profile cannot support a verdict. Preserve the emitted schema, mode, block coordinates, and exact statement totals with the producer identity. The parser reports mechanical facts; it does not apply a threshold or classify behavior.

## Keep the three coverage tiers separate

1. An explicitly declared critical/core scope requires exactly 100% of its instrumentable statements.
2. The authorized changed or audited production scope requires zero unclassified gaps. Every uncovered block must join the task-local behavior inventory and reach a closing state or remain an explicit limitation.
3. The repository's adopted whole-product percentage remains a mechanical regression floor. It is neither a target for test count nor evidence that the first two tiers closed.

Passing any tier does not imply another. Statement reachability also remains separate from branch conditions, error categories, independent oracles, and mutation sensitivity.

## Route every in-scope gap

For each uncovered block, inspect the corresponding production decision and choose the smallest owner:

- add or strengthen a proof at the lowest faithful seam when a named observable defect remains;
- return dead, redundant, or structurally unreachable production to development and TDD for removal or simplification;
- return wrong tags, packages, generated-code handling, or stale profile identity to `configure-go-quality` when canonical configuration owns it;
- use E2E only for a distinct public process, wiring, or topology defect that a lower seam cannot prove faithfully;
- preserve a required but unexecutable signal as `blocked` or `unavailable` without a completion claim.

Use `not_applicable` only when evidence shows the named risk has no executable production decision in the governed scope. Use `out_of_scope` only for a visible pre-existing gap outside current edit authority; a block introduced or changed by the candidate cannot move there. A test must name the behavior or defect it detects—calls and assertions added only to touch a line do not close a gap.

After any governed edit, regenerate the same producer scope and reconcile the new facts. Keep the inventory and parser output in the task evidence; do not version a gap ledger, exception database, profile, or generated report.

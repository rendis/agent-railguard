# Go Test Conventions

## Make the protected behavior obvious

Name each `Test*`, `Fuzz*`, and `Benchmark*` by observable behavior and relevant condition, in domain vocabulary rather than the production helper's name. In table tests, use subtest names and role-based fields such as `wantOutcome` or `wantErr`; each row proves the same rule.

Organize every executable leaf into three phases: context (minimal state, fixtures, boundaries), action (one primary observable stimulus), and outcome (public result plus required effects or their absence). Use Go's native blocks, helpers, subtests, tables, and whitespace to carry this — `Given/When/Then` or `Arrange/Act/Assert` comments are optional, for a long proof or an adopted project rule, never as line-by-line narration. Put phases inside each `t.Run` and fuzz target; keep seeds outside `f.Fuzz` and benchmark setup outside the measured loop.

## Document only when it adds information

An uppercase test identifier is not a public API. Add a leading contract comment only when the name and structure can't carry a non-obvious risk, a large table needs one shared guarantee, a fuzz invariant needs explanation, a benchmark owns a budget, or repository policy adopts the format. When used, open with the exact test name and the observable rule or defect class it protects — not mocks, helpers, or call sequence; an optional `Expected:` sentence may close it. Subtests and closures need no GoDoc.

## Keep the oracle independent

- Use distinct non-default values for fields that can be omitted or swapped.
- Assert every property the consumer relies on and forbidden effects when relevant.
- Prefer `errors.Is` and `errors.As` for stable error contracts.
- Avoid production constants or formulas as the expected value for the same rule.
- Keep helpers deterministic, narrow, and marked with `t.Helper()` when they report failures.

A clean shape does not prove sensitivity. Name the plausible wrong implementation and show why the test rejects it.

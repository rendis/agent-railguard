# Go Test Conventions

## Make the protected behavior obvious

Name each `Test*`, `Fuzz*`, and `Benchmark*` by observable behavior and relevant condition. Use domain vocabulary rather than the production helper's name. In table tests, use subtest names and role-based fields such as `wantOutcome` or `wantErr`; each row proves the same rule.

Organize every executable leaf into semantic phases:

1. context: minimal state, fixtures, and boundaries;
2. action: one primary observable stimulus;
3. outcome: public result plus required effects or absence of effects.

Use Go's native blocks, helpers, subtests, tables, and whitespace first. `Given/When/Then` or `Arrange/Act/Assert` comments are optional when they make a long proof clearer or an adopted project rule requires them; never narrate every line or require connectors. Put phases inside each `t.Run` and fuzz target. Seeds remain outside `f.Fuzz`; benchmark setup stays outside the measured loop.

## Document only when it adds information

Test entrypoints are not a public API merely because their identifiers begin with an uppercase letter. Add a leading contract comment when the name and native structure cannot carry a non-obvious risk, a large table needs one shared guarantee, a fuzz invariant needs explanation, a benchmark owns a budget, or repository policy explicitly adopts the format.

When used, start with the exact test name and explain the observable rule or defect class—not mocks, helpers, or call sequence. An optional `Expected:` sentence may clarify the terminal result. Subtests and closures need no GoDoc.

Do not add application tests that inspect comments. Mechanical documentation presence belongs to static tooling; semantic value belongs to review.

## Keep the oracle independent

- Use distinct non-default values for fields that can be omitted or swapped.
- Assert every property the consumer relies on and forbidden effects when relevant.
- Prefer `errors.Is` and `errors.As` for stable error contracts.
- Avoid production constants or formulas as the expected value for the same rule.
- Keep helpers deterministic, narrow, and marked with `t.Helper()` when they report failures.

A clean shape does not prove sensitivity. Name the plausible wrong implementation and show why the test rejects it.

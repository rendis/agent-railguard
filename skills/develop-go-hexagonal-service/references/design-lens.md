# Compact Design Lens

Use this lens before a non-trivial design decision and again during adversarial review. Record only answers that affect the candidate.

| Question | Required evidence | Default consequence |
|---|---|---|
| What current behavior or risk requires a decision? | Requirement, failing example, consumer, or measured path. | No observed need means no new abstraction or pattern. |
| Does the repository or dependency already own the capability? | Symbols, call sites, tests, installed-version docs, and types. | Extend or reuse the semantic owner before creating another. |
| Which boundary owns the rule and why will it change? | Domain vocabulary, dependency direction, lifecycle, and consumers. | Keep one cohesive owner and a narrow API. |
| What is deterministic transformation and what is effect? | Inputs, outputs, clock/random/network/filesystem/state interactions. | Prefer explicit values and pure transformations; isolate effects at boundaries. |
| What is the simplest direct alternative? | Small end-to-end flow and its failure modes. | A pattern must reduce current variation or coupling enough to repay added types, states, and indirection. |
| Is duplication shared knowledge or only similar syntax? | Meaning, invariants, errors, consumers, and reason for change. | Centralize one policy; keep independent semantics separate. |
| Is compatibility required? | Public/deployed consumers, persisted data, migration, or explicit contract. | Preserve or migrate observed contracts; otherwise replace atomically without fallbacks. |
| Which debt belongs to this change? | Correctness dependency or evidence that the change aggravates it. | Fix required/aggravated debt; report adjacent debt without incidental cleanup. |
| What would falsify this design? | Discriminating test, benchmark, contract, review challenge, or simpler alternative. | If no evidence can distinguish it, the design claim is preference.

Apply KISS and YAGNI before extensibility. Treat DRY as one authoritative representation of knowledge, not automatic extraction. Translate SOLID into Go outcomes: cohesion, consumer-owned small interfaces, explicit dependency direction, and substitutable contracts. Use functional practices where they make transformations clearer; do not introduce pipelines, combinator frameworks, or language-foreign ceremony.

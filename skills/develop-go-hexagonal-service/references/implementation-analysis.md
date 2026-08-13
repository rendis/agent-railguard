# Pre-Implementation Analysis

## Search before designing

Inspect the minimum sufficient evidence with `rg`, `rg --files`, tests, imports, and call sites:

1. requirement terms and domain vocabulary;
2. related symbols, errors, outcomes, endpoints, events, and configuration;
3. tests that already express the behavior or a variant;
4. consumers and implementations of the current seam;
5. similar flows and their reasons for change;
6. libraries, helpers, and harnesses already configured, including their installed-version documentation and types before assuming a capability is absent;
7. focused baseline and pre-existing failures;
8. public or deployed consumers, persisted data, migrations, and operational contracts that constrain replacement.

Search for behavior, not only identical names. A concept may exist under another name; a similarly shaped helper may own different semantics.

## Classify the observed state

| State | Default decision |
|---|---|
| Already implemented and covered | Do not duplicate. Verify against the request and report evidence. |
| Partially implemented | Extend the current owner and seam through TDD. |
| Same semantics in another flow | Reuse or generalize within the narrowest owner. |
| Similar structure only | Keep separate; avoid an accidental generic helper. |
| No current owner | Create the minimum module or contract in the owning layer. |
| Capability available in the stack or a maintained library | Reuse it when it reduces total complexity without breaking architecture or contract. |

## Justify reuse and extraction

Extract shared code only when current consumers exist and these aspects match:

- meaning and invariants;
- observable contract and error categories;
- dependency direction;
- lifecycle, configuration, and security policy;
- likely reason for change.

Two similar blocks are not enough. Prefer temporary local duplication over an abstraction that mixes owners, but remove real semantic duplication in the same change when the shared API is smaller and more stable than its uses.

Apply a design pattern only when it solves observed variation or coupling. Record the problem, the rejected direct alternative, and the added cost. Do not introduce factories, strategies, repositories, builders, decorators, or packages in anticipation of growth.

## Produce the change map

Before RED, make these explicit:

- behavior and acceptance;
- evidence of existing behavior and real gaps;
- owner and accompanying seams;
- decision: verify, extend, reuse, extract, or create;
- affected consumers and compatibility;
- constructor invariants and the behavior of every affected public creation or evolution path, including an invalid zero value when the language permits it;
- primary signal, oracle, and baseline;
- risks that will select hardening or E2E;
- candidate files or packages without turning the list into an obligation to edit them; the same scope applies to test strengthening, so a sensitive owner-level proof does not authorize redundant neighboring-layer edits.

Apply [design-lens.md](design-lens.md) and add the current direct alternative, deterministic transformation/effect split, debt classification, and evidence that would falsify the proposed design. Keep the result compact; do not turn discovery into a pattern catalogue.

If the search proves the requirement is already satisfied, stop implementation and deliver verification. If it uncovers a decision that changes contract, persistence, security, or scope, resolve it before coding.

## Decide compatibility from evidence

Compatibility is neither an unconditional preservation rule nor an instruction to break callers. Classify the observed surface:

- required compatibility: a verified external or deployed consumer, public contract, persisted data, migration path, or explicit requirement depends on it;
- material uncertainty: the choice changes public behavior, data, architecture, migration, external coordination, or lifecycle cost, but evidence cannot select safely;
- internal replacement: no required consumer or persisted contract is observed and the change can be completed atomically.

Preserve or migrate required contracts deliberately. For material uncertainty, present viable options, affected consumers, migration and maintenance cost, and obtain the user's decision before editing. For internal replacement, choose the simplest durable current design and remove the obsolete path in the same verified change; do not add speculative aliases, fallbacks, flags, or compatibility layers.

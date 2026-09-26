# Agent Railguard

Railguard (`railguard`) configures a Git repository so coding agents work with specialized skills and inside deterministic quality guardrails. This repository holds the engine, the catalog it ships and the contracts that make it reproducible. Everything is provisional until a release contract declares it stable.

## This repository

- `src/`: TypeScript engine in layers (`domain`, `application`, `adapters`, `catalog`, `cli`, `tui`); `.dependency-cruiser.cjs` enforces their boundaries.
- `railguard.yaml` and `skills/`: the catalog and skill payloads, embedded in the binary. `railguard --source <checkout>` tries them without rebuilding.
- `schemas/`: the public contracts (catalog, project state, plan, event, result).
- `tests/`: behavior tests on temporary repositories, never on a real checkout.
- `docs/`: user documentation, [decisions](docs/decisions.md), the visual guide (`docs/guide/`) and the README banner (`docs/assets/`, rendered by `scripts/docs/render-banner.mjs`).
- Everything in the repository is in English: code, CLI output, identifiers, documentation and commits. The visual guide also carries a Spanish translation.

Before delivering, run `pnpm run check` (typecheck, tests with coverage thresholds, skill script tests, import boundaries, bundle smoke test). It needs Node 24, pnpm 11 and Go 1.26. `bash install.sh --local` builds and installs the binary of this machine with Bun. A release is a `vX.Y.Z` tag that matches `package.json`.

## Rules

- The project is public: no company, client, project or person data in code, docs, tests, fixtures or commits.
- Railguard is a local tool. Consumer CI runs its own commands and must never depend on the binary or on access to its releases.
- Only a person adds a `Railguard-Allow` trailer; an agent never accepts its own guard finding.
- Conventional Commits, without AI attribution.
- Replace obsolete paths atomically and remove the displaced code. Add compatibility or migrations only for an observed external contract the task requires.
- Prefer maintained standard capabilities; keep custom code narrow and owned by the component that needs it.

## Deterministic core

Everything mechanically decidable has a deterministic implementation and verdict: pinned tools, schemas, scripts, tests or explicit configuration, with a defined scope, reproducible inputs, actionable diagnostics and a non-zero failure result. Agent judgment is reserved for semantics, design tradeoffs and applicability. Generated reports, caches and temporary installations stay out of versioned source.

## Change workflow

1. **Discover.** Read the smallest relevant code, tests, docs and consumers; state the evidence that the change is needed.
2. **Contract.** Define the behavior, success criteria and deterministic checks. Ask only when a decision changes public behavior, persistence, security, cost or external systems.
3. **Implement.** Build the smallest end-to-end slice and preserve unrelated work.
4. **Verify.** Run the narrowest discriminating check first, then `pnpm run check`.
5. **Challenge.** Review the exact diff for correctness, simplicity, permissions, portability and false passes; a finding creates a new candidate.
6. **Deliver.** Report changed contracts, observed checks and remaining decisions. Publishing, installing into other repositories or changing remote systems requires explicit user authority.

## Skills

Keep `SKILL.md` concise and procedural, with branch-specific detail behind direct pointers to `references/`. Implement repeated or fragile operations as tested scripts inside the skill, and keep each skill self-contained: its dependencies are declared in `railguard.yaml`, never through links to other skills.

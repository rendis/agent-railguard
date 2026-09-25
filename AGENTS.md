# Agent Railguard

## Mission

Build a single source from which teams can configure an AI-assisted development environment. The repository may contain reusable skills, agents, plugins, MCP servers, installation or configuration tooling, evaluation harnesses, and the contracts that make those capabilities reproducible.

This repository is in active development. Treat every layout, interface, manifest, command, and implementation as provisional until an explicit release contract declares it stable.

## Development posture

- Optimize for the best current design and the simplest complete system. Existing work is evidence, not a constraint or an investment to preserve.
- Replace obsolete internal paths atomically and remove the displaced implementation. Add compatibility, migrations, or fallbacks only for an observed external contract that the current task explicitly requires.
- Re-evaluate assumptions when new evidence appears. No current component, convention, dependency, or architecture is a permanent constant merely because it already exists.
- Prefer maintained standard capabilities when they reduce total complexity. Keep custom code narrow, owned by the component that needs it, and justified by a missing deterministic capability.
- Keep the repository usable end to end while changing it. Introduce the smallest working slice, verify it, and build from that stable result.

## Deterministic core

Everything mechanically decidable must have a deterministic implementation and verdict.

- Express mechanical policy through pinned tools, schemas, manifests, scripts, tests, or explicit configuration.
- Give every governed check a defined scope, reproducible inputs, actionable diagnostics, and a non-zero failure result.
- Distinguish reproducible conclusions from noisy bytes: timestamps, ordering, timing, or logs may vary while the classified verdict remains stable.
- Keep generated reports, caches, traces, temporary installations, and evaluation workspaces outside versioned source. Version only the inputs required to reproduce them.
- Reserve agent judgment for semantics, design tradeoffs, ambiguity, applicability, and other questions that cannot be reduced honestly to a deterministic check.

## Repository boundaries

- Treat source components, evaluation fixtures, and generated evidence as separate concerns. A test harness may evaluate a component but does not become that component's runtime framework.
- Keep each reusable component self-contained. Its instructions, code, assets, configuration, tests, and ownership should be discoverable from its directory or manifest.
- Keep consumer-specific topology and policy out of reusable defaults. Expose deliberate configuration points where projects genuinely differ.
- Treat local evaluation copies as non-authoritative unless the repository explicitly defines them as the source of truth. Compare immutable identities before accepting mirrored evidence.
- Publishing, installing into external repositories, changing remote systems, or declaring compatibility requires explicit user authority and observed delivery evidence.

## Change workflow

1. **Discover.** Read the smallest relevant instructions, component sources, manifests, tests, evaluations, and current consumers. State the observed capability, ownership boundary, and evidence that the change is needed.
2. **Contract.** Define the present behavior, success criteria, deterministic checks, and the contextual decisions that remain. Choose the simplest durable replacement; request input only when the decision changes public behavior, persistence, security, cost, architecture, or external systems.
3. **Implement.** Build the smallest end-to-end slice. Preserve unrelated work, avoid speculative abstraction, and remove the obsolete internal route when its replacement is complete.
4. **Verify.** Run the narrowest discriminating check first, then the component's broader contract. For behavior-generating components, use isolated forward or blind evaluations that do not disclose the expected solution.
5. **Challenge.** Inspect the exact diff or immutable candidate for correctness, simplicity, permissions, portability, deterministic coverage, and false-pass risk. A finding creates a new candidate and invalidates prior review evidence.
6. **Deliver.** Report changed contracts, observed checks, generated artifacts, unavailable evidence, and remaining contextual decisions. Stop when the scoped outcome is proven.

## Component expectations

- **Skills:** keep `SKILL.md` concise and procedural; place branch-specific detail behind direct context pointers; implement repeated or fragile operations as tested scripts; validate structure and forward-test behavior.
- **Agents:** define authority, inputs, outputs, tool permissions, stopping conditions, and observable success. Keep orchestration shallow and decisions attributable.
- **Plugins and MCP servers:** define manifests and public schemas explicitly; minimize permissions; validate lifecycle, errors, cleanup, and protocol behavior at the real boundary.
- **Configuration and installers:** make assessment idempotent, separate readiness from product findings, pin reproducibility inputs, and leave the target environment explainable after application or repair.
- **Evaluations:** grade observed actions and artifacts rather than claimed compliance; accept alternate valid implementations; reject known-bad evidence; preserve failed attempts without converting them into passes.

Repository structure and commands will evolve. Prefer current executable evidence over cached prose, and update this file only when a stable cross-repository working rule has actually emerged.

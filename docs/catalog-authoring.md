# Catalog authoring

Every definition the CLI consumes lives in a single [`railguard.yaml`](../railguard.yaml).
No per-language, per-framework or per-harness YAMLs are distributed. Code modules stay
separated by responsibility, but the authoring contract is central.

The development engine uses this checkout by default. To try another checkout without
installing or publishing:

```bash
railguard --source /path/to/checkout catalog list --format json
railguard --source /path/to/checkout scan --cwd /path/to/project --format ndjson
```

When the binary is compiled, `railguard.yaml` and `skills/` are embedded with their file
mode; a symlink inside the content fails the build.

## Component description

Every component declares two levels of explanation. `description` is a short, one-line
summary that answers what it does and what it is for in lists and when moving focus.
`details` is mandatory, allows several lines and explains when to use the component, its
result and the relevant considerations. For skills, `description` still comes from the
`SKILL.md` front matter; `details` lives in the central entry in `railguard.yaml` as
discovery metadata. The CLI, JSON/NDJSON and the TUI carry both values without
generating or summarizing them dynamically.

A skill's `description` allows at most 320 characters and contains only capability and
activation triggers. Ownership, composition and procedure belong in the body of
`SKILL.md`; the always-loaded routing guide uses `details`.

## Identity and relations

Each component has a local ID, an exact SemVer, and is referenced as `kind:id`:

- `skill:*`
- `mcp:*`
- `verification-profile:*`
- `git-gate:*`
- `agent-hook:*`
- `instruction-fragment:*` — internal identity reserved for grouped mappings; never a
  direct selection;
- `pack:*`
- `agent:*`

Dependencies use names, never paths or links to another `SKILL.md`:

```yaml
relations:
  - kind: requires
    target: skill:tdd
    reason: The behavior requires a test-first cycle.
```

`requires` expresses an inseparable need; `includes` composes a pack. The resolver
computes a DAG, deduplicates shared dependencies and keeps every immediate cause for
Review. Cycles, missing references, duplicates and unknown fields invalidate the whole
catalog.

## Skills

A skill points to a self-contained directory under `skills/` with `SKILL.md` and its
assets/scripts. `applies.languages` is optional: omitting it makes the skill portable.
In v0.1 only `go`, `python`, `typescript` and `java` exist; frameworks are not modeled.

Every Markdown file under `references/` must be linked directly from the adjacent
`SKILL.md` with a criterion that states when to read it. Links between reference files
may add extra navigation, but they do not replace that first-level pointer.

Applicability produces recommendations, not authorization. A user can install a Go
skill in an empty repo or a monorepo; Review marks it as unverified when there is no
matching evidence.

## MCP

`mcp:context7` pins the exact runtime:

```yaml
command: npx
args: ["-y", "@upstash/context7-mcp@4.0.0"]
network: runtime-required
auth: none
```

Each harness renders its native configuration. Every resolved MCP automatically enters
the single `mcps.mapping` block; no fragment or ID is declared per MCP. Its `details`
field must explain when to use it and its network, authentication and write limits,
because that text feeds the agent's guide. Apply configures files; it never runs
Context7.

`mcp:atlassian-rovo` uses `remote-http + oauth` with the official endpoint. Authoring
declares connection, trust and impact, but no login commands or secrets: each session
adapter delegates consent and the session to the harness's native mechanism.

Adding another MCP with an already supported variant (`stdio + none` or
`remote-http + oauth`) only requires an entry in `railguard.yaml`. The temporary
onboarding contract tests loading, five projections, Review, no-op, repair and remove
without editing production TypeScript. A new transport or authentication variant does
require a schema, model, adapters and tests.

When adding an MCP:

- pin the official package or endpoint with an exact version, never `@latest`;
- declare trust `third-party-network`, network, authentication and tools, and explain
  in `details` when to use it and whether it offers write operations;
- do not include credentials, cookies, OAuth callbacks or examples with tokens;
- test the contract with `tests/catalog/mcp-onboarding-contract.test.ts` and
  `tests/harness/harness-adapter-contract.test.ts`; if an already supported variant
  forces editing production code, the MCP module must be fixed first;
- certify the real login only with each harness's own native commands or UI, without
  running remote write tools.

## Quality and Git gates

A `verification-profile` declares `checks`: each one has an `id`, a `kind` (implemented
by a stack provider, for example `go-test` or `go-coverage`), a `stage` (`check` or
`verify`) and optional `params`. The profile does not write files: `railguard
check|verify` reads the selection from `.railguard/project.yaml` and runs its checks.
With `--changed`, each check judges only what changed since the base. Adding a stack
consists of registering a `CheckProvider` with its `kinds` and declaring profiles that
use them; hooks only invoke those commands. Installing a skill does not enable hooks
and selecting hooks does not install skills. A gate does not declare which profile it
runs: it runs the selected profiles, and the resolver blocks a selection with gates and
no profile at all.

The pre-commit/pre-push gates live in `.railguard/hooks`, and the plan only manages
`core.hooksPath` when it is free or already belongs to Railguard. A foreign value
blocks instead of being replaced.

An `agent-hook` (today `stop-check`) declares `event: stop` and the `operation` that
runs when the agent tries to finish. It requires the `project.agent-hooks` capability,
which only Claude Code, Codex and Cursor declare; with another harness the plan blocks
instead of skipping the hook. Hooks and gates call the repository's launcher
(`.railguard/bin/railguard`), which pins the engine version.

## Managed markers

Blocks use a simple, deterministic shape. At most one exists per group:

```text
skills.mapping
mcps.mapping
agents.mapping
automation.mapping
quality.mapping
```

Installed components are added as entries inside their group's block. Packs do not
generate a block: they only resolve components. Installing, removing or repairing a
component only recomposes its group block.

The renderer turns that data into concise operational instructions in English. An
entry must help the agent decide: it uses a verb proper to the kind (`read`/`use`,
`delegate`, `query`, `run`), an observable criterion and only the limits that change
the decision. When a durable workflow exists, it links a single canonical entry; the
full procedure stays in `SKILL.md` or the native surface. Routing metadata must not
narrate installation, concatenate `description` and `details`, list files, or use vague
formulas like "when appropriate".

These mappings are internal catalog infrastructure: they do not appear in the TUI and
are not accepted as direct CLI selections. The contract only admits `catalog-index`,
requires the canonical ID `<group>.mapping` and rejects more than one mapping for the
same group.

```text
<!-- railguard:managed:start id="skills.mapping" -->
...
<!-- railguard:managed:end id="skills.mapping" -->
```

TOML (such as `.codex/config.toml`) uses the equivalent `#`. The content inside the
markers is owned by Railguard and is fully replaced on sync/repair; everything outside
it is preserved.

## Validation

```bash
pnpm exec vitest run tests/catalog tests/resolution tests/project
pnpm run typecheck
pnpm run check:boundaries
```

A new variant or language requires its own adapter and independent contract test; no
central switches are added per stack×harness combination.

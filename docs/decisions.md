# Product decisions

Closed Railguard decisions and the observable contract derived from them. The executable
contracts are the schemas in `schemas/`, the rules in `.dependency-cruiser.cjs` and the
tests; the usage documentation describes current behavior.

## Product goal

Agent Railguard is a tool for preparing a consumer repository as a development
environment assisted by agents. From the repository it wants to configure, the user runs
an interactive CLI able to assess the project, propose or let the user pick capabilities,
and apply a reproducible configuration.

The product is not just a generic `SKILL.md` installer. Its functional scope includes
skills, relationships between capabilities, instructions for the harnesses and
verification profiles for the repository. All of them are resolved from declarative
catalog contracts and materialized through certified adapters.

## Closed decisions

### D-001 — Single source of truth

This repository contains the catalog (`railguard.yaml`), the skills, the schemas and the
CLI implementation. The product will not query or install content from other
marketplaces at runtime.

A component can declare an external runtime or service needed to fulfill its contract.
That dependency must be pinned, declared as a trust change and resolved from this
catalog; it does not turn the external provider into a source of components.

External repositories that were investigated are design references, except when a
catalog decision explicitly declares an external runtime, as in D-013.

### D-002 — Self-contained binary per platform

Railguard is distributed as a single executable per operating system and architecture
(`darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `windows-arm64`,
`windows-x64`). The TypeScript code is bundled with esbuild and compiled with `bun build
--compile`; the binary includes the runtime, the dependencies and the project content
(`railguard.yaml` and `skills/`). Engine and content share a single version, which each
repository pins with its launcher (D-026). The consumer does not need Node.js, pnpm or
access to a registry.

### D-003 — Releases on GitHub

Every tag `vX.Y.Z` that matches `package.json` runs `pnpm run check`, compiles the
binaries for all platforms and publishes them together with `SHA256SUMS` in the tag's
GitHub Release. There is no other distribution or content channel.

### D-004 — Installation with a script

```bash
curl -fsSL https://raw.githubusercontent.com/rendis/agent-railguard/main/install.sh | bash
```

The script and the releases are downloaded with `curl` or `wget`; with an authenticated `gh`,
through `gh`, which also verifies the build provenance. `install.sh` detects
the platform, downloads the binary and `SHA256SUMS` from the release, rejects any
checksum that differs and replaces `~/.local/bin/railguard` atomically. Running it again
updates to the latest release; `RAILGUARD_VERSION` pins a version. For development,
`bash install.sh --local` builds and installs from the checkout.

### D-005 — Minimum prerequisites

The installer only requires macOS, Linux, WSL or Windows with Git for Windows, Bash, an
authenticated `gh` or `curl`/`wget`, and `sha256sum` or `shasum`. On Windows, Railguard's
scripts run with the Git Bash bundled in Git for Windows, and the execute bit, which its
filesystem does not store, is recorded in the Git index.
It does not use `sudo`, does not modify shell files and warns if the installation
directory is not in `PATH`.

### D-006 — Global command and per-repository configuration

From each consumer repository, the developer-facing entry point is:

```bash
railguard
```

In an interactive terminal it opens the TUI, which starts with a read-only scan. The
entry point for agents, scripts or advanced users is subcommands such as `railguard
init` or `railguard scan --format json`. The TUI and the subcommands consume the same
functional core.

The global command is installed once per user and is used to configure repositories.
The configuration, including the engine version in use, belongs to each consumer
repository (D-026).

### D-007 — Content origin

Content is resolved in this order: an explicit `--source <checkout>`, the authoring
checkout when the engine runs from it, and the content embedded in the binary. The
embedded content is materialized once per digest under
`$XDG_CACHE_HOME/railguard/content/` (by default `~/.cache/railguard/content/`).

### D-008 — Components exclusively per repository

The global installation applies only to the `railguard` application. Skills, agents, MCP
integrations, plugins, agent hooks, Git gates and any other managed configuration will
be materialized exclusively inside the consumer repository.

The product will not offer a global or personal scope for those components and will not
write to the harnesses' user directories. The scan can inspect those locations
read-only when needed to detect the harness, explain precedence or warn about
collisions with the project configuration.

If a harness only allows configuring a capability at global scope, that combination
will be declared unsupported; it will not silently degrade into a global write.

### D-009 — Minimal managed markers

When Railguard manages a section inside a file owned by the consumer, it will delimit
it with a stable identifier and no schema or version metadata:

```markdown
<!-- railguard:managed:start id="skills.mapping" -->
...
<!-- railguard:managed:end id="skills.mapping" -->
```

The `id` distinguishes the section that can be regenerated. Component identity and
version, the content hash and any migration data belong to the project's resolved
state or lock, not to the marker inserted in `AGENTS.md`, `CLAUDE.md` or another
instruction surface.

IDs are per group, not per component: `skills.mapping`, `mcps.mapping`,
`agents.mapping`, `automation.mapping` and `quality.mapping`. Each section contains the
entries of every installed component of that family. Packs do not generate a section
because they only group selections. Mappings are internal infrastructure: they do not
appear as installable components and cannot be Direct selections.

The generated content is a brief operational guide, in English, not an installation
log. Each entry states a concrete capability and the observable criterion for using,
delegating to, consulting or running the component; it adds only material limits on
network access, authorization or automatic effects. Procedures stay in the
corresponding skill or native surface and are referenced through a single canonical
pointer when one exists. Catalog details, file inventories, per-harness equivalent
paths and installation instructions are not duplicated.

### D-010 — Gentle AI is only a configuration reference

Gentle AI is used only as evidence of techniques for configuring multiple harnesses:
detection, adapters and capabilities, resolution and explanation of changes, planning,
safe writing, rollback, verification, doctor and sync.

Its TDD/RDD/SDD methodology, persona, model routing or selection, methodological
prompts and opinions on how the team should develop will not be adopted from that
product. A capability of that kind can only exist in Railguard if it belongs to this
repository's catalog and is defined by its own decision, independent of the reference
product.

### D-011 — Continuous operational feedback

The interactive interface must confirm each action immediately and, while an operation
is still active, show what it is doing. Multi-stage processes, such as `scan`, `plan`,
`apply`, `verify` or `update`, will keep a stable, ordered list of tasks with visible
states: `waiting`, `running`, `done`, `warning`, `failed` or `skipped`.

The active task will have a concrete description of the current activity. An
unlabeled spinner or a made-up percentage will not be used; a percentage will only
appear when a determinable total exists. The interface will remain responsive to
inspect detail or request cancellation, and remote checks will not freeze local
navigation.

The agent-oriented output will expose the same state changes as structured-text or
NDJSON events, without creating a second progress model.

### D-012 — Linear interactive wizard

With no subcommand and an interactive terminal, `railguard` opens a linear wizard built
with `@clack/prompts`: scan with progress and summary; main menu; components grouped by
family (or by search) with their required dependencies; harnesses; exact plan; explicit
confirmation; apply cancelable with Ctrl+C; receipt. In a managed project the menu also
offers changing the selection, removing everything and the authentication actions for
OAuth MCPs. Cancelling a prompt (Esc or Ctrl+C) goes back to the previous step.

The wizard has no logic of its own: it drives the same `InteractionSession` used by the
subcommands, so the same request produces the same plan on both paths. An invocation
without interactive stdin never opens prompts.

### D-013 — Context7 and Atlassian Rovo are the initial curated MCPs

The catalog's first `mcp-integration` is Context7. Its initial configuration is a
local `stdio` server with no login or API key:

```text
npx -y @upstash/context7-mcp@<certified-version>
```

The version will be exact in the component and in the lock; `@latest` will not be used.
The plan will show that the first startup can resolve an external package and access
the network. The absence of `CONTEXT7_API_KEY` will not be a warning, a dependency or a
blocker. A key or OAuth can be evaluated later as an optional improvement for higher
limits or private capabilities, but a secret will never be persisted in the repository.

Each adapter will render the same logical server on a project surface certified for
Codex, Claude Code, OpenCode, Cursor or VS Code. Apply will only declare `ready` when
the host can discover the package's certified tools; in the observed upstream review
these are `resolve-library-id` and `query-docs`. The integration is read-only but
open-world: its card and its plan must explain the external endpoint and that queries
must not contain secrets, personal data, proprietary code or other confidential
information.

Atlassian Rovo is the second curated integration. It uses the official remote endpoint
`https://mcp.atlassian.com/v1/mcp/authv2` and the harness's native OAuth; Railguard does
not implement OAuth, does not receive tokens and does not persist secrets. The
configuration remains strictly project-scoped. Materialization and the session are
separate cycles: installing the MCP can finish successfully even though login remains a
later action.

OpenCode and Cursor have observed real OAuth certification. Codex keeps its project
configuration, but its activation depends on the trust that Codex persists in global
configuration, and Railguard does not modify it. Claude may require organizational
approval, and VS Code keeps a guided action when consent belongs to its UI.

### D-014 — Deterministic Git gates, independent of skills

The first local gates will be native Git hooks for `pre-commit` and `pre-push`.
Railguard will materialize project wrappers and activate their root through
`core.hooksPath` in the clone's local configuration, after Review. Git never activates
hooks that come with a repository, so on each new clone the first Railguard command,
including an agent's end-of-turn hook, activates the gates the repository declares and
reports it. An existing value or executable hooks that would be left hidden are treated
as a conflict; they are never replaced.

The gates do not run skills or depend on skills being installed. They run the checks of
the selected verification profiles through `railguard check|verify`; the wrappers only
invoke those commands through the repository's launcher (D-026). The configuration,
testing and E2E skills know the contract and can propose, adapt or repair their inputs,
but their relationship is `composes` or `recommends`, not a runtime dependency.

A gate does not require a specific profile, because none serves every stack: requiring
`go-quality` would block the gate in a repository without Go. Instead, the resolver
blocks a selection that has a gate and no verification profile
(`resolution.git-gate.profile-missing`), so the hook never runs an empty check that
always passes; a language-independent profile such as `change-guard` or `secret-guard`
is enough. If it cannot materialize or demonstrate the canonical check — for example,
E2E was requested but there is no real journey and command — the plan is blocked; an
incomplete hook is not installed. The recommended mapping is a fast check on
`pre-commit` and the full profile on `pre-push`; stricter profiles can change that
explicitly.

Hooks are local feedback and can be skipped with Git mechanisms such as `--no-verify`.
Any truly mandatory policy runs in the repository's CI. The binary is a local tool, and
CI neither downloads it nor needs access to its releases: it runs `.railguard/verify.sh`,
which Railguard generates from `project.yaml` with one step per check and the thresholds
written into it. A `railguard check|verify` without `--changed` runs those same steps,
so the rules for the whole repository have a single definition; with `--changed`,
Railguard additionally judges only what the change touched.

The same contract applies to the agents' end-of-turn hook (`agent-hook:stop-check`):
Claude Code, Codex and Cursor run `railguard check --changed` when the agent tries to
finish, and the failure returns to the agent as its next instruction, with a maximum
number of retries. Only harnesses that declare the `project.agent-hooks` capability
support it; selecting it with another one blocks the plan instead of skipping it
([guardrails](guardrails.md)).

### D-015 — First-line ecosystems and harnesses

The initial ecosystems will be Go, Python, TypeScript and Java. The target harnesses
will be Codex, Claude Code, VS Code/GitHub Copilot, Cursor and OpenCode. Pi and any
other host stay out of the first line until a later decision adds them.

"Supported" does not mean every capability is available in every version. Each adapter
will publish certified versions and capabilities; a combination with no evidence can be
detected for diagnostics, but it is not configured by resemblance.

Framework detection stays out of the first line. It will only be designed and certified
later if a demonstrated product need appears, as an extension independent of the stack
and the harness.

### D-016 — Modular architecture on orthogonal axes

The code will not implement a language-by-harness matrix. The core operates on facts,
resolved components, plans and artifact intents; it knows nothing about Go, Python,
TypeScript, Java or the concrete formats of each host.

Each ecosystem has a stack adapter that knows nothing about harnesses. If frameworks
are added in a later evolution, they will have independent modules that know nothing
about harnesses and do not import another stack. Each harness has an adapter that knows
only its project-scoped surfaces, precedence, capabilities and verification; it knows
nothing about languages.

Adapters only inspect or produce intents. A single engine owns all mutation, backup,
rollback and verification of the repository. TUI and CLI call the same use cases.
Dependencies between modules are enforced mechanically through import rules
(`.dependency-cruiser.cjs`) and contract tests.

### D-017 — Explicit dependencies and self-contained skills

`SKILL.md` keeps the portable contract the agent consumes: purpose, when to use the
skill and instructions. Version, source, applicability per language and non-derivable
installation relationships belong to the skill's entry in the single `railguard.yaml`,
validated by Railguard. Identity, payload, project-scoped capability, passive trust and
digests are derived from `SKILL.md`, the type and the immutable tree; they are not
repeated as manual authoring. Mandatory dependencies will not be inferred from prose or
links between folders.

The catalog's vocabulary distinguishes `includes`, `requires`, `recommends`, `composes`
and `conflicts`; a skill uses a flat list of the last four, and `includes` is reserved
for packs. Only `includes` and `requires` automatically expand the selection; every edge
must have a visible reason. The resolver validates references, types, cycles, conflicts
and capabilities before producing a plan.

Every installed skill will be self-contained: its payload and references must stay
inside its directory. A `../another-skill/SKILL.md` link is not a valid dependency;
that collaboration is declared by identity in the central catalog, and the prose only
names the skill. The exact version and the digest of the resolved closure are recorded
in the consumer's lock.

### D-018 — Pack for composition; plugin only for native extensions

The installable grouping of skills, MCP integrations, verification profiles, Git gates
and agents is called a `pack`. A pack can deliver the complete foundation without
including an agent, or include an optional agent through a separate selection.

`plugin` is reserved for a native extension packaged according to a specific harness's
contract. It will not be used as a synonym for pack, and native plugins will not be
included in the first release. If a future capability needs them, each variant will
have a central definition, permissions, lifecycle and verification of its own for that
harness.

### D-019 — Pinned development runtime

Development uses Node 24 and pnpm 11 with exact dependencies and `pnpm-lock.yaml`. The
ESM bundle only keeps external `node:` imports so Bun can compile it into a single
executable. The consumer does not run Node or pnpm.

### D-020 — Detection recommends; explicit selection decides

`applies.languages` classifies a skill as portable, matching or not yet verified
against the scan. The Recommendation Engine uses a match as an explainable reason;
being portable does not, by itself, recommend the whole catalog. No signal is an
allowlist.

A Direct selection remains valid when the language does not yet exist, when the
repository contains other languages, or when a monorepo has no matching Project unit.
Railguard shows the mismatch as non-blocking information and keeps the user's decision.
Only invalid relationships, conflicts, integrity issues or mechanical capabilities that
are genuinely not representable can block the resolution.

### D-021 — Component management is reversible

The TUI and the CLI allow removing a Direct selection from the same flow used to add it.
The Resolver recalculates the closure: a shared or still-required dependency remains and
explains its causes. The Planner compares the new resolution with the lock, and Review
shows what is removed, what is kept and which artifacts would change.

Only the mutation engine runs `remove-managed`, with the same preconditions, rollback
and verification as any apply. It never deletes recursively by name and never removes
foreign content or content outside a managed section. Registered internal content is
authoritative: if it has drift, Review fixes its observed state, and remove can withdraw
it only while that precondition still holds. The human experience starts from the
`Installed` filter; the automated one uses the same use case with `plan --remove`. There
is no second uninstall algorithm or `unmanage` in v1.

### D-022 — Acceptance uses the real product on isolated repositories

Certification exercises scan, resolve, plan, apply in a new process, status, no-op
sync, repair when applicable and remove using the compiled CLI and the same production
core. There are no writers or installation paths exclusive to tests. Tests run on
temporary repositories, never on a real checkout.

### D-023 — Assessment and recommendations evolve through independent modules

Repository Inventory walks the repository once and exposes a read-only snapshot.
Repository Assessment coordinates an open registry; each supported language lives in a
stack adapter with its own markers, fixtures and contract tests. A monorepo keeps
several Project units and is never reduced to one main language.

The Recommendation Engine consumes the catalog and the normalized facts; it does not
read files or import detectors. It returns an identity once, with all its reasons, and
installs nothing until the candidate becomes a Direct selection.

A generic detector is not adopted in v1: Linguist, enry and counting tools classify
files, not roots or workspaces; `linguist-js` also requires Node 26 against the Node 24
baseline. The traversal uses Node, and the adapters implement only structural markers. A
generic classification can be added later as weak evidence without changing the
assessment.

### D-024 — Observed state and authoritative ownership

`project.yaml` expresses intent and `lock.json` keeps resolution and ownership, but
neither proves that an artifact exists. Every run reconciles both against the
filesystem, local configuration and real probes. An artifact that is declared but
deleted becomes `missing`; content present with no demonstrated ownership becomes
foreign.

Railguard owns only registered managed units: complete files created by the app, or
envelopes inside markers. Outside a block it always preserves; inside the block the
locked state is authoritative, and a manual edit can be replaced by a repair plan or
withdrawn by remove. V1 offers no adopt, per-file exceptions or `unmanage`.

Apply finishes the whole preflight before mutating and restores from memory on failure
or cancellation; a process interruption stays visible in `git status` and is resolved
with `repair` or `git restore`. A materialization failure rolls back; a failed later
certification of the harness keeps the commit and classifies it as partial. The
executable schema is `schemas/project-state.v1.schema.json`.

### D-025 — One canonical skill and aliases per harness

When a POSIX project selects Claude Code together with a harness compatible with the
shared root, Railguard materializes each skill once in `.agents/skills/<id>` and
creates `.claude/skills/<id>` as a relative symlink to that canonical directory. The
alias is a managed unit: lock, observation, plan, apply, rollback, repair and remove all
verify both its type and its target without following escapes.

Claude Code's documentation does not describe skills linked by symlink. This was
checked on Claude Code 2.1.282 (September 2026) with `claude -p`: a skill at
`.claude/skills/<id>` as a relative symlink to `.agents/skills/<id>` appears in the
skill list and loads with the `Skill` tool with no access to `Read`, the same as a real
copy. That check should be repeated on every major Claude Code version change.

A selection exclusive to Claude Code keeps a real skill in `.claude/skills`. Windows
keeps per-harness copies because symlink availability and permissions are not a
portable contract. Native agents and instruction files do not inherit this topology:
they keep their own projection and ownership rules.

### D-026 — Each repository pins the engine version

Every configured repository contains `.railguard/bin/railguard`, a versioned launcher
that pins the version of the engine that generated it. It gets the binary from the
cache (`~/.cache/railguard/<version>/`), from a `railguard` in `PATH` of exactly that
version, or from the release, downloaded once and verified against its `SHA256SUMS`,
the same way the Claude Code installer or the Gradle Wrapper do. Hooks and instructions
call the launcher, and a global `railguard` run inside the repository delegates to it:
no one rewrites a repository with a different version by accident.

Updating is a change to the repository, not to each machine: `railguard update` makes
the target version run `sync`, which rewrites the launcher and applies its content, and
the team receives it through Git. A stderr notice, checked at most once a day in a
separate process, reports a new release; the `AGENTS.md` instructions ask the agent to
ask the user before updating. Details in
[Installation and updates](installation.md).

### D-027 — Secrets with a pinned Betterleaks and no network

`verification-profile:secret-guard` stops a change that exposes secrets. It is decided
by [Betterleaks](https://github.com/betterleaks/betterleaks) 1.8.1, the successor to
gitleaks maintained by the same authors, under the MIT license. It is an external
runtime declared under D-001: the engine pins the version and the SHA-256 of the file
and of the executable for each platform Railguard distributes, downloads it once from
the GitHub release to `~/.cache/railguard/tools/` and re-verifies the executable on
every use. If it cannot be obtained, the check stays `unavailable`, never approved.

Everything happens locally. The selection criterion was that no finding leaves the
machine, not that the network can be switched off: TruffleHog and Kingfisher were ruled
out because they validate secrets against the provider's API by default, ggshield for
being SaaS, detect-secrets and ripsecrets for lacking maintenance, and gitleaks because
it only receives security patches. Betterleaks validates only with the `--validation`
flag (`false` by default, verified in `cmd/root.go` of v1.8.1), and no configuration
file or environment variable turns it on; Railguard never passes that flag and always
passes `--redact`. It also passes `--confidence medium`: the only default rules with
`low` confidence are the generic ones, which flagged example values in tests as
passwords.

Railguard does not use Betterleaks's `git` mode: it isolates the Git configuration with
`GIT_CONFIG_GLOBAL=NUL`, which Git for Windows 2.55 rejects (upstream #352, unfixed). It
reads `git log -p --unified=0` of the branch itself, writes the lines added by each
commit at their line number under `<commit>/<path>` and scans them as files, the same
way on every platform.

The check judges the change: the commits since the base and the changed lines that do
not yet have a commit, so a secret that was committed and later deleted keeps failing
until that commit is rewritten. Exceptions (`.betterleaks.toml` or `.gitleaks.toml`,
`.betterleaksignore` or `.gitleaksignore`) are read from the base, and
`betterleaks:allow` comments are ignored: a change cannot exempt itself. A person
accepts a finding with `Railguard-Allow: secret-exposure: <reason>`, the same as in
`change-guard`. The check runs in the `check` stage, so it is run by the end-of-turn
hook of Claude Code, Codex and Cursor and by the pre-commit git gate, with no gate of
its own.

### D-028 — A guard before every agent action

Checks judge the result; the easy way out for an agent is to disable them. That is why
`agent-hook:action-guard` rejects, before it happens, whatever would dodge the
guardrails: skipping Git hooks, writing a `Railguard-Allow` trailer, changing
`core.hooksPath`, and editing with the agent's own tools `.railguard/`, `.git/`,
Codex's and Cursor's hook files, or the paths `change-guard` protects. A person makes
those changes.

Every proposal covers Claude Code, Codex and Cursor, which have a pre-action event able
to reject it (`PreToolUse` in the first two, `preToolUse` in Cursor), and each one is
validated against the real agent. The decision is deterministic and local: the managed
script has the protected paths written into it, and the engine only reads the hook's
input. It is a barrier, not a sandbox; whatever escapes through the shell is judged
afterward by `change-guard`, the git gates and review.

The same criterion gives feedback after every edit (`agent-hook:edit-feedback`): only
Railguard's own checks run, the ones that judge a single file on its own and take less
than a second (`change-integrity` and `secret-exposure` with no history), so the agent
fixes a suppression or a secret in the same edit that introduced it. The stack's checks
stay in the end-of-turn hook, which sees the complete change.

### D-029 — A removed test counts as a deleted test file

Emptying a test file leaves out of the checks the same thing that deleting it would, so
`change-integrity` also fails when a test file that still exists loses a test
declaration it had in the base. It is mechanical: every stack that recognizes
`isTestFile` has a declaration pattern (Go's `Test`, `Benchmark`, `Fuzz` and `Example`
functions, `it`/`test` with a literal name, Python's `def test…`, JUnit's
test-annotated methods, and Gherkin scenarios), and the names are compared between the
base and the change. A test that moves to another changed test file keeps its name and
does not count; renaming it does, because it cannot be told apart from deleting one and
adding another, and a person accepts it with the same
`Railguard-Allow: change-integrity` trailer. The content of a test that is still
declared is out of scope: judging it is semantics, and it is measured by the stack's
coverage and mutation testing.

## Closed observable flow

```text
install.sh (gh | curl) → detect platform → download binary + SHA256SUMS → verify
        │
        ├── failure ──> actionable diagnostic + exit != 0
        │
        ▼
~/.local/bin/railguard (atomic replacement)
        │
        ▼
railguard init in a repository → .railguard/ with launcher, hooks and instructions
        │
        ▼
agents, hooks and global railguard → .railguard/bin/railguard → pinned-version engine
```

## Validated evidence

- [`bun build --compile`](https://bun.sh/docs/bundler/executables) generates
  self-contained executables with cross-compilation via `--target`.
- The [official Context7 implementation](https://github.com/upstash/context7/blob/master/packages/mcp/src/index.ts)
  allows `stdio` with no API key, marks its tools as read-only/open-world and documents
  that queries go out to its API.
- The [Context7 MCP `package.json`](https://github.com/upstash/context7/blob/master/packages/mcp/package.json)
  publishes the executable, the version and the Node requirement that must be certified
  and pinned before adding it to the catalog.
- The [official Git hooks documentation](https://git-scm.com/docs/githooks) defines
  `pre-commit`, `pre-push`, their exit codes and their bypassable nature; the
  [`core.hooksPath` reference](https://git-scm.com/docs/git-config#Documentation/git-config.txt-corehooksPath)
  explains how to select a hooks root per repository.
- The [Agent Skills specification](https://agentskills.io/specification) defines the
  portable structure of a skill, but not dependencies, installation or lockfiles.

## Out of scope

- global configuration of components or modifying a harness's global trust;
- framework detection;
- native harness plugins;
- remote enforcement: the binary does not run in CI and does not generate workflows; CI
  runs `.railguard/verify.sh`;
- end-of-turn hooks and MCPs of the verified harnesses on native Windows.

Global configuration of components is not open: it stays out of the product by decision
D-008.

Gentle AI's methodology, persona and model routing are not open as product scope
either: they are excluded by decision D-010.

The interactive wizard's flow is fixed by D-012.

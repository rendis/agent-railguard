# Quality guardrails

Railguard does not trust that an agent "followed" a skill: it checks the result with
deterministic tools. Skills teach how to work; the checks decide whether the change is
acceptable.

## What gets judged: the change, not the repository

```bash
railguard check --changed     # fast: format, vet, tests for changed packages, lint, architecture
railguard verify --changed    # everything: plus race, coverage of changed lines, mutation, E2E, vulnerabilities
```

With `--changed` the baseline is the merge-base with the default branch (or `--base <ref>`).
Each check looks only at what the change touched:

| Check | What it judges with `--changed` |
| --- | --- |
| Format | changed Go files |
| `go vet` and tests | packages that contain changes |
| golangci-lint | issues on new or modified lines |
| Architecture | imports of the changed files |
| Coverage | changed lines with statements: 100% in core, 80% in the rest |
| Mutation | mutants over changed lines: all must die |
| `go mod verify`, govulncheck | only if `go.mod` or `go.sum` change |
| E2E | if the module changed |

This way a repository with prior debt (broken tests, unformatted code, architecture
violations) does not block someone working well on their own part.

## The whole repository: `.railguard/verify.sh`

Without `--changed` the whole repository is judged with `.railguard/verify.sh`, a script
that Railguard generates from `.railguard/project.yaml`: one step per check of each
profile, with the selected packages and thresholds written into it (coverage: 100% in
core and 85% overall). It is the sole definition of the whole-repository rules:

```bash
.railguard/verify.sh check                               # fast stage
.railguard/verify.sh verify                              # both stages; what CI runs
COVERAGE_PROFILE=coverage.out .railguard/verify.sh verify  # keeps the coverage profile
.railguard/verify.sh --step go-assurance/coverage@.     # a single step
```

It only needs `sh`, Go and the tools pinned in `go.mod` (golangci-lint, govulncheck,
gremlins); it does not use the binary. `railguard verify` without `--changed` runs those
same steps and reports each one; if the script does not match the current selection, it
blocks with `verification.script.stale`. To change a rule, edit `project.yaml` and run
`railguard sync --yes`, which regenerates the script in the same change; `sync --check`
and `status` detect a manual edit. `change-guard` and `secret-guard` judge a change, so they
are not part of the script.

An `unavailable` check (unpinned tool, missing configuration) never counts as passed; it
is fixed with the `configure-go-quality` skill.

## Changes that hide problems

`verification-profile:change-guard` does not look at the code but at the shape of the
change. With active guardrails, the easy way out for an agent is to turn off the check
instead of fixing the cause; this profile makes that visible:

- **check:** fails if the change adds a suppression marker in code (`//nolint`, `#nosec`,
  `NOSONAR`, skipped or focused tests, `eslint-disable`, `@ts-ignore`, `# noqa`, coverage
  exclusions), edits or deletes a protected configuration (`protected_paths`:
  `.golangci.*`, `.gremlins.yaml`, `.railguard/project.yaml`, `sonar-project.properties`,
  Betterleaks exceptions...), deletes a test file, or removes a test from a test file
  that still exists.
- **verify:** fails if the change adds or modifies more than `max_changed_lines` lines
  (400 by default) outside tests, generated code, lockfiles and harness configuration. A
  large diff is not reviewed. Binary files do not count; every new text file counts in
  full, whatever its size. A text file larger than 16 MiB fails the integrity check
  because it cannot be scanned.

A person accepts what the branch has up to that point with a trailer on a commit:
`Railguard-Allow: change-integrity: <reason>` or `Railguard-Allow: change-size: <reason>`,
making that commit with `git commit --no-verify`. Everything before that commit is
accepted and everything after it keeps being judged; this way a branch that already
existed before adopting Railguard does not get blocked, but it is not exempt either. It
stays in the history and in the PR, and the check's result shows it (`since <commit>
(accepted: <reason>)`). Railguard cannot know who wrote the trailer: the instructions and
the failure messages forbid the agent from adding it, and whoever reviews the PR must
check that a person put each `Railguard-Allow`. With squash merge, the trailer carries
over to the final commit message. Adding a new protected configuration does not count;
modifying or deleting one that already existed on the base does, including the selection
in `.railguard/project.yaml`.

A removed test is a declaration that the file had on the base and the change no longer
has: `func Test…`, `Benchmark…`, `Fuzz…` and `Example…` in `_test.go` (also as a suite
method); `it(…)` and `test(…)` with a literal name in `*.test.*` and `*.spec.*`; `def
test…` in Python tests; methods with `@Test`, `@ParameterizedTest`, `@RepeatedTest`,
`@TestFactory` or `@TestTemplate` in `*Test.java`, `*Tests.java` and `*IT.java`, and the
`Scenario`, `Scenario Outline` and `Example` of `.feature` files. It is compared by name:
moving a test to another test file in the same change does not count, but renaming it
does, because mechanically it cannot be told apart from deleting one and adding another.
What changes inside a test that is still declared (removed assertions, empty body) is not
detected; that is measured by each stack's coverage and mutation testing.

`railguard report` lists each accepted trailer and the agent hook activity, to see which
rules actually block and which are only accepted out of habit
([CLI](cli.md#activity-report)).

## Secrets

`verification-profile:secret-guard` fails if the change exposes a secret: a token, a
private key or a credential recognizable by one of the more than 400 default rules. This
is decided by Betterleaks 1.8.1
([D-027](decisions.md#d-027--secrets-with-a-pinned-betterleaks-and-no-network)), which
Railguard downloads once, verifies against pinned digests and runs locally:

- **What it looks at:** the commits since the base and the changed lines that do not yet
  have a commit, including new files. A secret committed and later deleted still fails,
  because the push would publish it anyway: that commit must be rewritten (`git commit
  --amend`, `git rebase`) and the credential rotated if it was real.
- **No network:** validating secrets against each provider's API is never triggered, and
  the report hides all values; it shows file, line, rule and fingerprint.
- **No guessing:** only `medium` or `high` confidence findings count. The generic rules
  (`generic-password`, `generic-api-key`, `generic-username`) start at `low` and only rise
  when the context supports it, so an example value in a test does not block; the more
  than 400 rules for specific providers are not affected.
- **When it runs:** in the `check` stage, so it is run by the end-of-turn hook of Claude
  Code, Codex and Cursor and the pre-commit gate, before the secret reaches history.
- **Exceptions:** custom rules and recurring false positives go in `.betterleaks.toml`
  (with `[extend] useDefault = true` to keep the default rules) or in
  `.betterleaksignore`, with the finding's fingerprint. They are read from the base, so a
  change on the branch does not exempt itself; gitleaks names are also accepted. The
  `betterleaks:allow` and `gitleaks:allow` comments are ignored. Modifying or deleting
  those files is also a protected-configuration change for `change-guard`.
- **Explicit acceptance:** a person accepts what the branch has up to that point with
  `Railguard-Allow: secret-exposure: <reason>` on a commit made with `git commit
  --no-verify`, as in `change-guard`. What comes after keeps being judged.

If Betterleaks cannot be downloaded or does not run, the check stays `unavailable`. Like
`change-guard`, it judges a change and is not part of `verify.sh`.

## Before each agent action

`agent-hook:action-guard` rejects what would dodge the guardrails before it happens, and
the reason goes back to the agent:

- **Commands:** skipping Git hooks (`--no-verify`, `git commit -n`), writing a
  `Railguard-Allow` trailer or changing `core.hooksPath`.
- **File edits** with the agent's tools: all of `.railguard/`, `.git/`,
  `.codex/hooks.json`, `.cursor/hooks.json` and the `protected_paths` of `change-guard`
  if it is selected. Those paths are written to `.railguard/agent-hooks/guard` on
  `sync`, so the hook decides without loading the catalog.

It connects to `PreToolUse` in Claude Code (`Bash`, `Write`, `Edit`, `MultiEdit`,
`NotebookEdit`) and in Codex (`Bash`, `apply_patch`), and to `preToolUse` in Cursor
(`Shell`, `Write`, `Delete`). It is a barrier, not a sandbox: a shell command that writes
a protected file (`printf >> .golangci.yml`) is not intercepted and is judged afterward by
`change-guard`, and Codex warns that some internal paths may not go through its hooks. If
the engine is not available, the action continues with a warning.

Cursor also runs the `.claude/settings.json` hooks by default, with its own entry. When
the repository has Railguard's Cursor hooks, the copy of Claude Code that Cursor invokes
does nothing: each event is decided, blocked and logged only once. If only Claude Code is
selected, that copy is what protects Cursor and does decide.

## After each agent edit

`agent-hook:edit-feedback` runs, after the agent edits, creates or deletes files with its
tools, the checks that judge a single file on its own, and only over those files:
`change-integrity` from `change-guard` (suppressions, protected configuration, deleted
test files and removed tests) and `secret-exposure` from `secret-guard` (changed lines
with no commit, without scanning history). If they fail, the report goes back to the
agent as context while it continues with that edit, instead of at the end of the turn.
Format, tests, lint and the rest of the stack's checks stay in the end-of-turn hook. It
takes about a second per edit.

It connects to `PostToolUse` in Claude Code (`Write`, `Edit`, `MultiEdit`,
`NotebookEdit`) and in Codex (`apply_patch`), and to `postToolUse` in Cursor (`Write`,
`Delete`). Tested on September 26, 2026 by asking each agent to create a Go file with
`//nolint:all`: Claude Code (`claude -p`), Codex (`codex exec -s workspace-write`) and
Cursor (`cursor-agent -p`) received the report right after the edit; Codex removed the
suppression on its own.

## Where it runs

1. **When the agent's turn ends** (`agent-hook:stop-check`). Claude Code, Codex and
   Cursor run `railguard check --changed` when the agent tries to finish. If it fails, the
   report goes back to the agent as its next instruction, up to three times per session;
   after that the agent may finish and the change is marked as unverified. That mark
   lives in the worktree's Git directory (`railguard/unverified.json`) and the agent's
   next session receives it as context at start (`SessionStart` in Claude Code and Codex,
   `sessionStart` in Cursor), with the checks that were failing and the instruction to
   fix them before another task. It is cleared when a `check` or `verify --changed` of the
   whole change passes again, from the hook, the pre-push gate or the terminal; a
   `--staged` pass does not clear it, because it leaves unstaged work out. A missing tool never traps the agent
   in a loop. VS Code and OpenCode do not have this hook: selecting it with one of them
   as target blocks the plan (`resolution.capability.unsupported`) instead of silently
   skipping it.
2. **Before commit or push** (`git-gate:*`), with `core.hooksPath`. Git never activates
   the hooks that ship with a repository, so a new clone starts without them. Railguard's
   first command in the clone activates them, including the end-of-turn hook that Claude
   Code and Cursor run with no configuration: if the repository declares the gates and
   the clone has no `core.hooksPath`, it configures it and reports it on stderr. A
   developer's own `core.hooksPath` is not touched; `railguard status` reports it. Even
   when activated, `git commit --no-verify` skips them. The pre-commit gate judges only what
   the commit holds (`--changed --staged`): unrelated unstaged or untracked work never blocks
   it, and the pre-push gate judges the whole branch. A gate runs the selected profiles,
   whatever stack they belong to; with none, the plan blocks
   (`resolution.git-gate.profile-missing`) instead of installing a hook that always
   passes.
3. **In CI**, with `.railguard/verify.sh verify`. It is the only point no one can skip.
   CI does not download the binary or need credentials for it, and it judges the same
   rules as Railguard locally
   ([Railguard and CI](installation.md#railguard-and-ci)).

The hooks call the repository's launcher (`.railguard/bin/railguard`), which uses the
version the repository pins and downloads it if missing
([installation](installation.md#in-each-repository-the-launcher)). If the engine cannot
be obtained, the hooks warn and let the process continue.

## Architecture: only if the repository adopts it

`verification-profile:go-architecture` checks the direction of dependencies:

- **Hexagonal (default):** files in `core_packages` only import the standard library
  (except `database/sql`, `net/http`, `net/rpc`, `os/exec`), other core packages and the
  modules in `core_allowed_imports`.
- **Custom architecture:** `core_packages: [disabled]` and `forbidden_imports` rules
  (`forbidden_imports: ["./internal/domain/... -> ./internal/infra/..."]`).
- **No rule:** don't select the profile.

In an existing repository, `--changed` freezes the current architecture: only new
imports that violate it fail.

## Hook approval by harness

According to the official documentation (September 2026):

| Harness | File | Requires approval? | What each developer does |
| --- | --- | --- | --- |
| Claude Code | `hooks.Stop`, `hooks.SessionStart`, `hooks.PreToolUse` and `hooks.PostToolUse` in `.claude/settings.json` (Railguard only manages those keys) | No. Settings hooks run even before trusting the folder, also in `claude -p`, and changes are hot-reloaded. | Nothing. Worth knowing: cloning the repo and using Claude runs the hook. |
| Codex | `.codex/hooks.json` | Yes. The project's `.codex/` layer must be trusted and each hook is trusted by its hash; a new or modified hook is skipped, with a warning at startup, until it is reviewed. | Open `/hooks`, review the `Stop`, `SessionStart`, `PreToolUse` and `PostToolUse` hooks and trust them. Repeat it every time Railguard changes them. |
| Cursor | `.cursor/hooks.json` | Only if workspace trust is enabled (off by default). There is no per-hook approval. | If "Trust this workspace" appears, choose normal mode. In the headless CLI, `--trust`. `cursor-agent -p` does not run the stop hook in practice. |

Tested on macOS on September 26, 2026 with a real agent, asking it to add a badly
formatted Go function without running commands: the hook blocked the turn with the
`gofmt` failure and the agent fixed the formatting before finishing.

| Harness | Version | Mode tested | Result |
| --- | --- | --- | --- |
| Claude Code | 2.1.282 | `claude -p` | Blocked, the agent fixed it and `check --changed` passes. With the fix forbidden, it blocked three times and then let it finish. |
| Codex | 0.157.0 | `codex exec` with `--dangerously-bypass-hook-trust`, which skips the hook trust a developer grants in `/hooks` | Blocked and the agent fixed it with `gofmt`. |
| Cursor | 2026.09.26 | interactive `cursor-agent` | Blocked and the agent fixed it. With `cursor-agent -p` the hook does not run. |

The pre-action guard was tested the same day by asking each agent to do three steps:
`git commit --allow-empty --no-verify`, adding a line to `.golangci.yml` with its editing
tool, and creating `notes.txt`. All three rejected the first two with Railguard's reason
and created `notes.txt`.

| Harness | Mode tested | Observed input |
| --- | --- | --- |
| Claude Code 2.1.282 | `claude -p --permission-mode bypassPermissions` | `Bash` with `command`; `Edit` with an absolute `file_path`. |
| Codex 0.157.0 | `codex exec -s workspace-write --dangerously-bypass-hook-trust` | `Bash` with `command`; `apply_patch` with the patch in `command`. |
| Cursor 2026.09.26 | `cursor-agent -p --force --trust` | `Shell` with `command`; its edits arrive as `Write` with `file_path` and `content`. The `.claude/settings.json` hook also ran. |

The startup warning was tested by writing an unverified-change mark and asking each agent,
with no tools, what Railguard had told it at startup. Claude Code (`claude -p`), Codex
(`codex exec -s workspace-write`) and Cursor (`cursor-agent -p`) quoted the warning; in
Claude Code and Codex the end-of-turn hook passed and cleared the mark. In a first run of
`codex exec -s read-only` the agent replied that it had received nothing, with no record
of whether the hook ran; in the instrumented repeat the hook did run.

An organization can disable the project's hooks: in Claude Code with `disableAllHooks` or
`allowManagedHooksOnly`; in Codex with `[features] hooks = false` or
`allow_managed_hooks_only`.

Sources: [Claude Code: permissions and trust](https://code.claude.com/docs/en/permissions),
[hooks](https://code.claude.com/docs/en/hooks), [Codex hooks](https://learn.chatgpt.com/docs/hooks),
[Cursor hooks](https://cursor.com/docs/hooks), [Cursor security](https://cursor.com/docs/agent/security).

## Project instructions

Railguard writes the instructions in `AGENTS.md`, which Codex, Cursor and Claude Code
(≥ 2.1.277) read. Claude Code reads `AGENTS.md` **only if `CLAUDE.md` does not exist**;
that is why Railguard never creates `CLAUDE.md`. If the repository already has one and
Claude Code is selected, Railguard adds a managed block to it with the `@AGENTS.md` line
so Claude loads both. Whoever maintains their own `CLAUDE.md` outside Railguard must keep
that import.

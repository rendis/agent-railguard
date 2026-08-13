# CLI

The CLI does not open prompts when a subcommand is used. Without a subcommand it opens the TUI
only if stdin and stdout are TTY; in pipes or agents it exits with code 2 and points to `--help`.

Global options:

- `--cwd <path>`: target Git root; never configures at the global level.
- `--source <path>`: replaces, for this invocation, the content channel with a
  local checkout containing `railguard.yaml`; applies equally to the TUI and subcommands.
- `--plain`: unstyled text, meant for limited terminals.
- `--format text|json|ndjson`: format per command.

`json` writes a single final envelope to stdout. `ndjson` writes ordered events and ends with a
single result. In text mode, progress goes to stderr and the result to stdout.

Content precedence is: `--source`, the authoring checkout when the engine runs from it, and the
content embedded in the binary. An invalid explicit source blocks; it never falls back silently
to another.

## Queries

```bash
railguard scan --format json
railguard status --format json
railguard doctor --format json
railguard catalog list --type skill --format json
railguard catalog show mcp:context7 --format json
```

`scan` detects all Go/Python/TypeScript/Java units, including monorepos and repositories without
a stack. Zero detections does not block. `status` compares desired, lock, and actual artifacts;
it reports `partial` or drift if something was deleted or altered.

## Initialize and manage

Review recommendations without applying:

```bash
railguard init --recommended --harness codex --plan-only
```

Select components manually, even if the stack did not recommend them:

```bash
railguard init \
  --add skill:tdd mcp:context7 \
  --harness codex claude-code cursor vscode opencode \
  --plan-only
```

Apply the generated plan in the same run:

```bash
railguard init --add pack:go-service-foundation --harness codex --yes
```

Typed inputs use JSON strings:

```bash
railguard init \
  --add verification-profile:go-quality \
  --set 'verification-profile:go-quality.test_packages=["./cmd/...","./internal/..."]' \
  --harness codex --yes
```

Modify desired state or targets:

```bash
railguard plan --add mcp:context7 --remove skill:tdd --harness codex cursor
```

Export and apply from separate processes:

```bash
railguard plan --add skill:tdd --harness codex --out /tmp/railguard-plan.json --format json
railguard apply --plan /tmp/railguard-plan.json --yes --format json
```

`--out` must be outside the target repository: writing the plan inside it would change the
fingerprint that plan itself certifies. Apply rebuilds the plan against a fresh scan and blocks
if the repository, catalog, desired state, targets, or inputs changed.

Sync the catalog version and repair drift:

```bash
railguard sync --check
railguard sync --plan-only
railguard sync --yes
railguard repair --plan-only
railguard repair --yes
```

`sync` reconciles skills, configurations, sections, hooks, and repository state with the current
content. To update the binary, run the installer again ([Installation](installation.md));
afterward, `sync` applies the new content to the repository.

Uninstall selections or everything managed:

```bash
railguard remove skill:tdd --plan-only
railguard remove skill:tdd --yes
railguard remove --all --yes
```

Remove computes the remaining desired state and removes only units whose ownership appears in
the lock or inside managed markers. It does not delete foreign content.

## Verification

```bash
railguard check --changed            # quick checks on the change
railguard verify --changed           # all checks on the change
railguard verify --changed --base origin/release
railguard verify                     # the whole repository with .railguard/verify.sh, like CI
railguard verify --changed --format json
```

These run the checks of the verification profiles selected in `.railguard/project.yaml`. `check`
runs the fast stage; `verify`, both. With `--changed` the base is the merge-base with the default
branch (`origin/HEAD`, `origin/main`, `main`, or `master`) or the explicit `--base`, and each
check judges only what changed: modified files, new lines, affected packages. Untracked files
count as changes. With no commits yet, the whole repository is the change. If there are commits
but none of those branches exist (for example, a shallow clone), the result is `blocked`: the
change is never compared against itself. Fetch the default branch with enough history or pass
`--base`.

Without `--changed` the steps of `.railguard/verify.sh` run
([guardrails](guardrails.md#the-whole-repository-railguardverifysh)); if the script does not
match the current selection, the result is `blocked` and `railguard sync --yes` regenerates it.

Each check ends `passed`, `failed`, `skipped`, or `unavailable`. `unavailable` indicates a
missing tool or configuration and never counts as passed. Exit codes: `0` passed, `8` some check
failed, `4` some check could not run, `5` blocked (for example, a repository with no selection).
The JSON uses the schema `railguard/verification-report/v1`.

With invalid input (unsupported format, empty `--base`, unknown harness in `hook stop`), `check`,
`verify`, and `hook stop` exit with `2` and explain the error on stderr.

### Activity report

```bash
railguard report                     # all history and recorded activity
railguard report --since 2026-09-01  # only from that date
railguard report --format json       # schema railguard/activity-report/v1
```

Shows whether the guardrails earn their place in this clone:

- findings accepted with `Railguard-Allow` in commits reachable from `HEAD`, per check and with
  their commit, author, and reason, to verify a person wrote them;
- agent hook activity: end-of-turn hook blocks per check, sessions that ended without verifying,
  actions rejected by rule, and flagged edits, per harness;
- the change a session left unverified, if any.

Hooks record that activity in `railguard/activity.jsonl` in the common Git directory, shared by
the clone's worktrees and never versioned. It stores only check and rule names, no code, paths,
or values, and discards the oldest half once it passes 1 MiB. A `--since` that is not
`YYYY-MM-DD` exits with `2`.

## Updating

```bash
railguard update --check             # is there a newer release?  0 no, 6 yes
railguard update --plan-only         # review the update
railguard update --yes               # pin the new version and apply its content
railguard update --yes --to 0.1.0    # pin an exact version, also an earlier one
```

The chosen version runs `sync`: the change lands in the launcher and in the repository's
content. It exits with `4` if the release cannot be fetched. Each command warns on stderr when a
newer release is available ([Installation](installation.md#updating)).

## Report a bug or propose an improvement

```bash
railguard issue bug
railguard issue improvement
```

Prints the guidance, the GitHub template for that type, the Railguard version (and the one the
repository pins, if different), and the platform. It reads nothing else from the repository and
publishes nothing. `railguard issue --check <draft>.md` searches a draft for project and person
data a machine can recognize; it exits with `8` if it finds any. See
[Report a bug or propose an improvement](reporting-issues.md).

## MCP authentication

Installation and OAuth are separate operations. `mcp status/login/logout` delegate to the harness
and never write credentials or global configuration. The certified Atlassian flow, including
guided Cursor and native OpenCode, is in [MCP authentication](mcp-authentication.md).

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Ready, plan ready, applied, no changes, or already initialized |
| 2 | Invalid input or flag combination |
| 3 | Invalid scope |
| 4 | Readiness blocked |
| 5 | Plan/operation blocked or rejected |
| 6 | Updates available (`sync --check`) |
| 7 | Failure, rollback, or incomplete rollback |
| 8 | Verification failed |
| 70 | Unclassified internal error |
| 130 | Cancellation requested by the user |

Agents must decide based on `verdict`, `exit_code`, `diagnostics[].code`, and the versioned
envelope, not on human copy. Every public diagnostic keeps `location` and `evidence`.

`railguard --help` documents `TYPE:NAME` references, the five targets, source precedence,
effects, and exit codes. Each `COMMAND --help` includes flags, examples, and whether the command
mutates. No subcommand opens prompts: review is expressed with `--plan-only`, exported plans, or
explicit `--yes`.

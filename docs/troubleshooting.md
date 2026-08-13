# Troubleshooting and recovery

If a problem is not here or looks like a Railguard bug, report it with `railguard issue
bug` ([guide](reporting-issues.md)).

Always start with queries that do not mutate anything:

```bash
railguard scan --format json
railguard status --format json
railguard doctor --format json
```

Diagnostics include `code`, severity, `location`, `evidence`, impact, next action and the
explicit resolutions available. There is no need to interpret free-form logs.

## Installation

- `unsupported operating system/architecture`: the binary exists for macOS, Linux and
  Windows on `arm64` and `x64`. On Windows, run the installer from Git Bash.
- On Windows, the engine runs `sh` scripts with the `sh.exe` from Git for Windows, which
  it locates from `git`. If Git is at another path, point to the shell with
  `RAILGUARD_SH`.
- `checksum mismatch`: the download does not match `SHA256SUMS`; nothing was installed.
  Retry; if it persists, report it with `railguard issue bug`.
- `railguard: command not found`: add `~/.local/bin` (or `RAILGUARD_INSTALL_DIR`) to
  `PATH`.
- `gh could not download` or `download failed … (a private repository needs gh auth
  login)`: while the repository is private, releases require an authenticated `gh`
  (`gh auth login`) with access to `rendis/agent-railguard`.

## Engine not available in a repository

`railguard 0.1.0 is not available: …` comes from the launcher
(`.railguard/bin/railguard`): it did not find that version in `~/.cache/railguard/`, nor
a `railguard` of that version in `PATH`, nor could it download it. It exits with code
`127` and the hooks treat it as a missing engine: they warn (`Railguard is unavailable`)
and let the process continue, so the change is not verified. Authenticate `gh` or install
that version with `RAILGUARD_VERSION=<version>` and the installer.

Once downloaded, the version stays in the cache and does not need the network again. A
launcher `checksum mismatch` saves nothing to the cache.

## Updates

- `railguard update` exits with `4` if it cannot determine or fetch the release: without
  an authenticated `gh` it cannot see the releases of a private repository. `--to X.Y.Z`
  avoids querying the latest release, but the download still needs access.
- The new-version notice is stored in `~/.cache/railguard/latest.json`; deleting it forces
  a new query. `RAILGUARD_NO_UPDATE_CHECK=1` disables it.

## `--changed` blocked

`verification.change-set.unavailable` with `No merge-base with the default branch`
indicates a clone without the default branch, typical of a shallow clone. Bring in the
default branch with its history or pass `--base <ref>`; Railguard never compares the
change against itself.

## Project content

`catalog.source.unavailable` blocks commands that need the catalog:

- with `--source`, check that the path contains a regular `railguard.yaml`;
- with the binary, the embedded content is materialized at
  `${XDG_CACHE_HOME:-$HOME/.cache}/railguard/content/<digest>`; if that directory got
  corrupted, delete it and it is rebuilt on the next run.

## `partial` or drift

This can happen if someone deletes a file manually or edits a managed block. The lock is
not taken as proof of presence. Check first:

```bash
railguard repair --plan-only
railguard repair --yes
```

Drift outside markers is not overwritten. Malformed, duplicated or nested markers block
to avoid adopting ambiguous content.

## `core.hooksPath` already exists

Railguard does not replace foreign hooks. The plan explains the conflicting value. The
user decides whether to keep their own solution, call `railguard check --changed` or
`railguard verify --changed` from it, or free `core.hooksPath` before replanning.

## Stale plan

An exported plan certifies fingerprints of the repo, catalog and state. Any later change
invalidates it. Generate another plan outside the target repository:

```bash
railguard plan ... --out /tmp/railguard-plan.json
```

## Interrupted operation

Within the same process, a failure or a cancellation restores all applied units. If the
process dies mid-apply, the partial changes remain in the worktree:

```bash
git status                      # see what was left half-done
railguard repair --plan-only   # reconcile against the lock, or else
git restore <paths>             # discard the changes
```

`RECOVERY_REQUIRED` indicates that an automatic restore failed; the
`apply.rollback.incomplete` diagnostic lists the paths to review.

## Uninstalling

```bash
railguard remove --all --plan-only
railguard remove --all --yes
```

An exact remove restores owned files/sections and Git config. If a unit was altered
outside ownership, it blocks so as not to delete someone else's work.

## Terminal without styling

For a limited terminal or plain-text logs:

```bash
NO_COLOR=1 railguard
railguard status --plain
```

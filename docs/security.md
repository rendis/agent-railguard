# Security model

## Trust boundaries

Railguard only mutates the Git top-level pointed to by `--cwd`. Before planning writes it
validates realpath, non-bare worktree, permissions, active locks, submodules, LFS
attributes and relevant Git configuration. The presence of `.env`, `.npmrc`, certificates
or other potentially sensitive names does not block installation. The inventory reads
the regular files within its bounds to compute fingerprints; it does not load them as
environment variables. Files outside the plan are not modified.

Detecting a language or harness only affects recommendations. The user's selection stays
explicit, and Review exposes applicability, network, auth, executables and paths.

## Preflight, transaction and ownership

All operations and dependencies are resolved before writing. The engine does a full
preflight, mutation, verification and commit of desired/lock. On failure or cancellation
it restores in reverse order from in-memory before-images. A process interruption is
visible in `git status`.

Railguard governs exclusively:

- artifacts listed in `.railguard/lock.json`;
- Git effects declared by that lock;
- content inside `railguard:managed:start/end`.

Editing a managed block means accepting that repair/sync will replace it. Content outside
the markers is neither adopted nor deleted. Unexpected symlinks, collisions and insecure
permissions fail closed.

## MCP runtime and hooks

Context7 uses a pinned npx package and only needs the network when an agent runs it. It
requires no API key or login. Apply does not launch MCPs. Git gates and the agents'
end-of-turn hook do run `railguard check` or `railguard verify` on commit/push or when the
agent finishes; the review shows this local execution effect before installing it.

## Launcher and updates

Hooks, agents and the global `railguard` run the engine through the repository's launcher
(`.railguard/bin/railguard`). If the pinned version is not in the cache or in `PATH`, the
launcher downloads the release from `rendis/agent-railguard` (with `gh`, or over HTTPS if
the repository is public) and runs the binary only if it matches that release's
`SHA256SUMS`; it stores it in `~/.cache/railguard/<version>/`. A launcher is a versioned
file: changing it is a reviewable change to the repository.

`secret-guard` downloads the pinned Betterleaks release the same way, once, from GitHub
into `~/.cache/railguard/tools/` and runs the binary only if the file and the executable
match the SHA-256 values the engine pins; it re-verifies this on every use. The scan is
local: Railguard never triggers secret validation against the network, and the report
hides its values.

The update notice makes, at most once a day and in a separate process, a read-only query
to the GitHub API about the latest release. It sends no repository data. `CI` or
`RAILGUARD_NO_UPDATE_CHECK=1` disable it.

## Supply chain

- exact direct dependencies and transitive ones pinned by `pnpm-lock.yaml`;
- the binary is built on GitHub Actions from a tag that must match `package.json`, after
  `pnpm run check`;
- engine and content (`railguard.yaml`, `skills/`) travel in the same binary, so there is
  no separate content channel that could get out of sync;
- workflow actions are pinned by SHA and each job has only the permissions it uses;
- the release attests the provenance of each binary
  (`actions/attest-build-provenance`) when the repository is public; GitHub does not
  offer this on private repositories of a personal account;
- `install.sh` verifies the SHA-256 against `SHA256SUMS`, verifies the attestation when
  an authenticated `gh` is available, and replaces the binary atomically;
- the embedded content is materialized by digest and rejects paths that escape its root.

## Reporting issues

Do not attach private repositories or `.env` files. Share the diagnostic code, version,
plan ID and the redacted gate evidence in a repository issue; vulnerabilities are
reported privately through GitHub Security Advisories.

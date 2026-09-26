# Installation and updates

Railguard is a single executable per platform that includes the engine and the project's content
(catalog and skills). It does not require Node.js, pnpm, or any registry.

## Install or update

```bash
curl -fsSL https://raw.githubusercontent.com/rendis/agent-railguard/main/install.sh | bash
```

It needs `curl` or `wget`. With an authenticated `gh` (`gh auth login`), the script downloads the
release through `gh` and also verifies its build provenance.

The script:

1. detects the platform (`darwin`, `linux`, or `windows`, `arm64` or `x64`; WSL counts as Linux; a
   shell under Rosetta on Apple silicon installs the `arm64` binary, and Git Bash on Windows on
   ARM, which runs emulated as x64, also does);
2. downloads with `curl` or `wget` the `railguard-<os>-<arch>` (with `.exe` on Windows) and
   `SHA256SUMS` from the GitHub Release;
3. rejects the installation if the checksum does not match;
4. with an authenticated `gh`, also verifies the build's provenance attestation
   (`gh attestation verify`) and rejects the installation if it does not match the repository.
   Without `gh` it says so and continues with the checksum. Releases before `v0.1.14` were
   published while the repository was private and carry no attestation: install one of them with
   `RAILGUARD_VERSION` from a shell without an authenticated `gh`;
5. atomically replaces `~/.local/bin/railguard` and shows the installed version;
6. warns if the install directory is not on `PATH`. It does not edit shell files.

Running it again updates the global command.

### Windows

Railguard runs natively on Windows 10 and 11 (`x64` and `arm64`) and requires
[Git for Windows](https://git-scm.com/download/win): the launcher, the Git hooks, and
`.railguard/verify.sh` are `sh` scripts that run under its Git Bash, and the engine uses that same
`sh.exe` (or whichever `RAILGUARD_SH` points to). Install from Git Bash with the same command; the
binary ends up at `~/.local/bin/railguard.exe`. To use it from PowerShell or cmd too, add
`%USERPROFILE%\.local\bin` to the user `Path`.

Windows does not store a file's execute bit. Because of that, when applying a change on Windows,
Railguard records its scripts (launcher, hooks, `verify.sh`) as executable in the Git index: it
changes the mode of the ones already versioned and adds the new ones to the index, so that on
commit they arrive executable on macOS and Linux.

The end-of-turn hooks and the MCPs of Claude Code, Codex, and Cursor are not verified on native
Windows: their documentation does not state which shell runs a hook or how they launch `npx`.

Available variables:

| Variable | Use |
| --- | --- |
| `RAILGUARD_REPO` | `owner/repo` that publishes the releases |
| `RAILGUARD_VERSION` | exact version without `v`; defaults to `latest` |
| `RAILGUARD_INSTALL_DIR` | destination; defaults to `~/.local/bin` |
| `RAILGUARD_DOWNLOAD_URL` | alternative base URL with a release's assets |

Uninstalling means deleting the binary and, if desired, the content cache:

```bash
rm ~/.local/bin/railguard
rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/railguard"
```

## In each repository: the launcher

Railguard writes `.railguard/bin/railguard` in every repository it configures, a small, versioned
script that pins the version of the engine that generated it. Hooks and agent instructions call
it, not the global `railguard`, so the whole team uses the same version even if each machine has a
different one installed. It obtains the engine in this order:

1. `~/.cache/railguard/<version>/railguard` (or `$XDG_CACHE_HOME/railguard/...`);
2. a `railguard` on `PATH` of exactly that version, for example the one from `install.sh --local`;
3. the `v<version>` release: it downloads it once with `gh` (or with `curl`/`wget` if the
   repository is public, or from `RAILGUARD_DOWNLOAD_URL`), verifies it against its `SHA256SUMS`,
   and stores it in the cache.

If it cannot obtain it, it explains how to and exits with code `127`; hooks treat this as a
missing engine: they warn and let things continue. It writes only to stderr, so the hooks' stdout
protocol does not change.

A global `railguard` run inside a repository that pins another version delegates to the
launcher: every command runs with the repository's version, so no one accidentally rewrites a
repository with a different version by mistake. `update` and `issue` are the exception: the
global `railguard` runs them, so a repository can be updated even if its pinned version is not
available.

## Railguard and CI

The binary is a local tool: developers, their agents, and hooks use it. CI does not download it
or need access to its releases. It runs `.railguard/verify.sh verify`, the versioned script
Railguard generates from `.railguard/project.yaml`, so CI and local judge the same rules from a
single definition ([the whole repository](guardrails.md#the-whole-repository-railguardverifysh)).
For example, in GitHub Actions:

```yaml
- run: COVERAGE_PROFILE=coverage.out .railguard/verify.sh verify
```

## Updating

- **Notice.** At most once a day, in a separate process that never delays or fails the command in
  progress, Railguard checks the latest release (with `gh`, which also reaches a private
  repository) and stores it in `~/.cache/railguard/latest.json`. If it is newer than the
  repository's, every command warns about it on stderr. `AGENTS.md`'s instructions ask the agent
  to tell the user and ask whether they want to update; it never updates without asking. `CI` or
  `RAILGUARD_NO_UPDATE_CHECK=1` disable it.
- **Repository.** `railguard update --check|--plan-only|--yes` moves the repository to the latest
  release (or to an exact one with `--to X.Y.Z`, also backward): that version is obtained the same
  way the launcher does and runs `sync`, which rewrites the launcher with its version and applies
  the content it brings. It is a repository change that gets reviewed and shared through Git, so
  the team receives the new version on pull.
- **Global command.** Running the installer again updates the global `railguard`, which is only
  needed to configure new repositories.

## From a checkout

To develop the catalog or the engine, with Node 24, pnpm 11, and Bun installed:

```bash
bash install.sh --local
```

Compiles the current platform's binary from the checkout and installs it. To test content
without recompiling, any binary accepts an explicit checkout:

```bash
railguard --source /path/to/checkout
railguard --source /path/to/checkout scan --format json
```

## Publishing a release

1. Update `version` in `package.json`.
2. Create and publish the tag `vX.Y.Z` with that same version.
3. The `Release` workflow runs `pnpm run check`, builds the four binaries with
   `node scripts/build-binaries.mjs` with Bun pinned, attests each binary's provenance, and
   creates the GitHub Release with `SHA256SUMS`.

A tag that does not match `package.json` fails the build.

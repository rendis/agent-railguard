# Status and next steps

Starting point for resuming the work. Decisions live in [decisions.md](decisions.md); the
guardrails, in [guardrails.md](guardrails.md).

## Status

- Current release: `v0.1.13`, with binaries for macOS, Linux, and Windows on arm64/x64 and
  `SHA256SUMS`, published by `release.yml` on pushing a `vX.Y.Z` tag. The `rendis/agent-railguard`
  repository is public: downloads work with `curl` or `wget`, the visual guide is published on
  GitHub Pages, and releases from `v0.1.14` on carry build provenance attestation.
- Each repository pins the engine version in its launcher `.railguard/bin/railguard`;
  `railguard update` changes it and a daily notice reports new releases.
- Verification: `railguard check|verify [--changed]` with Go profiles and the language-agnostic
  profiles `change-guard` and `secret-guard` (Betterleaks pinned, no network).
- Hooks for Claude Code, Codex, and Cursor: a guard before each action (`action-guard`), feedback
  after each edit (`edit-feedback`), and end-of-turn, with a notice to the next session if the
  change was left unverified. Git gates with `core.hooksPath`.
- Railguard is local: CI runs `.railguard/verify.sh`, generated from `project.yaml`, and does not
  download the binary; the whole repository's rules have a single definition.
- Reports: `railguard report` (accepted findings and agent hook activity in the clone),
  `railguard issue bug|improvement`, and `railguard issue --check`.
- Native Windows (`x64` and `arm64`) with Git for Windows: engine, launcher, Git hooks, and
  `verify.sh` tested on Windows 11 ARM and covered by the CI's `windows` job
  (`scripts/verification/windows-smoke.sh`). The end-of-turn hooks and the harnesses' MCPs are not
  verified on Windows.

## Next steps

1. **Windows with real agents**: check in Claude Code, Codex, and Cursor which shell runs the
   agent hooks (end-of-turn, guard, edit, session start) and how they launch an MCP with `npx`.
   The Windows smoke test already covers those hooks invoked directly and secret scanning, on
   x64 in CI and on Windows 11 ARM64 with Git for Windows 2.55.
2. **Other stacks**: packages and check providers for TypeScript, Java, and Python.
3. **Decide with `railguard report` data** whether the new-dependency gate, `go mod tidy` and
   `go generate` with no diff, and `sensitive_paths` are needed.

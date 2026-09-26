#!/usr/bin/env bash
# End-to-end check of the Windows binary from Git Bash: install, init, the executable bit in the
# Git index, a clean status, the launcher download, a full check, the commit hook and remove.
#   bash scripts/verification/windows-smoke.sh DIRECTORY_WITH_THE_RELEASE_ASSETS
set -euo pipefail
release="$(cd "$1" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export HOME="$work/home" RAILGUARD_NO_UPDATE_CHECK=1 GIT_CONFIG_NOSYSTEM=1
export RAILGUARD_DOWNLOAD_URL="file:///$(cygpath -m "$release")"
# Only the railguard this script installs may be found on PATH.
clean_path=
IFS=: read -r -a directories <<< "$PATH"
for directory in "${directories[@]}"; do
  [ -e "$directory/railguard.exe" ] || [ -e "$directory/railguard" ] || clean_path="$clean_path${clean_path:+:}$directory"
done
export RAILGUARD_INSTALL_DIR="$HOME/.local/bin" PATH="$HOME/.local/bin:$clean_path"
mkdir -p "$HOME"
git config --global user.email smoke@example.com
git config --global user.name smoke
git config --global init.defaultBranch main
fail() { echo "windows smoke: $*" >&2; exit 1; }
# Runs a step quietly and shows its output only when it fails.
quiet() { "$@" > "$work/step.log" 2>&1 || { cat "$work/step.log" >&2; return 1; }; }

quiet bash "$(dirname "$0")/../../install.sh" || fail "install.sh failed"
version="$(railguard --version)"

repository="$work/repository"
mkdir -p "$repository/internal/core" && cd "$repository"
git init -q
printf 'module example.com/smoke\n\ngo 1.24\n' > go.mod
printf 'package core\n\n// Sum adds two numbers.\nfunc Sum(a, b int) int { return a + b }\n' > internal/core/sum.go
printf 'package core\n\nimport "testing"\n\nfunc TestSum(t *testing.T) {\n\tif Sum(1, 2) != 3 {\n\t\tt.Fatal("sum")\n\t}\n}\n' > internal/core/sum_test.go
git add -A && git commit -qm init

quiet railguard init --add verification-profile:go-quality git-gate:pre-commit-check agent-hook:stop-check skill:tdd \
  --harness claude-code codex --yes --plain || fail "init failed"
for script in .railguard/bin/railguard .railguard/hooks/pre-commit .railguard/agent-hooks/stop .railguard/verify.sh; do
  [ "$(git ls-files --stage -- "$script" | cut -d' ' -f1)" = 100755 ] || fail "$script is not executable in the Git index"
done
railguard status --plain 2>/dev/null | grep -q '^State: managed · clean' || fail "status is not clean"
railguard sync --check >/dev/null 2>&1 || fail "sync --check found changes after init"

rm -rf "$HOME/.local/bin/railguard.exe" "$HOME/.cache/railguard/$version"
[ "$(.railguard/bin/railguard --version 2>/dev/null)" = "$version" ] || fail "the launcher did not obtain $version"
[ -x "$HOME/.cache/railguard/$version/railguard.exe" ] || fail "the launcher did not cache railguard.exe"

quiet .railguard/bin/railguard check || fail "the full check failed"
quiet git commit -qm "chore: adopt railguard" || fail "the commit hook rejected a clean change"
printf 'package core\n\n// Twice doubles.\nfunc Twice(a int) int {   return a * 2 }\n' > internal/core/twice.go
git add internal/core/twice.go
if git commit -qm "feat: twice" >/dev/null 2>&1; then fail "the commit hook accepted unformatted Go"; fi
printf '{"session_id":"smoke","stop_hook_active":false}' | .railguard/agent-hooks/stop claude-code >/dev/null \
  || fail "the agent stop hook failed"
git reset -q --hard HEAD

quiet .railguard/bin/railguard remove --all --yes || fail "remove failed"
[ ! -e .railguard ] || fail "remove left .railguard behind"
echo "windows smoke passed: railguard $version"

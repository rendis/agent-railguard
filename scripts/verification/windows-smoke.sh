#!/usr/bin/env bash
# End-to-end check of the Windows binary from Git Bash: install, init, the executable bit in the
# Git index, a clean status, the launcher download, a full check, the commit hook, the agent hooks
# (stop, pre-action guard, edit feedback, session start), the pinned Betterleaks download and
# secret scan, the activity report and remove.
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
  verification-profile:change-guard verification-profile:secret-guard agent-hook:action-guard agent-hook:edit-feedback \
  --harness claude-code codex cursor --yes --plain || fail "init failed"
for script in .railguard/bin/railguard .railguard/hooks/pre-commit .railguard/agent-hooks/stop .railguard/verify.sh \
  .railguard/agent-hooks/guard .railguard/agent-hooks/edit .railguard/agent-hooks/session-start; do
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

guard() { printf '%s' "$2" | .railguard/agent-hooks/guard "$1"; }
guard claude-code '{"tool_name":"Bash","tool_input":{"command":"git commit --no-verify -m wip"}}' \
  | grep -q '"permissionDecision":"deny"' || fail "the pre-action guard allowed --no-verify"
[ "$(guard cursor '{"tool_name":"Shell","tool_input":{"command":"go test ./..."}}')" = '{"permission":"allow"}' ] \
  || fail "the pre-action guard did not allow a plain command in Cursor"
# Harnesses on Windows report native absolute paths.
project="$(cygpath -w "$PWD/.railguard/project.yaml" | sed 's/\\/\\\\/g')"
guard codex "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$project\"}}" | grep -q 'belongs to the guardrails' \
  || fail "the pre-action guard allowed editing .railguard/project.yaml through a Windows path"

printf 'package core\n\n// Half halves.\nfunc Half(a int) int { return a / 2 } //nolint:all\n' > internal/core/half.go
printf '{"tool_name":"Write","tool_input":{"file_path":"internal/core/half.go"}}' | .railguard/agent-hooks/edit codex \
  | grep -q 'lint suppression' || fail "edit feedback did not report a suppression"
rm internal/core/half.go

# A token assembled at run time, so no scanner flags this script.
printf 'package core\n\n// Token is a leaked credential.\nconst Token = "%s%s"\n' ghp_ A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8 > internal/core/token.go
git add internal/core/token.go
if git commit -qm "feat: token" > "$work/secret.log" 2>&1; then fail "the commit hook accepted a secret"; fi
grep -q 'secret(s) exposed by the change' "$work/secret.log" || { cat "$work/secret.log" >&2; fail "secret-guard did not report the token"; }
[ -n "$(find "$HOME/.cache/railguard/tools/betterleaks" -name betterleaks.exe 2>/dev/null)" ] \
  || fail "Betterleaks was not installed in the tool cache"
git reset -q --hard HEAD

mkdir -p "$(git rev-parse --absolute-git-dir)/railguard"
printf '{"schema":"railguard/unverified/v1","stage":"check","attempts":3,"recordedAt":"2026-01-01T00:00:00Z","failures":["go-quality/test: 1 failed"]}' \
  > "$(git rev-parse --absolute-git-dir)/railguard/unverified.json"
printf '{"session_id":"smoke","source":"startup"}' | .railguard/agent-hooks/session-start claude-code | grep -q 'NOT verified' \
  || fail "the session start hook did not report the unverified change"
railguard report --plain > "$work/report.log" 2>&1 || fail "report failed"
grep -q 'refused actions: 2' "$work/report.log" && grep -q 'flagged edits: 1' "$work/report.log" \
  || { cat "$work/report.log" >&2; fail "report did not count the agent hook activity"; }

quiet .railguard/bin/railguard remove --all --yes || fail "remove failed"
[ ! -e .railguard ] || fail "remove left .railguard behind"
echo "windows smoke passed: railguard $version"

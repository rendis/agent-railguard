#!/usr/bin/env bash
# Install or update the railguard binary.
#
#   gh api repos/rendis/agent-railguard/contents/install.sh -H "Accept: application/vnd.github.raw" | bash
#   bash install.sh --local        # build and install from this checkout (requires Node, pnpm and Bun)
#
# Environment:
#   RAILGUARD_REPO         GitHub owner/repo that publishes releases (default: DEFAULT_REPO below)
#   RAILGUARD_VERSION      release version without "v" (default: latest)
#   RAILGUARD_INSTALL_DIR  destination directory (default: ~/.local/bin)
#   RAILGUARD_DOWNLOAD_URL base URL that holds the release assets (overrides REPO/VERSION)

set -euo pipefail

DEFAULT_REPO="rendis/agent-railguard"
REPO="${RAILGUARD_REPO:-$DEFAULT_REPO}"
VERSION="${RAILGUARD_VERSION:-latest}"
INSTALL_DIR="${RAILGUARD_INSTALL_DIR:-$HOME/.local/bin}"
WORK_DIR=""

say() { printf 'railguard: %s\n' "$*"; }
fail() { printf 'railguard: %s\n' "$*" >&2; exit 1; }
cleanup() { [ -z "$WORK_DIR" ] || rm -rf "$WORK_DIR"; }
trap cleanup EXIT

platform() {
  local os arch
  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux) os="linux" ;;
    MINGW*|MSYS*|CYGWIN*) os="windows" ;;
    *) fail "unsupported operating system: $(uname -s). Use macOS, Linux, WSL or Git Bash on Windows." ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64) arch="x64" ;;
    *) fail "unsupported architecture: $(uname -m)" ;;
  esac
  # A shell translated by Rosetta reports x86_64 on Apple silicon; install the native binary.
  if [ "$os-$arch" = "darwin-x64" ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = "1" ]; then
    arch="arm64"
  fi
  # Git Bash on Windows on Arm runs emulated as x86_64; its system name keeps the native ARM64.
  case "$os-$(uname -s)" in windows-*-ARM64) arch="arm64" ;; esac
  printf '%s-%s' "$os" "$arch"
}

# Windows runs only files named .exe.
executable_suffix() {
  case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) printf '.exe' ;; esac
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else fail "sha256sum or shasum is required to verify the download"
  fi
}

download() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then wget -q --tries=3 -O "$2" "$1"
  else fail "curl or wget is required to download railguard"
  fi
}

install_binary() {
  local source="$1" target
  target="$INSTALL_DIR/railguard$(executable_suffix)"
  mkdir -p "$INSTALL_DIR"
  cp "$source" "$INSTALL_DIR/.railguard.tmp.$$$(executable_suffix)"
  chmod 0755 "$INSTALL_DIR/.railguard.tmp.$$$(executable_suffix)"
  mv -f "$INSTALL_DIR/.railguard.tmp.$$$(executable_suffix)" "$target"
  say "installed $("$target" --version) at $target"
  case ":$PATH:" in
    *":$INSTALL_DIR:"*) ;;
    *) say "add $INSTALL_DIR to your PATH, for example: export PATH=\"$INSTALL_DIR:\$PATH\""
       [ -z "$(executable_suffix)" ] || say "for PowerShell and cmd too, add $(cygpath -w "$INSTALL_DIR" 2>/dev/null || echo "$INSTALL_DIR") to the user Path in the Windows environment variables" ;;
  esac
}

# The checksum only proves the download matches the release; the attestation proves the release
# workflow of $REPO built it. It needs an authenticated GitHub CLI, so it is checked when available.
gh_ready() {
  command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1
}

verify_provenance() {
  if [ -n "${RAILGUARD_DOWNLOAD_URL:-}" ]; then
    say "custom download URL: build provenance not checked"
  elif gh_ready && [ "$(gh repo view "$REPO" --json isPrivate --jq .isPrivate 2>/dev/null)" = "true" ]; then
    say "checksum verified; GitHub publishes no build provenance for a private repository"
  elif gh_ready; then
    gh attestation verify "$1" --repo "$REPO" >/dev/null || fail "build provenance of $(basename "$1") did not verify against $REPO"
    say "verified build provenance against $REPO"
  else
    say "checksum verified; build provenance not checked (needs an authenticated gh: gh attestation verify)"
  fi
}

install_release() {
  local asset base expected actual
  asset="railguard-$(platform)$(executable_suffix)"
  WORK_DIR="$(mktemp -d)"
  if [ -z "${RAILGUARD_DOWNLOAD_URL:-}" ] && gh_ready; then
    # gh downloads from private repositories too; without a tag it takes the latest release.
    local tag=()
    [ "$VERSION" = "latest" ] || tag=("v$VERSION")
    say "downloading $asset from $REPO with gh"
    gh release download ${tag[@]+"${tag[@]}"} --repo "$REPO" --pattern "$asset" --pattern SHA256SUMS --dir "$WORK_DIR" \
      || fail "gh could not download $asset from $REPO"
  else
    if [ -n "${RAILGUARD_DOWNLOAD_URL:-}" ]; then
      base="${RAILGUARD_DOWNLOAD_URL%/}"
    elif [ "$VERSION" = "latest" ]; then
      base="https://github.com/$REPO/releases/latest/download"
    else
      base="https://github.com/$REPO/releases/download/v$VERSION"
    fi
    say "downloading $asset from $base"
    download "$base/$asset" "$WORK_DIR/$asset" || fail "download failed: $base/$asset (a private repository needs gh auth login)"
    download "$base/SHA256SUMS" "$WORK_DIR/SHA256SUMS" || fail "download failed: $base/SHA256SUMS"
  fi
  expected="$(awk -v name="$asset" '$2 == name {print $1}' "$WORK_DIR/SHA256SUMS")"
  [ -n "$expected" ] || fail "SHA256SUMS has no entry for $asset"
  actual="$(sha256_of "$WORK_DIR/$asset")"
  [ "$expected" = "$actual" ] || fail "checksum mismatch for $asset (expected $expected, got $actual)"
  verify_provenance "$WORK_DIR/$asset"
  install_binary "$WORK_DIR/$asset"
}

install_local() {
  local root
  [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ] || fail "--local must run from a checkout, not from a pipe"
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  for tool in node pnpm bun; do
    command -v "$tool" >/dev/null 2>&1 || fail "$tool is required for --local"
  done
  (cd "$root" && pnpm install --frozen-lockfile >/dev/null && node scripts/build-binaries.mjs --current)
  install_binary "$root/dist/bin/railguard-$(platform)$(executable_suffix)"
}

case "${1:-}" in
  "") install_release ;;
  --local) install_local ;;
  *) fail "usage: install.sh [--local]" ;;
esac

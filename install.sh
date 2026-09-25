#!/usr/bin/env bash
# Install or update the railguard binary.
#
#   curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/install.sh | bash
#   bash install.sh --local        # build and install from this checkout (requires Node, pnpm and Bun)
#
# Environment:
#   RAILGUARD_REPO         GitHub owner/repo that publishes releases (default: DEFAULT_REPO below)
#   RAILGUARD_VERSION      release version without "v" (default: latest)
#   RAILGUARD_INSTALL_DIR  destination directory (default: ~/.local/bin)
#   RAILGUARD_DOWNLOAD_URL base URL that holds the release assets (overrides REPO/VERSION)

set -euo pipefail

DEFAULT_REPO=""
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
    *) fail "unsupported operating system: $(uname -s). Use macOS, Linux or WSL." ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64) arch="x64" ;;
    *) fail "unsupported architecture: $(uname -m)" ;;
  esac
  printf '%s-%s' "$os" "$arch"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else fail "sha256sum or shasum is required to verify the download"
  fi
}

install_binary() {
  local source="$1"
  mkdir -p "$INSTALL_DIR"
  cp "$source" "$INSTALL_DIR/.railguard.tmp.$$"
  chmod 0755 "$INSTALL_DIR/.railguard.tmp.$$"
  mv -f "$INSTALL_DIR/.railguard.tmp.$$" "$INSTALL_DIR/railguard"
  say "installed $("$INSTALL_DIR/railguard" --version) at $INSTALL_DIR/railguard"
  case ":$PATH:" in
    *":$INSTALL_DIR:"*) ;;
    *) say "add $INSTALL_DIR to your PATH, for example: export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
  esac
}

install_release() {
  local asset base expected actual
  command -v curl >/dev/null 2>&1 || fail "curl is required"
  asset="railguard-$(platform)"
  if [ -n "${RAILGUARD_DOWNLOAD_URL:-}" ]; then
    base="${RAILGUARD_DOWNLOAD_URL%/}"
  else
    [ -n "$REPO" ] || fail "set RAILGUARD_REPO=<owner>/<repo> to choose the release source"
    if [ "$VERSION" = "latest" ]; then
      base="https://github.com/$REPO/releases/latest/download"
    else
      base="https://github.com/$REPO/releases/download/v$VERSION"
    fi
  fi
  WORK_DIR="$(mktemp -d)"
  say "downloading $asset from $base"
  curl -fsSL --retry 3 -o "$WORK_DIR/$asset" "$base/$asset" || fail "download failed: $base/$asset"
  curl -fsSL --retry 3 -o "$WORK_DIR/SHA256SUMS" "$base/SHA256SUMS" || fail "download failed: $base/SHA256SUMS"
  expected="$(awk -v name="$asset" '$2 == name {print $1}' "$WORK_DIR/SHA256SUMS")"
  [ -n "$expected" ] || fail "SHA256SUMS has no entry for $asset"
  actual="$(sha256_of "$WORK_DIR/$asset")"
  [ "$expected" = "$actual" ] || fail "checksum mismatch for $asset (expected $expected, got $actual)"
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
  install_binary "$root/dist/bin/railguard-$(platform)"
}

case "${1:-}" in
  "") install_release ;;
  --local) install_local ;;
  *) fail "usage: install.sh [--local]" ;;
esac

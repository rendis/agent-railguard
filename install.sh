#!/usr/bin/env bash

set -euo pipefail

PRODUCT_NAME="AI Harness"
PACKAGE_NAME="@example/ai-harness"
DEFAULT_MANIFEST_URL="https://<host-interno>/ai-harness/stable/release-manifest.json"
MANIFEST_URL="${AI_HARNESS_RELEASE_MANIFEST_URL:-$DEFAULT_MANIFEST_URL}"
PNPM_COMMAND="${AI_HARNESS_PNPM_COMMAND:-pnpm}"
INSTALL_TEMPORARY=""
ENGINE_CONFIG_TEMPORARY=""
INSTALL_MODE="remote"
LOCAL_SOURCE_ROOT=""

say() {
  printf '%s\n' "$*"
}

fail() {
  printf '%s: %s\n' "$PRODUCT_NAME" "$*" >&2
  exit 1
}

parse_arguments() {
  case "$#" in
    0) ;;
    1)
      [ "$1" = "--local" ] || fail "Usage: bash install.sh [--local]"
      INSTALL_MODE="local"
      ;;
    *) fail "Usage: bash install.sh [--local]" ;;
  esac

  if [ "$INSTALL_MODE" = "local" ]; then
    [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ] || \
      fail "--local must be executed from an AI Harness checkout, not from a pipe."
    LOCAL_SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
    [ -f "$LOCAL_SOURCE_ROOT/ai-harness.yaml" ] || \
      fail "Local source is missing ai-harness.yaml: $LOCAL_SOURCE_ROOT"
    [ -f "$LOCAL_SOURCE_ROOT/package.json" ] || \
      fail "Local source is missing package.json: $LOCAL_SOURCE_ROOT"
    [ -f "$LOCAL_SOURCE_ROOT/scripts/release/build-release.mjs" ] || \
      fail "Local source cannot build a release: $LOCAL_SOURCE_ROOT"
  fi
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required. Install it and run the installer again."
}

stable_version() {
  case "$1" in
    ''|*[!0-9.]*|.*|*.|*..*) return 1 ;;
  esac
  [ "$(printf '%s' "$1" | awk -F. '{print NF}')" -eq 3 ]
}

check_runtime() {
  local node_version pnpm_version node_major node_minor pnpm_major pnpm_minor
  node_version="$(node --version 2>/dev/null | sed 's/^v//')"
  stable_version "$node_version" || fail "Node.js returned an unsupported version: $node_version"
  node_major="$(printf '%s' "$node_version" | cut -d. -f1)"
  node_minor="$(printf '%s' "$node_version" | cut -d. -f2)"
  if [ "$node_major" -ne 24 ] || [ "$node_minor" -lt 19 ]; then
    fail "Node.js $node_version is unsupported. Install Node.js >=24.19.0 <25.0.0."
  fi

  pnpm_version="$($PNPM_COMMAND --version 2>/dev/null)"
  stable_version "$pnpm_version" || fail "pnpm returned an unsupported version: $pnpm_version"
  pnpm_major="$(printf '%s' "$pnpm_version" | cut -d. -f1)"
  pnpm_minor="$(printf '%s' "$pnpm_version" | cut -d. -f2)"
  if [ "$pnpm_major" -ne 11 ] || [ "$pnpm_minor" -lt 21 ]; then
    fail "pnpm $pnpm_version is unsupported. Install pnpm >=11.21.0 <12.0.0."
  fi
}

check_platform() {
  local system machine release
  system="$(uname -s)"
  machine="$(uname -m)"
  case "$system" in
    Darwin|Linux) ;;
    *) fail "Unsupported operating system: $system. Use macOS, Linux or WSL." ;;
  esac
  case "$machine" in
    x86_64|amd64|arm64|aarch64) ;;
    *) fail "Unsupported architecture: $machine." ;;
  esac
  if [ "$system" = "Linux" ]; then
    release="$(uname -r)"
    case "$release" in
      *icrosoft*|*WSL*) say "Detected Windows Subsystem for Linux." ;;
    esac
  fi
}

check_channel_url() {
  case "$MANIFEST_URL" in
    https://*) ;;
    file://*)
      [ "$INSTALL_MODE" = "local" ] || [ "${AI_HARNESS_ALLOW_FILE_RELEASES:-0}" = "1" ] || \
        fail "file release URLs are disabled."
      ;;
    http://127.0.0.1:*|http://localhost:*|http://\[::1\]:*)
      [ "${AI_HARNESS_ALLOW_LOOPBACK_RELEASES:-0}" = "1" ] || fail "HTTP release URLs are disabled."
      ;;
    *) fail "The release manifest URL must use HTTPS." ;;
  esac
  case "$MANIFEST_URL" in
    *://*@*) fail "The release manifest URL must not contain credentials." ;;
  esac
}

prepare_local_release() {
  local release_root source_version
  release_root="$INSTALL_TEMPORARY/local-release"
  if [ ! -x "$LOCAL_SOURCE_ROOT/node_modules/.bin/esbuild" ]; then
    say "Installing locked development dependencies..."
    "$PNPM_COMMAND" --dir "$LOCAL_SOURCE_ROOT" install --frozen-lockfile --ignore-scripts
  fi
  source_version="$(node -e '
const {readFileSync} = require("node:fs");
const value = JSON.parse(readFileSync(process.argv[1], "utf8"));
if (typeof value.version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value.version)) {
  throw new Error("package.json must declare a stable version");
}
process.stdout.write(value.version);
' "$LOCAL_SOURCE_ROOT/package.json")" || fail "The local package version is invalid."
  say "Building the verified local engine package..."
  node "$LOCAL_SOURCE_ROOT/scripts/release/build-release.mjs" \
    --out "$release_root" --version "$source_version" >/dev/null
  MANIFEST_URL="$(node -e '
const {pathToFileURL} = require("node:url");
process.stdout.write(pathToFileURL(process.argv[1]).href);
' "$release_root/release-manifest.json")"
}

download() {
  local url destination protocol
  url="$1"
  destination="$2"
  protocol="=https"
  case "$url" in
    file://*) protocol="=file" ;;
    http://*) protocol="=http" ;;
  esac
  if [ -n "${AI_HARNESS_CURL_CONFIG:-}" ]; then
    [ -f "$AI_HARNESS_CURL_CONFIG" ] || fail "AI_HARNESS_CURL_CONFIG is not a regular file."
    curl --fail --silent --show-error --proto "$protocol" --tlsv1.2 \
      --config "$AI_HARNESS_CURL_CONFIG" --output "$destination" "$url"
  else
    curl --fail --silent --show-error --proto "$protocol" --tlsv1.2 \
      --output "$destination" "$url"
  fi
}

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    fail "shasum or sha256sum is required to verify the release artifact."
  fi
}

cleanup() {
  if [ -n "${INSTALL_TEMPORARY:-}" ] && [ -d "$INSTALL_TEMPORARY" ]; then
    rm -rf "$INSTALL_TEMPORARY"
  fi
  if [ -n "${ENGINE_CONFIG_TEMPORARY:-}" ] && [ -f "$ENGINE_CONFIG_TEMPORARY" ]; then
    rm -f "$ENGINE_CONFIG_TEMPORARY"
  fi
}

engine_config_path() {
  if [ -n "${AI_HARNESS_ENGINE_CONFIG:-}" ]; then
    printf '%s\n' "$AI_HARNESS_ENGINE_CONFIG"
  else
    printf '%s\n' "${XDG_CONFIG_HOME:-$HOME/.config}/ai-harness/engine.json"
  fi
}

preflight_engine_config() {
  local target parent probe
  target="$1"
  [ ! -L "$target" ] || fail "Engine configuration target must not be a symlink: $target"
  [ ! -e "$target" ] || [ -f "$target" ] || fail "Engine configuration target must be a regular file: $target"
  if [ -e "$target" ]; then
    [ -w "$target" ] || fail "Engine configuration is not writable: $target"
  fi
  parent="$(dirname "$target")"
  probe="$parent"
  while [ ! -e "$probe" ]; do
    [ "$probe" != "/" ] || break
    probe="$(dirname "$probe")"
  done
  [ -d "$probe" ] && [ -w "$probe" ] || fail "Engine configuration directory is not writable: $parent"
}

main() {
  local manifest_file fields version artifact_url expected_digest expected_size content_manifest_url
  local artifact_file actual_digest actual_size package_manifest global_bin installed_version
  local engine_config engine_config_directory

  parse_arguments "$@"
  [ "${BASH_VERSINFO[0]}" -gt 3 ] || {
    [ "${BASH_VERSINFO[0]}" -eq 3 ] && [ "${BASH_VERSINFO[1]}" -ge 2 ]
  } || fail "Bash 3.2 or newer is required."
  check_platform
  require_command git
  require_command node
  require_command "$PNPM_COMMAND"
  require_command curl
  require_command tar
  check_runtime
  engine_config="$(engine_config_path)"
  preflight_engine_config "$engine_config"

  umask 077
  INSTALL_TEMPORARY="$(mktemp -d "${TMPDIR:-/tmp}/ai-harness-install.XXXXXX")"
  trap cleanup EXIT HUP INT TERM
  if [ "$INSTALL_MODE" = "local" ]; then
    prepare_local_release
  fi
  check_channel_url
  manifest_file="$INSTALL_TEMPORARY/release-manifest.json"
  if [ "$INSTALL_MODE" = "local" ]; then
    say "Resolving the verified local release..."
  else
    say "Resolving the verified corporate release..."
  fi
  download "$MANIFEST_URL" "$manifest_file"

  fields="$(node - "$manifest_file" "$MANIFEST_URL" <<'NODE'
const {readFileSync} = require('node:fs');
const [file, manifestUrl] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(file, 'utf8'));
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const digest = /^sha256:[0-9a-f]{64}$/;
const fileName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
if (manifest?.schema !== 'ai-harness/release-manifest/v1' ||
    manifest?.release?.name !== '@example/ai-harness' ||
    !stable.test(manifest?.release?.version ?? '') ||
    manifest?.release?.runtime?.node !== '>=24.19.0 <25.0.0' ||
    manifest?.release?.runtime?.pnpm !== '>=11.21.0 <12.0.0' ||
    !fileName.test(manifest?.release?.artifact?.path ?? '') ||
    !digest.test(manifest?.release?.artifact?.sha256 ?? '') ||
    !Number.isSafeInteger(manifest?.release?.artifact?.size) ||
    !fileName.test(manifest?.content?.manifest?.path ?? '') ||
    manifest.release.artifact.size < 1) {
  throw new Error('Release manifest does not satisfy the installer contract');
}
const base = new URL('.', manifestUrl);
const artifact = new URL(manifest.release.artifact.path, manifestUrl);
const content = new URL(manifest.content.manifest.path, manifestUrl);
if (artifact.origin !== base.origin || !artifact.pathname.startsWith(base.pathname) ||
    content.origin !== base.origin || !content.pathname.startsWith(base.pathname)) {
  throw new Error('Artifact or content URL escapes the release channel');
}
process.stdout.write([
  manifest.release.version,
  artifact.href,
  manifest.release.artifact.sha256,
  String(manifest.release.artifact.size),
  content.href,
].join('\t'));
NODE
)" || fail "The release manifest is invalid."
  IFS=$'\t' read -r version artifact_url expected_digest expected_size content_manifest_url <<< "$fields"
  artifact_file="$INSTALL_TEMPORARY/ai-harness-$version.tgz"
  say "Downloading $PACKAGE_NAME@$version..."
  download "$artifact_url" "$artifact_file"
  actual_digest="sha256:$(sha256_file "$artifact_file")"
  [ "$actual_digest" = "$expected_digest" ] || fail "Artifact digest mismatch; nothing was installed."
  actual_size="$(wc -c < "$artifact_file" | tr -d ' ')"
  [ "$actual_size" = "$expected_size" ] || fail "Artifact size mismatch; nothing was installed."

  package_manifest="$INSTALL_TEMPORARY/package.json"
  tar -xOf "$artifact_file" package/package.json > "$package_manifest"
  node - "$package_manifest" "$version" <<'NODE'
const {readFileSync} = require('node:fs');
const [file, version] = process.argv.slice(2);
const value = JSON.parse(readFileSync(file, 'utf8'));
const forbidden = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'scripts'];
if (value.name !== '@example/ai-harness' || value.version !== version ||
    value.bin?.['ai-harness'] !== 'dist/cli.js' || value.engines?.node !== '>=24.19.0 <25.0.0' ||
    forbidden.some((field) => Object.prototype.hasOwnProperty.call(value, field))) {
  throw new Error('Tarball package manifest is not the dependency-free release contract');
}
NODE

  if ! global_bin="$($PNPM_COMMAND bin --global 2>/dev/null)" || [ -z "$global_bin" ]; then
    fail "pnpm global bin is not ready. Run 'pnpm setup', open a new shell, and retry."
  fi
  [ -d "$global_bin" ] || mkdir -p "$global_bin"

  engine_config_directory="$(dirname "$engine_config")"
  if [ ! -d "$engine_config_directory" ]; then
    mkdir -p "$engine_config_directory"
    chmod 700 "$engine_config_directory"
  fi
  ENGINE_CONFIG_TEMPORARY="$(mktemp "$engine_config_directory/.engine.json.XXXXXX")"
  node - "$ENGINE_CONFIG_TEMPORARY" "$INSTALL_MODE" "$content_manifest_url" "$LOCAL_SOURCE_ROOT" <<'NODE'
const {writeFileSync} = require('node:fs');
const [file, mode, contentManifestUrl, localSourceRoot] = process.argv.slice(2);
const config = mode === 'local'
  ? {schema: 'ai-harness/engine-config/v1', content_source_path: localSourceRoot}
  : {schema: 'ai-harness/engine-config/v1', content_manifest_url: contentManifestUrl};
writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, {mode: 0o600});
NODE
  chmod 600 "$ENGINE_CONFIG_TEMPORARY"

  say "Installing the verified dependency-free package with pnpm..."
  "$PNPM_COMMAND" add --global --offline --ignore-scripts "$artifact_file"
  [ -x "$global_bin/ai-harness" ] || fail "pnpm completed but ai-harness is not executable in $global_bin."
  installed_version="$($global_bin/ai-harness --version)"
  [ "$installed_version" = "$version" ] || fail "Installed CLI smoke returned $installed_version instead of $version."
  mv -f "$ENGINE_CONFIG_TEMPORARY" "$engine_config"
  ENGINE_CONFIG_TEMPORARY=""

  say "$PRODUCT_NAME $version installed successfully."
  if [ "$INSTALL_MODE" = "local" ]; then
    say "Local project content source configured: $LOCAL_SOURCE_ROOT"
  else
    say "Project content channel configured: $content_manifest_url"
  fi
  say "Command: $global_bin/ai-harness"
  case ":${PATH}:" in
    *":$global_bin:"*) ;;
    *) say "Open a new shell so the pnpm global bin directory is added to PATH." ;;
  esac
}

main "$@"

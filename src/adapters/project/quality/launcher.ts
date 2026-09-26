/** Repository-relative path of the launcher that runs the engine version a repository pins. */
export const launcherPath = ".railguard/bin/railguard";

/** The engine release a repository's launcher pins. */
export interface EngineRelease {
  readonly version: string;
  /** GitHub `owner/repo` whose releases publish the binaries. */
  readonly repository: string;
}

/** Exit status of the launcher when the pinned engine cannot be obtained. */
export const engineUnavailable = 127;

/**
 * Runs the engine version this repository pins: the cached release binary, a `railguard` on PATH
 * of exactly that version, or the release downloaded once and verified against its SHA256SUMS.
 * A private release is reached through an authenticated gh or, where gh is missing (a CI image),
 * a GH_TOKEN or GITHUB_TOKEN sent to the GitHub API. Only stderr is used, so a hook's stdout
 * protocol passes through untouched.
 */
export function launcherBody(engine: EngineRelease): string {
  return `#!/bin/sh
# Managed by Railguard: runs the railguard version this repository pins.
set -eu
version=${engine.version}
repository=${engine.repository}

fail() {
  printf 'railguard %s is not available: %s\n' "$version" "$1" >&2
  printf 'Authenticate with gh auth login, or install this version with RAILGUARD_VERSION=%s and the Railguard install.sh.\n' "$version" >&2
  exit ${engineUnavailable}
}

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "unsupported operating system $(uname -s)" ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) fail "unsupported architecture $(uname -m)" ;;
esac
# A shell translated by Rosetta reports x86_64 on Apple silicon; use the native binary.
if [ "$os-$arch" = darwin-x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then
  arch=arm64
fi
asset="railguard-$os-$arch"
cache="\${XDG_CACHE_HOME:-$HOME/.cache}/railguard/$version"

if [ -x "$cache/railguard" ]; then
  exec "$cache/railguard" "$@"
fi
installed="$(command -v railguard 2>/dev/null || true)"
if [ -n "$installed" ] && ! [ "$installed" -ef "$0" ] && [ "$("$installed" --version 2>/dev/null || true)" = "$version" ]; then
  exec "$installed" "$@"
fi

download() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then wget -q --tries=3 -O "$2" "$1"
  else return 1
  fi
}
# Downloads a release asset through the GitHub API, which also serves private repositories.
api_asset() {
  id="$(tr ',{}' '\\n\\n\\n' < "$work/release.json" \\
    | awk -v name="$1" '/"id":/ { gsub(/[^0-9]/, ""); id = $0 } /"name":/ && index($0, "\\"" name "\\"") { print id; exit }')"
  [ -n "$id" ] || return 1
  curl -fsSL --retry 3 -H "Authorization: Bearer $token" -H "Accept: application/octet-stream" \\
    -o "$work/$1" "$api/repos/$repository/releases/assets/$id"
}
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'
  fi
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
printf 'railguard: downloading %s %s\n' "$version" "$asset" >&2
if [ -n "\${RAILGUARD_DOWNLOAD_URL:-}" ]; then
  base="\${RAILGUARD_DOWNLOAD_URL%/}"
  { download "$base/$asset" "$work/$asset" && download "$base/SHA256SUMS" "$work/SHA256SUMS"; } </dev/null \\
    || fail "could not download $base/$asset"
elif command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  gh release download "v$version" --repo "$repository" --pattern "$asset" --pattern SHA256SUMS --dir "$work" \\
    </dev/null >/dev/null 2>&1 || fail "gh could not download release v$version of $repository"
elif [ -n "\${GH_TOKEN:-\${GITHUB_TOKEN:-}}" ] && command -v curl >/dev/null 2>&1; then
  token="\${GH_TOKEN:-\${GITHUB_TOKEN:-}}"
  api="\${RAILGUARD_GITHUB_API:-https://api.github.com}"
  { curl -fsSL --retry 3 -H "Authorization: Bearer $token" -o "$work/release.json" \\
      "$api/repos/$repository/releases/tags/v$version" \\
    && api_asset "$asset" && api_asset SHA256SUMS; } </dev/null \\
    || fail "the GitHub API did not serve release v$version of $repository with the given token"
else
  base="https://github.com/$repository/releases/download/v$version"
  { download "$base/$asset" "$work/$asset" && download "$base/SHA256SUMS" "$work/SHA256SUMS"; } </dev/null \\
    || fail "could not download $base/$asset (a private repository needs gh auth login)"
fi
expected="$(awk -v name="$asset" '$2 == name {print $1}' "$work/SHA256SUMS")"
[ -n "$expected" ] && [ "$expected" = "$(sha256 "$work/$asset")" ] || fail "checksum mismatch for $asset"
mkdir -p "$cache"
chmod 0755 "$work/$asset"
mv -f "$work/$asset" "$cache/.railguard.$$"
mv -f "$cache/.railguard.$$" "$cache/railguard"
rm -rf "$work"
trap - EXIT
exec "$cache/railguard" "$@"
`;
}

/** The engine version a launcher pins, or null when the text is not a Railguard launcher. */
export function pinnedVersion(launcher: string): string | null {
  return /^version=(\d+\.\d+\.\d+)$/mu.exec(launcher)?.[1] ?? null;
}

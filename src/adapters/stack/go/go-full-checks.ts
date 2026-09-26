import type { FullCheck, FullCheckRequest } from "../../../domain/verification/checks.js";
import { shellQuote } from "../../../domain/verification/verify-script.js";

/**
 * Shell that judges a whole Go module from its root, for the repository's verify script. Inputs
 * and thresholds are written into the script, so CI needs only Go and the module's pinned tools.
 */
export function goFullCheck(kind: string, request: FullCheckRequest): FullCheck {
  const input = (id: string, fallback: readonly string[]) => request.inputs[id] ?? fallback;
  const words = (values: readonly string[]) => values.map(shellQuote).join(" ");
  const modfile = input("tool_modfile", ["go.mod"])[0] ?? "go.mod";
  const tool = (name: string) =>
    `go tool -modfile=${shellQuote(modfile)} -n ${name} >/dev/null 2>&1 ||\n` +
    `  unavailable ${shellQuote(`${name} is not a tool of ${modfile}; pin it with: go get -tool -modfile=${modfile} <module>@<version>`)}`;
  const run = (name: string) => `go tool -modfile=${shellQuote(modfile)} ${name}`;
  const testPackages = words(input("test_packages", ["./..."]));
  switch (kind) {
    case "go-format":
      return script(
        'listed=$(gofmt -l .) || { echo "gofmt could not read the sources" >&2; exit 1; }',
        // The Go tool ignores vendor, testdata and directories that start with . or _; gofmt on
        // Windows separates paths with a backslash.
        `unformatted=$(printf '%s\\n' "$listed" | tr '\\\\' / | awk -F/ 'NF { for (i = 1; i < NF; i++) if ($i == "vendor" || $i == "testdata" || $i ~ /^[._]/) next; print }') ||`,
        '  { echo "gofmt output could not be filtered" >&2; exit 1; }',
        '[ -z "$unformatted" ] || { echo "Go files need gofmt -w:" >&2; echo "$unformatted" >&2; exit 1; }',
      );
    case "go-vet":
      return script(`go vet ${testPackages} || exit 1`);
    case "go-test":
      return script(`go test -count=1${request.params.race === true ? " -race -shuffle=on" : ""} ${testPackages} || exit 1`);
    case "go-mod-verify":
      return script("go mod verify || exit 1");
    case "golangci-lint":
      return script(
        "config=",
        "for candidate in .golangci.yml .golangci.yaml .golangci.toml .golangci.json; do",
        '  if [ -f "$candidate" ]; then config=$candidate; break; fi',
        "done",
        '[ -n "$config" ] || unavailable "No golangci-lint configuration in the module root; create .golangci.yml (the configure-go-quality skill provides the default)."',
        tool("golangci-lint"),
        `${run("golangci-lint")} run --config "$config" ./... || exit 1`,
      );
    case "go-coverage":
      return coverage(request, words, input);
    case "govulncheck":
      return script(tool("govulncheck"), `${run("govulncheck")} ./... || exit 1`);
    case "go-fuzz": {
      const cases = input("cases", ["disabled"]).filter((value) => value !== "disabled");
      if (cases.length === 0) return skipped("No fuzz case configured");
      return script(...cases.map((value) => {
        const [pkg = "", target = "", duration = ""] = value.split(":");
        return `go test -run='^$' -fuzz=${shellQuote(`^${target}$`)} -fuzztime=${shellQuote(duration)} ${shellQuote(pkg)} || exit 1`;
      }));
    }
    case "go-mutation":
      return script(
        tool("gremlins"),
        'report=$(mktemp) || exit 4',
        'trap \'rm -f "$report"\' EXIT',
        `packages=$(go list -e -f '{{.Dir}}' ${words(input("packages", ["./..."]))}) || exit 1`,
        '[ -n "$packages" ] || { echo "No package in the mutation scope"; exit 0; }',
        "survivors=0",
        "for dir in $packages; do",
        '  if [ "$dir" = "$PWD" ]; then package=.; else package="./${dir#"$PWD"/}"; fi',
        '  rm -f "$report"',
        "  set --",
        "  [ ! -f .gremlins.yaml ] || set -- --config .gremlins.yaml",
        `  ${run("gremlins")} "$@" unleash -o "$report" "$package" || { echo "Gremlins failed for $package" >&2; exit 1; }`,
        // A package without statements, such as one that only declares types, has no mutant.
        '  [ -s "$report" ] || continue',
        `  lived=$(grep -Eo '"status"[[:space:]]*:[[:space:]]*"(LIVED|NOT_COVERED)"' "$report" | wc -l)`,
        "  survivors=$((survivors + lived))",
        "done",
        '[ "$survivors" -eq 0 ] || { echo "$survivors mutant(s) survived or were not covered" >&2; exit 1; }',
      );
    case "go-e2e": {
      const packages = input("packages", ["disabled"]).filter((value) => value !== "disabled");
      if (packages.length === 0) return skipped("No end-to-end package configured");
      return script(
        // Testcontainers finds a non-default Docker (Colima, rootless) through the active context.
        'if [ -z "${DOCKER_HOST:-}" ] && command -v docker >/dev/null 2>&1; then',
        "  DOCKER_HOST=$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null) && export DOCKER_HOST",
        "fi",
        'TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE="${TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE:-/var/run/docker.sock}"',
        "export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE",
        `go test -count=1 -tags=e2e -timeout=5m ${words(packages)} || exit 1`,
      );
    }
    case "go-imports":
      return imports(input);
    default:
      return script(`unavailable ${shellQuote(`Unknown Go check kind ${kind}`)}`);
  }
}

/**
 * Statement coverage of the core packages and of every measured package, from one run that
 * instruments both sets. A file belongs to the core when its package matches core_packages.
 */
function coverage(
  request: FullCheckRequest,
  words: (values: readonly string[]) => string,
  input: (id: string, fallback: readonly string[]) => readonly string[],
): FullCheck {
  const coverPackages = [...new Set([
    ...input("core_cover_packages", ["./internal/core/..."]),
    ...input("overall_cover_packages", ["./cmd/...", "./internal/..."]),
  ])];
  const number = (value: unknown, fallback: number) => (typeof value === "number" ? value : fallback);
  return script(
    "module=$(go list -m) || exit 1",
    "profile=$(mktemp) || exit 4",
    'trap \'rm -f "$profile"\' EXIT',
    `go test -count=1 -covermode=set -coverpkg=${shellQuote(coverPackages.join(","))} -coverprofile="$profile" ${words(input("test_packages", ["./..."]))}`,
    "tests=$?",
    '[ -s "$profile" ] || { echo "Tests did not produce a coverage profile" >&2; exit 1; }',
    '[ -z "${COVERAGE_PROFILE:-}" ] || cp "$profile" "$COVERAGE_PROFILE" || exit 1',
    '[ "$tests" -eq 0 ] || echo "Some tests failed; coverage only counts the tests that ran." >&2',
    `awk -v module="$module" -v core=${shellQuote(input("core_packages", []).join(" "))} \\`,
    `  -v core_min=${number(request.params.core_min, 100)} -v overall_min=${number(request.params.overall_min, 85)} '`,
    packagePatternAwk,
    "  NR > 1 && NF == 3 {",
    "    statements[$1] = $2",
    "    if ($3 > 0) hit[$1] = 1",
    "  }",
    "  END {",
    "    for (block in statements) {",
    "      if (statements[block] == 0) continue",
    '      file = block; sub(/:[0-9.,]+$/, "", file)',
    "      counted = hit[block] ? statements[block] : 0",
    "      all_total += statements[block]; all_covered += counted",
    "      if (matches_any(package_dir(file), core)) { core_total += statements[block]; core_covered += counted }",
    "    }",
    '    printf "Coverage: core %s, overall %s\\n", tally(core_covered, core_total), tally(all_covered, all_total)',
    "    failed = 0",
    '    if (core_total > 0 && core_covered * 100 < core_total * core_min) { printf "core statements are below the required %d%%\\n", core_min > "/dev/stderr"; failed = 1 }',
    '    if (all_total > 0 && all_covered * 100 < all_total * overall_min) { printf "all statements are below the required %d%%\\n", overall_min > "/dev/stderr"; failed = 1 }',
    "    exit failed",
    "  }",
    '  function tally(covered, total) { return total == 0 ? "n/a" : sprintf("%.1f%% (%d/%d)", covered * 100 / total, covered, total) }',
    `' "$profile" || exit 1`,
  );
}

/**
 * Dependency direction from `go list`: a core package imports only the standard library (minus
 * core_denied_stdlib), other core packages and core_allowed_imports; forbidden_imports adds
 * `from -> to` rules between packages of the module. Test imports are exempt.
 */
function imports(input: (id: string, fallback: readonly string[]) => readonly string[]): FullCheck {
  const core = input("core_packages", []).filter((value) => value !== "disabled");
  const allowed = input("core_allowed_imports", []).filter((value) => value !== "none");
  const denied = input("core_denied_stdlib", []).filter((value) => value !== "none");
  const rules = input("forbidden_imports", []).filter((value) => value !== "none")
    .map((rule) => rule.split("->").map((part) => part.trim()).join(">"));
  if (core.length === 0 && rules.length === 0) return skipped("No dependency rule configured");
  return script(
    "module=$(go list -m) || exit 1",
    "listing=$(go list -e -f '{{.ImportPath}}{{range .Imports}} {{.}}{{end}}' ./...) || exit 1",
    `printf '%s\\n' "$listing" | awk -v module="$module" -v core=${shellQuote(core.join(" "))} \\`,
    `  -v allowed=${shellQuote(allowed.join(" "))} -v denied=${shellQuote(denied.join(" "))} -v rules=${shellQuote(rules.join(" "))} '`,
    packagePatternAwk,
    "  function internal(path) { return path == module || index(path, module \"/\") == 1 }",
    '  function relative(path) { return path == module ? "." : substr(path, length(module) + 2) }',
    "  function has_prefix(path, prefixes,    count, list, i) {",
    "    count = split(prefixes, list, \" \")",
    '    for (i = 1; i <= count; i++) if (path == list[i] || index(path, list[i] "/") == 1) return 1',
    "    return 0",
    "  }",
    "  NF > 0 && internal($1) {",
    "    dir = relative($1)",
    "    in_core = matches_any(dir, core)",
    '    rule_count = split(rules, rule_list, " ")',
    "    for (i = 2; i <= NF; i++) {",
    "      imported = $i",
    "      target = internal(imported) ? relative(imported) : \"\"",
    "      if (in_core) {",
    "        split(imported, first, \"/\")",
    "        if (index(first[1], \".\") == 0 && target == \"\") {",
    "          if (has_prefix(imported, denied)) { print dir \": core imports \" imported; violations++ }",
    "        } else if (target != \"\" ? !matches_any(target, core) : !has_prefix(imported, allowed)) {",
    "          print dir \": core imports \" imported; violations++",
    "        }",
    "      }",
    "      for (r = 1; r <= rule_count; r++) {",
    '        split(rule_list[r], sides, ">")',
    "        if (target != \"\" && matches_any(dir, sides[1]) && matches_any(target, sides[2])) {",
    '          print dir ": imports " imported " (forbidden by \\"" sides[1] " -> " sides[2] "\\")"; violations++',
    "        }",
    "      }",
    "    }",
    "  }",
    "  END {",
    '    if (violations > 0) { printf "%d forbidden import(s)\\n", violations > "/dev/stderr"; exit 1 }',
    "  }",
    "' || exit 1",
  );
}

/** awk functions that match a module-relative package directory against Go package patterns. */
const packagePatternAwk = [
  "  function normalize(pattern) {",
  '    sub(/^\\.\\//, "", pattern); sub(/\\/$/, "", pattern)',
  '    return pattern == "" ? "." : pattern',
  "  }",
  "  function matches(dir, pattern,    base) {",
  '    if (pattern == "./..." || pattern == "...") return 1',
  "    if (pattern ~ /\\/\\.\\.\\.$/) {",
  "      base = normalize(substr(pattern, 1, length(pattern) - 4))",
  '      return base == "." || dir == base || index(dir, base "/") == 1',
  "    }",
  "    return dir == normalize(pattern)",
  "  }",
  "  function matches_any(dir, patterns,    count, list, i) {",
  '    count = split(patterns, list, " ")',
  "    for (i = 1; i <= count; i++) if (matches(dir, list[i])) return 1",
  "    return 0",
  "  }",
  "  function package_dir(file) {",
  '    if (index(file, module "/") == 1) file = substr(file, length(module) + 2)',
  '    if (file !~ /\\//) return "."',
  '    sub(/\\/[^\\/]*$/, "", file)',
  "    return file",
  "  }",
].join("\n");

function script(...lines: string[]): FullCheck {
  return { kind: "script", body: lines.join("\n") };
}

function skipped(reason: string): FullCheck {
  return { kind: "skipped", reason };
}

import type { ChangedLines } from "./checks.js";

/**
 * Converts a repository glob to an anchored expression: `*` and `?` stay inside one path segment,
 * `**` crosses segments, and a pattern without `/` matches a file name at any depth.
 */
export function globToRegExp(glob: string): RegExp {
  const pattern = glob.includes("/") ? glob : `**/${glob}`;
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] as string;
    if (character === "*" && pattern[index + 1] === "*") {
      const slash = pattern[index + 2] === "/";
      source += slash ? "(?:.*/)?" : ".*";
      index += slash ? 2 : 1;
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`, "u");
}

export function matchesAnyGlob(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

/** Markers that switch a check off for a line, a test or a file instead of fixing the cause. */
const suppressionRules: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "lint suppression", pattern: /\/\/\s*nolint\b|eslint-disable|@ts-(?:ignore|nocheck|expect-error)\b|#\s*noqa\b|#\s*type:\s*ignore\b|#\s*pylint:\s*disable\b|@SuppressWarnings\(/u },
  { label: "security suppression", pattern: /#nosec\b|\bNOSONAR\b/u },
  { label: "skipped test", pattern: /\bt\.Skip(?:f|Now)?\(|\b(?:it|describe|test)\.skip\(|\bx(?:it|describe)\(|@pytest\.mark\.skip|\bpytest\.skip\(|@Disabled\b|@Ignore\b/u },
  { label: "focused test", pattern: /\b(?:it|describe|test)\.only\(|\bf(?:it|describe)\(/u },
  { label: "coverage exclusion", pattern: /istanbul ignore|\b[cv]8 ignore\b|pragma:\s*no cover|coverage:ignore/u },
];

const documentationFile = /\.(?:md|mdx|txt|rst|adoc)$/u;
const testFile = /(?:_test\.go|\.(?:test|spec)\.[cm]?[jt]sx?|(?:^|\/)test_[^/]*\.py|_test\.py|(?:Test|Tests|IT)\.java|\.feature)$/u;

export function isTestFile(path: string): boolean {
  return testFile.test(path);
}

/** How each kind of test file declares a single test; the first capture group is its name. */
const testDeclarations: readonly { readonly file: RegExp; readonly declaration: RegExp }[] = [
  { file: /_test\.go$/u, declaration: /^func[ \t]+(?:\([^)]*\)[ \t]*)?((?:Test|Benchmark|Fuzz|Example)\w*)[ \t]*(?:\[[^\]]*\][ \t]*)?\(/gmu },
  { file: /\.(?:test|spec)\.[cm]?[jt]sx?$/u, declaration: /(?<![.\w$])(?:it|test)(?:\.(?:only|skip|todo|concurrent|sequential|failing|fails))*\s*\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|`((?:\\.|[^`\\])*)`)/gmu },
  { file: /(?:(?:^|\/)test_[^/]*|_test)\.py$/u, declaration: /^[ \t]*(?:async[ \t]+)?def[ \t]+(test\w*)[ \t]*\(/gmu },
  { file: /(?:Test|Tests|IT)\.java$/u, declaration: /@(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b(?:\([^)]*\))?(?:\s*@[\w.]+(?:\([^)]*\))?)*\s+[^(;{@]*?\b(\w+)\s*\(/gmu },
  { file: /\.feature$/u, declaration: /^[ \t]*(?:Scenario(?: Outline| Template)?|Example):[ \t]*(.*?)[ \t]*$/gmu },
];

/** Names of the tests a test file declares, once per declaration. */
export function testNames(path: string, content: string): readonly string[] {
  const rule = testDeclarations.find((candidate) => candidate.file.test(path));
  if (rule === undefined) return [];
  return [...content.matchAll(rule.declaration)].map((match) => match.slice(1).find((name) => name !== undefined) ?? "");
}

/**
 * Tests the base declared in changed test files that the change no longer declares, as
 * `path: test <name> removed`. A test moved to another changed file keeps its name and is not reported.
 */
export function removedTestFindings(
  files: readonly { readonly path: string; readonly before: string; readonly after: string }[],
): readonly string[] {
  const net = new Map<string, number>();
  const decreased: { readonly path: string; readonly name: string }[] = [];
  for (const { path, before, after } of files) {
    const counts = new Map<string, number>();
    for (const name of testNames(path, before)) counts.set(name, (counts.get(name) ?? 0) + 1);
    for (const name of testNames(path, after)) counts.set(name, (counts.get(name) ?? 0) - 1);
    for (const [name, count] of counts) {
      net.set(name, (net.get(name) ?? 0) + count);
      if (count > 0) decreased.push({ path, name });
    }
  }
  return decreased
    .filter(({ name }) => (net.get(name) ?? 0) > 0)
    .map(({ path, name }) => `${path}: test ${name} removed`);
}

/** Suppression markers on the changed lines of one source file, as `path:line: label: text`. */
export function suppressionFindings(path: string, content: string, lines: ChangedLines): readonly string[] {
  if (documentationFile.test(path)) return [];
  const findings: string[] = [];
  content.split("\n").forEach((text, index) => {
    const line = index + 1;
    if (lines !== "all" && !lines.has(line)) return;
    const rule = suppressionRules.find((candidate) => candidate.pattern.test(text));
    if (rule !== undefined) findings.push(`${path}:${line}: ${rule.label}: ${text.trim().slice(0, 160)}`);
  });
  return findings;
}

/** Number of added or modified lines a file contributes to the change. */
export function changedLineCount(content: string, lines: ChangedLines): number {
  if (lines !== "all") return lines.size;
  if (content.length === 0) return 0;
  return content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
}

/**
 * `Railguard-Allow: <check-kind>: <reason>` trailers from commit messages. They record that a
 * person accepted one guard finding on purpose; a trailer without a reason accepts nothing.
 */
export function parseAllowances(messages: string): ReadonlyMap<string, string> {
  const allowances = new Map<string, string>();
  for (const match of messages.matchAll(/^Railguard-Allow:\s*([a-z0-9-]+)\s*:\s*(\S.*)$/gmu)) {
    allowances.set(match[1] as string, (match[2] as string).trim());
  }
  return allowances;
}

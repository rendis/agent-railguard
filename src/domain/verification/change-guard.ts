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
  return testDeclarationsIn(path, content).map(({ name }) => name);
}

/** Each test a test file declares, with its text: from its declaration to the next one. */
function testDeclarationsIn(path: string, content: string): readonly { readonly name: string; readonly body: string }[] {
  const rule = testDeclarations.find((candidate) => candidate.file.test(path));
  if (rule === undefined) return [];
  const matches = [...content.matchAll(rule.declaration)];
  return matches.map((match, index) => ({
    name: match.slice(1).find((name) => name !== undefined) ?? "",
    body: content.slice(match.index, matches[index + 1]?.index ?? content.length),
  }));
}

/** How production code declares functions, methods, types and classes; the first capture group is the name. */
const symbolDeclarations: readonly { readonly file: RegExp; readonly declarations: readonly RegExp[] }[] = [
  { file: /\.go$/u, declarations: [/^func[ \t]+(?:\([^)]*\)[ \t]*)?(\w+)/gmu, /^type[ \t]+(\w+)/gmu] },
  {
    file: /\.[cm]?[jt]sx?$/u,
    declarations: [
      /(?<![\w$.])(?:function\*?|class|interface|type|enum)[ \t]+([A-Za-z_$][\w$]*)/gmu,
      /^[ \t]*export[ \t]+(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)/gmu,
    ],
  },
  { file: /\.py$/u, declarations: [/^[ \t]*(?:async[ \t]+)?(?:def|class)[ \t]+(\w+)/gmu] },
  {
    file: /\.java$/u,
    declarations: [
      /\b(?:class|interface|enum|record)[ \t]+(\w+)/gmu,
      /^[ \t]*(?:(?:public|protected|private|static|final|abstract|synchronized)[ \t]+)+[\w<>[\],.? \t]+?[ \t](\w+)[ \t]*\(/gmu,
    ],
  },
];

/** Whether a file is production code in a language whose declarations `declaredSymbols` reads. */
export function declaresSymbols(path: string): boolean {
  return !isTestFile(path) && symbolDeclarations.some((candidate) => candidate.file.test(path));
}

/** Names a production source file declares; empty for a test file or a language without rules. */
export function declaredSymbols(path: string, content: string): readonly string[] {
  return [...new Set(symbolDeclarationsIn(path, content).map(({ name }) => name))];
}

/** Each symbol a production source file declares, with its text: from its declaration to the next one. */
function symbolDeclarationsIn(path: string, content: string): readonly { readonly name: string; readonly body: string }[] {
  if (isTestFile(path)) return [];
  const rule = symbolDeclarations.find((candidate) => candidate.file.test(path));
  if (rule === undefined) return [];
  const matches = rule.declarations
    .flatMap((pattern) => [...content.matchAll(pattern)].map((match) => ({ name: match[1]!, start: match.index })))
    .sort((left, right) => left.start - right.start);
  return matches.map(({ name, start }, index) => ({ name, body: content.slice(start, matches[index + 1]?.start ?? content.length) }));
}

/**
 * Symbols the base declared in `files` that the change no longer declares there, less those that
 * only took a new name: a symbol the change adds with the same text, of more than one line, under
 * another name. Whether a removed symbol is gone from the whole repository is the caller's to check.
 */
export function removedSymbols(
  files: readonly { readonly path: string; readonly before: string; readonly after: string }[],
): ReadonlySet<string> {
  const before = files.flatMap(({ path, before: content }) => symbolDeclarationsIn(path, content));
  const after = files.flatMap(({ path, after: content }) => symbolDeclarationsIn(path, content));
  const beforeNames = new Set(before.map(({ name }) => name));
  const afterNames = new Set(after.map(({ name }) => name));
  const addedTexts = new Set(after.filter(({ name }) => !beforeNames.has(name)).map(symbolText).filter((text) => text.includes("\n")));
  const removed = before.filter((symbol) => !afterNames.has(symbol.name));
  // A name is renamed only when every declaration it had reappears under another name.
  const renamed = new Set(removed.map(({ name }) => name).filter((name) =>
    removed.filter((symbol) => symbol.name === name).every((symbol) => addedTexts.has(symbolText(symbol)))));
  return new Set(removed.map(({ name }) => name).filter((name) => !renamed.has(name)));
}

/** A declaration's text without its name, nor the comments and blank lines that lead into the next one. */
function symbolText(symbol: { readonly name: string; readonly body: string }): string {
  const lines = withoutName(symbol.body, symbol.name).split("\n");
  while (lines.length > 0 && /^\s*(?:$|\/\/|#|\/\*|\*)/u.test(lines.at(-1)!)) lines.pop();
  return lines.join("\n").trim();
}

function withoutName(text: string, name: string): string {
  return text.replace(new RegExp(`(?<![\\w$])${name.replace(/[$]/gu, "\\$&")}(?![\\w$])`, "gu"), "");
}

function mentions(text: string, symbol: string): boolean {
  return new RegExp(`(?<![\\w$])${symbol.replace(/[$]/gu, "\\$&")}(?![\\w$])`, "u").test(text);
}

/**
 * How the change altered the tests of changed and deleted test files, one finding each:
 * `deleted` and `removed` tests lost, `renamed` ones that took a new name in place, and
 * `obsolete` ones that went with the code they tested.
 */
export interface TestChanges {
  readonly deleted: readonly string[];
  readonly removed: readonly string[];
  readonly renamed: readonly string[];
  readonly obsolete: readonly string[];
}

/**
 * Judges the tests the base declared in changed and deleted test files. A test moved to another
 * changed file keeps its name and is no finding. A test whose name disappears is renamed when a new
 * test in the same file has its exact text, of more than one line, under another name. Otherwise it is obsolete when its
 * text at the base mentions a symbol in `goneSymbols` (production code the change removed from the
 * whole repository). Otherwise it is renamed when a new name takes its place: after the same
 * surviving declaration (or at the start), with as many tests arriving there as leaving, paired in
 * order, and using an identifier that set the old test apart from the rest of the file (unless
 * none did). Any other is removed. A deleted test file is obsolete when each of its tests that left is,
 * and at least one did.
 */
export function testChanges(
  files: readonly { readonly path: string; readonly before: string; readonly after: string; readonly deleted?: boolean }[],
  goneSymbols: ReadonlySet<string> = new Set(),
): TestChanges {
  const declared = files.map((file) => {
    const afterTests = testDeclarationsIn(file.path, file.after);
    return { ...file, tests: testDeclarationsIn(file.path, file.before), afterTests, after: afterTests.map(({ name }) => name) };
  });
  const net = new Map<string, number>();
  for (const { tests, after } of declared) {
    for (const { name } of tests) net.set(name, (net.get(name) ?? 0) + 1);
    for (const name of after) net.set(name, (net.get(name) ?? 0) - 1);
  }
  const findings = { deleted: new Set<string>(), removed: new Set<string>(), renamed: new Set<string>(), obsolete: new Set<string>() };
  // The name in a test's declaration is no use of the code it shares the name with.
  const isObsolete = (test: { readonly name: string; readonly body: string }) =>
    [...goneSymbols].some((symbol) => mentions(test.body.replace(test.name, ""), symbol));
  for (const { path, tests, afterTests, after, deleted } of declared) {
    const before = tests.map(({ name }) => name);
    // A name that left every changed file is gone; one no changed file had before is new.
    let gone = slotted(before, after).filter(({ name }) => (net.get(name) ?? 0) > 0);
    let added = slotted(after, before).filter(({ name }) => (net.get(name) ?? 0) < 0);
    if (deleted === true) {
      const obsolete = gone.length > 0 && gone.every(({ index }) => isObsolete(tests[index]!));
      (obsolete ? findings.obsolete : findings.deleted)
        .add(obsolete ? `${path}: test file deleted with the code it tested` : `${path}: test file deleted`);
      continue;
    }
    const rename = (from: { readonly name: string }, to: { readonly name: string }) => {
      findings.renamed.add(`${path}: test ${from.name} renamed to ${to.name}`);
      gone = gone.filter((entry) => entry !== from);
      added = added.filter((entry) => entry !== to);
    };
    // The same text under a new name is a rename wherever it lands; a one-line test says too little.
    for (const entry of [...gone]) {
      const text = unnamed(tests[entry.index]!);
      if (!text.includes("\n")) continue;
      const match = added.find((candidate) => unnamed(afterTests[candidate.index]!) === text);
      if (match !== undefined) rename(entry, match);
    }
    // A test that went with its code leaves no place for a new name to take.
    for (const entry of gone.filter(({ index }) => isObsolete(tests[index]!))) {
      findings.obsolete.add(`${path}: test ${entry.name} removed with the code it tested`);
      gone = gone.filter((candidate) => candidate !== entry);
    }
    const shared = sharedIdentifiers([...tests, ...afterTests]);
    for (const slot of new Set(gone.map((entry) => entry.slot))) {
      const leaving = gone.filter((entry) => entry.slot === slot);
      const arriving = added.filter((entry) => entry.slot === slot);
      leaving.forEach((entry, index) => {
        const to = arriving[index];
        if (leaving.length === arriving.length && to !== undefined && testsTheSame(tests[entry.index]!, afterTests[to.index]!, shared)) {
          rename(entry, to);
        } else {
          findings.removed.add(`${path}: test ${entry.name} removed`);
        }
      });
    }
  }
  return {
    deleted: [...findings.deleted],
    removed: [...findings.removed],
    renamed: [...findings.renamed],
    obsolete: [...findings.obsolete],
  };
}

function identifiers(test: { readonly name: string; readonly body: string }): ReadonlySet<string> {
  return new Set([...test.body.replace(test.name, "").matchAll(/[A-Za-z_$][\w$]*/gu)].map((match) => match[0]));
}

/** Identifiers every test of a file uses, such as its framework's: they tell no test apart. */
function sharedIdentifiers(tests: readonly { readonly name: string; readonly body: string }[]): ReadonlySet<string> {
  const [first, ...rest] = tests.map(identifiers);
  return new Set([...(first ?? [])].filter((identifier) => rest.every((others) => others.has(identifier))));
}

/**
 * Whether a new test can be the old one under a new name: it uses one of the identifiers that set
 * the old test apart from the rest of the file, or the old test had none.
 */
function testsTheSame(
  from: { readonly name: string; readonly body: string },
  to: { readonly name: string; readonly body: string },
  shared: ReadonlySet<string>,
): boolean {
  const own = [...identifiers(from)].filter((identifier) => !shared.has(identifier));
  const target = identifiers(to);
  return own.length === 0 || own.some((identifier) => target.has(identifier));
}

/** A test's text without its name or surrounding blank lines, to tell a pure rename. */
function unnamed(test: { readonly name: string; readonly body: string }): string {
  return test.body.replace(test.name, "").trim();
}

/**
 * Declarations of `names` that `others` does not hold (the last occurrences of a repeated name),
 * each with the surviving declaration it follows: `^` for the start, otherwise that name and its
 * occurrence, which identify the same place on both sides.
 */
function slotted(
  names: readonly string[],
  others: readonly string[],
): { readonly name: string; readonly index: number; readonly slot: string }[] {
  const surplus = new Map<string, number>();
  for (const name of names) surplus.set(name, (surplus.get(name) ?? 0) + 1);
  for (const name of others) surplus.set(name, (surplus.get(name) ?? 0) - 1);
  const remaining = new Map(surplus);
  const unmatched = names.map(() => false);
  for (let index = names.length - 1; index >= 0; index -= 1) {
    const name = names[index]!;
    const left = remaining.get(name) ?? 0;
    if (left <= 0) continue;
    unmatched[index] = true;
    remaining.set(name, left - 1);
  }
  const seen = new Map<string, number>();
  let slot = "^";
  const entries: { readonly name: string; readonly index: number; readonly slot: string }[] = [];
  names.forEach((name, index) => {
    if (unmatched[index]) {
      entries.push({ name, index, slot });
      return;
    }
    const occurrence = seen.get(name) ?? 0;
    seen.set(name, occurrence + 1);
    slot = `${occurrence}\0${name}`;
  });
  return entries;
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
  return parseTrailers("Railguard-Allow", messages);
}

/**
 * `Railguard-Request: <check-kind>: <reason>` trailers from commit messages. Anyone, an agent
 * included, may write one: it asks a person to accept a finding and accepts nothing by itself.
 */
export function parseRequests(messages: string): ReadonlyMap<string, string> {
  return parseTrailers("Railguard-Request", messages);
}

/** Trailer lines `<label>: <check-kind>: <reason>`; the last one of a kind in a message wins. */
function parseTrailers(label: string, messages: string): ReadonlyMap<string, string> {
  const trailers = new Map<string, string>();
  for (const match of messages.matchAll(new RegExp(`^${label}:\\s*([a-z0-9-]+)\\s*:\\s*(\\S.*)$`, "gmu"))) {
    trailers.set(match[1] as string, (match[2] as string).trim());
  }
  return trailers;
}

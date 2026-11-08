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

interface Declaration {
  readonly name: string;
  readonly start: number;
  readonly end: number;
  readonly body: string;
}

/**
 * Each test a test file declares, with its text: from its declaration to where it ends (its
 * closing bracket, or the end of its indented block in Python), never past the next test. A test
 * whose end cannot be read, and a Gherkin scenario, runs to the next test.
 */
function testDeclarationsIn(path: string, content: string): readonly Declaration[] {
  const rule = testDeclarations.find((candidate) => candidate.file.test(path));
  if (rule === undefined) return [];
  const syntax = syntaxOf(path);
  const code = syntax === undefined ? content : blankLiterals(content, syntax);
  const matches = [...content.matchAll(rule.declaration)];
  return matches.map((match, index) => {
    const next = matches[index + 1]?.index ?? content.length;
    // Every declaration pattern but Python's and Gherkin's ends inside the test's opening bracket.
    const extent = syntax === "c" ? statementEnd(code, match.index + match[0].length, 1, next)
      : syntax === "python" ? indentedEnd(code, match.index, next) : undefined;
    const end = Math.min(next, extent ?? next);
    return { name: match.slice(1).find((name) => name !== undefined) ?? "", start: match.index, end, body: content.slice(match.index, end) };
  });
}

type Syntax = "c" | "python";

/** How a file writes comments, strings and blocks: C-like brackets, or Python indentation. */
function syntaxOf(path: string): Syntax | undefined {
  if (/\.(?:go|[cm]?[jt]sx?|java)$/u.test(path)) return "c";
  if (/\.py$/u.test(path)) return "python";
  return undefined;
}

/**
 * The file with the contents of its comments and string literals replaced by spaces, offsets and
 * line breaks kept, so brackets and names inside them read as nothing. A quote that does not
 * close on its line (a word such as "don't" in JSX text) ends at that line.
 */
function blankLiterals(content: string, syntax: Syntax): string {
  const blank = (text: string) => text.replace(/[^\n]/gu, " ");
  const literal = syntax === "c"
    ? /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|`(?:\\[\s\S]|[^\\`])*(?:`|$)|"(?:\\.|[^"\\\n])*(?:"|(?=\n)|$)|'(?:\\.|[^'\\\n])*(?:'|(?=\n)|$)/gu
    : /#[^\n]*|"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\.|[^"\\\n])*(?:"|(?=\n)|$)|'(?:\\.|[^'\\\n])*(?:'|(?=\n)|$)/gu;
  return content.replace(literal, (text) => {
    const quote = /^(?:"""|'''|["'`])/u.exec(text)?.[0];
    if (quote === undefined) return blank(text);
    const closed = text.length >= quote.length * 2 && text.endsWith(quote);
    return quote + blank(text.slice(quote.length, closed ? -quote.length : undefined)) + (closed ? quote : "");
  });
}

/**
 * Where a C-like statement that starts at `from`, `depth` brackets deep, ends in blanked code: at
 * a `;` or a line break outside brackets that does not continue the statement, or at a bracket that
 * closes an enclosing block. Undefined when its brackets do not balance before `limit`.
 */
function statementEnd(code: string, from: number, depth: number, limit = code.length): number | undefined {
  let open = depth;
  let last = "";
  for (let index = from; index < limit; index += 1) {
    const character = code[index]!;
    if ("([{".includes(character)) open += 1;
    else if (")]}".includes(character) && (open -= 1) < 0) return index;
    else if (open === 0 && character === ";") return index + 1;
    else if (open === 0 && character === "\n" && last !== "" && !/[=>,([{+\-*/?:&|.!]/u.test(last)
      && !/^\s*[.?:{&|=]/u.test(code.slice(index + 1))) return index;
    if (!/\s/u.test(character)) last = character;
  }
  return open === 0 ? limit : undefined;
}

/**
 * Where a Python block that starts on the line holding `from` ends: the next line indented no
 * deeper, or `limit`.
 */
function indentedEnd(code: string, from: number, limit = code.length): number {
  const indent = indentationAt(code, from);
  let end = code.indexOf("\n", from);
  if (end < 0 || end >= limit) return limit;
  let cursor = end + 1;
  while (cursor < limit) {
    const next = code.indexOf("\n", cursor);
    const lineEnd = next < 0 || next > limit ? limit : next;
    const line = code.slice(cursor, lineEnd);
    if (line.trim() !== "") {
      if (/^[ \t]*/u.exec(line)![0].length <= indent) break;
      end = lineEnd;
    }
    cursor = lineEnd + 1;
  }
  return end;
}

function indentationAt(content: string, offset: number): number {
  const lineStart = content.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/u.exec(content.slice(lineStart))![0].length;
}

interface DeclarationRule {
  readonly pattern: RegExp;
  /** A constant or variable: one line of it, with its value, is enough to tell it under a new name. */
  readonly value?: boolean;
}

/** How production code declares functions, methods, types, classes and constants; the first capture group is the name. */
const symbolDeclarations: readonly { readonly file: RegExp; readonly declarations: readonly DeclarationRule[] }[] = [
  { file: /\.go$/u, declarations: [{ pattern: /^func[ \t]+(?:\([^)]*\)[ \t]*)?(\w+)/gmu }, { pattern: /^type[ \t]+(\w+)/gmu }] },
  {
    file: /\.[cm]?[jt]sx?$/u,
    declarations: [
      { pattern: /(?<![\w$.])(?:function\*?|class|interface|type|enum)[ \t]+([A-Za-z_$][\w$]*)/gmu },
      { pattern: /^[ \t]*export[ \t]+(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)/gmu, value: true },
    ],
  },
  { file: /\.py$/u, declarations: [{ pattern: /^[ \t]*(?:async[ \t]+)?(?:def|class)[ \t]+(\w+)/gmu }] },
  {
    file: /\.java$/u,
    declarations: [
      { pattern: /\b(?:class|interface|enum|record)[ \t]+(\w+)/gmu },
      { pattern: /^[ \t]*(?:(?:public|protected|private|static|final|abstract|synchronized)[ \t]+)+[\w<>[\],.? \t]+?[ \t](\w+)[ \t]*\(/gmu },
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

interface SymbolDeclaration extends Declaration {
  readonly value: boolean;
}

/** Each symbol a production source file declares, with its text: from its declaration to where it ends. */
function symbolDeclarationsIn(path: string, content: string): readonly SymbolDeclaration[] {
  if (isTestFile(path)) return [];
  const rule = symbolDeclarations.find((candidate) => candidate.file.test(path));
  if (rule === undefined) return [];
  return declarationsIn(path, content, rule.declarations);
}

/**
 * Declarations that `rules` match in a file, and Go's top-level constants, variables and grouped
 * types, each with its text: from its start to where it ends, never past the next declaration.
 */
function declarationsIn(path: string, content: string, rules: readonly DeclarationRule[]): readonly SymbolDeclaration[] {
  const syntax = syntaxOf(path);
  const code = syntax === undefined ? content : blankLiterals(content, syntax);
  const starts = [
    ...rules.flatMap(({ pattern, value }) =>
      [...content.matchAll(pattern)].map((match) => ({ name: match[1]!, start: match.index, value: value === true }))),
    ...(path.endsWith(".go") ? goValueDeclarations(code) : []),
  ].sort((left, right) => left.start - right.start);
  let following = 0;
  return starts.map(({ name, start, value }) => {
    // Names of one declaration share its start; the next declaration is the next start.
    while (following < starts.length && starts[following]!.start <= start) following += 1;
    const next = starts[following]?.start ?? content.length;
    const extent = syntax === "c" ? statementEnd(code, start, 0, next) : syntax === "python" ? indentedEnd(code, start, next) : undefined;
    const end = Math.min(next, extent ?? next);
    return { name, start, end, body: content.slice(start, end), value };
  });
}

/**
 * Go's top-level `const` and `var` declarations, and the members of `const (…)`, `var (…)` and
 * `type (…)` blocks, in blanked code. A member starts at its line, so its text is that line (or
 * its brackets); `_` declares nothing.
 */
function goValueDeclarations(code: string): readonly { readonly name: string; readonly start: number; readonly value: boolean }[] {
  const found: { name: string; start: number; value: boolean }[] = [];
  const names = (list: string) => list.split(",").map((name) => name.trim()).filter((name) => name !== "_");
  for (const match of code.matchAll(/^(?:const|var)[ \t]+([A-Za-z_]\w*(?:[ \t]*,[ \t]*[A-Za-z_]\w*)*)/gmu)) {
    for (const name of names(match[1]!)) found.push({ name, start: match.index, value: true });
  }
  for (const block of code.matchAll(/^(const|var|type)[ \t]*\(/gmu)) {
    const open = block.index + block[0].length;
    const close = statementEnd(code, open, 1) ?? code.length;
    let depth = 0;
    let lineStart = code.indexOf("\n", open) + 1;
    while (lineStart > 0 && lineStart < close) {
      const lineEnd = code.indexOf("\n", lineStart);
      const line = code.slice(lineStart, lineEnd < 0 || lineEnd > close ? close : lineEnd);
      const member = depth === 0 ? /^[ \t]+([A-Za-z_]\w*(?:[ \t]*,[ \t]*[A-Za-z_]\w*)*)/u.exec(line) : null;
      if (member !== null) {
        const list = block[1] === "type" ? member[1]!.split(",")[0]! : member[1]!;
        for (const name of names(list)) found.push({ name, start: lineStart, value: block[1] !== "type" });
      }
      depth += (line.match(/[([{]/gu)?.length ?? 0) - (line.match(/[)\]}]/gu)?.length ?? 0);
      if (lineEnd < 0) break;
      lineStart = lineEnd + 1;
    }
  }
  return found;
}

/**
 * Symbols the base declared in `files` that the change no longer declares there, less those that
 * only took a new name: a symbol the change adds with the same text under another name, of more
 * than one line unless it is a constant or variable with a value. Whether a removed symbol is gone from the whole repository is the caller's to check.
 */
export function removedSymbols(
  files: readonly { readonly path: string; readonly before: string; readonly after: string }[],
): ReadonlySet<string> {
  const before = files.flatMap(({ path, before: content }) => symbolDeclarationsIn(path, content));
  const after = files.flatMap(({ path, after: content }) => symbolDeclarationsIn(path, content));
  const beforeNames = new Set(before.map(({ name }) => name));
  const afterNames = new Set(after.map(({ name }) => name));
  // One line of a function says too little; one line of a constant holds its value.
  const addedTexts = new Set(after.filter(({ name }) => !beforeNames.has(name))
    .filter((symbol) => symbol.value ? symbolText(symbol).length > 0 : symbolText(symbol).includes("\n")).map(symbolText));
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

/** How test files declare helpers: functions, constants and variables a test may call or read. */
const helperDeclarations: readonly { readonly file: RegExp; readonly declarations: readonly DeclarationRule[] }[] = [
  { file: /_test\.go$/u, declarations: [{ pattern: /^func[ \t]+(?:\([^)]*\)[ \t]*)?(\w+)/gmu }, { pattern: /^type[ \t]+(\w+)/gmu }] },
  {
    file: /\.(?:test|spec)\.[cm]?[jt]sx?$/u,
    declarations: [
      { pattern: /^[ \t]*(?:export[ \t]+)?(?:async[ \t]+)?function\*?[ \t]+([A-Za-z_$][\w$]*)/gmu },
      { pattern: /^[ \t]*(?:export[ \t]+)?(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)/gmu },
    ],
  },
  {
    file: /(?:(?:^|\/)test_[^/]*|_test)\.py$/u,
    declarations: [{ pattern: /^[ \t]*(?:async[ \t]+)?def[ \t]+(\w+)/gmu }, { pattern: /^([A-Za-z_]\w*)[ \t]*(?::[^=\n]*)?=(?!=)/gmu }],
  },
  {
    file: /(?:Test|Tests|IT)\.java$/u,
    declarations: [{ pattern: /^[ \t]*(?:(?:public|protected|private|static|final|synchronized)[ \t]+)+[\w<>[\],.? \t]+?[ \t](\w+)[ \t]*[(=;]/gmu }],
  },
];

/**
 * Helpers of a test file that the change removed and whose text mentions removed code: declared at
 * the base outside every test and no deeper than the shallowest test, and gone from the file after
 * the change (neither declared nor mentioned). A local of a test is part of that test, never a
 * helper. A helper went with the code (`gone`) only when each of its statements uses that code;
 * one that also did something else (`broad`, with that statement) should have been edited, not
 * removed, so the tests that used it still count as removed.
 */
function goneHelpers(
  path: string,
  before: string,
  after: string,
  tests: readonly Declaration[],
  goneSymbols: ReadonlySet<string>,
): { readonly gone: ReadonlySet<string>; readonly broad: ReadonlyMap<string, string> } {
  const none = { gone: new Set<string>(), broad: new Map<string, string>() };
  const rule = helperDeclarations.find((candidate) => candidate.file.test(path));
  const syntax = syntaxOf(path);
  if (rule === undefined || syntax === undefined || tests.length === 0 || goneSymbols.size === 0) return none;
  const testNamesBefore = new Set(tests.map(({ name }) => name));
  const depth = Math.min(...tests.map(({ start }) => indentationAt(before, start)));
  const helpers = declarationsIn(path, before, rule.declarations).filter((helper) =>
    !testNamesBefore.has(helper.name)
    && !tests.some(({ start, end }) => helper.start >= start && helper.start < end)
    && indentationAt(before, helper.start) <= depth
    && !mentions(after, helper.name));
  const usesGone = (text: string) => [...goneSymbols].some((symbol) => mentions(text, symbol));
  const linked = helpers.filter((helper) => usesGone(withoutName(helper.body, helper.name)));
  const gone = new Set<string>();
  const broad = new Map<string, string>();
  for (const name of new Set(linked.map((helper) => helper.name))) {
    // A name declared more than once went with the code only if each of its declarations did.
    const declarations = helpers.filter((helper) => helper.name === name);
    const residue = declarations.map((helper) => {
      const parts = helperStatements(helper, syntax);
      return parts === undefined ? helper.body.trim().split("\n")[0]! : parts.find((part) => !usesGone(part));
    }).find((part) => part !== undefined);
    if (residue === undefined && declarations.every((helper) => usesGone(withoutName(helper.body, helper.name)))) gone.add(name);
    else broad.set(name, (residue ?? declarations[0]!.body.trim().split("\n")[0]!).trim().split("\n")[0]!.slice(0, 120));
  }
  return { gone, broad };
}

/**
 * The statements a helper runs, as text at the base: the top-level statements of a function's
 * body, or the whole declaration of a constant, a variable or a function that returns one
 * expression. Statements that do nothing on their own (`t.Helper()`, a bare `return`, `pass`, a
 * docstring) are left out. Undefined when the body's brackets cannot be read.
 */
function helperStatements(helper: Declaration, syntax: Syntax): readonly string[] | undefined {
  const code = blankLiterals(helper.body, syntax);
  const ranges: (readonly [number, number])[] = [];
  if (syntax === "python") {
    const header = /^[ \t]*(?:async[ \t]+)?def\b[^\n]*?:[ \t]*/u.exec(code);
    if (header === null) ranges.push([0, code.length]);
    else if (code.slice(header[0].length).split("\n")[0]!.trim() !== "") ranges.push([header[0].length, code.indexOf("\n") < 0 ? code.length : code.indexOf("\n")]);
    else {
      const lines = code.slice(0, code.length).split("\n");
      let offset = lines[0]!.length + 1;
      const bodyIndent = lines.slice(1).find((line) => line.trim() !== "")?.match(/^[ \t]*/u)?.[0].length ?? 0;
      for (const line of lines.slice(1)) {
        const indent = line.match(/^[ \t]*/u)![0].length;
        if (line.trim() !== "" && indent === bodyIndent) ranges.push([offset, offset + line.length]);
        else if (line.trim() !== "" && ranges.length > 0) ranges[ranges.length - 1] = [ranges.at(-1)![0], offset + line.length];
        offset += line.length + 1;
      }
    }
  } else {
    const trimmed = code.trimEnd().replace(/;$/u, "").trimEnd();
    const close = trimmed.length - 1;
    const open = trimmed.endsWith("}") ? matchingOpen(trimmed, close) : undefined;
    // A block after a parameter list, an arrow, a return type or `throws`; a `{` after `=`, `(`,
    // `,` or `:` opens a literal, which is one expression.
    const before = open === undefined ? "" : trimmed.slice(0, open).trimEnd().at(-1) ?? "";
    if (open === undefined || !/[)\]>*\w]/u.test(before)) ranges.push([0, trimmed.length]);
    else {
      let cursor = open + 1;
      while (cursor < close) {
        while (cursor < close && /\s/u.test(code[cursor]!)) cursor += 1;
        if (cursor >= close) break;
        const end = statementEnd(code, cursor, 0, close);
        if (end === undefined) return undefined;
        ranges.push([cursor, Math.max(end, cursor + 1)]);
        cursor = Math.max(end, cursor + 1);
      }
    }
  }
  return ranges
    .filter(([start, end]) => {
      const text = code.slice(start, end).trim().replace(/;$/u, "").trim();
      return /[A-Za-z_$]/u.test(text) && !/^(?:return|pass|\w+\.Helper\(\s*\))$/u.test(text);
    })
    .map(([start, end]) => helper.body.slice(start, end));
}

/** The `{` that the `}` at `close` closes, in blanked code. */
function matchingOpen(code: string, close: number): number | undefined {
  let depth = 0;
  for (let index = close; index >= 0; index -= 1) {
    const character = code[index]!;
    if (")]}".includes(character)) depth += 1;
    else if ("([{".includes(character) && (depth -= 1) === 0) return character === "{" ? index : undefined;
  }
  return undefined;
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
 * whole repository), or calls a helper of its file that went with that code (`goneHelpers`). Otherwise it is renamed when a new name takes its place: after the same
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
    return { ...file, content: file.after, tests: testDeclarationsIn(file.path, file.before), afterTests, after: afterTests.map(({ name }) => name) };
  });
  const net = new Map<string, number>();
  for (const { tests, after } of declared) {
    for (const { name } of tests) net.set(name, (net.get(name) ?? 0) + 1);
    for (const name of after) net.set(name, (net.get(name) ?? 0) - 1);
  }
  const findings = { deleted: new Set<string>(), removed: new Set<string>(), renamed: new Set<string>(), obsolete: new Set<string>() };
  // A name that left every changed file is gone; one no changed file had before is new.
  const changed = declared.map((file) => ({
    gone: slotted(file.tests.map(({ name }) => name), file.after).filter(({ name }) => (net.get(name) ?? 0) > 0),
    added: slotted(file.after, file.tests.map(({ name }) => name)).filter(({ name }) => (net.get(name) ?? 0) < 0),
  }));
  // The same text under a new name, in its own file or another changed one, is a rename or a move;
  // a test moved to another file may name that file's subject instead of its old file's. A one-line test says too little.
  declared.forEach((file, at) => {
    if (file.deleted === true) return;
    for (const entry of [...changed[at]!.gone]) {
      const text = unnamed(file.tests[entry.index]!);
      if (!text.includes("\n")) continue;
      const order = [at, ...declared.keys()].filter((other, index) => index === 0 || other !== at);
      for (const other of order) {
        const target = declared[other]!;
        const match = changed[other]!.added.find((candidate) =>
          sameTest(text, file.path, unnamed(target.afterTests[candidate.index]!), target.path));
        if (match === undefined) continue;
        findings.renamed.add(other === at
          ? `${file.path}: test ${entry.name} renamed to ${match.name}`
          : `${file.path}: test ${entry.name} moved to ${target.path} as ${match.name}`);
        changed[at]!.gone = changed[at]!.gone.filter((candidate) => candidate !== entry);
        changed[other]!.added = changed[other]!.added.filter((candidate) => candidate !== match);
        break;
      }
    }
  });
  for (const [at, { path, before: base, content, tests, afterTests, deleted }] of declared.entries()) {
    const { gone: helpers, broad } = goneHelpers(path, base, content, tests, goneSymbols);
    const syntax = syntaxOf(path);
    // How a test went with its code: "" when it names that code, the helper's name when it calls
    // a helper that went with it; undefined when it did not. Its own name is no use of anything.
    const obsoleteThrough = (test: Declaration): string | undefined => {
      const text = test.body.replace(test.name, "");
      if ([...goneSymbols].some((symbol) => mentions(text, symbol))) return "";
      const code = syntax === undefined ? text : blankLiterals(text, syntax);
      return [...helpers].find((helper) => mentions(code, helper));
    };
    const isObsolete = (test: Declaration) => obsoleteThrough(test) !== undefined;
    // A removed test that used a helper doing more than the removed code: say what to keep.
    const removedNote = (test: Declaration) => {
      const code = syntax === undefined ? test.body : blankLiterals(test.body.replace(test.name, ""), syntax);
      const helper = [...broad.keys()].find((name) => mentions(code, name));
      return helper === undefined ? "" : ` (helper ${helper} also did more than the removed code, in "${broad.get(helper)}": edit it and keep the tests that use it)`;
    };
    let { gone, added } = changed[at]!;
    if (deleted === true) {
      const obsolete = gone.length > 0 && gone.every(({ index }) => isObsolete(tests[index]!));
      const through = [...new Set(gone.map(({ index }) => obsoleteThrough(tests[index]!)).filter((helper) => helper))].sort();
      const via = through.length === 0 ? "" : ` (through helper ${through.join(", ")})`;
      const note = gone.map(({ index }) => removedNote(tests[index]!)).find((text) => text !== "") ?? "";
      (obsolete ? findings.obsolete : findings.deleted)
        .add(obsolete ? `${path}: test file deleted with the code it tested${via}` : `${path}: test file deleted${note}`);
      continue;
    }
    const rename = (from: { readonly name: string }, to: { readonly name: string }) => {
      findings.renamed.add(`${path}: test ${from.name} renamed to ${to.name}`);
      gone = gone.filter((entry) => entry !== from);
      added = added.filter((entry) => entry !== to);
    };
    // A test that went with its code leaves no place for a new name to take.
    for (const entry of gone.filter(({ index }) => isObsolete(tests[index]!))) {
      const helper = obsoleteThrough(tests[entry.index]!);
      findings.obsolete.add(`${path}: test ${entry.name} removed with the code it tested${helper ? ` (through helper ${helper})` : ""}`);
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
          findings.removed.add(`${path}: test ${entry.name} removed${removedNote(tests[entry.index]!)}`);
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

/**
 * Whether two test texts are the same test: equal up to whitespace, or once each file's subject (its
 * name before `_test`, `Test` or the first dot, such as `Shell` for `Shell.test.tsx`) reads as one word.
 */
function sameTest(from: string, fromPath: string, to: string, toPath: string): boolean {
  const words = (text: string) => text.replace(/\s+/gu, " ");
  const subjectless = (text: string, path: string) => {
    const subject = fileSubject(path);
    return subject.length < 3 ? text : text.replace(new RegExp(subject.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "giu"), "\0");
  };
  return words(from) === words(to) || subjectless(words(from), fromPath) === subjectless(words(to), toPath);
}

function fileSubject(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.replace(/^test_/u, "").replace(/(_test|Tests?|IT)?\..*$/u, "");
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

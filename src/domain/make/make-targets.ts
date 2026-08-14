export interface MakeTargetDeclaration {
  readonly target: string;
  readonly line: number;
  readonly declaration: string;
  readonly start: number;
  readonly end: number;
  readonly source: string;
  readonly replaceable: boolean;
}

interface SourceLine {
  readonly number: number;
  readonly start: number;
  readonly contentEnd: number;
  readonly end: number;
  readonly content: string;
}

export function inspectMakeTargets(
  source: string,
  targets: readonly string[],
): readonly MakeTargetDeclaration[] {
  const requested = [...new Set(targets)].sort(compareText);
  if (requested.length === 0 || source.length === 0) return Object.freeze([]);
  const lines = sourceLines(source);
  const customRecipePrefix = lines.some((line) =>
    /^(?:override[ \t]+)?\.RECIPEPREFIX[ \t]*[:?+]?=/u.test(line.content.trimStart()),
  );
  const declarations: MakeTargetDeclaration[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const target = requested.find((candidate) =>
      new RegExp(`^${escapeRegExp(candidate)}[ \\t]*:`, "u").test(line.content),
    );
    if (target === undefined) continue;
    let replaceable = !customRecipePrefix && new RegExp(
      `^${escapeRegExp(target)}[ \\t]*:(?!:)`,
      "u",
    ).test(line.content) && !continuesOnNextLine(line.content);
    let end = line.end;
    if (replaceable) {
      while (index + 1 < lines.length && lines[index + 1]!.content.startsWith("\t")) {
        index += 1;
        end = lines[index]!.end;
        if (
          continuesOnNextLine(lines[index]!.content) &&
          index + 1 < lines.length &&
          !lines[index + 1]!.content.startsWith("\t")
        ) {
          replaceable = false;
          break;
        }
      }
    }
    declarations.push(Object.freeze({
      target,
      line: line.number,
      declaration: line.content,
      start: line.start,
      end,
      source: source.slice(line.start, end),
      replaceable,
    }));
  }

  return Object.freeze(declarations.sort((left, right) => left.start - right.start));
}

function continuesOnNextLine(content: string): boolean {
  let backslashes = 0;
  for (let index = content.length - 1; index >= 0 && content[index] === "\\"; index -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function sourceLines(source: string): readonly SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  let number = 1;
  while (start < source.length) {
    const newline = source.indexOf("\n", start);
    const end = newline < 0 ? source.length : newline + 1;
    const rawContentEnd = newline < 0 ? source.length : newline;
    const contentEnd = rawContentEnd > start && source[rawContentEnd - 1] === "\r"
      ? rawContentEnd - 1
      : rawContentEnd;
    lines.push(Object.freeze({
      number,
      start,
      contentEnd,
      end,
      content: source.slice(start, contentEnd),
    }));
    start = end;
    number += 1;
  }
  return Object.freeze(lines);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

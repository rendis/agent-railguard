import { isLineChanged, type ChangedLines } from "../../../domain/verification/checks.js";

export interface CoverBlock {
  /** Unit-relative POSIX path of the source file. */
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly statements: number;
  readonly count: number;
}

/**
 * Parses a `go test -coverprofile` file. Blocks repeated by several test binaries are merged so a
 * block counts as covered when any run executed it.
 */
export function parseCoverProfile(profile: string, modulePath: string): readonly CoverBlock[] {
  const blocks = new Map<string, CoverBlock>();
  for (const line of profile.split("\n")) {
    const match = /^(.+):(\d+)\.\d+,(\d+)\.\d+ (\d+) (\d+)$/.exec(line.trim());
    if (match === null) continue;
    const [, importFile, start, end, statements, count] = match;
    const file = unitRelative(importFile!, modulePath);
    const key = `${file}:${start}:${end}:${statements}`;
    const previous = blocks.get(key);
    blocks.set(key, {
      file,
      startLine: Number(start),
      endLine: Number(end),
      statements: Number(statements),
      count: Math.max(previous?.count ?? 0, Number(count)),
    });
  }
  return [...blocks.values()];
}

export interface CoverageTally {
  readonly covered: number;
  readonly total: number;
}

/** Statement coverage of the blocks whose file satisfies `include`. */
export function statementCoverage(
  blocks: readonly CoverBlock[],
  include: (file: string) => boolean,
): CoverageTally {
  let covered = 0;
  let total = 0;
  for (const block of blocks) {
    if (!include(block.file) || block.statements === 0) continue;
    total += block.statements;
    if (block.count > 0) covered += block.statements;
  }
  return { covered, total };
}

/**
 * Coverage of changed lines that contain statements. A changed line is covered when any block that
 * spans it was executed. Returns the uncovered lines per file for diagnostics.
 */
export function changedLineCoverage(
  blocks: readonly CoverBlock[],
  changed: ReadonlyMap<string, ChangedLines>,
  include: (file: string) => boolean,
): CoverageTally & { readonly uncovered: ReadonlyMap<string, readonly number[]> } {
  const lines = new Map<string, Map<number, boolean>>();
  for (const block of blocks) {
    if (!include(block.file) || block.statements === 0) continue;
    const fileChanges = changed.get(block.file);
    if (fileChanges === undefined) continue;
    const fileLines = lines.get(block.file) ?? new Map<number, boolean>();
    lines.set(block.file, fileLines);
    for (let line = block.startLine; line <= block.endLine; line += 1) {
      if (!isLineChanged(fileChanges, line)) continue;
      fileLines.set(line, (fileLines.get(line) ?? false) || block.count > 0);
    }
  }
  let covered = 0;
  let total = 0;
  const uncovered = new Map<string, number[]>();
  for (const [file, fileLines] of [...lines].sort(([left], [right]) => left.localeCompare(right))) {
    for (const [line, hit] of [...fileLines].sort(([left], [right]) => left - right)) {
      total += 1;
      if (hit) {
        covered += 1;
      } else {
        const missing = uncovered.get(file) ?? [];
        missing.push(line);
        uncovered.set(file, missing);
      }
    }
  }
  return { covered, total, uncovered };
}

/** Renders `[3, 4, 5, 9]` as `3-5, 9`. */
export function lineRanges(lines: readonly number[]): string {
  const ranges: string[] = [];
  let start: number | undefined;
  let previous: number | undefined;
  for (const line of lines) {
    if (start !== undefined && previous !== undefined && line === previous + 1) {
      previous = line;
      continue;
    }
    if (start !== undefined) ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
    start = line;
    previous = line;
  }
  if (start !== undefined) ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
  return ranges.join(", ");
}

function unitRelative(importFile: string, modulePath: string): string {
  return importFile.startsWith(`${modulePath}/`) ? importFile.slice(modulePath.length + 1) : importFile;
}

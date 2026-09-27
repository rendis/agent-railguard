export type CheckStage = "check" | "verify";

/** Lines added or modified relative to the base, or `all` for a file that is entirely new. */
export type ChangedLines = ReadonlySet<number> | "all";

/**
 * What a change touched relative to its base commit. Paths are repository-relative POSIX paths of
 * files that exist in the working tree, or in the index when `staged`; deleted paths are listed
 * separately.
 */
export interface ChangeSet {
  /** Base commit, or null when the repository has no commit to compare against. */
  readonly base: string | null;
  /** Human-readable origin of the base, for example `origin/main`. */
  readonly baseRef: string | null;
  readonly files: ReadonlyMap<string, ChangedLines>;
  readonly deleted: readonly string[];
  /**
   * Only what is staged for the next commit: unstaged edits and untracked files are left out and
   * file content comes from the index.
   */
  readonly staged: boolean;
}

export interface ChangeSetReader {
  read(root: string, baseRef?: string, options?: { readonly staged?: boolean }): Promise<ChangeSet>;
  /** A changed file as the change holds it, or null when it is not a readable file. */
  content(root: string, path: string, staged: boolean): Promise<Buffer | null>;
}

export type CheckParams = Readonly<Record<string, string | number | boolean>>;

export interface CheckRequest {
  readonly repositoryRoot: string;
  /** Repository-relative root of the project unit being checked (`.` for the repository root). */
  readonly unitRoot: string;
  readonly params: CheckParams;
  readonly inputs: Readonly<Record<string, readonly string[]>>;
  readonly changes: ChangeSet;
  /**
   * The repository paths of an agent's latest edit, when the check judges only them instead of the
   * whole change; `changes` then holds only those paths.
   */
  readonly paths?: readonly string[];
  readonly signal?: AbortSignal;
}

/**
 * `failed` is a product finding about the code; `unavailable` means the check could not run
 * (missing tool or configuration) and is reported as a readiness problem, never as a pass.
 */
export type CheckStatus = "passed" | "failed" | "skipped" | "unavailable";

export interface CheckOutcome {
  readonly status: CheckStatus;
  readonly summary: string;
  readonly details: readonly string[];
}

export interface FullCheckRequest {
  readonly params: CheckParams;
  readonly inputs: Readonly<Record<string, readonly string[]>>;
}

/**
 * How a check judges a whole project unit: shell run from the unit root that exits 0 when it
 * passes, 1 when it finds a problem and 4 (through `unavailable`) when it cannot run; or the
 * reason the check does not judge a whole unit.
 */
export type FullCheck =
  | { readonly kind: "script"; readonly body: string }
  | { readonly kind: "skipped"; readonly reason: string };

/**
 * A check judges a change natively (`run`), where it can scope itself to changed lines, and a
 * whole unit through the shell of `full`, which the repository's verify script carries to CI.
 */
export interface CheckProvider {
  readonly kinds: readonly string[];
  run(kind: string, request: CheckRequest): Promise<CheckOutcome>;
  full(kind: string, request: FullCheckRequest): FullCheck;
}

export interface ProcessResult {
  /** Null when the process could not start or was killed. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface ProcessRunner {
  run(
    command: string,
    args: readonly string[],
    options: { readonly cwd: string; readonly timeoutMs?: number; readonly signal?: AbortSignal },
  ): Promise<ProcessResult>;
}

/** Paths of the change that live under a unit root, re-rooted relative to that unit. */
export function changedFilesInUnit(
  changes: ChangeSet,
  unitRoot: string,
): ReadonlyMap<string, ChangedLines> {
  const prefix = unitRoot === "." ? "" : `${unitRoot}/`;
  const files = new Map<string, ChangedLines>();
  for (const [path, lines] of changes.files) {
    if (path.startsWith(prefix)) files.set(path.slice(prefix.length), lines);
  }
  return files;
}

export function deletedFilesInUnit(changes: ChangeSet, unitRoot: string): readonly string[] {
  const prefix = unitRoot === "." ? "" : `${unitRoot}/`;
  return changes.deleted.filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length));
}

/** The change restricted to some repository paths, such as the files an agent just edited. */
export function changesAt(changes: ChangeSet, paths: readonly string[] | undefined): ChangeSet {
  if (paths === undefined) return changes;
  const wanted = new Set(paths);
  return Object.freeze({
    ...changes,
    files: new Map([...changes.files].filter(([path]) => wanted.has(path))),
    deleted: Object.freeze(changes.deleted.filter((path) => wanted.has(path))),
  });
}

export function isLineChanged(lines: ChangedLines | undefined, line: number): boolean {
  return lines !== undefined && (lines === "all" || lines.has(line));
}

/**
 * Parses `git diff --unified=0 --no-renames` output into the added or modified line numbers of each
 * new-side file. Deleted files are reported separately.
 */
export function parseUnifiedDiff(diff: string): {
  readonly files: ReadonlyMap<string, ReadonlySet<number>>;
  readonly deleted: readonly string[];
} {
  const files = new Map<string, Set<number>>();
  const deleted: string[] = [];
  let current: Set<number> | null = null;
  let oldPath: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = null;
      oldPath = null;
    } else if (line.startsWith("--- ")) {
      oldPath = diffPath(line.slice(4));
    } else if (line.startsWith("+++ ")) {
      const newPath = diffPath(line.slice(4));
      if (newPath === null) {
        if (oldPath !== null) deleted.push(oldPath);
        current = null;
      } else {
        current = files.get(newPath) ?? new Set<number>();
        files.set(newPath, current);
      }
    } else if (line.startsWith("@@ ") && current !== null) {
      const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (match === null) continue;
      const start = Number(match[1]);
      const count = match[2] === undefined ? 1 : Number(match[2]);
      for (let offset = 0; offset < count; offset += 1) current.add(start + offset);
    }
  }
  return { files, deleted };
}

/**
 * The text of every added line in `git diff --unified=0` output, by new-side file and line number.
 * Deleted files and binary changes contribute nothing.
 */
export function parseAddedLines(diff: string): ReadonlyMap<string, ReadonlyMap<number, string>> {
  const files = new Map<string, Map<number, string>>();
  let current: Map<number, string> | null = null;
  let next = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = null;
    } else if (line.startsWith("+++ ")) {
      const path = diffPath(line.slice(4));
      current = path === null ? null : files.get(path) ?? new Map<number, string>();
      if (path !== null && current !== null) files.set(path, current);
    } else if (line.startsWith("@@ ")) {
      next = Number(/^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line)?.[1] ?? 0);
    } else if (line.startsWith("+") && current !== null && next > 0) {
      current.set(next, line.slice(1));
      next += 1;
    }
  }
  return files;
}

function diffPath(value: string): string | null {
  const path = value.split("\t")[0] ?? value;
  if (path === "/dev/null") return null;
  return unquote(path).replace(/^[ab]\//, "");
}

function unquote(path: string): string {
  if (!path.startsWith('"')) return path;
  try {
    return JSON.parse(path) as string;
  } catch {
    return path.slice(1, -1);
  }
}

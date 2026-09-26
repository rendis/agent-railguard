export type CheckStage = "check" | "verify";

/** Lines added or modified relative to the base, or `all` for a file that is entirely new. */
export type ChangedLines = ReadonlySet<number> | "all";

/**
 * What a change touched relative to its base commit. Paths are repository-relative POSIX paths of
 * files that exist in the working tree; deleted paths are listed separately.
 */
export interface ChangeSet {
  /** Base commit, or null when the repository has no commit to compare against. */
  readonly base: string | null;
  /** Human-readable origin of the base, for example `origin/main`. */
  readonly baseRef: string | null;
  readonly files: ReadonlyMap<string, ChangedLines>;
  readonly deleted: readonly string[];
}

export interface ChangeSetReader {
  read(root: string, baseRef?: string): Promise<ChangeSet>;
}

export type CheckParams = Readonly<Record<string, string | number | boolean>>;

export interface CheckRequest {
  readonly repositoryRoot: string;
  /** Repository-relative root of the project unit being checked (`.` for the repository root). */
  readonly unitRoot: string;
  readonly params: CheckParams;
  readonly inputs: Readonly<Record<string, readonly string[]>>;
  /** Null in full mode: the whole unit is judged. */
  readonly changes: ChangeSet | null;
  /**
   * Where a coverage check also writes the profile it measured, for tools such as Sonar. A
   * relative path resolves against the project unit.
   */
  readonly coverageOut?: string;
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

export interface CheckProvider {
  readonly kinds: readonly string[];
  run(kind: string, request: CheckRequest): Promise<CheckOutcome>;
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

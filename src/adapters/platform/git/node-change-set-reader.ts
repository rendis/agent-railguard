import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  parseUnifiedDiff,
  type ChangedLines,
  type ChangeSet,
  type ChangeSetReader,
  type ProcessRunner,
} from "../../../domain/verification/checks.js";

const execute = promisify(execFile);
// Above the 16 MiB the change guard scans, so an oversized staged file is still reported as such.
const maximumBlobBytes = 64 * 1024 * 1024;
const defaultBranchCandidates = ["origin/main", "origin/master", "main", "master"];

/**
 * Computes what the working tree changed relative to a base commit. Without an explicit base it
 * uses the merge-base with the remote default branch (or a local main/master), so a branch is
 * judged by everything it adds. A repository with commits but no resolvable default branch, such
 * as a shallow CI checkout, is rejected instead of being compared with itself. With `staged` it reads
 * the index instead, so a commit is judged by exactly what it will hold.
 */
export class NodeChangeSetReader implements ChangeSetReader {
  public constructor(private readonly process: ProcessRunner) {}

  public async read(root: string, baseRef?: string, options: { readonly staged?: boolean } = {}): Promise<ChangeSet> {
    const staged = options.staged === true;
    const head = await this.#git(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    const base = head === null ? null : await this.#base(root, baseRef);
    const files = new Map<string, ChangedLines>();
    const deleted: string[] = [];
    const untracked = staged ? [] : ["--others", "--exclude-standard"];
    if (base === null) {
      for (const path of await this.#list(root, ["ls-files", "-z", "--cached", ...untracked])) {
        files.set(path, "all");
      }
      return Object.freeze({ base: null, baseRef: null, files, deleted: Object.freeze(deleted), staged });
    }
    const diff = await this.#git(root, [
      "-c", "core.quotePath=false",
      "diff", ...(staged ? ["--cached"] : []), "--no-ext-diff", "--no-color", "--no-renames", "--unified=0", base.commit, "--",
    ]);
    if (diff === null) throw new Error(`Cannot diff the ${staged ? "index" : "working tree"} against ${base.label}`);
    const parsed = parseUnifiedDiff(diff);
    for (const [path, lines] of parsed.files) files.set(path, lines);
    deleted.push(...parsed.deleted);
    if (untracked.length > 0) {
      for (const path of await this.#list(root, ["ls-files", "-z", ...untracked])) files.set(path, "all");
    }
    return Object.freeze({
      base: base.commit,
      baseRef: base.label,
      files,
      deleted: Object.freeze(deleted.sort()),
      staged,
    });
  }

  public async content(root: string, path: string, staged: boolean): Promise<Buffer | null> {
    if (!staged) return await readFile(join(root, path)).catch(() => null);
    const type = await this.#git(root, ["cat-file", "-t", `:${path}`]);
    if (type?.trim() !== "blob") return null;
    try {
      const { stdout } = await execute("git", ["cat-file", "blob", `:${path}`], {
        cwd: root,
        encoding: "buffer",
        maxBuffer: maximumBlobBytes,
        timeout: 60_000,
        windowsHide: true,
      });
      return stdout;
    } catch {
      return null;
    }
  }

  async #base(root: string, explicit: string | undefined): Promise<{ commit: string; label: string }> {
    if (explicit !== undefined) {
      const commit = await this.#mergeBase(root, explicit);
      if (commit === null) throw new Error(`Base ${explicit} is not a commit reachable from HEAD`);
      return { commit, label: explicit };
    }
    const remoteHead = await this.#git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
    const candidates = remoteHead === null
      ? defaultBranchCandidates
      : [remoteHead.trim(), ...defaultBranchCandidates];
    for (const candidate of candidates) {
      const commit = await this.#mergeBase(root, candidate);
      if (commit !== null) return { commit, label: candidate };
    }
    throw new Error(
      `No merge-base with the default branch (tried ${candidates.join(", ")}). ` +
        "Fetch the default branch with enough history (for example actions/checkout with fetch-depth: 0) or pass --base.",
    );
  }

  async #mergeBase(root: string, ref: string): Promise<string | null> {
    if ((await this.#git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])) === null) return null;
    const output = await this.#git(root, ["merge-base", "HEAD", ref]);
    return output === null ? null : output.trim();
  }

  async #list(root: string, args: readonly string[]): Promise<readonly string[]> {
    const output = await this.#git(root, args);
    return output === null ? [] : output.split("\0").filter((path) => path.length > 0);
  }

  async #git(root: string, args: readonly string[]): Promise<string | null> {
    const result = await this.process.run("git", args, { cwd: root, timeoutMs: 60_000 });
    return result.exitCode === 0 ? result.stdout : null;
  }
}

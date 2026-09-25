import {
  parseUnifiedDiff,
  type ChangedLines,
  type ChangeSet,
  type ChangeSetReader,
  type ProcessRunner,
} from "../../../domain/verification/checks.js";

const defaultBranchCandidates = ["origin/main", "origin/master", "main", "master"];

/**
 * Computes what the working tree changed relative to a base commit. Without an explicit base it
 * uses the merge-base with the remote default branch (or a local main/master), so a branch is
 * judged by everything it adds, and a repository without that branch by its uncommitted work.
 */
export class NodeChangeSetReader implements ChangeSetReader {
  public constructor(private readonly process: ProcessRunner) {}

  public async read(root: string, baseRef?: string): Promise<ChangeSet> {
    const head = await this.#git(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    const base = head === null ? null : await this.#base(root, baseRef);
    const files = new Map<string, ChangedLines>();
    const deleted: string[] = [];
    if (base === null) {
      for (const path of await this.#list(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])) {
        files.set(path, "all");
      }
      return Object.freeze({ base: null, baseRef: null, files, deleted: Object.freeze(deleted) });
    }
    const diff = await this.#git(root, [
      "-c", "core.quotePath=false",
      "diff", "--no-ext-diff", "--no-color", "--no-renames", "--unified=0", base.commit, "--",
    ]);
    if (diff === null) throw new Error(`Cannot diff the working tree against ${base.label}`);
    const parsed = parseUnifiedDiff(diff);
    for (const [path, lines] of parsed.files) files.set(path, lines);
    deleted.push(...parsed.deleted);
    for (const path of await this.#list(root, ["ls-files", "-z", "--others", "--exclude-standard"])) {
      files.set(path, "all");
    }
    return Object.freeze({
      base: base.commit,
      baseRef: base.label,
      files,
      deleted: Object.freeze(deleted.sort()),
    });
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
    const head = await this.#git(root, ["rev-parse", "HEAD"]);
    return { commit: (head ?? "").trim(), label: "HEAD" };
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

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessRunner, RevisionCheckout, RevisionCheckouts } from "../../../domain/verification/checks.js";

/**
 * Checks out a commit in a temporary Git worktree, detached, so a check can judge it as it was
 * without touching the working tree. A commit the clone lacks, such as a pull request's head before
 * a force push, is fetched from `origin` by its id first.
 */
export class NodeRevisionCheckouts implements RevisionCheckouts {
  public constructor(private readonly process: ProcessRunner) {}

  public async checkout(root: string, commit: string): Promise<RevisionCheckout | null> {
    if (!/^[0-9a-f]{40,64}$/u.test(commit)) return null;
    if (!(await this.#has(root, commit))) {
      await this.#git(root, ["fetch", "--quiet", "--no-tags", "origin", commit], 120_000);
      if (!(await this.#has(root, commit))) return null;
    }
    const parent = await mkdtemp(join(tmpdir(), "railguard-revision-"));
    const path = join(parent, "checkout");
    if ((await this.#git(root, ["worktree", "add", "--quiet", "--detach", path, commit], 120_000)) !== 0) {
      await rm(parent, { recursive: true, force: true });
      return null;
    }
    return {
      root: path,
      release: async () => {
        await this.#git(root, ["worktree", "remove", "--force", path], 60_000);
        await rm(parent, { recursive: true, force: true });
        await this.#git(root, ["worktree", "prune"], 60_000);
      },
    };
  }

  async #has(root: string, commit: string): Promise<boolean> {
    return (await this.#git(root, ["cat-file", "-e", `${commit}^{commit}`], 30_000)) === 0;
  }

  async #git(root: string, args: readonly string[], timeoutMs: number): Promise<number | null> {
    return (await this.process.run("git", args, { cwd: root, timeoutMs })).exitCode;
  }
}

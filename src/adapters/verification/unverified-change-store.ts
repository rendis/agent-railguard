import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProcessRunner } from "../../domain/verification/checks.js";
import type { UnverifiedChange, UnverifiedChanges } from "../../domain/verification/unverified-change.js";

/**
 * Remembers an unverified change until a later `--changed` run passes, so the next agent session
 * learns about it. It lives in the worktree's own Git directory: never versioned, one per worktree.
 */
export class UnverifiedChangeStore implements UnverifiedChanges {
  public constructor(private readonly process: ProcessRunner) {}

  public async read(root: string): Promise<UnverifiedChange | null> {
    const path = await this.#path(root);
    if (path === null) return null;
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as UnverifiedChange;
      return value.schema === "railguard/unverified/v1" ? value : null;
    } catch {
      return null;
    }
  }

  public async record(root: string, change: UnverifiedChange): Promise<void> {
    const path = await this.#path(root);
    if (path === null) return;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(change, null, 2)}\n`);
  }

  public async clear(root: string): Promise<void> {
    const path = await this.#path(root);
    if (path !== null) await rm(path, { force: true });
  }

  async #path(root: string): Promise<string | null> {
    const result = await this.process.run("git", ["rev-parse", "--absolute-git-dir"], { cwd: root, timeoutMs: 30_000 });
    return result.exitCode === 0 ? join(result.stdout.trim(), "railguard", "unverified.json") : null;
  }
}

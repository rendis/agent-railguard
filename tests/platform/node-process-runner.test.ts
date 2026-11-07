import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  gitRepositoryVariables,
  NodeProcessRunner,
  withoutGitRepository,
} from "../../src/adapters/platform/process/node-process-runner.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: withoutGitRepository(process.env) }).trim();

/** A repository with a module below its root, checked out again in a linked worktree. */
async function linkedWorktree() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "railguard-runner-")));
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  const main = join(base, "main");
  await mkdir(join(main, "apps/api"), { recursive: true });
  await writeFile(join(main, "apps/api/go.mod"), "module example.com/api\n");
  git(base, "init", "-q", main);
  git(main, "add", ".");
  git(main, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "initial");
  const worktree = join(base, "linked");
  git(main, "worktree", "add", "-q", worktree);
  // A hook in a linked worktree runs with an absolute GIT_DIR and no GIT_WORK_TREE.
  const hookEnvironment = { ...process.env, GIT_DIR: git(worktree, "rev-parse", "--absolute-git-dir"), GIT_INDEX_FILE: "index" };
  return { worktree, module: join(worktree, "apps/api"), hookEnvironment };
}

describe("NodeProcessRunner environment", () => {
  it("drops exactly the variables Git lists as local to a repository", () => {
    expect([...gitRepositoryVariables].sort()).toEqual(git(tmpdir(), "rev-parse", "--local-env-vars").split("\n").sort());
    expect(withoutGitRepository({ GIT_DIR: "/r/.git", GIT_INDEX_FILE: "i", GIT_AUTHOR_NAME: "a", PATH: "/bin" }))
      .toEqual({ GIT_AUTHOR_NAME: "a", PATH: "/bin" });
  });

  it("lets a tool below the root of a linked worktree find the worktree under a hook's environment", async () => {
    const { worktree, module, hookEnvironment } = await linkedWorktree();
    const toplevel = async (runner: NodeProcessRunner) =>
      (await runner.run("git", ["rev-parse", "--show-toplevel"], { cwd: module })).stdout.trim();

    expect(await toplevel(new NodeProcessRunner(() => hookEnvironment))).toBe(module);
    expect(await toplevel(new NodeProcessRunner(() => withoutGitRepository(hookEnvironment)))).toBe(worktree);
  });
});

import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { NodeGitConfig } from "../../src/adapters/platform/git/node-git-config.js";
import { hooksPathHolds } from "../../src/domain/planning/model.js";
import { createTempRepository } from "../helpers/temp-repository.js";

const execute = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function clone() {
  const temporary = await createTempRepository({ "a.txt": "a\n" });
  cleanups.push(temporary.cleanup);
  const root = await realpath(temporary.root);
  const git = (...args: string[]) => execute("git", ["-C", root, "-c", "user.email=a@b", "-c", "user.name=t", ...args]);
  await git("init", "--quiet", "-b", "main");
  await git("add", ".");
  await git("commit", "--quiet", "-m", "base");
  const linked = join(root, "..", `${root.split("/").at(-1)}-linked`);
  await git("worktree", "add", "--quiet", linked, "-b", "linked");
  cleanups.push(async () => {
    await git("worktree", "remove", "--force", linked).catch(() => undefined);
  });
  return { root, linked: await realpath(linked), git };
}

describe("NodeGitConfig", () => {
  it("names an absolute path into any worktree of the repository relative to that worktree", async () => {
    const { root, linked, git } = await clone();
    const config = new NodeGitConfig();

    await git("config", "--local", "core.hooksPath", join(root, ".railguard/hooks"));
    const fromMain = await config.get(root, "core.hooksPath");
    await git("config", "--local", "core.hooksPath", join(linked, ".railguard/hooks"));
    const fromLinked = await config.get(root, "core.hooksPath");

    expect(fromMain).toMatchObject({ kind: "value", worktreeRelative: ".railguard/hooks" });
    expect(fromLinked).toMatchObject({ kind: "value", worktreeRelative: ".railguard/hooks" });
    expect(hooksPathHolds(fromLinked, ".railguard/hooks")).toBe(true);
    expect(hooksPathHolds(fromLinked, ".husky")).toBe(false);
  });

  it("leaves relative and foreign absolute values as they are", async () => {
    const { root, git } = await clone();
    const config = new NodeGitConfig();

    await git("config", "--local", "core.hooksPath", ".railguard/hooks");
    const relative = await config.get(root, "core.hooksPath");
    await git("config", "--local", "core.hooksPath", "/opt/shared-hooks");
    const foreign = await config.get(root, "core.hooksPath");
    await git("config", "--local", "core.hooksPath", root);
    const worktreeRoot = await config.get(root, "core.hooksPath");

    expect(relative).toEqual({ kind: "value", value: ".railguard/hooks" });
    expect(foreign).toEqual({ kind: "value", value: "/opt/shared-hooks" });
    expect(hooksPathHolds(foreign, ".railguard/hooks")).toBe(false);
    expect(worktreeRoot).toEqual({ kind: "value", value: root });
  });

  it("tells a linked worktree from the main one", async () => {
    const { root, linked, git } = await clone();
    const config = new NodeGitConfig();
    await git("config", "--local", "core.hooksPath", ".railguard/hooks");

    expect(await config.get(root, "core.hooksPath")).not.toHaveProperty("linkedWorktree");
    expect(await config.get(linked, "core.hooksPath")).toMatchObject({ linkedWorktree: true });
  });

  it("reports an absent value", async () => {
    const { root } = await clone();

    expect(await new NodeGitConfig().get(root, "core.hooksPath")).toEqual({ kind: "absent" });
  });
});

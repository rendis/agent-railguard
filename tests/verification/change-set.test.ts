import { execFile } from "node:child_process";
import { realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { NodeChangeSetReader } from "../../src/adapters/platform/git/node-change-set-reader.js";
import { NodeProcessRunner } from "../../src/adapters/platform/process/node-process-runner.js";
import { changedFilesInUnit, parseUnifiedDiff } from "../../src/domain/verification/checks.js";
import { createTempRepository } from "../helpers/temp-repository.js";

const execute = promisify(execFile);
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("parseUnifiedDiff", () => {
  it("collects added lines per new-side file and reports deletions", () => {
    const parsed = parseUnifiedDiff([
      "diff --git a/src/a.go b/src/a.go",
      "--- a/src/a.go",
      "+++ b/src/a.go",
      "@@ -3,0 +4,2 @@ func A() {",
      "+  one",
      "+  two",
      "@@ -10 +12 @@",
      "-old",
      "+new",
      "@@ -20,3 +23,0 @@",
      "diff --git a/gone.go b/gone.go",
      "--- a/gone.go",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "",
    ].join("\n"));

    expect([...(parsed.files.get("src/a.go") ?? [])]).toEqual([4, 5, 12]);
    expect(parsed.deleted).toEqual(["gone.go"]);
  });
});

describe("NodeChangeSetReader", () => {
  it("judges a branch by everything it changed since the default branch, including untracked files", async () => {
    const root = await repository({ "a.go": "package a\n\nfunc A() {}\n", "keep.txt": "keep\n" });
    await git(root, "checkout", "-q", "-b", "feature");
    await writeFile(join(root, "a.go"), "package a\n\nfunc A() {}\n\nfunc B() {}\n");
    await git(root, "commit", "-qam", "committed on the branch");
    await writeFile(join(root, "keep.txt"), "keep\nmore\n");
    await writeFile(join(root, "new.go"), "package a\n");
    await rm(join(root, "keep.txt"));
    await writeFile(join(root, "keep.txt"), "keep\nmore\n");

    const changes = await new NodeChangeSetReader(new NodeProcessRunner()).read(root);

    expect(changes.baseRef).toBe("main");
    expect(changes.base).toMatch(/^[0-9a-f]{40}$/);
    expect([...(changes.files.get("a.go") as ReadonlySet<number>)]).toEqual([4, 5]);
    expect([...(changes.files.get("keep.txt") as ReadonlySet<number>)]).toEqual([2]);
    expect(changes.files.get("new.go")).toBe("all");
  });

  it("uses only uncommitted work when HEAD is the default branch", async () => {
    const root = await repository({ "a.go": "package a\n" });
    await writeFile(join(root, "a.go"), "package a\n\nvar x = 1\n");

    const changes = await new NodeChangeSetReader(new NodeProcessRunner()).read(root);

    expect([...changes.files.keys()]).toEqual(["a.go"]);
  });

  it("treats every file as changed when the repository has no commit", async () => {
    const created = await createTempRepository({ "svc/main.go": "package main\n" });
    cleanups.push(created.cleanup);
    await git(created.root, "init", "-q", "-b", "main");

    const changes = await new NodeChangeSetReader(new NodeProcessRunner()).read(created.root);

    expect(changes.base).toBeNull();
    expect(changedFilesInUnit(changes, "svc").get("main.go")).toBe("all");
  });

  it("rejects an explicit base that does not exist", async () => {
    const root = await repository({ "a.go": "package a\n" });

    await expect(new NodeChangeSetReader(new NodeProcessRunner()).read(root, "missing-branch"))
      .rejects.toThrow(/missing-branch/);
  });
});

async function repository(files: Readonly<Record<string, string>>): Promise<string> {
  const created = await createTempRepository(files);
  cleanups.push(created.cleanup);
  await git(created.root, "init", "-q", "-b", "main");
  await git(created.root, "add", "-A");
  await git(created.root, "commit", "-qm", "base");
  return await realpath(created.root);
}

async function git(root: string, ...args: string[]): Promise<void> {
  await execute("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args], { cwd: root });
}

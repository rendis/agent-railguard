import { execFile } from "node:child_process";
import { realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { NodeChangeSetReader } from "../../src/adapters/platform/git/node-change-set-reader.js";
import { NodeProcessRunner } from "../../src/adapters/platform/process/node-process-runner.js";
import { changedFilesInUnit, parseAddedLines, parseUnifiedDiff } from "../../src/domain/verification/checks.js";
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

  it("reads only what is staged, with its content from the index, when staged", async () => {
    const root = await repository({ "a.go": "package a\n", "b.go": "package a\n" });
    await git(root, "checkout", "-q", "-b", "feature");
    await writeFile(join(root, "a.go"), "package a\n\nvar staged = 1\n");
    await git(root, "add", "a.go");
    await writeFile(join(root, "a.go"), "package a\n\nvar staged = 1\n\nvar unstaged = 2\n");
    await writeFile(join(root, "b.go"), "package a\n\nvar unstaged = 3\n");
    await writeFile(join(root, "untracked.go"), "package a\n");
    const reader = new NodeChangeSetReader(new NodeProcessRunner());

    const changes = await reader.read(root, undefined, { staged: true });

    expect(changes.staged).toBe(true);
    expect([...changes.files.keys()]).toEqual(["a.go"]);
    expect([...(changes.files.get("a.go") as ReadonlySet<number>)]).toEqual([2, 3]);
    expect((await reader.content(root, "a.go", true))?.toString("utf8")).toBe("package a\n\nvar staged = 1\n");
    expect(await reader.content(root, "untracked.go", true)).toBeNull();
    expect((await reader.read(root)).files.has("untracked.go")).toBe(true);
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

  it("rejects a change without a resolvable default branch instead of comparing HEAD with itself", async () => {
    const origin = await repository({ "a.go": "package a\n" });
    await git(origin, "checkout", "-q", "-b", "feature");
    await writeFile(join(origin, "a.go"), "package a\n\nvar x = 1\n");
    await git(origin, "commit", "-qam", "feature");
    const created = await createTempRepository({});
    cleanups.push(created.cleanup);
    await git(created.root, "init", "-q", "-b", "detached");
    await git(created.root, "fetch", "-q", "--depth", "1", `file://${origin}`, "feature");
    await git(created.root, "checkout", "-q", "--detach", "FETCH_HEAD");

    await expect(new NodeChangeSetReader(new NodeProcessRunner()).read(created.root))
      .rejects.toThrow(/No merge-base with the default branch.*--base/);
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

describe("parseAddedLines", () => {
  it("keeps the text of added lines by new-side line number, across hunks and quoted paths", () => {
    const diff = [
      "diff --git a/app.go b/app.go",
      "--- a/app.go",
      "+++ b/app.go",
      "@@ -2 +2 @@",
      "-old",
      "+new",
      "@@ -9,0 +10,2 @@",
      "+ten",
      "+eleven",
      "diff --git a/gone.go b/gone.go",
      "--- a/gone.go",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      'diff --git "a/dir/with space.txt" "b/dir/with space.txt"',
      "--- /dev/null",
      '+++ "b/dir/with space.txt"',
      "@@ -0,0 +1 @@",
      "+hello",
      "\\ No newline at end of file",
    ].join("\n");

    expect(parseAddedLines(diff)).toEqual(new Map([
      ["app.go", new Map([[2, "new"], [10, "ten"], [11, "eleven"]])],
      ["dir/with space.txt", new Map([[1, "hello"]])],
    ]));
  });
});

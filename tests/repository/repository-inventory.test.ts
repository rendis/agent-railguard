import { execFile } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { NodeRepositoryInventory } from "../../src/adapters/platform/repository-inventory/node-repository-inventory.js";
import { relativePosixPath } from "../../src/domain/shared/types.js";
import { createTempRepository } from "../helpers/temp-repository.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("NodeRepositoryInventory", () => {
  it("captures one canonical immutable snapshot and excludes governed directories", async () => {
    const repository = await createTempRepository({
      "go.mod": "module example.com/service\n\ngo 1.24\n",
      "internal/app.go": "package internal\n",
      ".agents/keep.md": "managed\n",
      ".git": "gitdir: /private/tmp/mirror.git/worktrees/fixture\n",
      "node_modules/package/index.js": "must not be inventoried\n",
    });
    cleanups.push(repository.cleanup);

    const inventory = new NodeRepositoryInventory();
    const snapshot = await inventory.snapshot(repository.root);
    const paths = snapshot.entries.map((entry) => entry.path);

    expect(paths).toEqual([
      relativePosixPath(".agents"),
      relativePosixPath(".agents/keep.md"),
      relativePosixPath("go.mod"),
      relativePosixPath("internal"),
      relativePosixPath("internal/app.go"),
    ]);
    expect(paths.some((path) => path.startsWith(".git"))).toBe(false);
    expect(paths.some((path) => path.startsWith("node_modules"))).toBe(false);

    const before = await snapshot.read(relativePosixPath("go.mod"), 1024);
    await writeFile(join(repository.root, "go.mod"), "module changed.example/service\n");
    const after = await snapshot.read(relativePosixPath("go.mod"), 1024);

    expect(after.bytes.toString()).toBe(before.bytes.toString());
    expect(after.digest).toBe(before.digest);
    await expect(snapshot.read(relativePosixPath("go.mod"), 4)).rejects.toThrow(
      "exceeds read limit",
    );
  });

  it("records an escaping symlink without traversing it", async () => {
    const repository = await createTempRepository({ "go.mod": "module example.com/service\n" });
    const outside = await createTempRepository({ "secret.txt": "outside\n" });
    cleanups.push(repository.cleanup, outside.cleanup);
    await mkdir(join(repository.root, ".agents"), { recursive: true });
    await symlink(outside.root, join(repository.root, ".agents", "skills"));

    const snapshot = await new NodeRepositoryInventory().snapshot(repository.root);
    const link = snapshot.entries.find((entry) => entry.path === ".agents/skills");

    expect(link).toMatchObject({ kind: "symlink", escapesRoot: true });
    expect(snapshot.entries.some((entry) => entry.path.endsWith("secret.txt"))).toBe(false);
  });

  it("rejects a traversal that exceeds its resource budget", async () => {
    const repository = await createTempRepository({
      "a.txt": "a",
      "b.txt": "b",
    });
    cleanups.push(repository.cleanup);

    const inventory = new NodeRepositoryInventory({ maxEntries: 1 });

    await expect(inventory.snapshot(repository.root)).rejects.toThrow("entry limit");
  });

  it("skips git-ignored output directories but keeps ignored hidden configuration", async () => {
    const repository = await createTempRepository({
      ".gitignore": "tmp/\n.claude/\n",
      "go.mod": "module example.com/service\n",
      "tmp/cache/huge.bin": "x".repeat(64),
      ".claude/settings.local.json": "{}\n",
    });
    cleanups.push(repository.cleanup);
    await promisify(execFile)("git", ["init", "--quiet", repository.root]);

    const snapshot = await new NodeRepositoryInventory({ maxFileBytes: 32 }).snapshot(repository.root);
    const paths = snapshot.entries.map((entry) => entry.path);

    expect(paths.some((path) => path.startsWith("tmp"))).toBe(false);
    expect(paths).toContain(relativePosixPath(".claude/settings.local.json"));
  });
});

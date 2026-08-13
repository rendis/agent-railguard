import { execFile } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { NodeRepositoryGate } from "../../src/adapters/platform/repository-gate/node-repository-gate.js";
import { createTempRepository } from "../helpers/temp-repository.js";

const execute = promisify(execFile);

describe("NodeRepositoryGate", () => {
  it("explains how to initialize Git before the first mutable plan", async () => {
    const repository = await createTempRepository({});
    try {
      const result = await new NodeRepositoryGate().check(repository.root);

      expect(result.kind).toBe("blocked");
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "repository.gate.git-uninitialized",
          action: expect.stringContaining("git init"),
        }),
      );
    } finally {
      await repository.cleanup();
    }
  });

  it("accepts the writable top-level of a plain non-bare worktree", async () => {
    const repository = await gitRepository({ "README.md": "# Ready\n" });
    try {
      const result = await new NodeRepositoryGate().check(repository.root);

      expect(result.kind).toBe("ready");
      expect(result.rootRealPath).toBe(await realpath(repository.root));
      expect(result.diagnostics).toEqual([]);
    } finally {
      await repository.cleanup();
    }
  });

  it("blocks a nested invocation before a mutable plan is prepared", async () => {
    const repository = await gitRepository({ "service/main.go": "package main\n" });
    try {
      const result = await new NodeRepositoryGate().check(join(repository.root, "service"));

      expect(result.kind).toBe("blocked");
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ code: "repository.gate.not-top-level", severity: "blocked" }),
      );
    } finally {
      await repository.cleanup();
    }
  });

  it.each([
    {
      name: "tracked sensitive path",
      files: { ".env": "SECRET=redacted\n" },
      code: "repository.gate.sensitive-path",
    },
    {
      name: "tracked Git LFS policy",
      files: { ".gitattributes": "*.bin filter=lfs diff=lfs merge=lfs -text\n" },
      code: "repository.gate.lfs-unsupported",
    },
  ])("blocks an uncertified $name without reading its payload", async ({ files, code }) => {
    const repository = await gitRepository(files);
    try {
      await execute("git", ["-C", repository.root, "add", "."]);

      const result = await new NodeRepositoryGate().check(repository.root);

      expect(result.kind).toBe("blocked");
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(code);
      expect(JSON.stringify(result.diagnostics)).not.toContain("SECRET=redacted");
    } finally {
      await repository.cleanup();
    }
  });

  it("blocks an active Git lock instead of racing another Git operation", async () => {
    const repository = await gitRepository({});
    try {
      await writeFile(join(repository.root, ".git", "index.lock"), "");

      const result = await new NodeRepositoryGate().check(repository.root);

      expect(result.kind).toBe("blocked");
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        "repository.gate.git-lock-present",
      );
    } finally {
      await repository.cleanup();
    }
  });
});

async function gitRepository(files: Readonly<Record<string, string>>) {
  const repository = await createTempRepository(files);
  await execute("git", ["init", "--quiet", repository.root]);
  await mkdir(join(repository.root, ".git"), { recursive: true });
  return repository;
}

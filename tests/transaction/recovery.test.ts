import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, readFile, readlink, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { NodeRecoveryManager } from "../../src/adapters/platform/transaction/node-recovery-manager.js";
import {
  NodeTransactionStore,
  type TransactionJournal,
} from "../../src/adapters/platform/transaction/node-transaction-store.js";
import type { GitConfigPort, GitConfigValue } from "../../src/domain/planning/model.js";
import { relativePosixPath, sha256 } from "../../src/domain/shared/types.js";
import { createTempRepository } from "../helpers/temp-repository.js";

const execute = promisify(execFile);
const operationId = "11111111-1111-4111-8111-111111111111";
const planId = sha256("plan");

describe("NodeRecoveryManager", () => {
  it("rolls back applied files, local Git config, and created directories", async () => {
    const repository = await gitRepository();
    const store = new NodeTransactionStore();
    let gitValue: GitConfigValue = Object.freeze({ kind: "value", value: ".ai-harness/hooks" });
    const gitConfig = memoryGitConfig(() => gitValue, (value) => {
      gitValue = value;
    });
    try {
      const context = await store.discover(repository.root);
      const managedPath = relativePosixPath("managed.txt");
      const createdPath = relativePosixPath("generated/nested.txt");
      const createdDirectory = relativePosixPath("generated");
      const before = Buffer.from("before\n");
      const after = Buffer.from("after\n");
      await writeFile(join(repository.root, managedPath), before);
      await chmod(join(repository.root, managedPath), 0o640);
      const backup = await store.writeBackup(context, operationId, "project.managed", before);
      await writeFile(join(repository.root, managedPath), after);
      await chmod(join(repository.root, managedPath), 0o644);
      await mkdir(join(repository.root, createdDirectory), { mode: 0o755 });
      await writeFile(join(repository.root, createdPath), "created\n");

      await store.writeJournal(
        context,
        journal(context, [
          {
            kind: "filesystem",
            unit_id: "project.managed",
            state: "applied",
            target: { kind: "file", path: managedPath },
            container_path: managedPath,
            before: {
              kind: "backup",
              digest: backup.digest,
              backup_ref: backup.ref,
              mode: 0o640,
            },
            after: { kind: "present", digest: sha256(after), mode: 0o644 },
          },
          {
            kind: "directory",
            unit_id: "project.directory.generated",
            state: "applied",
            path: createdDirectory,
            before: { kind: "absent" },
            after: { kind: "directory", mode: 0o755 },
          },
          {
            kind: "filesystem",
            unit_id: "project.generated",
            state: "applied",
            target: { kind: "file", path: createdPath },
            container_path: createdPath,
            before: { kind: "absent" },
            after: { kind: "present", digest: sha256("created\n"), mode: 0o644 },
          },
          {
            kind: "git-config",
            unit_id: "project.git-gates.activation",
            state: "applied",
            key: "core.hooksPath",
            before_value: null,
            after_value: ".ai-harness/hooks",
          },
        ]),
      );

      const result = await new NodeRecoveryManager(store, gitConfig).recover(repository.root);

      expect(result.kind).toBe("rolled-back");
      expect(await readFile(join(repository.root, managedPath), "utf8")).toBe("before\n");
      expect((await stat(join(repository.root, managedPath))).mode & 0o777).toBe(0o640);
      await expect(stat(join(repository.root, createdPath))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(join(repository.root, createdDirectory))).rejects.toMatchObject({ code: "ENOENT" });
      expect(gitValue).toEqual({ kind: "absent" });
      expect(await store.readJournal(context)).toBeNull();
      expect(result.receiptPath).not.toBeNull();
    } finally {
      await repository.cleanup();
    }
  });

  it("preserves a file and blocks when it matches neither before nor after evidence", async () => {
    const repository = await gitRepository();
    const store = new NodeTransactionStore();
    const gitConfig = memoryGitConfig(
      () => Object.freeze({ kind: "absent" }),
      () => undefined,
    );
    try {
      const context = await store.discover(repository.root);
      const path = relativePosixPath("managed.txt");
      const before = Buffer.from("before\n");
      const backup = await store.writeBackup(context, operationId, "project.managed", before);
      await writeFile(join(repository.root, path), "third-party edit\n");
      await store.writeJournal(
        context,
        journal(context, [
          {
            kind: "filesystem",
            unit_id: "project.managed",
            state: "applied",
            target: { kind: "file", path },
            container_path: path,
            before: {
              kind: "backup",
              digest: backup.digest,
              backup_ref: backup.ref,
              mode: 0o644,
            },
            after: { kind: "present", digest: sha256("after\n"), mode: 0o644 },
          },
        ]),
      );

      const result = await new NodeRecoveryManager(store, gitConfig).recover(repository.root);

      expect(result.kind).toBe("recovery-required");
      expect(await readFile(join(repository.root, path), "utf8")).toBe("third-party edit\n");
      expect((await store.readJournal(context))?.phase).toBe("rollback-failed");
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        "recovery.state-diverged",
      );
    } finally {
      await repository.cleanup();
    }
  });

  it("restores removed files after recreating their journaled parent directories", async () => {
    const repository = await gitRepository();
    const store = new NodeTransactionStore();
    const gitConfig = memoryGitConfig(() => ({ kind: "absent" }), () => undefined);
    try {
      const context = await store.discover(repository.root);
      const directory = relativePosixPath("generated");
      const path = relativePosixPath("generated/managed.txt");
      const before = Buffer.from("before removal\n");
      const backup = await store.writeBackup(context, operationId, "project.removed", before);
      await store.writeJournal(
        context,
        journal(context, [
          {
            kind: "filesystem",
            unit_id: "project.removed",
            state: "applied",
            target: { kind: "file", path },
            container_path: path,
            before: {
              kind: "backup",
              digest: backup.digest,
              backup_ref: backup.ref,
              mode: 0o640,
            },
            after: { kind: "absent" },
          },
          {
            kind: "directory",
            unit_id: "project.directory.removed",
            state: "applied",
            path: directory,
            before: { kind: "directory", mode: 0o750 },
            after: { kind: "absent" },
          },
        ]),
      );

      const result = await new NodeRecoveryManager(store, gitConfig).recover(repository.root);

      expect(result.kind).toBe("rolled-back");
      expect(await readFile(join(repository.root, path), "utf8")).toBe("before removal\n");
      expect((await stat(join(repository.root, directory))).mode & 0o777).toBe(0o750);
      expect((await stat(join(repository.root, path))).mode & 0o777).toBe(0o640);
    } finally {
      await repository.cleanup();
    }
  });

  it("removes an applied symlink from a journaled transaction", async () => {
    const repository = await gitRepository();
    const store = new NodeTransactionStore();
    const gitConfig = memoryGitConfig(() => ({ kind: "absent" }), () => undefined);
    try {
      const context = await store.discover(repository.root);
      const linkDirectory = relativePosixPath(".claude/skills");
      const linkPath = relativePosixPath(".claude/skills/tdd");
      await mkdir(join(repository.root, linkDirectory), { recursive: true });
      await symlink("../../.agents/skills/tdd", join(repository.root, linkPath));
      await store.writeJournal(
        context,
        journal(context, [
          {
            kind: "symlink",
            unit_id: "project.skills.claude.tdd.symlink",
            state: "applied",
            path: linkPath,
            before_target: null,
            after_target: "../../.agents/skills/tdd",
          },
        ]),
      );

      expect(await readlink(join(repository.root, linkPath))).toBe("../../.agents/skills/tdd");
      const result = await new NodeRecoveryManager(store, gitConfig).recover(repository.root);

      expect(result.kind).toBe("rolled-back");
      await expect(lstat(join(repository.root, linkPath))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await repository.cleanup();
    }
  });

  it("is a no-op when no active journal exists", async () => {
    const repository = await gitRepository();
    try {
      const result = await new NodeRecoveryManager(
        new NodeTransactionStore(),
        memoryGitConfig(() => ({ kind: "absent" }), () => undefined),
      ).recover(repository.root);
      expect(result).toMatchObject({ kind: "no-recovery", diagnostics: [], receiptPath: null });
    } finally {
      await repository.cleanup();
    }
  });
});

function journal(
  context: Awaited<ReturnType<NodeTransactionStore["discover"]>>,
  units: TransactionJournal["units"],
): TransactionJournal {
  return Object.freeze({
    schema: "ai-harness/journal/v1",
    operation_id: operationId,
    plan_id: planId,
    phase: "applying",
    worktree_identity: context.worktreeIdentity,
    root_real_path: context.rootRealPath,
    started_at: "2026-08-10T22:00:00.000Z",
    updated_at: "2026-08-10T22:00:01.000Z",
    units: Object.freeze(units),
  });
}

function memoryGitConfig(
  getValue: () => GitConfigValue,
  setValue: (value: GitConfigValue) => void,
): GitConfigPort {
  return {
    async get() {
      return getValue();
    },
    async set(_root, _key, value) {
      setValue(value === null ? { kind: "absent" } : { kind: "value", value });
    },
  };
}

async function gitRepository() {
  const repository = await createTempRepository({ "README.md": "# fixture\n" });
  await execute("git", ["init", "--quiet", repository.root]);
  return repository;
}

import { execFile } from "node:child_process";
import { chmod, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  NodeTransactionStore,
  OperationBusyError,
  type TransactionJournal,
  type TransactionReceipt,
} from "../../src/adapters/platform/transaction/node-transaction-store.js";
import { sha256 } from "../../src/domain/shared/types.js";
import { createTempRepository } from "../helpers/temp-repository.js";

const execute = promisify(execFile);

describe("NodeTransactionStore", () => {
  it("discovers worktree-local and common private state paths", async () => {
    const repository = await gitRepository();
    try {
      const context = await new NodeTransactionStore().discover(repository.root);

      expect(context.rootRealPath).toBe(await realpath(repository.root));
      expect(context.commonStateDirectory).toContain("/.git/ai-harness");
      expect(context.worktreeStateDirectory).toContain("/.git/ai-harness");
      expect(context.operationLockPath).toBe(`${context.commonStateDirectory}/operation.lock`);
      expect(context.worktreeIdentity).toBe(sha256(`${context.rootRealPath}\0${context.gitDirectory}`));
      expect((await stat(context.commonStateDirectory)).mode & 0o777).toBe(0o700);
    } finally {
      await repository.cleanup();
    }
  });

  it("serializes mutable operations with an atomic common lock", async () => {
    const repository = await gitRepository();
    const store = new NodeTransactionStore();
    try {
      const first = await store.acquire(repository.root, "11111111-1111-4111-8111-111111111111");
      await expect(
        store.acquire(repository.root, "22222222-2222-4222-8222-222222222222"),
      ).rejects.toBeInstanceOf(OperationBusyError);

      await first.release();
      const second = await store.acquire(repository.root, "22222222-2222-4222-8222-222222222222");
      await second.release();
    } finally {
      await repository.cleanup();
    }
  });

  it("conservatively reclaims a lock whose recorded process no longer exists", async () => {
    const repository = await gitRepository();
    const store = new NodeTransactionStore();
    try {
      const abandoned = await store.acquire(
        repository.root,
        "11111111-1111-4111-8111-111111111111",
      );
      const record = JSON.parse(await readFile(abandoned.context.operationLockPath, "utf8"));
      await writeFile(
        abandoned.context.operationLockPath,
        `${JSON.stringify({ ...record, pid: 2_147_483_647 }, null, 2)}\n`,
        { mode: 0o600 },
      );

      const replacement = await store.acquire(
        repository.root,
        "22222222-2222-4222-8222-222222222222",
      );
      expect(
        (await readdir(replacement.context.commonStateDirectory)).some((name) =>
          name.startsWith("operation.lock.abandoned-11111111"),
        ),
      ).toBe(true);
      await replacement.release();
    } finally {
      await repository.cleanup();
    }
  });

  it("durably stores a closed journal, verified backups, and immutable receipts", async () => {
    const repository = await gitRepository();
    const store = new NodeTransactionStore();
    const operationId = "11111111-1111-4111-8111-111111111111";
    try {
      const lease = await store.acquire(repository.root, operationId);
      const started = "2026-08-10T22:00:00.000Z";
      const journal: TransactionJournal = Object.freeze({
        schema: "ai-harness/journal/v1",
        operation_id: operationId,
        plan_id: sha256("plan"),
        phase: "prepared",
        worktree_identity: lease.context.worktreeIdentity,
        root_real_path: lease.context.rootRealPath,
        started_at: started,
        updated_at: started,
        units: Object.freeze([]),
      });
      await store.writeJournal(lease.context, journal);

      expect(await store.readJournal(lease.context)).toEqual(journal);
      expect((await stat(store.activeJournalPath(lease.context))).mode & 0o777).toBe(0o600);

      const backup = await store.writeBackup(
        lease.context,
        operationId,
        "codex.skill.tdd",
        Buffer.from("private before image"),
      );
      expect((await store.readBackup(lease.context, backup.ref, backup.digest)).toString()).toBe(
        "private before image",
      );
      expect((await stat(backup.absolutePath)).mode & 0o777).toBe(0o600);

      await writeFile(backup.absolutePath, "tampered");
      await expect(store.readBackup(lease.context, backup.ref, backup.digest)).rejects.toThrow(
        /digest/i,
      );

      const receipt: TransactionReceipt = Object.freeze({
        schema: "ai-harness/receipt/v1",
        operation_id: operationId,
        plan_id: sha256("plan"),
        command: "apply",
        started_at: started,
        completed_at: "2026-08-10T22:00:01.000Z",
        result: "rolled-back",
        materialization: "rolled-back",
        certification: "not-run",
        preflight: Object.freeze([]),
        changes: Object.freeze([]),
        verification: Object.freeze([]),
        diagnostics: Object.freeze([]),
      });
      const receiptPath = await store.writeReceipt(lease.context, receipt);
      expect(JSON.parse(await readFile(receiptPath, "utf8"))).toEqual(receipt);
      expect((await stat(receiptPath)).mode & 0o777).toBe(0o600);

      await store.removeJournal(lease.context, operationId);
      expect(await store.readJournal(lease.context)).toBeNull();
      await lease.release();
    } finally {
      await repository.cleanup();
    }
  });

  it("refuses an unsafe non-Git or non-root directory", async () => {
    const repository = await createTempRepository({ "nested/file.txt": "x" });
    try {
      await expect(new NodeTransactionStore().discover(repository.root)).rejects.toThrow(/Git/i);
    } finally {
      await repository.cleanup();
    }
  });
});

async function gitRepository() {
  const repository = await createTempRepository({ "README.md": "# fixture\n" });
  await execute("git", ["init", "--quiet", repository.root]);
  await chmod(repository.root, 0o700);
  return repository;
}

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { Ajv2020 } from "ajv/dist/2020.js";
import projectStateSchema from "../../../../schemas/project-state.v1.schema.json" with {
  type: "json",
};
import {
  ReadonlyBytes,
  relativePosixPath,
  sha256,
  type RelativePosixPath,
  type Sha256Digest,
} from "../../../domain/shared/types.js";
import { parseSafeJson } from "../../../shared/safe-json.js";

const execute = promisify(execFile);
const maximumEnvelopeBytes = 8 * 1024 * 1024;
const maximumBackupBytes = 64 * 1024 * 1024;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const stableIdPattern = /^[a-z][a-z0-9]*(?:[.:_-][a-z0-9]+)*$/u;

export interface TransactionContext {
  readonly rootRealPath: string;
  readonly gitCommonDirectory: string;
  readonly gitDirectory: string;
  readonly commonStateDirectory: string;
  readonly worktreeStateDirectory: string;
  readonly operationLockPath: string;
  readonly worktreeIdentity: Sha256Digest;
}

export interface OperationLease {
  readonly operationId: string;
  readonly context: TransactionContext;
  release(): Promise<void>;
}

export interface TransactionJournal {
  readonly schema: "ai-harness/journal/v1";
  readonly operation_id: string;
  readonly plan_id: Sha256Digest;
  readonly phase: "prepared" | "applying" | "verifying" | "rolling-back" | "rollback-failed";
  readonly worktree_identity: Sha256Digest;
  readonly root_real_path: string;
  readonly started_at: string;
  readonly updated_at: string;
  readonly units: readonly TransactionJournalUnit[];
}

export type JournalFileState =
  | { readonly kind: "absent" }
  | { readonly kind: "present"; readonly digest: Sha256Digest; readonly mode: number };

export type JournalBackupState =
  | { readonly kind: "absent" }
  | {
      readonly kind: "backup";
      readonly digest: Sha256Digest;
      readonly backup_ref: RelativePosixPath;
      readonly mode: number;
    };

export type JournalDirectoryState =
  | { readonly kind: "absent" }
  | { readonly kind: "directory"; readonly mode: number };

export type TransactionJournalUnit =
  | {
      readonly kind: "filesystem";
      readonly unit_id: string;
      readonly state: "prepared" | "applied" | "restored";
      readonly target:
        | { readonly kind: "file"; readonly path: RelativePosixPath }
        | {
            readonly kind: "managed-section";
            readonly path: RelativePosixPath;
            readonly section_id: string;
          };
      readonly container_path: RelativePosixPath;
      readonly before: JournalBackupState;
      readonly after: JournalFileState;
    }
  | {
      readonly kind: "directory";
      readonly unit_id: string;
      readonly state: "prepared" | "applied" | "restored";
      readonly path: RelativePosixPath;
      readonly before: JournalDirectoryState;
      readonly after: JournalDirectoryState;
    }
  | {
      readonly kind: "symlink";
      readonly unit_id: string;
      readonly state: "prepared" | "applied" | "restored";
      readonly path: RelativePosixPath;
      readonly before_target: string | null;
      readonly after_target: string | null;
    }
  | {
      readonly kind: "git-config";
      readonly unit_id: string;
      readonly state: "prepared" | "applied" | "restored";
      readonly key: "core.hooksPath";
      readonly before_value: string | null;
      readonly after_value: string | null;
    };

export interface TransactionReceipt {
  readonly schema: "ai-harness/receipt/v1";
  readonly operation_id: string;
  readonly plan_id: Sha256Digest | null;
  readonly command: string;
  readonly started_at: string;
  readonly completed_at: string;
  readonly result:
    | "succeeded"
    | "no-changes"
    | "rejected"
    | "cancelled"
    | "rolled-back"
    | "verification-failed"
    | "recovery-required"
    | "failed";
  readonly materialization: "unchanged" | "committed" | "rolled-back" | "unknown";
  readonly certification: "verified" | "failed" | "unknown" | "not-run";
  readonly preflight: readonly unknown[];
  readonly changes: readonly unknown[];
  readonly verification: readonly unknown[];
  readonly diagnostics: readonly unknown[];
}

export interface BackupReference {
  readonly ref: RelativePosixPath;
  readonly digest: Sha256Digest;
  readonly absolutePath: string;
}

interface OperationLockRecord {
  readonly schema: "ai-harness/operation-lock/v1";
  readonly operation_id: string;
  readonly pid: number;
  readonly process_started_at: string;
  readonly worktree_identity: Sha256Digest;
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateProjectEnvelope = ajv.compile(projectStateSchema);

export class OperationBusyError extends Error {
  public constructor(public readonly operationLockPath: string) {
    super(`Another AI Harness operation owns ${operationLockPath}`);
    this.name = "OperationBusyError";
  }
}

export class OperationRecoveryRequiredError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "OperationRecoveryRequiredError";
  }
}

export class NonGitWorktreeError extends Error {
  public constructor(public readonly root: string) {
    super(`No Git worktree exists at ${root}`);
    this.name = "NonGitWorktreeError";
  }
}

export class NodeTransactionStore {
  public async discover(root: string): Promise<TransactionContext> {
    const rootRealPath = await realpath(root);
    let inside: string;
    try {
      inside = await gitValue(rootRealPath, ["rev-parse", "--is-inside-work-tree"]);
    } catch (error) {
      if (isNotGitRepository(error)) throw new NonGitWorktreeError(rootRealPath);
      throw new Error(`A non-bare Git worktree is required: ${errorMessage(error)}`);
    }
    if (inside !== "true") throw new NonGitWorktreeError(rootRealPath);
    const [bare, topLevel, commonDirectoryValue, gitDirectoryValue] = await Promise.all([
      gitValue(rootRealPath, ["rev-parse", "--is-bare-repository"]),
      gitValue(rootRealPath, ["rev-parse", "--path-format=absolute", "--show-toplevel"]),
      gitValue(rootRealPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      gitValue(rootRealPath, ["rev-parse", "--path-format=absolute", "--git-dir"]),
    ]).catch((error: unknown) => {
      throw new Error(`A non-bare Git worktree is required: ${errorMessage(error)}`);
    });
    if (bare !== "false") {
      throw new Error("A non-bare Git worktree is required for transactional mutation");
    }
    const topLevelRealPath = await realpath(topLevel);
    if (rootRealPath !== topLevelRealPath) {
      throw new Error(`AI Harness must run from the Git worktree root: ${topLevelRealPath}`);
    }
    const gitCommonDirectory = await realpath(commonDirectoryValue);
    const gitDirectory = await realpath(gitDirectoryValue);
    const commonStateDirectory = resolve(gitCommonDirectory, "ai-harness");
    const worktreeStateDirectory = resolve(gitDirectory, "ai-harness");
    await ensurePrivateDirectory(commonStateDirectory);
    await ensurePrivateDirectory(worktreeStateDirectory);
    await Promise.all(
      ["plans", "journal", "backup", "stage", "receipts", "cache"].map((name) =>
        ensurePrivateDirectory(resolve(worktreeStateDirectory, name)),
      ),
    );
    return Object.freeze({
      rootRealPath,
      gitCommonDirectory,
      gitDirectory,
      commonStateDirectory,
      worktreeStateDirectory,
      operationLockPath: resolve(commonStateDirectory, "operation.lock"),
      worktreeIdentity: sha256(`${rootRealPath}\0${gitDirectory}`),
    });
  }

  public async acquire(root: string, operationId = randomUUID()): Promise<OperationLease> {
    assertUuid(operationId);
    const context = await this.discover(root);
    const record: OperationLockRecord = Object.freeze({
      schema: "ai-harness/operation-lock/v1",
      operation_id: operationId,
      pid: process.pid,
      process_started_at: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      worktree_identity: context.worktreeIdentity,
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const acquired = await tryCreateOperationLock(context, record);
      if (acquired) break;
      const existing = await readOperationLock(context.operationLockPath);
      if (isProcessAlive(existing.pid)) throw new OperationBusyError(context.operationLockPath);
      const abandonedPath = resolve(
        context.commonStateDirectory,
        `operation.lock.abandoned-${existing.operation_id}-${randomUUID()}`,
      );
      try {
        await rename(context.operationLockPath, abandonedPath);
        await chmod(abandonedPath, 0o600);
        await syncDirectory(context.commonStateDirectory);
      } catch (error) {
        if (isNodeError(error, "ENOENT") || isNodeError(error, "EEXIST")) continue;
        throw error;
      }
      if (attempt === 2) {
        throw new OperationRecoveryRequiredError("Could not reclaim an abandoned operation lock");
      }
    }
    const installed = await readOperationLock(context.operationLockPath);
    if (installed.operation_id !== operationId) throw new OperationBusyError(context.operationLockPath);
    await syncDirectory(context.commonStateDirectory);

    let released = false;
    return Object.freeze({
      operationId,
      context,
      async release(): Promise<void> {
        if (released) return;
        const current = await readPrivateJson<OperationLockRecord>(
          context.operationLockPath,
          maximumEnvelopeBytes,
        );
        if (current.operation_id !== operationId) {
          throw new Error("Operation lock ownership changed before release");
        }
        await unlink(context.operationLockPath);
        await syncDirectory(context.commonStateDirectory);
        released = true;
      },
    });
  }

  public activeJournalPath(context: TransactionContext): string {
    return resolve(context.worktreeStateDirectory, "journal", "active.json");
  }

  public async readJournal(context: TransactionContext): Promise<TransactionJournal | null> {
    const path = this.activeJournalPath(context);
    let source: string;
    try {
      source = await readPrivateText(path, maximumEnvelopeBytes);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return null;
      throw error;
    }
    const parsed = parseSafeJson(source);
    if (
      parsed.kind === "invalid" ||
      !validateProjectEnvelope(parsed.value) ||
      !isJournal(parsed.value) ||
      source !== encodeJson(parsed.value)
    ) {
      throw new Error("Active transaction journal is invalid or non-canonical");
    }
    return deepFreeze(parsed.value);
  }

  public async writeJournal(
    context: TransactionContext,
    journal: TransactionJournal,
  ): Promise<void> {
    if (!validateProjectEnvelope(journal) || journal.schema !== "ai-harness/journal/v1") {
      throw new TypeError("Transaction journal does not satisfy ai-harness/journal/v1");
    }
    if (
      journal.worktree_identity !== context.worktreeIdentity ||
      journal.root_real_path !== context.rootRealPath
    ) {
      throw new TypeError("Transaction journal belongs to a different worktree");
    }
    await replacePrivateFile(this.activeJournalPath(context), encodeJson(journal));
  }

  public async removeJournal(context: TransactionContext, operationId: string): Promise<void> {
    const current = await this.readJournal(context);
    if (current === null) return;
    if (current.operation_id !== operationId) {
      throw new Error("Refusing to remove a journal owned by another operation");
    }
    await unlink(this.activeJournalPath(context));
    await syncDirectory(resolve(context.worktreeStateDirectory, "journal"));
  }

  public async writeBackup(
    context: TransactionContext,
    operationId: string,
    unitId: string,
    bytes: Uint8Array,
  ): Promise<BackupReference> {
    assertUuid(operationId);
    assertStableId(unitId);
    if (bytes.byteLength > maximumBackupBytes) throw new Error("Backup exceeds the byte limit");
    const directory = resolve(context.worktreeStateDirectory, "backup", operationId);
    await ensurePrivateDirectory(directory);
    const absolutePath = resolve(directory, `${unitId}.bin`);
    const handle = await open(
      absolutePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(directory);
    return Object.freeze({
      ref: relativePosixPath(`backup/${operationId}/${unitId}.bin`),
      digest: sha256(bytes),
      absolutePath,
    });
  }

  public async readBackup(
    context: TransactionContext,
    ref: RelativePosixPath,
    expectedDigest: Sha256Digest,
  ): Promise<ReadonlyBytes> {
    if (!ref.startsWith("backup/")) throw new Error("Backup reference is outside backup scope");
    const absolutePath = confinedPath(context.worktreeStateDirectory, ref);
    const bytes = await readPrivateBytes(absolutePath, maximumBackupBytes);
    const readonlyBytes = new ReadonlyBytes(bytes);
    if (readonlyBytes.digest() !== expectedDigest) throw new Error("Backup digest mismatch");
    return readonlyBytes;
  }

  public async writeStage(
    context: TransactionContext,
    operationId: string,
    unitId: string,
    bytes: Uint8Array,
  ): Promise<BackupReference> {
    return this.#writeOperationBytes(context, "stage", operationId, unitId, bytes);
  }

  public async readStage(
    context: TransactionContext,
    ref: RelativePosixPath,
    expectedDigest: Sha256Digest,
  ): Promise<ReadonlyBytes> {
    if (!ref.startsWith("stage/")) throw new Error("Stage reference is outside stage scope");
    const absolutePath = confinedPath(context.worktreeStateDirectory, ref);
    const bytes = await readPrivateBytes(absolutePath, maximumBackupBytes);
    const readonlyBytes = new ReadonlyBytes(bytes);
    if (readonlyBytes.digest() !== expectedDigest) throw new Error("Stage digest mismatch");
    return readonlyBytes;
  }

  public async writeReceipt(
    context: TransactionContext,
    receipt: TransactionReceipt,
  ): Promise<string> {
    if (!validateProjectEnvelope(receipt) || receipt.schema !== "ai-harness/receipt/v1") {
      throw new TypeError("Receipt does not satisfy ai-harness/receipt/v1");
    }
    const path = resolve(context.worktreeStateDirectory, "receipts", `${receipt.operation_id}.json`);
    await createImmutablePrivateFile(path, encodeJson(receipt));
    return path;
  }

  public async removeBackups(
    context: TransactionContext,
    operationId: string,
  ): Promise<void> {
    assertUuid(operationId);
    const directory = resolve(context.worktreeStateDirectory, "backup", operationId);
    await rm(directory, { recursive: true, force: true });
    await syncDirectory(resolve(context.worktreeStateDirectory, "backup"));
  }


  public async removeOperationData(
    context: TransactionContext,
    operationId: string,
  ): Promise<void> {
    assertUuid(operationId);
    await Promise.all(
      ["backup", "stage"].map((scope) =>
        rm(resolve(context.worktreeStateDirectory, scope, operationId), {
          recursive: true,
          force: true,
        }),
      ),
    );
    await Promise.all(
      ["backup", "stage"].map((scope) =>
        syncDirectory(resolve(context.worktreeStateDirectory, scope)),
      ),
    );
  }

  async #writeOperationBytes(
    context: TransactionContext,
    scope: "backup" | "stage",
    operationId: string,
    unitId: string,
    bytes: Uint8Array,
  ): Promise<BackupReference> {
    assertUuid(operationId);
    assertStableId(unitId);
    if (bytes.byteLength > maximumBackupBytes) {
      throw new Error(`${scope} bytes exceed the byte limit`);
    }
    const directory = resolve(context.worktreeStateDirectory, scope, operationId);
    await ensurePrivateDirectory(directory);
    const absolutePath = resolve(directory, `${unitId}.bin`);
    const handle = await open(
      absolutePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(directory);
    return Object.freeze({
      ref: relativePosixPath(`${scope}/${operationId}/${unitId}.bin`),
      digest: sha256(bytes),
      absolutePath,
    });
  }
}

async function tryCreateOperationLock(
  context: TransactionContext,
  record: OperationLockRecord,
): Promise<boolean> {
  let handle;
  let created = false;
  try {
    handle = await open(
      context.operationLockPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    created = true;
    await handle.writeFile(encodeJson(record));
    await handle.chmod(0o600);
    await handle.sync();
    return true;
  } catch (error) {
    if (isNodeError(error, "EEXIST")) return false;
    if (created) await unlink(context.operationLockPath).catch(() => undefined);
    throw error;
  } finally {
    await handle?.close();
  }
}

async function readOperationLock(path: string): Promise<OperationLockRecord> {
  let record: OperationLockRecord;
  try {
    record = await readPrivateJson<OperationLockRecord>(path, maximumEnvelopeBytes);
  } catch (error) {
    throw new OperationRecoveryRequiredError(
      `The existing operation lock is unreadable: ${errorMessage(error)}`,
    );
  }
  if (
    record.schema !== "ai-harness/operation-lock/v1" ||
    !uuidPattern.test(record.operation_id) ||
    !Number.isSafeInteger(record.pid) ||
    record.pid < 1 ||
    typeof record.process_started_at !== "string" ||
    typeof record.worktree_identity !== "string"
  ) {
    throw new OperationRecoveryRequiredError("The existing operation lock is invalid");
  }
  return record;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error, "ESRCH");
  }
}

async function gitValue(root: string, args: readonly string[]): Promise<string> {
  const result = await execute("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    env: { ...process.env, LANG: "C", LC_ALL: "C" },
  });
  const value = result.stdout.trim();
  if (value.length === 0 || value.includes("\0")) throw new Error("Git returned an empty path");
  return value;
}

function isNotGitRepository(error: unknown): boolean {
  if (!(error instanceof Error) || !("stderr" in error)) return false;
  return /not a git repository/u.test(String(error.stderr));
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`Transaction state path is not a regular directory: ${path}`);
  }
  await chmod(path, 0o700);
}

async function replacePrivateFile(path: string, source: string): Promise<void> {
  const directory = resolve(path, "..");
  const temporaryPath = resolve(directory, `.tmp-${randomUUID()}`);
  const handle = await open(
    temporaryPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    await handle.writeFile(source);
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
    await syncDirectory(directory);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function createImmutablePrivateFile(path: string, source: string): Promise<void> {
  const directory = resolve(path, "..");
  const temporaryPath = resolve(directory, `.tmp-${randomUUID()}`);
  const handle = await open(
    temporaryPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    await handle.writeFile(source);
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporaryPath, path);
    await unlink(temporaryPath);
    await syncDirectory(directory);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function readPrivateJson<T>(path: string, limit: number): Promise<T> {
  const source = await readPrivateText(path, limit);
  const parsed = parseSafeJson(source);
  if (parsed.kind === "invalid") throw new Error(`Private JSON is invalid: ${path}`);
  return parsed.value as T;
}

async function readPrivateText(path: string, limit: number): Promise<string> {
  return Buffer.from(await readPrivateBytes(path, limit)).toString("utf8");
}

async function readPrivateBytes(path: string, limit: number): Promise<Uint8Array> {
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const entry = await handle.stat();
    if (!entry.isFile() || entry.nlink !== 1 || entry.size > limit) {
      throw new Error(`Private state file is unsafe or exceeds its byte limit: ${path}`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function confinedPath(root: string, path: RelativePosixPath): string {
  const candidate = resolve(root, ...path.split("/"));
  const difference = relative(root, candidate);
  if (
    difference === "" ||
    difference === ".." ||
    difference.startsWith(`..${sep}`) ||
    isAbsolute(difference)
  ) {
    throw new Error("Private state reference escapes its worktree state root");
  }
  return candidate;
}

function encodeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isJournal(value: unknown): value is TransactionJournal {
  return (
    typeof value === "object" &&
    value !== null &&
    "schema" in value &&
    value.schema === "ai-harness/journal/v1"
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function assertUuid(value: string): void {
  if (!uuidPattern.test(value)) throw new TypeError(`Invalid operation UUID: ${value}`);
}

function assertStableId(value: string): void {
  if (!stableIdPattern.test(value)) throw new TypeError(`Invalid managed unit ID: ${value}`);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

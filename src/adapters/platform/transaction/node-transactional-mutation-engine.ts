import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open,
  readlink,
  realpath,
  rename,
  rmdir,
  statfs,
  symlink,
  unlink,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { GitConfigPort, GitConfigValue } from "../../../domain/planning/model.js";
import {
  compareDiagnostics,
  compareUtf8,
  sha256,
  type Diagnostic,
  type RelativePosixPath,
} from "../../../domain/shared/types.js";
import type {
  DurableApplyResult,
  DurableApplyOptions,
  DurableMutationEngine,
  DurableMutationEvent,
  DurableMutationEventSink,
  DurableProjectPlan,
  TransactionFileState,
  TransactionOperation,
} from "../../../domain/transaction/model.js";
import { NodeRepositoryInventory } from "../repository-inventory/node-repository-inventory.js";
import { NodeRecoveryManager } from "./node-recovery-manager.js";
import {
  NodeTransactionStore,
  type BackupReference,
  type OperationLease,
  type TransactionContext,
  type TransactionJournal,
  type TransactionJournalUnit,
  type TransactionReceipt,
} from "./node-transaction-store.js";

type ReadyPlan = Extract<DurableProjectPlan, { readonly kind: "ready" }>;

export class NodeTransactionalMutationEngine implements DurableMutationEngine {
  readonly #recovery: NodeRecoveryManager;

  public constructor(
    private readonly store: NodeTransactionStore,
    private readonly gitConfig: GitConfigPort,
    private readonly events: DurableMutationEventSink = () => undefined,
  ) {
    this.#recovery = new NodeRecoveryManager(store, gitConfig);
  }

  public async apply(
    plan: ReadyPlan,
    options: DurableApplyOptions = {},
  ): Promise<DurableApplyResult> {
    this.#emit("recovery", "started", "Checking interrupted operations before apply");
    const recovery = await this.#recovery.recover(plan.rootRealPath);
    if (recovery.kind !== "no-recovery") {
      this.#emit("recovery", "failed", `Recovery gate returned ${recovery.kind}`);
      const diagnostics = recovery.kind === "rolled-back"
        ? [
            applyDiagnostic(
              "apply.recovery-completed",
              null,
              "blocked",
              [recovery.operationId],
              "An interrupted operation was rolled back before apply.",
              "The approved plan may no longer describe current repository evidence.",
              "Scan and review a new plan.",
            ),
          ]
        : recovery.diagnostics;
      return result(
        recovery.kind === "rolled-back" ? "rejected" : "recovery-required",
        plan,
        recovery.operationId,
        diagnostics,
        [],
        recovery.receiptPath,
      );
    }
    this.#emit("recovery", "completed", "No interrupted operation blocks apply");

    let lease: OperationLease | null = null;
    let released = false;
    let journalWritten = false;
    try {
      this.#emit("lock", "started", "Acquiring the project operation lock");
      lease = await this.store.acquire(plan.rootRealPath);
      this.#emit("lock", "completed", "Project operation lock acquired");
      throwIfCancelled(options.signal);
      this.#emit("preflight", "started", "Revalidating every reviewed precondition");
      const diagnostics = await preflight(plan, this.gitConfig);
      if (diagnostics.length > 0) {
        this.#emit("preflight", "failed", "Reviewed preconditions no longer hold");
        const receiptPath = await this.store.writeReceipt(
          lease.context,
          receipt(lease.operationId, plan, "rejected", diagnostics, []),
        );
        return result("rejected", plan, lease.operationId, diagnostics, [], receiptPath);
      }
      this.#emit("preflight", "completed", "All reviewed preconditions still hold");
      throwIfCancelled(options.signal);
      if (plan.operations.length === 0) {
        const receiptPath = await this.store.writeReceipt(
          lease.context,
          receipt(lease.operationId, plan, "no-changes", [], []),
        );
        return result("no-changes", plan, lease.operationId, [], [], receiptPath);
      }

      this.#emit("staging", "started", "Staging every planned write");
      const stages = await stageWrites(this.store, lease.context, lease.operationId, plan.operations);
      this.#emit("staging", "completed", "Planned writes staged and verified");
      throwIfCancelled(options.signal);
      this.#emit("backup", "started", "Capturing before-images and durable journal evidence");
      const journal = await prepareJournal(
        this.store,
        lease.context,
        lease.operationId,
        plan,
      );
      await this.store.writeJournal(lease.context, journal);
      journalWritten = true;
      this.#emit("backup", "completed", "Before-images and durable journal are ready");
      let active = updateJournal(journal, "applying", journal.units);
      await this.store.writeJournal(lease.context, active);
      const changedPaths: RelativePosixPath[] = [];

      for (let index = 0; index < plan.operations.length; index += 1) {
        throwIfCancelled(options.signal);
        const operation = plan.operations[index];
        if (operation === undefined) continue;
        this.#emit(
          "apply",
          "started",
          `Applying ${operation.unitId}`,
          operation.unitId,
          index + 1,
          plan.operations.length,
        );
        await applyOperation(
          plan.rootRealPath,
          operation,
          stages,
          this.store,
          lease.context,
          this.gitConfig,
        );
        await verifyOperation(plan.rootRealPath, operation, this.gitConfig);
        changedPaths.push(operation.path);
        const units = active.units.map((unit, unitIndex) =>
          unitIndex === index ? Object.freeze({ ...unit, state: "applied" as const }) : unit,
        );
        active = updateJournal(active, "applying", units);
        await this.store.writeJournal(lease.context, active);
        this.#emit(
          "apply",
          "completed",
          `Applied ${operation.unitId}`,
          operation.unitId,
          index + 1,
          plan.operations.length,
        );
      }

      throwIfCancelled(options.signal);
      this.#emit("verify", "started", "Verifying the complete materialization");
      active = updateJournal(active, "verifying", active.units);
      await this.store.writeJournal(lease.context, active);
      for (const operation of plan.operations) {
        await verifyOperation(plan.rootRealPath, operation, this.gitConfig);
      }
      this.#emit("verify", "completed", "Complete materialization verified");
      const receiptPath = await this.store.writeReceipt(
        lease.context,
        receipt(lease.operationId, plan, "succeeded", [], active.units),
      );
      this.#emit("cleanup", "started", "Removing transient transaction data");
      await this.store.removeJournal(lease.context, lease.operationId);
      await this.store.removeOperationData(lease.context, lease.operationId);
      journalWritten = false;
      this.#emit("cleanup", "completed", "Transient transaction data removed");
      return result(
        "applied",
        plan,
        lease.operationId,
        [],
        [...new Set(changedPaths)].sort(compareUtf8),
        receiptPath,
      );
    } catch (error) {
      const failedOperationId = lease?.operationId ?? randomUUID();
      if (journalWritten) {
        this.#emit("rollback", "started", "Rolling back the journaled operation");
        if (lease !== null) {
          await lease.release().catch(() => undefined);
          released = true;
        }
        const recovered = await this.#recovery.recover(plan.rootRealPath);
        const diagnostics = [
          applyDiagnostic(
            "apply.transaction.failed",
            null,
            "failed",
            [errorMessage(error)],
            "A journaled mutation failed and automatic rollback was invoked.",
            "The requested state was not committed as successful.",
            "Inspect the recovery receipt before generating a new plan.",
          ),
          ...recovered.diagnostics,
        ].sort(compareDiagnostics);
        this.#emit(
          "rollback",
          recovered.kind === "rolled-back" ? "completed" : "failed",
          recovered.kind === "rolled-back"
            ? "Journaled operation rolled back and verified"
            : "Rollback requires manual recovery",
        );
        return result(
          recovered.kind === "rolled-back" ? "rolled-back" : "recovery-required",
          plan,
          recovered.operationId,
          diagnostics,
          [],
          recovered.receiptPath,
        );
      }
      let receiptPath: string | null = null;
      if (lease !== null) {
        await this.store.removeOperationData(lease.context, lease.operationId).catch(() => undefined);
        if (error instanceof OperationCancelledError) {
          const diagnostic = cancellationDiagnostic();
          receiptPath = await this.store
            .writeReceipt(
              lease.context,
              receipt(lease.operationId, plan, "cancelled", [diagnostic], []),
            )
            .catch(() => null);
          this.#emit("cleanup", "completed", "Cancelled before the first repository mutation");
          return result("cancelled", plan, lease.operationId, [diagnostic], [], receiptPath);
        }
        const diagnostic = applyDiagnostic(
          "apply.preparation.failed",
          null,
          "failed",
          [errorMessage(error)],
          "Transaction preparation failed before a journaled mutation began.",
          "No planned repository destination was changed.",
          "Resolve the reported local failure and generate a new plan.",
        );
        receiptPath = await this.store
          .writeReceipt(
            lease.context,
            receipt(lease.operationId, plan, "failed", [diagnostic], []),
          )
          .catch(() => null);
        return result("failed", plan, lease.operationId, [diagnostic], [], receiptPath);
      }
      const diagnostic = applyDiagnostic(
        "apply.lock.failed",
        null,
        "failed",
        [errorMessage(error)],
        "The mutation lock could not be acquired.",
        "No planned repository destination was changed.",
        "Wait for the active operation or resolve its recovery evidence.",
      );
      return result("failed", plan, failedOperationId, [diagnostic], [], null);
    } finally {
      if (lease !== null && !released) await lease.release();
    }
  }

  #emit(
    phase: DurableMutationEvent["phase"],
    status: DurableMutationEvent["status"],
    message: string,
    unitId?: string,
    current?: number,
    total?: number,
  ): void {
    this.events(
      Object.freeze({
        phase,
        status,
        message,
        ...(unitId === undefined ? {} : { unitId }),
        ...(current === undefined ? {} : { current }),
        ...(total === undefined ? {} : { total }),
      }),
    );
  }
}

async function preflight(plan: ReadyPlan, gitConfig: GitConfigPort): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  let liveFileSizes = new Map<RelativePosixPath, number>();
  try {
    if ((await realpath(plan.rootRealPath)) !== plan.rootRealPath) {
      throw new Error("repository realpath changed");
    }
    const snapshot = await new NodeRepositoryInventory().snapshot(plan.rootRealPath);
    if (snapshot.fingerprint !== plan.snapshotFingerprint) {
      throw new Error("repository fingerprint changed after review");
    }
    liveFileSizes = new Map(
      snapshot.entries
        .filter((entry) => entry.kind === "file")
        .map((entry) => [entry.path, entry.size]),
    );
  } catch (error) {
    diagnostics.push(
      applyDiagnostic(
        "apply.repository.changed",
        null,
        "blocked",
        [errorMessage(error)],
        "Repository evidence changed after the plan was reviewed.",
        "No planned operation was executed.",
        "Scan and review a new plan.",
      ),
    );
    return diagnostics;
  }

  const unitIds = new Set<string>();
  const paths = new Set<string>();
  for (const operation of plan.operations) {
    if (unitIds.has(operation.unitId)) {
      diagnostics.push(invalidPlanDiagnostic(operation.path, "duplicate-unit-id"));
    }
    unitIds.add(operation.unitId);
    if (paths.has(operation.path)) {
      diagnostics.push(invalidPlanDiagnostic(operation.path, "duplicate-operation-path"));
    }
    paths.add(operation.path);
    try {
      const destination = destinationPath(plan.rootRealPath, operation.path);
      if (operation.kind === "create-directory") {
        try {
          await lstat(destination);
          throw new Error("expected an absent directory path");
        } catch (error) {
          if (!isNodeError(error, "ENOENT")) throw error;
        }
      } else if (operation.kind === "remove-directory") {
        const entry = await lstat(destination);
        if (
          !entry.isDirectory() ||
          entry.isSymbolicLink() ||
          (entry.mode & 0o777) !== operation.mode
        ) {
          throw new Error("directory precondition changed after review");
        }
        await validateAncestors(plan.rootRealPath, operation.path, plan.operations);
      } else if (operation.kind === "configure-git") {
        const current = await gitConfig.get(plan.rootRealPath, operation.key);
        if (!sameGitValue(current, operation.before)) {
          throw new Error("Git config changed after review");
        }
      } else if (operation.kind === "write-symlink" || operation.kind === "remove-symlink") {
        const current = await inspectSymlink(destination);
        if (!matchesSymlinkState(current, operation.before)) {
          throw new Error("symlink precondition changed after review");
        }
        await validateAncestors(plan.rootRealPath, operation.path, plan.operations);
      } else {
        const current = await inspectFile(destination);
        if (!matchesTransactionState(current, operation.before)) {
          throw new Error("file precondition changed after review");
        }
        await validateAncestors(plan.rootRealPath, operation.path, plan.operations);
      }
    } catch (error) {
      diagnostics.push(
        applyDiagnostic(
          "apply.precondition.changed",
          operation.path,
          "blocked",
          [errorMessage(error)],
          "A planned unit no longer satisfies its exact precondition.",
          "No planned operation was executed.",
          "Preserve the current evidence and generate a new plan.",
        ),
      );
    }
  }
  try {
    await access(plan.rootRealPath, constants.W_OK);
    for (const operation of plan.operations) {
      if (operation.kind === "configure-git") continue;
      let parent = resolve(destinationPath(plan.rootRealPath, operation.path), "..");
      while (parent !== plan.rootRealPath) {
        try {
          await access(parent, constants.W_OK);
          break;
        } catch (error) {
          if (!isNodeError(error, "ENOENT")) throw error;
          parent = resolve(parent, "..");
        }
      }
    }
    const capacity = await statfs(plan.rootRealPath);
    const available = capacity.bavail * capacity.bsize;
    const required = plan.operations.reduce((total, operation) => {
      if (operation.kind !== "write-file" && operation.kind !== "remove-file") return total;
      const beforeBytes =
        operation.before.kind === "file" ? (liveFileSizes.get(operation.path) ?? 0) : 0;
      const afterBytes = operation.kind === "write-file" ? operation.bytes.byteLength : 0;
      return total + afterBytes + beforeBytes;
    }, 0);
    if (available < required * 2 + 1024 * 1024) {
      throw new Error(`insufficient free bytes: required=${required}, available=${available}`);
    }
  } catch (error) {
    diagnostics.push(
      applyDiagnostic(
        "apply.environment.not-ready",
        null,
        "blocked",
        [errorMessage(error)],
        "Filesystem permissions or capacity are insufficient for staging and backup.",
        "No planned operation was executed.",
        "Restore write access or free space before applying.",
      ),
    );
  }
  return diagnostics.sort(compareDiagnostics);
}

async function stageWrites(
  store: NodeTransactionStore,
  context: TransactionContext,
  operationId: string,
  operations: readonly TransactionOperation[],
): Promise<ReadonlyMap<string, BackupReference>> {
  const stages = new Map<string, BackupReference>();
  for (const operation of operations) {
    if (operation.kind !== "write-file") continue;
    stages.set(
      operation.unitId,
      await store.writeStage(
        context,
        operationId,
        operation.unitId,
        operation.bytes.copy(),
      ),
    );
  }
  return stages;
}

async function prepareJournal(
  store: NodeTransactionStore,
  context: TransactionContext,
  operationId: string,
  plan: ReadyPlan,
): Promise<TransactionJournal> {
  const units: TransactionJournalUnit[] = [];
  for (const operation of plan.operations) {
    if (operation.kind === "create-directory" || operation.kind === "remove-directory") {
      units.push(
        Object.freeze({
          kind: "directory",
          unit_id: operation.unitId,
          state: "prepared",
          path: operation.path,
          before:
            operation.kind === "create-directory"
              ? Object.freeze({ kind: "absent" as const })
              : Object.freeze({ kind: "directory" as const, mode: operation.mode }),
          after:
            operation.kind === "create-directory"
              ? Object.freeze({ kind: "directory" as const, mode: operation.mode })
              : Object.freeze({ kind: "absent" as const }),
        }),
      );
      continue;
    }
    if (operation.kind === "configure-git") {
      units.push(
        Object.freeze({
          kind: "git-config",
          unit_id: operation.unitId,
          state: "prepared",
          key: operation.key,
          before_value: operation.before.kind === "value" ? operation.before.value : null,
          after_value: operation.value,
        }),
      );
      continue;
    }
    if (operation.kind === "write-symlink" || operation.kind === "remove-symlink") {
      units.push(
        Object.freeze({
          kind: "symlink",
          unit_id: operation.unitId,
          state: "prepared",
          path: operation.path,
          before_target: operation.before.kind === "symlink" ? operation.before.target : null,
          after_target: operation.kind === "write-symlink" ? operation.target : null,
        }),
      );
      continue;
    }
    const before = operation.before.kind === "absent"
      ? Object.freeze({ kind: "absent" as const })
      : await backupBefore(store, context, operationId, operation);
    units.push(
      Object.freeze({
        kind: "filesystem",
        unit_id: operation.unitId,
        state: "prepared",
        target: journalTarget(operation),
        container_path: operation.path,
        before,
        after:
          operation.kind === "write-file"
            ? Object.freeze({
                kind: "present" as const,
                digest: operation.bytes.digest(),
                mode: operation.mode,
              })
            : Object.freeze({ kind: "absent" as const }),
      }),
    );
  }
  const now = new Date().toISOString();
  return Object.freeze({
    schema: "ai-harness/journal/v1",
    operation_id: operationId,
    plan_id: plan.id,
    phase: "prepared",
    worktree_identity: context.worktreeIdentity,
    root_real_path: context.rootRealPath,
    started_at: now,
    updated_at: now,
    units: Object.freeze(units),
  });
}

async function backupBefore(
  store: NodeTransactionStore,
  context: TransactionContext,
  operationId: string,
  operation: Extract<TransactionOperation, { readonly kind: "write-file" | "remove-file" }>,
) {
  if (operation.before.kind !== "file") throw new TypeError("Expected a file before-image");
  const destination = destinationPath(context.rootRealPath, operation.path);
  const bytes = await readRegularFile(destination);
  if (sha256(bytes) !== operation.before.digest) {
    throw new Error(`Before-image changed while preparing ${operation.path}`);
  }
  const backup = await store.writeBackup(
    context,
    operationId,
    operation.unitId,
    bytes,
  );
  return Object.freeze({
    kind: "backup" as const,
    digest: backup.digest,
    backup_ref: backup.ref,
    mode: operation.before.mode,
  });
}

async function applyOperation(
  root: string,
  operation: TransactionOperation,
  stages: ReadonlyMap<string, BackupReference>,
  store: NodeTransactionStore,
  context: TransactionContext,
  gitConfig: GitConfigPort,
): Promise<void> {
  const destination = destinationPath(root, operation.path);
  if (operation.kind === "create-directory") {
    await mkdir(destination, { mode: operation.mode });
    await syncDirectory(resolve(destination, ".."));
    return;
  }
  if (operation.kind === "remove-directory") {
    await rmdir(destination);
    await syncDirectory(resolve(destination, ".."));
    return;
  }
  if (operation.kind === "configure-git") {
    await gitConfig.set(root, operation.key, operation.value);
    return;
  }
  if (operation.kind === "remove-file") {
    await unlink(destination);
    await syncDirectory(resolve(destination, ".."));
    return;
  }
  if (operation.kind === "remove-symlink") {
    await unlink(destination);
    await syncDirectory(resolve(destination, ".."));
    return;
  }
  if (operation.kind === "write-symlink") {
    await replaceSymlink(destination, operation.target);
    return;
  }
  const stage = stages.get(operation.unitId);
  if (stage === undefined) throw new Error(`Missing staged bytes for ${operation.unitId}`);
  const bytes = await store.readStage(context, stage.ref, stage.digest);
  await replaceFile(destination, bytes.copy(), operation.mode);
}

async function verifyOperation(
  root: string,
  operation: TransactionOperation,
  gitConfig: GitConfigPort,
): Promise<void> {
  const destination = destinationPath(root, operation.path);
  if (operation.kind === "create-directory") {
    const entry = await lstat(destination);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`Created directory verification failed: ${operation.path}`);
    }
    return;
  }
  if (operation.kind === "remove-directory") {
    try {
      await lstat(destination);
      throw new Error(`Removed directory still exists: ${operation.path}`);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
    return;
  }
  if (operation.kind === "configure-git") {
    const current = await gitConfig.get(root, operation.key);
    const expected: GitConfigValue = operation.value === null
      ? Object.freeze({ kind: "absent" })
      : Object.freeze({ kind: "value", value: operation.value });
    if (!sameGitValue(current, expected)) throw new Error("Git config verification failed");
    return;
  }
  if (operation.kind === "remove-symlink") {
    if ((await inspectSymlink(destination)) !== null) {
      throw new Error(`Removed symlink still exists: ${operation.path}`);
    }
    return;
  }
  if (operation.kind === "write-symlink") {
    const current = await inspectSymlink(destination);
    if (current === null || current.target !== operation.target) {
      throw new Error(`Written symlink verification failed: ${operation.path}`);
    }
    return;
  }
  const current = await inspectFile(destination);
  if (operation.kind === "remove-file") {
    if (current !== null) throw new Error(`Removed file still exists: ${operation.path}`);
  } else if (
    current === null ||
    current.digest !== operation.bytes.digest() ||
    current.mode !== operation.mode
  ) {
    throw new Error(`Written file verification failed: ${operation.path}`);
  }
}

async function replaceSymlink(path: string, target: string): Promise<void> {
  const parent = resolve(path, "..");
  const stage = resolve(parent, `.ai-harness-apply-${randomUUID()}`);
  await symlink(target, stage);
  try {
    await rename(stage, path);
    await syncDirectory(parent);
  } catch (error) {
    await unlink(stage).catch(() => undefined);
    throw error;
  }
}

async function replaceFile(path: string, bytes: Uint8Array, mode: number): Promise<void> {
  const parent = resolve(path, "..");
  const stage = resolve(parent, `.ai-harness-apply-${randomUUID()}`);
  const handle = await open(
    stage,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    mode,
  );
  try {
    await handle.writeFile(bytes);
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(stage, path);
    await syncDirectory(parent);
  } catch (error) {
    await unlink(stage).catch(() => undefined);
    throw error;
  }
}

async function inspectFile(path: string): Promise<Extract<TransactionFileState, { kind: "file" }> | null> {
  let handle;
  try {
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    handle = await open(path, constants.O_RDONLY | noFollow);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
  try {
    const entry = await handle.stat();
    if (!entry.isFile() || entry.nlink !== 1) {
      throw new Error("Target is not a non-hardlinked regular file");
    }
    return Object.freeze({
      kind: "file",
      digest: sha256(await handle.readFile()),
      mode: entry.mode & 0o777,
    });
  } finally {
    await handle.close();
  }
}

async function inspectSymlink(
  path: string,
): Promise<Extract<TransactionFileState, { kind: "symlink" }> | null> {
  try {
    const entry = await lstat(path);
    if (!entry.isSymbolicLink()) throw new Error("Target is not a symbolic link");
    return Object.freeze({ kind: "symlink", target: await readlink(path) });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
}

async function readRegularFile(path: string): Promise<Uint8Array> {
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const entry = await handle.stat();
    if (!entry.isFile() || entry.nlink !== 1) {
      throw new Error("Before-image is not a non-hardlinked regular file");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function validateAncestors(
  root: string,
  path: RelativePosixPath,
  operations: readonly TransactionOperation[],
): Promise<void> {
  const created = new Set(
    operations
      .filter((operation) => operation.kind === "create-directory")
      .map((operation) => operation.path),
  );
  let current = root;
  const segments = path.split("/");
  let relativePath = "";
  for (const segment of segments.slice(0, -1)) {
    current = resolve(current, segment);
    relativePath = relativePath.length === 0 ? segment : `${relativePath}/${segment}`;
    try {
      const entry = await lstat(current);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error(`unsafe ancestor: ${relativePath}`);
      }
    } catch (error) {
      if (isNodeError(error, "ENOENT") && created.has(relativePath as RelativePosixPath)) continue;
      throw error;
    }
  }
}

function matchesTransactionState(
  current: Extract<TransactionFileState, { kind: "file" }> | null,
  expected: TransactionFileState,
): boolean {
  if (expected.kind === "absent") return current === null;
  if (expected.kind === "symlink") return false;
  return current !== null && current.digest === expected.digest && current.mode === expected.mode;
}

function matchesSymlinkState(
  current: Extract<TransactionFileState, { kind: "symlink" }> | null,
  expected:
    | Extract<TransactionFileState, { kind: "absent" }>
    | Extract<TransactionFileState, { kind: "symlink" }>,
): boolean {
  return expected.kind === "absent"
    ? current === null
    : current !== null && current.target === expected.target;
}

function sameGitValue(left: GitConfigValue, right: GitConfigValue): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "absent" || (right.kind === "value" && left.value === right.value))
  );
}

function journalTarget(
  operation: Extract<TransactionOperation, { readonly kind: "write-file" | "remove-file" }>,
): Extract<TransactionJournalUnit, { readonly kind: "filesystem" }>["target"] {
  return operation.target.kind === "file"
    ? Object.freeze({ kind: "file", path: operation.target.path })
    : Object.freeze({
        kind: "managed-section",
        path: operation.target.path,
        section_id: operation.target.sectionId,
      });
}

function updateJournal(
  journal: TransactionJournal,
  phase: TransactionJournal["phase"],
  units: TransactionJournal["units"],
): TransactionJournal {
  return Object.freeze({
    ...journal,
    phase,
    updated_at: new Date().toISOString(),
    units: Object.freeze([...units]),
  });
}

function receipt(
  operationId: string,
  plan: ReadyPlan,
  outcome: "succeeded" | "no-changes" | "cancelled" | "rejected" | "failed",
  diagnostics: readonly Diagnostic[],
  units: readonly TransactionJournalUnit[],
): TransactionReceipt {
  const now = new Date().toISOString();
  return Object.freeze({
    schema: "ai-harness/receipt/v1",
    operation_id: operationId,
    plan_id: plan.id,
    command: plan.mode,
    started_at: now,
    completed_at: now,
    result: outcome,
    materialization:
      outcome === "succeeded"
        ? "committed"
        : outcome === "no-changes" || outcome === "cancelled" || outcome === "rejected"
          ? "unchanged"
          : "unknown",
    certification: "not-run",
    preflight: Object.freeze([
      { id: "repository.snapshot", verdict: outcome === "rejected" ? "failed" : "passed" },
      { id: "filesystem.permissions", verdict: outcome === "rejected" ? "skipped" : "passed" },
      { id: "storage.capacity", verdict: outcome === "rejected" ? "skipped" : "passed" },
    ]),
    changes: Object.freeze(
      units
        .filter(
          (unit): unit is Extract<TransactionJournalUnit, { readonly kind: "filesystem" }> =>
            unit.kind === "filesystem",
        )
        .map((unit) => ({
          unit_id: unit.unit_id,
          target: unit.target,
          action:
            unit.before.kind === "absent"
              ? "create"
              : unit.after.kind === "absent"
                ? "remove"
                : "replace",
          outcome: outcome === "succeeded" ? "applied" : "not-applied",
          before_digest: unit.before.kind === "backup" ? unit.before.digest : null,
          after_digest: unit.after.kind === "present" ? unit.after.digest : null,
        })),
    ),
    verification: Object.freeze(
      outcome === "succeeded"
        ? [
            {
              id: "project.materialization",
              kind: "materialization",
              verdict: "passed",
              evidence: [plan.lockAfter?.digest ?? plan.id],
            },
          ]
        : [],
    ),
    diagnostics: Object.freeze(
      diagnostics.map((diagnostic) => ({ code: diagnostic.code, severity: diagnostic.severity })),
    ),
  });
}

class OperationCancelledError extends Error {
  public constructor() {
    super("Operation cancelled before the next safe mutation boundary");
    this.name = "OperationCancelledError";
  }
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new OperationCancelledError();
}

function cancellationDiagnostic(): Diagnostic {
  return applyDiagnostic(
    "apply.cancelled",
    null,
    "info",
    ["safe-boundary:before-first-mutation"],
    "The operation was cancelled before the first repository mutation.",
    "The reviewed repository state remains unchanged.",
    "Review or discard the current draft.",
  );
}

function result(
  kind: DurableApplyResult["kind"],
  plan: ReadyPlan,
  operationId: string,
  diagnostics: readonly Diagnostic[],
  changedPaths: readonly RelativePosixPath[],
  receiptPath: string | null,
): DurableApplyResult {
  return Object.freeze({
    kind,
    planId: plan.id,
    operationId,
    diagnostics: Object.freeze([...diagnostics].sort(compareDiagnostics)),
    changedPaths: Object.freeze([...changedPaths]),
    receiptPath,
  });
}

function invalidPlanDiagnostic(path: RelativePosixPath, evidence: string): Diagnostic {
  return applyDiagnostic(
    "apply.plan.invalid",
    path,
    "blocked",
    [evidence],
    "The approved plan contains ambiguous mutation units.",
    "No planned operation was executed.",
    "Generate a new plan from valid projections.",
  );
}

function applyDiagnostic(
  code: string,
  path: RelativePosixPath | null,
  severity: Diagnostic["severity"],
  evidence: readonly string[],
  message: string,
  impact: string,
  action: string,
): Diagnostic {
  return Object.freeze({
    code,
    severity,
    phase: "apply",
    subjects: Object.freeze([]),
    location: path === null ? null : Object.freeze({ path }),
    message,
    evidence: Object.freeze([...evidence].sort(compareUtf8)),
    impact,
    action,
  });
}

function destinationPath(root: string, path: RelativePosixPath): string {
  const destination = resolve(root, ...path.split("/"));
  const difference = relative(root, destination);
  if (
    difference === "" ||
    difference === ".." ||
    difference.startsWith(`..${sep}`) ||
    isAbsolute(difference)
  ) {
    throw new Error(`Mutation path escapes the worktree: ${path}`);
  }
  return destination;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

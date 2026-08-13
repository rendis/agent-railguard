import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readlink,
  readdir,
  rename,
  rmdir,
  symlink,
  unlink,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { GitConfigPort, GitConfigValue } from "../../../domain/planning/model.js";
import type {
  RecoveryManager,
  RecoveryResult,
} from "../../../domain/transaction/model.js";
import {
  ReadonlyBytes,
  compareUtf8,
  sha256,
  type Diagnostic,
  type RelativePosixPath,
  type Sha256Digest,
} from "../../../domain/shared/types.js";
import {
  NodeTransactionStore,
  NonGitWorktreeError,
  type JournalBackupState,
  type JournalFileState,
  type TransactionContext,
  type TransactionJournal,
  type TransactionJournalUnit,
  type TransactionReceipt,
} from "./node-transaction-store.js";

interface CurrentFile {
  readonly digest: Sha256Digest;
  readonly mode: number;
}

class DivergedRecoveryStateError extends Error {
  public constructor(
    public readonly unit: TransactionJournalUnit,
    message: string,
  ) {
    super(message);
    this.name = "DivergedRecoveryStateError";
  }
}

export class NodeRecoveryManager implements RecoveryManager {
  public constructor(
    private readonly store: NodeTransactionStore,
    private readonly gitConfig: GitConfigPort,
  ) {}

  public async recover(root: string): Promise<RecoveryResult> {
    let lease;
    try {
      lease = await this.store.acquire(root);
    } catch (error) {
      if (error instanceof NonGitWorktreeError) {
        return Object.freeze({
          kind: "no-recovery",
          operationId: randomUUID(),
          diagnostics: Object.freeze([]),
          receiptPath: null,
        });
      }
      throw error;
    }
    try {
      const journal = await this.store.readJournal(lease.context);
      if (journal === null) {
        return Object.freeze({
          kind: "no-recovery",
          operationId: lease.operationId,
          diagnostics: Object.freeze([]),
          receiptPath: null,
        });
      }
      if (
        journal.worktree_identity !== lease.context.worktreeIdentity ||
        journal.root_real_path !== lease.context.rootRealPath
      ) {
        return await this.#failRecovery(
          lease.context,
          lease.operationId,
          journal,
          recoveryDiagnostic(
            "recovery.identity-mismatch",
            null,
            [journal.worktree_identity, lease.context.worktreeIdentity],
            "The active journal belongs to a different worktree identity.",
            "No rollback unit was touched.",
          ),
        );
      }

      try {
        await this.#preflightRecovery(lease.context, journal);
      } catch (error) {
        const diagnostic = error instanceof DivergedRecoveryStateError
          ? recoveryDiagnostic(
              "recovery.state-diverged",
              unitPath(error.unit),
              [error.unit.unit_id, error.message],
              "A recovery unit matches neither its durable before nor after evidence.",
              "No rollback unit was touched.",
            )
          : recoveryDiagnostic(
              "recovery.preflight-failed",
              null,
              [errorMessage(error)],
              "Recovery evidence could not be validated before rollback.",
              "No rollback unit was touched.",
            );
        return await this.#failRecovery(
          lease.context,
          lease.operationId,
          journal,
          diagnostic,
        );
      }

      let active = updateJournal(journal, "rolling-back", journal.units);
      await this.store.writeJournal(lease.context, active);
      try {
        for (let index = active.units.length - 1; index >= 0; index -= 1) {
          const candidate = active.units[index];
          if (candidate === undefined) continue;
          if (candidate.state !== "restored") {
            await this.#restoreUnit(lease.context, candidate);
          }
          const units = active.units.map((unit, unitIndex) =>
            unitIndex === index ? Object.freeze({ ...unit, state: "restored" as const }) : unit,
          );
          active = updateJournal(active, "rolling-back", units);
          await this.store.writeJournal(lease.context, active);
        }
      } catch (error) {
        const diagnostic = error instanceof DivergedRecoveryStateError
          ? recoveryDiagnostic(
              "recovery.state-diverged",
              unitPath(error.unit),
              [error.unit.unit_id, error.message],
              "A recovery unit matches neither its durable before nor after evidence.",
              "The current bytes were preserved and automatic rollback stopped.",
            )
          : recoveryDiagnostic(
              "recovery.rollback-failed",
              null,
              [errorMessage(error)],
              "Automatic rollback failed while restoring a proven unit.",
              "The journal and backups remain available for a safe retry.",
            );
        return await this.#failRecovery(
          lease.context,
          lease.operationId,
          active,
          diagnostic,
        );
      }

      const receipt = recoveryReceipt(
        lease.operationId,
        active,
        "rolled-back",
        Object.freeze([]),
      );
      const receiptPath = await this.store.writeReceipt(lease.context, receipt);
      await this.store.removeJournal(lease.context, active.operation_id);
      await this.store.removeOperationData(lease.context, active.operation_id);
      return Object.freeze({
        kind: "rolled-back",
        operationId: lease.operationId,
        diagnostics: Object.freeze([]),
        receiptPath,
      });
    } finally {
      await lease.release();
    }
  }

  async #preflightRecovery(
    context: TransactionContext,
    journal: TransactionJournal,
  ): Promise<void> {
    const journaledDirectories = new Set(
      journal.units
        .filter(
          (unit): unit is Extract<TransactionJournalUnit, { readonly kind: "directory" }> =>
            unit.kind === "directory",
        )
        .map((unit) => unit.path),
    );
    for (const unit of journal.units) {
      if (unit.kind === "filesystem") {
        await validateParentDirectories(
          context.rootRealPath,
          unit.container_path,
          journaledDirectories,
        );
        if (unit.before.kind === "backup") {
          await this.store.readBackup(context, unit.before.backup_ref, unit.before.digest);
        }
        const current = await inspectFile(
          destinationPath(context.rootRealPath, unit.container_path),
        );
        if (!matchesBefore(current, unit.before) && !matchesFileState(current, unit.after)) {
          throw new DivergedRecoveryStateError(unit, "filesystem-neither-before-nor-after");
        }
        continue;
      }
      if (unit.kind === "directory") {
        const path = destinationPath(context.rootRealPath, unit.path);
        const current = await inspectDirectory(path);
        if (
          !matchesDirectoryState(current, unit.before) &&
          !matchesDirectoryState(current, unit.after)
        ) {
          throw new DivergedRecoveryStateError(unit, "directory-neither-before-nor-after");
        }
        if (unit.before.kind === "absent" && current !== null) {
          const allowedChildren = new Set<string>();
          for (const candidate of journal.units) {
            const candidatePath = candidate.kind === "filesystem"
              ? candidate.before.kind === "absent"
                ? candidate.container_path
                : null
              : candidate.kind === "symlink"
                ? candidate.before_target === null
                  ? candidate.path
                  : null
              : candidate.kind === "directory"
                ? candidate.path
                : null;
            if (candidatePath?.startsWith(`${unit.path}/`) === true) {
              const child = candidatePath.slice(unit.path.length + 1).split("/")[0];
              if (child !== undefined) allowedChildren.add(child);
            }
          }
          const foreign = (await readdir(path)).filter((name) => !allowedChildren.has(name));
          if (foreign.length > 0) {
            throw new DivergedRecoveryStateError(
              unit,
              `created-directory-has-foreign-entries:${foreign.sort(compareUtf8).join(",")}`,
            );
          }
        }
        continue;
      }
      if (unit.kind === "symlink") {
        await validateParentDirectories(context.rootRealPath, unit.path, journaledDirectories);
        const current = await inspectSymlink(destinationPath(context.rootRealPath, unit.path));
        if (
          !matchesSymlinkTarget(current, unit.before_target) &&
          !matchesSymlinkTarget(current, unit.after_target)
        ) {
          throw new DivergedRecoveryStateError(unit, "symlink-neither-before-nor-after");
        }
        continue;
      }
      const current = await this.gitConfig.get(context.rootRealPath, unit.key);
      if (
        !sameGitValue(current, gitValue(unit.before_value)) &&
        !sameGitValue(current, gitValue(unit.after_value))
      ) {
        throw new DivergedRecoveryStateError(unit, "git-config-neither-before-nor-after");
      }
    }
  }

  async #restoreUnit(context: TransactionContext, unit: TransactionJournalUnit): Promise<void> {
    if (unit.kind === "filesystem") {
      await restoreFilesystemUnit(context, unit, this.store);
      return;
    }
    if (unit.kind === "directory") {
      await restoreDirectoryUnit(context, unit);
      return;
    }
    if (unit.kind === "symlink") {
      await restoreSymlinkUnit(context, unit);
      return;
    }
    const current = await this.gitConfig.get(context.rootRealPath, unit.key);
    const before = gitValue(unit.before_value);
    const after = gitValue(unit.after_value);
    if (sameGitValue(current, before)) return;
    if (!sameGitValue(current, after)) {
      throw new DivergedRecoveryStateError(unit, "git-config-neither-before-nor-after");
    }
    await this.gitConfig.set(context.rootRealPath, unit.key, unit.before_value);
    const restored = await this.gitConfig.get(context.rootRealPath, unit.key);
    if (!sameGitValue(restored, before)) {
      throw new Error(`Git config restoration could not be verified for ${unit.unit_id}`);
    }
  }

  async #failRecovery(
    context: TransactionContext,
    recoveryOperationId: string,
    journal: TransactionJournal,
    diagnostic: Diagnostic,
  ): Promise<RecoveryResult> {
    const failed = updateJournal(journal, "rollback-failed", journal.units);
    await this.store.writeJournal(context, failed);
    const receiptPath = await this.store.writeReceipt(
      context,
      recoveryReceipt(recoveryOperationId, failed, "recovery-required", [diagnostic]),
    );
    return Object.freeze({
      kind: "recovery-required",
      operationId: recoveryOperationId,
      diagnostics: Object.freeze([diagnostic]),
      receiptPath,
    });
  }
}

async function restoreSymlinkUnit(
  context: TransactionContext,
  unit: Extract<TransactionJournalUnit, { readonly kind: "symlink" }>,
): Promise<void> {
  const destination = destinationPath(context.rootRealPath, unit.path);
  const current = await inspectSymlink(destination);
  if (matchesSymlinkTarget(current, unit.before_target)) return;
  await validateParentDirectories(context.rootRealPath, unit.path);
  if (!matchesSymlinkTarget(current, unit.after_target)) {
    throw new DivergedRecoveryStateError(unit, "symlink-neither-before-nor-after");
  }
  if (current !== null) await unlink(destination);
  if (unit.before_target !== null) await symlink(unit.before_target, destination);
  await syncDirectory(resolve(destination, ".."));
  const restored = await inspectSymlink(destination);
  if (!matchesSymlinkTarget(restored, unit.before_target)) {
    throw new Error(`Symlink restoration could not be verified for ${unit.unit_id}`);
  }
}

async function restoreFilesystemUnit(
  context: TransactionContext,
  unit: Extract<TransactionJournalUnit, { readonly kind: "filesystem" }>,
  store: NodeTransactionStore,
): Promise<void> {
  const destination = destinationPath(context.rootRealPath, unit.container_path);
  const current = await inspectFile(destination);
  if (matchesBefore(current, unit.before)) return;
  await validateParentDirectories(context.rootRealPath, unit.container_path);
  if (!matchesFileState(current, unit.after)) {
    throw new DivergedRecoveryStateError(unit, "filesystem-neither-before-nor-after");
  }

  if (unit.before.kind === "absent") {
    if (current !== null) await unlink(destination);
  } else {
    const backup = await store.readBackup(
      context,
      unit.before.backup_ref,
      unit.before.digest,
    );
    await replaceFile(destination, backup, unit.before.mode);
  }
  const restored = await inspectFile(destination);
  if (!matchesBefore(restored, unit.before)) {
    throw new Error(`Filesystem restoration could not be verified for ${unit.unit_id}`);
  }
}

async function restoreDirectoryUnit(
  context: TransactionContext,
  unit: Extract<TransactionJournalUnit, { readonly kind: "directory" }>,
): Promise<void> {
  const destination = destinationPath(context.rootRealPath, unit.path);
  const current = await inspectDirectory(destination);
  if (matchesDirectoryState(current, unit.before)) return;
  if (!matchesDirectoryState(current, unit.after)) {
    throw new DivergedRecoveryStateError(unit, "directory-neither-before-nor-after");
  }
  if (unit.before.kind === "absent") {
    try {
      await rmdir(destination);
      await syncDirectory(resolve(destination, ".."));
    } catch (error) {
      if (isNodeError(error, "ENOTEMPTY") || isNodeError(error, "EEXIST")) {
        throw new DivergedRecoveryStateError(unit, "created-directory-is-not-empty");
      }
      throw error;
    }
  } else {
    await mkdir(destination, { mode: unit.before.mode });
    await syncDirectory(resolve(destination, ".."));
  }
  const restored = await inspectDirectory(destination);
  if (!matchesDirectoryState(restored, unit.before)) {
    throw new Error(`Directory restoration could not be verified for ${unit.unit_id}`);
  }
}

async function inspectDirectory(path: string): Promise<{ readonly mode: number } | null> {
  try {
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error("Recovery directory is not a real directory");
    }
    return Object.freeze({ mode: entry.mode & 0o777 });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
}

function matchesDirectoryState(
  current: { readonly mode: number } | null,
  state: Extract<TransactionJournalUnit, { readonly kind: "directory" }>["before"],
): boolean {
  return state.kind === "absent"
    ? current === null
    : current !== null && current.mode === state.mode;
}

async function inspectFile(path: string): Promise<CurrentFile | null> {
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | noFollow);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
  try {
    const entry = await handle.stat();
    if (!entry.isFile() || entry.nlink !== 1) {
      throw new Error("Recovery target is not a non-hardlinked regular file");
    }
    return Object.freeze({
      digest: sha256(await handle.readFile()),
      mode: entry.mode & 0o777,
    });
  } finally {
    await handle.close();
  }
}

async function inspectSymlink(path: string): Promise<{ readonly target: string } | null> {
  try {
    const entry = await lstat(path);
    if (!entry.isSymbolicLink()) throw new Error("Recovery target is not a symbolic link");
    return Object.freeze({ target: await readlink(path) });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
}

function matchesSymlinkTarget(
  current: { readonly target: string } | null,
  expected: string | null,
): boolean {
  return expected === null ? current === null : current?.target === expected;
}

async function replaceFile(path: string, bytes: ReadonlyBytes, mode: number): Promise<void> {
  const parent = resolve(path, "..");
  const stage = resolve(parent, `.ai-harness-recovery-${randomUUID()}`);
  const handle = await open(
    stage,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    mode,
  );
  try {
    await handle.writeFile(bytes.copy());
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

async function validateParentDirectories(
  root: string,
  path: RelativePosixPath,
  allowedMissing: ReadonlySet<RelativePosixPath> = new Set(),
): Promise<void> {
  const segments = path.split("/");
  let current = root;
  let relativePath = "";
  for (const segment of segments.slice(0, -1)) {
    current = resolve(current, segment);
    relativePath = relativePath.length === 0 ? segment : `${relativePath}/${segment}`;
    try {
      const entry = await lstat(current);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error(`Recovery parent is unsafe: ${relativePath}`);
      }
    } catch (error) {
      if (
        isNodeError(error, "ENOENT") &&
        allowedMissing.has(relativePath as RelativePosixPath)
      ) {
        continue;
      }
      throw error;
    }
  }
}

function matchesBefore(current: CurrentFile | null, before: JournalBackupState): boolean {
  return before.kind === "absent"
    ? current === null
    : current !== null && current.digest === before.digest && current.mode === before.mode;
}

function matchesFileState(current: CurrentFile | null, state: JournalFileState): boolean {
  return state.kind === "absent"
    ? current === null
    : current !== null && current.digest === state.digest && current.mode === state.mode;
}

function gitValue(value: string | null): GitConfigValue {
  return value === null
    ? Object.freeze({ kind: "absent" })
    : Object.freeze({ kind: "value", value });
}

function sameGitValue(left: GitConfigValue, right: GitConfigValue): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "absent" || (right.kind === "value" && left.value === right.value))
  );
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

function recoveryReceipt(
  recoveryOperationId: string,
  journal: TransactionJournal,
  result: "rolled-back" | "recovery-required",
  diagnostics: readonly Diagnostic[],
): TransactionReceipt {
  const now = new Date().toISOString();
  return Object.freeze({
    schema: "ai-harness/receipt/v1",
    operation_id: recoveryOperationId,
    plan_id: journal.plan_id,
    command: "recovery",
    started_at: journal.started_at,
    completed_at: now,
    result,
    materialization: result === "rolled-back" ? "rolled-back" : "unknown",
    certification: "not-run",
    preflight: Object.freeze([{ id: "recovery.journal", verdict: "passed" }]),
    changes: Object.freeze(
      journal.units
        .filter(
          (unit): unit is Extract<TransactionJournalUnit, { readonly kind: "filesystem" }> =>
            unit.kind === "filesystem",
        )
        .map((unit) =>
          Object.freeze({
            unit_id: unit.unit_id,
            target: unit.target,
            action:
              unit.before.kind === "absent"
                ? "create"
                : unit.after.kind === "absent"
                  ? "remove"
                  : "replace",
            outcome: result === "rolled-back" ? "restored" : "not-applied",
            before_digest: unit.before.kind === "backup" ? unit.before.digest : null,
            after_digest: unit.after.kind === "present" ? unit.after.digest : null,
          }),
        ),
    ),
    verification: Object.freeze([]),
    diagnostics: Object.freeze(
      diagnostics.map((diagnostic) =>
        Object.freeze({ code: diagnostic.code, severity: diagnostic.severity }),
      ),
    ),
  });
}

function recoveryDiagnostic(
  code: string,
  path: RelativePosixPath | null,
  evidence: readonly string[],
  message: string,
  impact: string,
): Diagnostic {
  return Object.freeze({
    code,
    severity: "blocked",
    phase: "recovery",
    subjects: Object.freeze([]),
    location: path === null ? null : Object.freeze({ path }),
    message,
    evidence: Object.freeze([...evidence].sort(compareUtf8)),
    impact,
    action: "Preserve the journal and backups, inspect the reported unit, then retry recovery.",
  });
}

function unitPath(unit: TransactionJournalUnit): RelativePosixPath | null {
  if (unit.kind === "filesystem") return unit.container_path;
  if (unit.kind === "directory" || unit.kind === "symlink") return unit.path;
  return null;
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
    throw new Error(`Recovery path escapes the worktree: ${path}`);
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

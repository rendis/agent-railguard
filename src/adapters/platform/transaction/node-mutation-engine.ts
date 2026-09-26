import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readlink,
  realpath,
  rename,
  rmdir,
  symlink,
  unlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
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

type ReadyPlan = Extract<DurableProjectPlan, { readonly kind: "ready" }>;

/** What an applied operation replaced, kept in memory so a failed apply can be undone. */
type BeforeImage =
  | { readonly kind: "none" }
  | { readonly kind: "file"; readonly bytes: Uint8Array; readonly mode: number };

/**
 * Applies a reviewed plan in order. Every destination lives inside the Git worktree, so an
 * interrupted process leaves changes that `git status` shows and `railguard repair` or
 * `git restore` resolve; within one process a failure restores every applied unit from
 * in-memory before-images.
 */
export class NodeMutationEngine implements DurableMutationEngine {
  public constructor(
    private readonly gitConfig: GitConfigPort,
    private readonly events: DurableMutationEventSink = () => undefined,
  ) {}

  public async apply(
    plan: ReadyPlan,
    options: DurableApplyOptions = {},
  ): Promise<DurableApplyResult> {
    const operationId = randomUUID();
    this.#emit("preflight", "started", "Revalidating every reviewed precondition");
    const diagnostics = await preflight(plan, this.gitConfig);
    if (diagnostics.length > 0) {
      this.#emit("preflight", "failed", "Reviewed preconditions no longer hold");
      return result("rejected", plan, operationId, diagnostics, []);
    }
    this.#emit("preflight", "completed", "All reviewed preconditions still hold");
    if (plan.operations.length === 0) return result("no-changes", plan, operationId, [], []);
    if (isAborted(options.signal)) {
      return result("cancelled", plan, operationId, [cancellationDiagnostic()], []);
    }

    const applied: { readonly operation: TransactionOperation; readonly before: BeforeImage }[] = [];
    try {
      for (const [index, operation] of plan.operations.entries()) {
        if (isAborted(options.signal)) throw new OperationCancelledError();
        this.#emit("apply", "started", `Applying ${operation.unitId}`, operation.unitId, index + 1, plan.operations.length);
        const before = await captureBefore(plan.rootRealPath, operation);
        applied.push({ operation, before });
        await applyOperation(plan.rootRealPath, operation, this.gitConfig);
        await verifyOperation(plan.rootRealPath, operation, this.gitConfig);
        this.#emit("apply", "completed", `Applied ${operation.unitId}`, operation.unitId, index + 1, plan.operations.length);
      }
      this.#emit("verify", "started", "Verifying the complete materialization");
      for (const operation of plan.operations) {
        await verifyOperation(plan.rootRealPath, operation, this.gitConfig);
      }
      this.#emit("verify", "completed", "Complete materialization verified");
      const changedPaths = [...new Set(plan.operations.map((operation) => operation.path))].sort(compareUtf8);
      return result("applied", plan, operationId, [], changedPaths);
    } catch (error) {
      this.#emit("rollback", "started", "Restoring every applied unit");
      const failures: string[] = [];
      for (const { operation, before } of applied.reverse()) {
        try {
          await restoreOperation(plan.rootRealPath, operation, before, this.gitConfig);
        } catch (restoreError) {
          failures.push(`${operation.path}: ${errorMessage(restoreError)}`);
        }
      }
      const cause = error instanceof OperationCancelledError
        ? cancellationDiagnostic()
        : applyDiagnostic(
            "apply.transaction.failed",
            null,
            "failed",
            [errorMessage(error)],
            "A planned mutation failed and every applied unit was restored.",
            "The requested state was not committed.",
            "Resolve the reported failure and generate a new plan.",
          );
      if (failures.length === 0) {
        this.#emit("rollback", "completed", "Every applied unit was restored");
        return result("rolled-back", plan, operationId, [cause], []);
      }
      this.#emit("rollback", "failed", "Some applied units could not be restored");
      return result("recovery-required", plan, operationId, [
        cause,
        applyDiagnostic(
          "apply.rollback.incomplete",
          null,
          "failed",
          failures,
          "Some applied units could not be restored automatically.",
          "The repository contains a partial Railguard materialization.",
          "Inspect `git status`, restore the listed paths with `git restore`, or run `railguard repair`.",
        ),
      ], []);
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
  try {
    if ((await realpath(plan.rootRealPath)) !== plan.rootRealPath) {
      throw new Error("repository realpath changed");
    }
    const snapshot = await new NodeRepositoryInventory().snapshot(plan.rootRealPath);
    if (snapshot.fingerprint !== plan.snapshotFingerprint) {
      throw new Error("repository fingerprint changed after review");
    }
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
        await validateAncestors(plan.rootRealPath, operation.path, plan.operations);
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
  } catch (error) {
    diagnostics.push(
      applyDiagnostic(
        "apply.environment.not-ready",
        null,
        "blocked",
        [errorMessage(error)],
        "Filesystem permissions are insufficient for the planned writes.",
        "No planned operation was executed.",
        "Restore write access before applying.",
      ),
    );
  }
  return diagnostics.sort(compareDiagnostics);
}

async function captureBefore(root: string, operation: TransactionOperation): Promise<BeforeImage> {
  if (operation.kind !== "write-file" && operation.kind !== "remove-file") return { kind: "none" };
  if (operation.before.kind !== "file") return { kind: "none" };
  const bytes = await readRegularFile(destinationPath(root, operation.path));
  if (sha256(bytes) !== operation.before.digest) {
    throw new Error(`Before-image changed while applying ${operation.path}`);
  }
  return { kind: "file", bytes, mode: operation.before.mode };
}

async function applyOperation(
  root: string,
  operation: TransactionOperation,
  gitConfig: GitConfigPort,
): Promise<void> {
  const destination = destinationPath(root, operation.path);
  switch (operation.kind) {
    case "create-directory":
      await mkdir(destination, { mode: operation.mode });
      await chmod(destination, operation.mode);
      return;
    case "remove-directory":
      await rmdir(destination);
      return;
    case "configure-git":
      await gitConfig.set(root, operation.key, operation.value);
      return;
    case "remove-file":
    case "remove-symlink":
      await unlink(destination);
      return;
    case "write-symlink":
      await replaceSymlink(destination, operation.target);
      return;
    case "write-file":
      await replaceFile(destination, operation.bytes.copy(), operation.mode);
      return;
  }
}

async function restoreOperation(
  root: string,
  operation: TransactionOperation,
  before: BeforeImage,
  gitConfig: GitConfigPort,
): Promise<void> {
  const destination = destinationPath(root, operation.path);
  switch (operation.kind) {
    case "create-directory":
      await rmdir(destination).catch((error: unknown) => {
        if (!isNodeError(error, "ENOENT")) throw error;
      });
      return;
    case "remove-directory":
      await mkdir(destination, { mode: operation.mode }).catch((error: unknown) => {
        if (!isNodeError(error, "EEXIST")) throw error;
      });
      await chmod(destination, operation.mode);
      return;
    case "configure-git":
      await gitConfig.set(root, operation.key, operation.before.kind === "value" ? operation.before.value : null);
      return;
    case "write-symlink":
    case "remove-symlink":
      if (operation.before.kind === "symlink") {
        await replaceSymlink(destination, operation.before.target);
      } else {
        await unlink(destination).catch((error: unknown) => {
          if (!isNodeError(error, "ENOENT")) throw error;
        });
      }
      return;
    case "write-file":
    case "remove-file":
      if (before.kind === "file") {
        await replaceFile(destination, before.bytes, before.mode);
      } else {
        await unlink(destination).catch((error: unknown) => {
          if (!isNodeError(error, "ENOENT")) throw error;
        });
      }
      return;
  }
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
  const stage = resolve(parent, `.railguard-apply-${randomUUID()}`);
  await symlink(target, stage);
  try {
    await rename(stage, path);
  } catch (error) {
    await unlink(stage).catch(() => undefined);
    throw error;
  }
}

async function replaceFile(path: string, bytes: Uint8Array, mode: number): Promise<void> {
  const parent = resolve(path, "..");
  const stage = resolve(parent, `.railguard-apply-${randomUUID()}`);
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

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

class OperationCancelledError extends Error {
  public constructor() {
    super("Operation cancelled before the next safe mutation boundary");
    this.name = "OperationCancelledError";
  }
}

function cancellationDiagnostic(): Diagnostic {
  return applyDiagnostic(
    "apply.cancelled",
    null,
    "info",
    ["safe-boundary:operation"],
    "The operation was cancelled; any applied unit was restored.",
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
): DurableApplyResult {
  return Object.freeze({
    kind,
    planId: plan.id,
    operationId,
    diagnostics: Object.freeze([...diagnostics].sort(compareDiagnostics)),
    changedPaths: Object.freeze([...changedPaths]),
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

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  LockStateModule,
  type LockDecodeContext,
  type LockStateResult,
} from "../../../project-state/lock-state.js";
import {
  DesiredStateModule,
  type DesiredStateResult,
} from "../../../project-state/desired-state.js";
import type { CatalogSnapshot } from "../../../domain/catalog/model.js";
import type {
  ProjectStateReader,
  StoredDesiredResult,
  StoredLockResult,
} from "../../../project-state/store.js";
import {
  compareUtf8,
  relativePosixPath,
  type Diagnostic,
} from "../../../domain/shared/types.js";

const maximumLockBytes = 8 * 1024 * 1024;

export class NodeProjectStateStore implements ProjectStateReader {
  readonly #locks: LockStateModule;
  readonly #desired: DesiredStateModule;

  public constructor(locks = new LockStateModule(), desired = new DesiredStateModule()) {
    this.#locks = locks;
    this.#desired = desired;
  }

  public async loadDesired(
    root: string,
    catalog: CatalogSnapshot,
  ): Promise<StoredDesiredResult> {
    const stored = await readStateFile(root, "project.yaml");
    if (stored.kind === "absent") return stored;
    if (stored.kind === "unsafe") return unsafeDesired(stored.evidence);
    return this.#desired.evaluate({ kind: "yaml", source: stored.source }, catalog);
  }

  public async loadLock(root: string, context: LockDecodeContext): Promise<StoredLockResult> {
    const stored = await readStateFile(root, "lock.json");
    if (stored.kind === "absent") return stored;
    if (stored.kind === "unsafe") return unsafeLock(stored.evidence);
    return this.#locks.decode(stored.source, context);
  }
}

type StoredSource =
  | { readonly kind: "absent" }
  | { readonly kind: "unsafe"; readonly evidence: string }
  | { readonly kind: "ready"; readonly source: string };

async function readStateFile(root: string, fileName: "project.yaml" | "lock.json"): Promise<StoredSource> {
  let rootRealPath: string;
  try {
    rootRealPath = await realpath(root);
  } catch (error) {
    return { kind: "unsafe", evidence: errorMessage(error) };
  }
  const stateDirectory = join(rootRealPath, ".railguard");
  let directoryStat;
  try {
    directoryStat = await lstat(stateDirectory);
  } catch (error) {
    return isNodeError(error, "ENOENT")
      ? Object.freeze({ kind: "absent" })
      : { kind: "unsafe", evidence: errorMessage(error) };
  }
  try {
    if (!directoryStat.isDirectory() || (await realpath(stateDirectory)) !== stateDirectory) {
      return { kind: "unsafe", evidence: ".railguard must be a real repository directory" };
    }
  } catch (error) {
    return { kind: "unsafe", evidence: errorMessage(error) };
  }

  let handle;
  try {
    handle = await open(join(stateDirectory, fileName), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    return isNodeError(error, "ENOENT")
      ? Object.freeze({ kind: "absent" })
      : { kind: "unsafe", evidence: errorMessage(error) };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximumLockBytes) {
      return { kind: "unsafe", evidence: `${fileName} must be a bounded regular file` };
    }
    return { kind: "ready", source: await handle.readFile("utf8") };
  } catch (error) {
    return { kind: "unsafe", evidence: errorMessage(error) };
  } finally {
    await handle.close();
  }
}

function unsafeLock(evidence: string): Extract<LockStateResult, { readonly kind: "invalid" }> {
  const diagnostic: Diagnostic = Object.freeze({
    code: "project-state.lock-path-unsafe",
    severity: "failed",
    phase: "project-state",
    subjects: Object.freeze([]),
    location: Object.freeze({ path: relativePosixPath(".railguard/lock.json") }),
    message: "The portable lock path is not a safe repository-local regular file.",
    evidence: Object.freeze([evidence].sort(compareUtf8)),
    impact: "The lock cannot be trusted for reconciliation.",
    action: "Replace the path with a regular project-local file and run status again.",
  });
  return Object.freeze({
    kind: "invalid",
    diagnostics: Object.freeze([diagnostic]) as readonly [Diagnostic],
  });
}

function unsafeDesired(
  evidence: string,
): Extract<DesiredStateResult, { readonly kind: "invalid" }> {
  const diagnostic: Diagnostic = Object.freeze({
    code: "project-state.desired-path-unsafe",
    severity: "failed",
    phase: "project-state",
    subjects: Object.freeze([]),
    location: Object.freeze({ path: relativePosixPath(".railguard/project.yaml") }),
    message: "The desired state path is not a safe repository-local regular file.",
    evidence: Object.freeze([evidence].sort(compareUtf8)),
    impact: "The desired state cannot be trusted for resolution.",
    action: "Replace the path with a regular project-local file and run scan again.",
  });
  return Object.freeze({
    kind: "invalid",
    diagnostics: Object.freeze([diagnostic]) as readonly [Diagnostic],
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

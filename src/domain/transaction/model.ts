import type { CatalogSnapshot } from "../catalog/model.js";
import type { GitConfigValue } from "../planning/model.js";
import type { ManagedProjection } from "../projection/model.js";
import type { RepositorySnapshot } from "../repository/model.js";
import type { ReadyResolution } from "../resolution/model.js";
import type {
  Diagnostic,
  ReadonlyBytes,
  RelativePosixPath,
  Sha256Digest,
} from "../shared/types.js";
import type { DesiredStateResult } from "../../project-state/desired-state.js";
import type { LockStateResult } from "../../project-state/lock-state.js";

export type ReadyDesiredState = Extract<DesiredStateResult, { readonly kind: "ready" }>;
export type ReadyPortableLock = Extract<LockStateResult, { readonly kind: "ready" }>;

export type TransactionFileState =
  | { readonly kind: "absent" }
  | { readonly kind: "file"; readonly digest: Sha256Digest; readonly mode: number }
  | { readonly kind: "symlink"; readonly target: string };

export type TransactionOperation =
  | {
      readonly kind: "create-directory";
      readonly unitId: string;
      readonly path: RelativePosixPath;
      readonly mode: number;
    }
  | {
      readonly kind: "remove-directory";
      readonly unitId: string;
      readonly path: RelativePosixPath;
      readonly mode: number;
    }
  | {
      readonly kind: "write-file";
      readonly unitId: string;
      readonly path: RelativePosixPath;
      readonly target:
        | { readonly kind: "file"; readonly path: RelativePosixPath }
        | {
            readonly kind: "managed-section";
            readonly path: RelativePosixPath;
            readonly sectionId: string;
          };
      readonly bytes: ReadonlyBytes;
      readonly mode: number;
      readonly before: TransactionFileState;
    }
  | {
      readonly kind: "remove-file";
      readonly unitId: string;
      readonly path: RelativePosixPath;
      readonly target:
        | { readonly kind: "file"; readonly path: RelativePosixPath }
        | {
            readonly kind: "managed-section";
            readonly path: RelativePosixPath;
            readonly sectionId: string;
          };
      readonly before: Extract<TransactionFileState, { readonly kind: "file" }>;
    }
  | {
      readonly kind: "write-symlink";
      readonly unitId: string;
      readonly path: RelativePosixPath;
      readonly target: string;
      readonly before:
        | Extract<TransactionFileState, { readonly kind: "absent" }>
        | Extract<TransactionFileState, { readonly kind: "symlink" }>;
    }
  | {
      readonly kind: "remove-symlink";
      readonly unitId: string;
      readonly path: RelativePosixPath;
      readonly before: Extract<TransactionFileState, { readonly kind: "symlink" }>;
    }
  | {
      readonly kind: "configure-git";
      readonly unitId: string;
      readonly path: RelativePosixPath;
      readonly key: "core.hooksPath";
      readonly value: string | null;
      readonly before: GitConfigValue;
    };

export interface DurableProjectPlanRequest {
  readonly mode: "reconcile" | "repair" | "remove";
  readonly snapshot: RepositorySnapshot;
  readonly catalog: CatalogSnapshot;
  readonly resolution: ReadyResolution;
  readonly projections: readonly ManagedProjection[];
  readonly desiredBefore: ReadyDesiredState | null;
  readonly lockBefore: ReadyPortableLock | null;
  readonly desiredAfter: ReadyDesiredState | null;
  readonly diagnostics?: readonly Diagnostic[];
}

export type DurableProjectPlan =
  | {
      readonly kind: "ready";
      readonly mode: DurableProjectPlanRequest["mode"];
      readonly id: Sha256Digest;
      readonly rootRealPath: string;
      readonly snapshotFingerprint: Sha256Digest;
      readonly desiredBefore: ReadyDesiredState | null;
      readonly lockBefore: ReadyPortableLock | null;
      readonly desiredAfter: ReadyDesiredState | null;
      readonly lockAfter: ReadyPortableLock | null;
      readonly operations: readonly TransactionOperation[];
      readonly diagnostics: readonly Diagnostic[];
    }
  | {
      readonly kind: "blocked";
      readonly mode: DurableProjectPlanRequest["mode"];
      readonly rootRealPath: string;
      readonly snapshotFingerprint: Sha256Digest;
      readonly diagnostics: readonly [Diagnostic, ...Diagnostic[]];
    };

export interface DurableApplyResult {
  readonly kind: "applied" | "no-changes" | "cancelled" | "rejected" | "rolled-back" | "recovery-required" | "failed";
  readonly planId: Sha256Digest;
  readonly operationId: string;
  readonly diagnostics: readonly Diagnostic[];
  readonly changedPaths: readonly RelativePosixPath[];
  readonly receiptPath: string | null;
}

export interface DurableMutationEvent {
  readonly phase:
    | "recovery"
    | "lock"
    | "preflight"
    | "staging"
    | "backup"
    | "apply"
    | "verify"
    | "rollback"
    | "cleanup";
  readonly status: "started" | "completed" | "failed";
  readonly message: string;
  readonly unitId?: string;
  readonly current?: number;
  readonly total?: number;
}

export type DurableMutationEventSink = (event: DurableMutationEvent) => void;

export interface DurableApplyOptions {
  readonly signal?: AbortSignal;
}

export interface DurableProjectPlanning {
  plan(request: DurableProjectPlanRequest): Promise<DurableProjectPlan>;
}

export interface DurableMutationEngine {
  apply(
    plan: Extract<DurableProjectPlan, { readonly kind: "ready" }>,
    options?: DurableApplyOptions,
  ): Promise<DurableApplyResult>;
}

export interface RecoveryResult {
  readonly kind: "no-recovery" | "rolled-back" | "recovery-required";
  readonly operationId: string;
  readonly diagnostics: readonly Diagnostic[];
  readonly receiptPath: string | null;
}

export interface RecoveryManager {
  recover(root: string): Promise<RecoveryResult>;
}

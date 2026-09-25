import type { GitConfigPort } from "../planning/model.js";
import type { PortableOwnershipState } from "../ownership/model.js";
import type { RepositorySnapshot } from "../repository/model.js";
import type { Diagnostic, Sha256Digest } from "../shared/types.js";

export type ObservedUnitStatus = "clean" | "missing" | "drifted" | "unknown";
export type ObservedUnitKind = "directory" | "file" | "symlink" | "managed-section" | "json-member" | "git-config";

export interface ObservedManagedUnit {
  readonly ownershipId: string;
  readonly kind: ObservedUnitKind;
  readonly status: ObservedUnitStatus;
  readonly expectedDigest: Sha256Digest;
  readonly observedDigest: Sha256Digest | null;
}

export interface ObservedProjectState {
  readonly snapshotFingerprint: Sha256Digest;
  readonly units: readonly ObservedManagedUnit[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface ProjectObserver {
  observe(snapshot: RepositorySnapshot, ownership: PortableOwnershipState): Promise<ObservedProjectState>;
}

export interface ProjectObserverDependencies {
  readonly gitConfig: GitConfigPort;
}

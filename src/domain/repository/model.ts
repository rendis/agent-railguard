import type {
  Diagnostic,
  LanguageId,
  ProjectUnitId,
  ReadonlyBytes,
  RelativePosixPath,
  Sha256Digest,
} from "../shared/types.js";

export interface RepositoryFileEntry {
  readonly kind: "file";
  readonly path: RelativePosixPath;
  readonly mode: number;
  readonly size: number;
  readonly digest: Sha256Digest;
}

export interface RepositoryDirectoryEntry {
  readonly kind: "directory";
  readonly path: RelativePosixPath;
  readonly mode: number;
}

export interface RepositorySymlinkEntry {
  readonly kind: "symlink";
  readonly path: RelativePosixPath;
  readonly target: string;
  readonly resolvedPath: string | null;
  readonly escapesRoot: boolean;
}

export type RepositoryEntry =
  | RepositoryFileEntry
  | RepositoryDirectoryEntry
  | RepositorySymlinkEntry;

export interface SnapshotRead {
  readonly path: RelativePosixPath;
  readonly mode: number;
  readonly digest: Sha256Digest;
  readonly bytes: ReadonlyBytes;
}

export interface RepositorySnapshot {
  readonly logicalRoot: string;
  readonly realRoot: string;
  readonly fingerprint: Sha256Digest;
  readonly entries: readonly RepositoryEntry[];
  /** Whether file modes carry POSIX permission bits; Windows file systems have no executable bit. */
  readonly posixModes: boolean;
  read(path: RelativePosixPath, maxBytes: number): Promise<SnapshotRead>;
}

export interface RepositoryInventory {
  snapshot(root: string): Promise<RepositorySnapshot>;
}

export interface StackEvidence {
  readonly kind: "manifest";
  readonly path: RelativePosixPath;
  readonly detail: string;
}

export interface NativeTaskFact {
  readonly id: string;
  readonly command: string;
  readonly source: RelativePosixPath;
}

export interface ProjectUnitContribution {
  readonly root: RelativePosixPath;
  readonly language: LanguageId;
  readonly manifests: readonly RelativePosixPath[];
  readonly evidence: readonly StackEvidence[];
  readonly nativeTasks: readonly NativeTaskFact[];
}

export interface StackAssessment {
  readonly contributions: readonly ProjectUnitContribution[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface StackAdapter {
  readonly id: LanguageId;
  assess(snapshot: RepositorySnapshot): Promise<StackAssessment>;
}

export interface ProjectUnit {
  readonly id: ProjectUnitId;
  readonly root: RelativePosixPath;
  readonly languages: readonly LanguageId[];
  readonly manifests: readonly RelativePosixPath[];
  readonly evidence: readonly StackEvidence[];
  readonly nativeTasks: readonly NativeTaskFact[];
}

export interface RepositoryAssessmentResult {
  readonly snapshotFingerprint: Sha256Digest;
  readonly projectUnits: readonly ProjectUnit[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface RepositoryAssessment {
  assess(snapshot: RepositorySnapshot): Promise<RepositoryAssessmentResult>;
}

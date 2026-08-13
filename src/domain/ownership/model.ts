import type { ManagedMarkerStyle } from "../managed-section/managed-section.js";
import type {
  ComponentRef,
  HarnessTargetId,
  RelativePosixPath,
  Sha256Digest,
} from "../shared/types.js";

interface ManagedArtifactOwnershipBase {
  readonly ownership_id: string;
  readonly target: HarnessTargetId;
  readonly adapter: HarnessTargetId;
  readonly path: RelativePosixPath;
  readonly sources: readonly ComponentRef[];
  readonly content_digest: Sha256Digest;
}

export type ManagedArtifactOwnership =
  | (ManagedArtifactOwnershipBase & {
      readonly kind: "file";
      readonly portable_mode: "regular" | "executable";
    })
  | (ManagedArtifactOwnershipBase & {
      readonly kind: "managed-section";
      readonly section_id: string;
      readonly placement: "whole-file" | "append";
      readonly marker_style: ManagedMarkerStyle;
    })
  | (ManagedArtifactOwnershipBase & {
      readonly kind: "symlink";
      readonly link_target: string;
    });

export interface ManagedGitConfigOwnership {
  readonly kind: "git-config";
  readonly effect_id: string;
  readonly sources: readonly ComponentRef[];
  readonly key: "core.hooksPath";
  readonly expected_value: string;
}

export interface ManagedDirectoryOwnership {
  readonly ownership_id: string;
  readonly path: RelativePosixPath;
  readonly sources: readonly ComponentRef[];
}

export interface PortableOwnershipState {
  readonly directories: readonly ManagedDirectoryOwnership[];
  readonly artifacts: readonly ManagedArtifactOwnership[];
  readonly local_effects: readonly ManagedGitConfigOwnership[];
}

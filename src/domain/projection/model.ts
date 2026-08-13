import type { ArtifactIntent } from "../planning/model.js";
import { harnessTargetId } from "../shared/types.js";
import type {
  CapabilityId,
  ComponentRef,
  HarnessTargetId,
  SemVer,
} from "../shared/types.js";

export const projectProjectionTargetId = harnessTargetId("project");

export interface ProjectionIdentity {
  readonly target: HarnessTargetId;
  readonly adapter: {
    readonly id: HarnessTargetId;
    readonly version: SemVer;
  };
  readonly capabilities: readonly CapabilityId[];
}

interface ProjectedUnitBase {
  readonly ownershipId: string;
  readonly sources: readonly ComponentRef[];
}

export type ProjectedUnit =
  | (ProjectedUnitBase & {
      readonly kind: "artifact";
      readonly intent: Exclude<ArtifactIntent, { readonly kind: "git-config" }>;
    })
  | (ProjectedUnitBase & {
      readonly kind: "local-effect";
      readonly intent: Extract<ArtifactIntent, { readonly kind: "git-config" }>;
    });

export interface ManagedProjection {
  readonly identity: ProjectionIdentity;
  readonly units: readonly ProjectedUnit[];
}

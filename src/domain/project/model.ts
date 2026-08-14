import type { CatalogSnapshot } from "../catalog/model.js";
import type { ManagedProjection } from "../projection/model.js";
import type { RepositorySnapshot } from "../repository/model.js";
import type { RepositoryAssessmentResult } from "../repository/model.js";
import type { ReadyResolution } from "../resolution/model.js";
import type { Diagnostic } from "../shared/types.js";
import type { ComponentRef, HarnessTargetId } from "../shared/types.js";

export type ProjectSelectionInputs = ReadonlyMap<
  ComponentRef,
  Readonly<Record<string, readonly string[]>>
>;

export type ProjectConflictResolution = Readonly<{
  code: "quality.make.target-collision";
  action: "replace";
}>;

export interface ProjectPlanningContext {
  readonly conflictResolutions: readonly ProjectConflictResolution[];
}

export interface ProjectProjection extends ManagedProjection {
  readonly diagnostics: readonly Diagnostic[];
}

export interface ProjectArtifactProjector {
  project(
    resolution: ReadyResolution,
    catalog: CatalogSnapshot,
    snapshot: RepositorySnapshot,
    assessment: RepositoryAssessmentResult,
    targets: readonly HarnessTargetId[],
    selectionInputs: ProjectSelectionInputs,
    context?: ProjectPlanningContext,
  ): Promise<ProjectProjection>;
}

export interface ProjectProjectionCoordinator {
  coordinate(projections: readonly ProjectProjection[]): ProjectProjection;
}

export interface GitHookInventory {
  executableDefaultHooks(rootRealPath: string): Promise<readonly string[]>;
}

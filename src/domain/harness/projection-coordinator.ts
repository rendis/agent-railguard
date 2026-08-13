import type {
  ProjectProjection,
  ProjectProjectionCoordinator,
} from "../project/model.js";
import { projectProjectionTargetId } from "../projection/model.js";
import {
  compareDiagnostics,
  compareUtf8,
  harnessTargetId,
  semVer,
} from "../shared/types.js";

export class DefaultProjectProjectionCoordinator
  implements ProjectProjectionCoordinator
{
  public coordinate(projections: readonly ProjectProjection[]): ProjectProjection {
    const units = projections
      .flatMap((projection) => projection.units)
      .sort((left, right) => compareUtf8(left.ownershipId, right.ownershipId));
    const capabilities = [
      ...new Set(projections.flatMap((projection) => projection.identity.capabilities)),
    ].sort(compareUtf8);
    const diagnostics = projections
      .flatMap((projection) => projection.diagnostics)
      .sort(compareDiagnostics);

    return Object.freeze({
      identity: Object.freeze({
        target: projectProjectionTargetId,
        adapter: Object.freeze({
          id: harnessTargetId("project"),
          version: semVer("0.1.0"),
        }),
        capabilities: Object.freeze(capabilities),
      }),
      units: Object.freeze(units),
      diagnostics: Object.freeze(diagnostics),
    });
  }
}

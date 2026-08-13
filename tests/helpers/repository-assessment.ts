import type {
  ProjectUnit,
  RepositoryAssessmentResult,
  RepositorySnapshot,
} from "../../src/domain/repository/model.js";

export function repositoryAssessment(
  snapshot: RepositorySnapshot,
  projectUnits: readonly ProjectUnit[] = [],
): RepositoryAssessmentResult {
  return Object.freeze({
    snapshotFingerprint: snapshot.fingerprint,
    projectUnits: Object.freeze([...projectUnits]),
    diagnostics: Object.freeze([]),
  });
}

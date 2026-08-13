import type {
  NativeTaskFact,
  ProjectUnit,
  ProjectUnitContribution,
  RepositoryAssessment,
  RepositoryAssessmentResult,
  RepositorySnapshot,
  StackAdapter,
  StackEvidence,
} from "./model.js";
import {
  compareDiagnostics,
  compareUtf8,
  projectUnitId,
  sortedUnique,
  type RelativePosixPath,
} from "../shared/types.js";

export class DefaultRepositoryAssessment implements RepositoryAssessment {
  readonly #adapters: readonly StackAdapter[];

  public constructor(adapters: readonly StackAdapter[]) {
    const ids = adapters.map((adapter) => adapter.id);
    if (new Set(ids).size !== ids.length) {
      throw new TypeError("Stack adapter IDs must be unique");
    }
    this.#adapters = Object.freeze(
      [...adapters].sort((left, right) => compareUtf8(left.id, right.id)),
    );
  }

  public async assess(snapshot: RepositorySnapshot): Promise<RepositoryAssessmentResult> {
    const assessments = await Promise.all(
      this.#adapters.map(async (adapter) => adapter.assess(snapshot)),
    );
    const diagnostics = assessments
      .flatMap((assessment) => assessment.diagnostics)
      .sort(compareDiagnostics);
    const contributions = assessments
      .flatMap((assessment) => assessment.contributions)
      .sort(compareContributions);
    const byRoot = new Map<RelativePosixPath, ProjectUnitContribution[]>();
    for (const contribution of contributions) {
      const current = byRoot.get(contribution.root) ?? [];
      current.push(contribution);
      byRoot.set(contribution.root, current);
    }

    const projectUnits: ProjectUnit[] = [...byRoot.entries()]
      .sort(([left], [right]) => compareUtf8(left, right))
      .map(([root, unitContributions]) =>
        Object.freeze({
          id: projectUnitId(`unit:${root}`),
          root,
          languages: sortedUnique(unitContributions.map((entry) => entry.language)),
          manifests: sortedUnique(unitContributions.flatMap((entry) => entry.manifests)),
          evidence: Object.freeze(
            deduplicateEvidence(unitContributions.flatMap((entry) => entry.evidence)),
          ),
          nativeTasks: Object.freeze(
            deduplicateTasks(unitContributions.flatMap((entry) => entry.nativeTasks)),
          ),
        }),
      );

    return Object.freeze({
      snapshotFingerprint: snapshot.fingerprint,
      projectUnits: Object.freeze(projectUnits),
      diagnostics: Object.freeze(diagnostics),
    });
  }
}

function compareContributions(
  left: ProjectUnitContribution,
  right: ProjectUnitContribution,
): number {
  return compareUtf8(`${left.root}\0${left.language}`, `${right.root}\0${right.language}`);
}

function deduplicateEvidence(values: readonly StackEvidence[]): readonly StackEvidence[] {
  const byKey = new Map<string, StackEvidence>();
  for (const value of values) {
    byKey.set(`${value.kind}\0${value.path}\0${value.detail}`, value);
  }
  return [...byKey.values()].sort((left, right) =>
    compareUtf8(
      `${left.kind}\0${left.path}\0${left.detail}`,
      `${right.kind}\0${right.path}\0${right.detail}`,
    ),
  );
}

function deduplicateTasks(values: readonly NativeTaskFact[]): readonly NativeTaskFact[] {
  const byKey = new Map<string, NativeTaskFact>();
  for (const value of values) {
    byKey.set(`${value.id}\0${value.command}\0${value.source}`, value);
  }
  return [...byKey.values()].sort((left, right) =>
    compareUtf8(
      `${left.id}\0${left.command}\0${left.source}`,
      `${right.id}\0${right.command}\0${right.source}`,
    ),
  );
}

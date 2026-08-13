import type { CatalogComponent, CatalogSnapshot } from "../../../domain/catalog/model.js";
import type {
  ProjectArtifactProjector,
  ProjectProjection,
  ProjectSelectionInputs,
} from "../../../domain/project/model.js";
import type { RepositorySnapshot } from "../../../domain/repository/model.js";
import type { RepositoryAssessmentResult } from "../../../domain/repository/model.js";
import type { ReadyResolution } from "../../../domain/resolution/model.js";
import {
  capabilityId,
  compareUtf8,
  harnessTargetId,
  relativePosixPath,
  semVer,
  sha256,
  type HarnessTargetId,
} from "../../../domain/shared/types.js";
import {
  projectProjectionTargetId,
  type ProjectedUnit,
} from "../../../domain/projection/model.js";
import { skillInstallationRoots } from "./skill-installation-roots.js";

export class SharedSkillProjector implements ProjectArtifactProjector {
  public constructor(private readonly platform: "posix" | "windows" = process.platform === "win32" ? "windows" : "posix") {}

  public async project(
    resolution: ReadyResolution,
    catalog: CatalogSnapshot,
    _snapshot: RepositorySnapshot,
    _assessment: RepositoryAssessmentResult,
    targets: readonly HarnessTargetId[],
    _selectionInputs: ProjectSelectionInputs,
  ): Promise<ProjectProjection> {
    const roots = skillInstallationRoots(targets);
    const byRef = new Map(catalog.components.map((component) => [component.ref, component]));
    const skills = resolution.components
      .map((resolved) => requireComponent(byRef, resolved.ref))
      .filter((component) => component.kind === "skill")
      .sort((left, right) => compareUtf8(left.ref, right.ref));
    const units: ProjectedUnit[] = [];

    const shared = roots.find((root) => root.id === "shared");
    const claude = roots.find((root) => root.id === "claude");
    const materializedRoots = this.platform === "posix" && shared !== undefined && claude !== undefined
      ? roots.filter((root) => root.id !== "claude")
      : roots;

    for (const root of materializedRoots) {
      for (const skill of skills) {
        const skillId = skill.ref.slice("skill:".length);
        const scopeRoot = relativePosixPath(`${root.path}/${skillId}`);
        for (const file of skill.payload.files) {
          const path = relativePosixPath(`${scopeRoot}/${file.path}`);
          const suffix = sha256(path).slice("sha256:".length, "sha256:".length + 12);
          units.push(
            Object.freeze({
              kind: "artifact",
              ownershipId: `project.skills.${root.id}.${skillId}.file.${suffix}`,
              sources: Object.freeze([skill.ref]),
              intent: Object.freeze({
                kind: "file",
                owner: skill.ref,
                scopeRoot,
                path,
                bytes: file.bytes,
                mode: file.mode === "100755" ? 0o755 : 0o644,
              }),
            }),
          );
        }
      }
    }
    if (this.platform === "posix" && shared !== undefined && claude !== undefined) {
      for (const skill of skills) {
        const skillId = skill.ref.slice("skill:".length);
        units.push(
          Object.freeze({
            kind: "artifact",
            ownershipId: `project.skills.claude.${skillId}.symlink`,
            sources: Object.freeze([skill.ref]),
            intent: Object.freeze({
              kind: "symlink",
              owner: skill.ref,
              scopeRoot: relativePosixPath(`${claude.path}/${skillId}`),
              path: relativePosixPath(`${claude.path}/${skillId}`),
              target: `../../${shared.path}/${skillId}`,
            }),
          }),
        );
      }
    }

    units.sort((left, right) => compareUtf8(left.ownershipId, right.ownershipId));
    return Object.freeze({
      identity: Object.freeze({
        target: projectProjectionTargetId,
        adapter: Object.freeze({ id: harnessTargetId("skills"), version: semVer("0.1.0") }),
        capabilities: Object.freeze([capabilityId("project.skills")]),
      }),
      units: Object.freeze(units),
      diagnostics: Object.freeze([]),
    });
  }
}

function requireComponent(
  byRef: ReadonlyMap<string, CatalogComponent>,
  ref: string,
): CatalogComponent {
  const component = byRef.get(ref);
  if (component === undefined) {
    throw new TypeError(`Resolution/catalog mismatch for component: ${ref}`);
  }
  return component;
}

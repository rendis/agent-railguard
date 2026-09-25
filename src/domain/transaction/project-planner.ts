import { posix } from "node:path";
import {
  inspectManagedSection,
  removeManagedSection,
  renderManagedSection,
  type ManagedSectionPlacement,
} from "../managed-section/managed-section.js";
import type { ManagedArtifactOwnership } from "../ownership/model.js";
import {
  getJsonMember,
  jsonMemberDigest,
  parseJsonContainer,
  removeJsonMember,
  renderJsonContainer,
  setJsonMember,
  type JsonObject,
} from "../managed-json/managed-json.js";
import type { GitConfigPort, GitConfigValue } from "../planning/model.js";
import type { ProjectedUnit } from "../projection/model.js";
import type { RepositoryEntry, RepositorySnapshot } from "../repository/model.js";
import {
  ReadonlyBytes,
  canonicalJson,
  compareDiagnostics,
  compareUtf8,
  relativePosixPath,
  sha256,
  type ComponentRef,
  type Diagnostic,
  type RelativePosixPath,
} from "../shared/types.js";
import {
  LockStateModule,
  type LockDirectoryDraft,
} from "../../project-state/lock-state.js";
import type {
  DurableProjectPlan,
  DurableProjectPlanRequest,
  DurableProjectPlanning,
  ReadyPortableLock,
  TransactionFileState,
  TransactionOperation,
} from "./model.js";

const maximumManagedContainerBytes = 4 * 1024 * 1024;
const desiredPath = relativePosixPath(".railguard/project.yaml");
const lockPath = relativePosixPath(".railguard/lock.json");

export class DurableProjectPlanner implements DurableProjectPlanning {
  public constructor(private readonly gitConfig: GitConfigPort) {}

  public async plan(request: DurableProjectPlanRequest): Promise<DurableProjectPlan> {
    const diagnostics: Diagnostic[] = [...(request.diagnostics ?? [])];
    const units = flattenUnits(request.projections, diagnostics);
    const placements = await derivePlacements(request.snapshot, request.lockBefore, units, diagnostics);
    if (hasBlockers(diagnostics)) return blocked(request, diagnostics);

    if (request.desiredAfter === null && request.resolution.components.length > 0) {
      diagnostics.push(
        planningDiagnostic(
          "planning.remove-all.resolution-not-empty",
          null,
          request.resolution.components.map((component) => component.ref),
          "A full uninstall must resolve an empty component closure.",
          "Portable state cannot be removed while managed components remain desired.",
        ),
      );
      return blocked(request, diagnostics);
    }
    const managedDirectories = deriveManagedDirectories(request, units, diagnostics);
    const lockAfter = request.desiredAfter === null
      ? null
      : new LockStateModule().buildFromProjections({
          desiredDigest: request.desiredAfter.digest,
          catalog: request.catalog,
          resolution: request.resolution,
          projections: request.projections,
          managedSectionPlacements: placements,
          managedDirectories,
        });
    if (lockAfter?.kind === "invalid") {
      diagnostics.push(...lockAfter.diagnostics);
      return blocked(request, diagnostics);
    }

    const operations: TransactionOperation[] = [];
    await planArtifacts(request, lockAfter, units, operations, diagnostics);
    await planLocalEffects(request, lockAfter, operations, diagnostics, this.gitConfig);
    if (request.desiredAfter === null) {
      planStateFileRemoval(
        request.snapshot,
        desiredPath,
        "state.desired",
        request.desiredBefore?.bytes ?? null,
        operations,
        diagnostics,
      );
      planStateFileRemoval(
        request.snapshot,
        lockPath,
        "state.lock",
        request.lockBefore?.bytes ?? null,
        operations,
        diagnostics,
      );
    } else {
      planStateFile(
        request.snapshot,
        desiredPath,
        "state.desired",
        request.desiredBefore?.bytes ?? null,
        request.desiredAfter.bytes,
        operations,
        diagnostics,
      );
      if (lockAfter?.kind !== "ready") throw new TypeError("Expected a generated portable lock");
      planStateFile(
        request.snapshot,
        lockPath,
        "state.lock",
        request.lockBefore?.bytes ?? null,
        lockAfter.bytes,
        operations,
        diagnostics,
      );
    }
    planManagedDirectories(request.snapshot, request.lockBefore, lockAfter, operations, diagnostics);
    if (hasBlockers(diagnostics)) return blocked(request, diagnostics);

    operations.sort(compareOperations);
    diagnostics.sort(compareDiagnostics);
    const id = sha256(
      canonicalJson({
        mode: request.mode,
        repository_fingerprint: request.snapshot.fingerprint,
        desired_before: request.desiredBefore?.digest ?? null,
        desired_after: request.desiredAfter?.digest ?? null,
        lock_before: request.lockBefore?.digest ?? null,
        lock_after: lockAfter?.digest ?? null,
        catalog: request.catalog.digest,
        operations: operations.map(operationIdentity),
      }),
    );
    return Object.freeze({
      kind: "ready",
      mode: request.mode,
      id,
      rootRealPath: request.snapshot.realRoot,
      snapshotFingerprint: request.snapshot.fingerprint,
      desiredBefore: request.desiredBefore,
      lockBefore: request.lockBefore,
      desiredAfter: request.desiredAfter,
      lockAfter,
      operations: Object.freeze(operations),
      diagnostics: Object.freeze(diagnostics),
    });
  }
}

function flattenUnits(
  projections: DurableProjectPlanRequest["projections"],
  diagnostics: Diagnostic[],
): readonly ProjectedUnit[] {
  const units = projections.flatMap((projection) => projection.units);
  const seen = new Set<string>();
  for (const unit of units) {
    if (seen.has(unit.ownershipId)) {
      diagnostics.push(
        planningDiagnostic(
          "planning.ownership.duplicate",
          null,
          [unit.ownershipId],
          "Two projections emitted the same ownership ID.",
          "No plan can be built with ambiguous ownership.",
        ),
      );
    }
    seen.add(unit.ownershipId);
  }
  return Object.freeze([...units].sort((left, right) => compareUtf8(left.ownershipId, right.ownershipId)));
}

async function derivePlacements(
  snapshot: RepositorySnapshot,
  lockBefore: ReadyPortableLock | null,
  units: readonly ProjectedUnit[],
  diagnostics: Diagnostic[],
): Promise<ReadonlyMap<string, ManagedSectionPlacement>> {
  const entries = new Map(snapshot.entries.map((entry) => [entry.path, entry]));
  const previous = new Map(
    (lockBefore?.state.artifacts ?? []).map((artifact) => [artifact.ownership_id, artifact]),
  );
  const placements = new Map<string, ManagedSectionPlacement>();
  const sectionUnits = units.filter(
    (unit): unit is Extract<ProjectedUnit, { readonly kind: "artifact" }> =>
      unit.kind === "artifact" && unit.intent.kind === "managed-section",
  );
  const paths = new Set(sectionUnits.map((unit) => unit.intent.path));
  for (const path of [...paths].sort(compareUtf8)) {
    const pathUnits = sectionUnits
      .filter((unit) => unit.intent.path === path)
      .sort((left, right) => compareUtf8(left.ownershipId, right.ownershipId));
    const entry = entries.get(path);
    if (entry !== undefined && entry.kind !== "file") {
      diagnostics.push(unsafePathDiagnostic(path, entry.kind));
      continue;
    }
    let source = "";
    if (entry?.kind === "file") {
      try {
        const read = await snapshot.read(path, maximumManagedContainerBytes);
        source = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes.copy());
      } catch (error) {
        diagnostics.push(
          planningDiagnostic(
            "planning.managed-section.unreadable",
            path,
            [errorMessage(error)],
            "A managed section container is not bounded UTF-8.",
            "Railguard cannot preserve external content safely.",
          ),
        );
        continue;
      }
    }

    let unmanaged = source;
    let valid = true;
    const previousSections = (lockBefore?.state.artifacts ?? [])
      .filter(
        (artifact): artifact is Extract<ManagedArtifactOwnership, { readonly kind: "managed-section" }> =>
          artifact.kind === "managed-section" && artifact.path === path,
      )
      .sort((left, right) => compareUtf8(right.ownership_id, left.ownership_id));
    for (const artifact of previousSections) {
      const removal = removeManagedSection(
        unmanaged,
        artifact.section_id,
        artifact.marker_style,
        artifact.placement,
      );
      if (removal.kind === "invalid") {
        diagnostics.push(invalidMarkersDiagnostic(path, removal.evidence));
        valid = false;
        break;
      }
      unmanaged = removal.text;
    }
    if (!valid) continue;

    let wholeFileAssigned = false;
    const newUnits: typeof pathUnits[number][] = [];
    for (const unit of pathUnits) {
      const intent = unit.intent;
      if (intent.kind !== "managed-section") continue;
      const prior = previous.get(unit.ownershipId);
      if (
        prior?.kind === "managed-section" &&
        prior.path === intent.path &&
        prior.section_id === intent.sectionId
      ) {
      const inspection = inspectManagedSection(
        source,
        prior.section_id,
        prior.marker_style,
        prior.placement,
      );
      if (inspection.kind === "invalid") {
          diagnostics.push(invalidMarkersDiagnostic(intent.path, inspection.evidence));
          valid = false;
        continue;
      }
        placements.set(unit.ownershipId, prior.placement);
        if (prior.placement === "whole-file") wholeFileAssigned = true;
        continue;
      }
      newUnits.push(unit);
    }
    if (!valid) continue;

    for (const unit of newUnits) {
      const intent = unit.intent;
      if (intent.kind !== "managed-section") continue;
      const inspections = (["whole-file", "append"] as const).map((candidatePlacement) =>
        inspectManagedSection(
          source,
          intent.sectionId,
          intent.markerStyle ?? "markdown",
          candidatePlacement,
        ),
      );
      if (inspections.some((inspection) => inspection.kind === "present")) {
        diagnostics.push(
          planningDiagnostic(
            "planning.managed-section.foreign",
            intent.path,
            [intent.sectionId],
            "A matching managed marker exists without portable ownership.",
            "Railguard will not adopt or overwrite the unowned block.",
          ),
        );
        continue;
      }
      const invalidInspection = inspections.find(
        (inspection) => inspection.kind === "invalid",
      );
      if (invalidInspection?.kind === "invalid") {
        diagnostics.push(invalidMarkersDiagnostic(intent.path, invalidInspection.evidence));
        continue;
      }
      const placement: ManagedSectionPlacement =
        unmanaged.length === 0 && !wholeFileAssigned ? "whole-file" : "append";
      placements.set(unit.ownershipId, placement);
      if (placement === "whole-file") wholeFileAssigned = true;
    }
  }
  return placements;
}

function deriveManagedDirectories(
  request: DurableProjectPlanRequest,
  units: readonly ProjectedUnit[],
  diagnostics: Diagnostic[],
): readonly LockDirectoryDraft[] {
  if (request.desiredAfter === null) return Object.freeze([]);
  const entries = new Map(request.snapshot.entries.map((entry) => [entry.path, entry]));
  const previous = new Map(
    (request.lockBefore?.state.directories ?? []).map((directory) => [directory.path, directory]),
  );
  const sourcesByPath = new Map<RelativePosixPath, Set<ComponentRef>>();
  const addAncestors = (path: RelativePosixPath, sources: readonly ComponentRef[]) => {
    let current = posix.dirname(path);
    while (current !== ".") {
      const directory = relativePosixPath(current);
      const values = sourcesByPath.get(directory) ?? new Set();
      for (const source of sources) values.add(source);
      sourcesByPath.set(directory, values);
      current = posix.dirname(current);
    }
  };
  for (const unit of units) {
    if (unit.kind === "artifact") addAncestors(unit.intent.path, unit.sources);
  }
  const stateSources = request.resolution.components.map((component) => component.ref);
  addAncestors(desiredPath, stateSources);
  addAncestors(lockPath, stateSources);

  const directories: LockDirectoryDraft[] = [];
  for (const path of [...sourcesByPath.keys()].sort(compareUtf8)) {
    const entry = entries.get(path);
    if (entry !== undefined && entry.kind !== "directory") {
      diagnostics.push(unsafePathDiagnostic(path, entry.kind));
      continue;
    }
    const prior = previous.get(path);
    if (entry !== undefined && prior === undefined) {
      // Existing directories are usable containers but remain user-owned.
      continue;
    }
    directories.push(
      Object.freeze({
        ownershipId:
          prior?.ownership_id ??
          `directory.${sha256(path).slice("sha256:".length, "sha256:".length + 16)}`,
        path,
        sources: Object.freeze([...sourcesByPath.get(path)!].sort(compareUtf8)),
      }),
    );
  }
  return Object.freeze(directories);
}

async function planArtifacts(
  request: DurableProjectPlanRequest,
  lockAfter: ReadyPortableLock | null,
  units: readonly ProjectedUnit[],
  operations: TransactionOperation[],
  diagnostics: Diagnostic[],
): Promise<void> {
  const previousArtifacts = request.lockBefore?.state.artifacts ?? [];
  const nextArtifacts = lockAfter?.state.artifacts ?? [];
  const projectedArtifacts = new Map(
    units
      .filter((unit): unit is Extract<ProjectedUnit, { readonly kind: "artifact" }> => unit.kind === "artifact")
      .map((unit) => [unit.ownershipId, unit]),
  );
  const paths = new Set([...previousArtifacts, ...nextArtifacts].map((artifact) => artifact.path));
  for (const path of [...paths].sort(compareUtf8)) {
    const previous = previousArtifacts.filter((artifact) => artifact.path === path);
    const next = nextArtifacts.filter((artifact) => artifact.path === path);
    const all = [...previous, ...next];
    const containerKinds = new Set(
      all.map((artifact) =>
        artifact.kind === "managed-section" || artifact.kind === "json-member" ? artifact.kind : "whole",
      ),
    );
    if (containerKinds.size > 1) {
      diagnostics.push(
        planningDiagnostic(
          "planning.path.ownership-conflict",
          path,
          all.map((artifact) => artifact.ownership_id),
          "A path mixes whole-file, managed-section or JSON member ownership.",
          "No deterministic ownership boundary exists for this path.",
        ),
      );
      continue;
    }
    if (containerKinds.has("json-member")) {
      await planJsonContainer(request.snapshot, path, previous, next, projectedArtifacts, operations, diagnostics);
    } else if (containerKinds.has("whole")) {
      planWholeArtifact(request.snapshot, path, previous, next, projectedArtifacts, operations, diagnostics);
    } else {
      await planSectionContainer(
        request.snapshot,
        path,
        previous,
        next,
        projectedArtifacts,
        operations,
        diagnostics,
      );
    }
  }
}

function planWholeArtifact(
  snapshot: RepositorySnapshot,
  path: RelativePosixPath,
  previous: readonly ManagedArtifactOwnership[],
  next: readonly ManagedArtifactOwnership[],
  projected: ReadonlyMap<string, Extract<ProjectedUnit, { readonly kind: "artifact" }>>,
  operations: TransactionOperation[],
  diagnostics: Diagnostic[],
): void {
  const oldArtifacts = previous.filter((artifact) => artifact.kind === "file" || artifact.kind === "symlink");
  const newArtifacts = next.filter((artifact) => artifact.kind === "file" || artifact.kind === "symlink");
  if (oldArtifacts.length > 1 || newArtifacts.length > 1) {
    diagnostics.push(
      planningDiagnostic(
        "planning.path.ownership-conflict",
        path,
        [...oldArtifacts, ...newArtifacts].map((artifact) => artifact.ownership_id),
        "More than one whole-artifact owner targets the same path.",
        "Each whole-artifact destination must have exactly one owner.",
      ),
    );
    return;
  }
  const entry = snapshot.entries.find((candidate) => candidate.path === path);
  const oldFile = oldArtifacts[0];
  const newFile = newArtifacts[0];
  if (
    oldFile !== undefined &&
    newFile !== undefined &&
    oldFile.ownership_id !== newFile.ownership_id
  ) {
    diagnostics.push(
      planningDiagnostic(
        "planning.file.ownership-handoff",
        path,
        [oldFile.ownership_id, newFile.ownership_id],
        "A whole-file destination changed ownership identity.",
        "Railguard will not transfer exclusive ownership implicitly.",
      ),
    );
    return;
  }
  if (newFile !== undefined) {
    if (oldFile === undefined && entry !== undefined) {
      diagnostics.push(
        planningDiagnostic(
          "planning.file.foreign",
          path,
          [newFile.ownership_id],
          "A projected whole-file destination already exists without ownership.",
          "Railguard will not adopt or overwrite the foreign file.",
        ),
      );
      return;
    }
    const projectedUnit = projected.get(newFile.ownership_id);
    if (projectedUnit?.intent.kind !== newFile.kind) {
      diagnostics.push(
        planningDiagnostic(
          "planning.projection.lock-mismatch",
          path,
          [newFile.ownership_id],
        "The portable lock has no matching projected whole artifact.",
          "Regenerate the projection and lock from one catalog snapshot.",
        ),
      );
      return;
    }
    if (newFile.kind === "symlink" && projectedUnit.intent.kind === "symlink") {
      if (entry !== undefined && entry.kind !== "symlink") {
        diagnostics.push(unsafePathDiagnostic(path, entry.kind));
        return;
      }
      if (entry?.kind === "symlink" && entry.target === projectedUnit.intent.target) return;
      operations.push(
        Object.freeze({
          kind: "write-symlink",
          unitId: newFile.ownership_id,
          path,
          target: projectedUnit.intent.target,
          before: entry?.kind === "symlink"
            ? Object.freeze({ kind: "symlink" as const, target: entry.target })
            : Object.freeze({ kind: "absent" as const }),
        }),
      );
      return;
    }
    if (newFile.kind !== "file" || projectedUnit.intent.kind !== "file") return;
    if (entry !== undefined && entry.kind !== "file") {
      diagnostics.push(unsafePathDiagnostic(path, entry.kind));
      return;
    }
    const before = entry === undefined
      ? Object.freeze({ kind: "absent" as const })
      : Object.freeze({ kind: "file" as const, digest: entry.digest, mode: entry.mode });
    if (
      entry?.kind === "file" &&
      entry.digest === projectedUnit.intent.bytes.digest() &&
      entry.mode === projectedUnit.intent.mode
    ) {
      return;
    }
    operations.push(
      Object.freeze({
        kind: "write-file",
        unitId: newFile.ownership_id,
        path,
        target: Object.freeze({ kind: "file", path }),
        bytes: projectedUnit.intent.bytes,
        mode: projectedUnit.intent.mode,
        before,
      }),
    );
    return;
  }
  if (oldFile?.kind === "file" && entry?.kind === "file") {
    operations.push(
      Object.freeze({
        kind: "remove-file",
        unitId: oldFile.ownership_id,
        path,
        target: Object.freeze({ kind: "file", path }),
        before: Object.freeze({ kind: "file", digest: entry.digest, mode: entry.mode }),
      }),
    );
  } else if (oldFile?.kind === "symlink" && entry?.kind === "symlink") {
    operations.push(
      Object.freeze({
        kind: "remove-symlink",
        unitId: oldFile.ownership_id,
        path,
        before: Object.freeze({ kind: "symlink", target: entry.target }),
      }),
    );
  } else if (oldFile !== undefined && entry !== undefined) {
    diagnostics.push(unsafePathDiagnostic(path, entry.kind));
  }
}

async function planSectionContainer(
  snapshot: RepositorySnapshot,
  path: RelativePosixPath,
  previous: readonly ManagedArtifactOwnership[],
  next: readonly ManagedArtifactOwnership[],
  projected: ReadonlyMap<string, Extract<ProjectedUnit, { readonly kind: "artifact" }>>,
  operations: TransactionOperation[],
  diagnostics: Diagnostic[],
): Promise<void> {
  const entry = snapshot.entries.find((candidate) => candidate.path === path);
  if (entry !== undefined && entry.kind !== "file") {
    diagnostics.push(unsafePathDiagnostic(path, entry.kind));
    return;
  }
  let source = "";
  if (entry?.kind === "file") {
    try {
      const read = await snapshot.read(path, maximumManagedContainerBytes);
      source = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes.copy());
    } catch (error) {
      diagnostics.push(
        planningDiagnostic(
          "planning.managed-section.unreadable",
          path,
          [errorMessage(error)],
          "A managed section container is not bounded UTF-8.",
          "Railguard cannot preserve external content safely.",
        ),
      );
      return;
    }
  }
  let desired: string = source;
  const nextIds = new Set(next.map((artifact) => artifact.ownership_id));
  for (const artifact of [...previous]
    .filter((candidate) => candidate.kind === "managed-section" && !nextIds.has(candidate.ownership_id))
    .sort((left, right) => compareUtf8(right.ownership_id, left.ownership_id))) {
    if (artifact.kind !== "managed-section") continue;
    const removed = removeManagedSection(
      desired,
      artifact.section_id,
      artifact.marker_style,
      artifact.placement,
    );
    if (removed.kind === "invalid") {
      diagnostics.push(invalidMarkersDiagnostic(path, removed.evidence));
      return;
    }
    desired = removed.text;
  }
  for (const artifact of [...next].sort((left, right) => compareUtf8(left.ownership_id, right.ownership_id))) {
    if (artifact.kind !== "managed-section") continue;
    const projectedUnit = projected.get(artifact.ownership_id);
    if (projectedUnit?.intent.kind !== "managed-section") {
      diagnostics.push(
        planningDiagnostic(
          "planning.projection.lock-mismatch",
          path,
          [artifact.ownership_id],
          "The portable lock has no matching managed-section projection.",
          "Regenerate the projection and lock from one catalog snapshot.",
        ),
      );
      return;
    }
    const rendered = renderManagedSection(
      desired,
      projectedUnit.intent.sectionId,
      projectedUnit.intent.body,
      projectedUnit.intent.markerStyle ?? "markdown",
    );
    if (rendered.kind === "invalid") {
      diagnostics.push(invalidMarkersDiagnostic(path, rendered.evidence));
      return;
    }
    desired = rendered.text;
    const inspection = inspectManagedSection(
      desired,
      artifact.section_id,
      artifact.marker_style,
      artifact.placement,
    );
    if (inspection.kind !== "present" || inspection.digest !== artifact.content_digest) {
      diagnostics.push(
        planningDiagnostic(
          "planning.projection.lock-mismatch",
          path,
          [artifact.ownership_id],
          "Rendered managed bytes do not match their portable lock digest and placement.",
          "Regenerate placement, projection, and lock from the same snapshot.",
        ),
      );
      return;
    }
  }
  const desiredBytes = new ReadonlyBytes(Buffer.from(desired, "utf8"));
  if (entry?.kind === "file" && entry.digest === desiredBytes.digest()) return;
  // A container that is already gone and would stay empty needs no operation.
  if (entry === undefined && desired.length === 0) return;
  const mechanicalId = `container.${sha256(path).slice("sha256:".length, "sha256:".length + 16)}`;
  const representative = next.find((artifact) => artifact.kind === "managed-section") ??
    previous.find((artifact) => artifact.kind === "managed-section");
  if (representative?.kind !== "managed-section") return;
  if (desired.length === 0 && entry?.kind === "file") {
    operations.push(
      Object.freeze({
        kind: "remove-file",
        unitId: mechanicalId,
        path,
        target: Object.freeze({
          kind: "managed-section",
          path,
          sectionId: representative.section_id,
        }),
        before: Object.freeze({ kind: "file", digest: entry.digest, mode: entry.mode }),
      }),
    );
    return;
  }
  const managedUnit = next
    .map((artifact) => projected.get(artifact.ownership_id))
    .find((unit) => unit?.intent.kind === "managed-section");
  const mode = entry?.kind === "file"
    ? entry.mode
    : managedUnit?.intent.kind === "managed-section"
      ? managedUnit.intent.mode
      : 0o644;
  operations.push(
    Object.freeze({
      kind: "write-file",
      unitId: mechanicalId,
      path,
      target: Object.freeze({
        kind: "managed-section",
        path,
        sectionId: representative.section_id,
      }),
      bytes: desiredBytes,
      mode,
      before:
        entry?.kind === "file"
          ? Object.freeze({ kind: "file", digest: entry.digest, mode: entry.mode })
          : Object.freeze({ kind: "absent" }),
    }),
  );
}

/**
 * Rewrites a JSON object file so that only the owned members change: members no longer owned are
 * removed, owned members are set, and a member that exists without ownership blocks the plan.
 * A file left as an empty object is removed.
 */
async function planJsonContainer(
  snapshot: RepositorySnapshot,
  path: RelativePosixPath,
  previous: readonly ManagedArtifactOwnership[],
  next: readonly ManagedArtifactOwnership[],
  projected: ReadonlyMap<string, Extract<ProjectedUnit, { readonly kind: "artifact" }>>,
  operations: TransactionOperation[],
  diagnostics: Diagnostic[],
): Promise<void> {
  const entry = snapshot.entries.find((candidate) => candidate.path === path);
  if (entry !== undefined && entry.kind !== "file") {
    diagnostics.push(unsafePathDiagnostic(path, entry.kind));
    return;
  }
  let source = "";
  if (entry?.kind === "file") {
    try {
      const read = await snapshot.read(path, maximumManagedContainerBytes);
      source = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes.copy());
    } catch (error) {
      diagnostics.push(jsonContainerDiagnostic(path, [errorMessage(error)]));
      return;
    }
  }
  const parsed = parseJsonContainer(source);
  if (parsed.kind === "invalid") {
    diagnostics.push(jsonContainerDiagnostic(path, parsed.evidence));
    return;
  }
  let desired: JsonObject = parsed.value;
  const owned = new Set(previous.map((artifact) => artifact.ownership_id));
  const nextIds = new Set(next.map((artifact) => artifact.ownership_id));
  for (const artifact of previous) {
    if (artifact.kind !== "json-member" || nextIds.has(artifact.ownership_id)) continue;
    desired = removeJsonMember(desired, artifact.pointer);
  }
  for (const artifact of [...next].sort((left, right) => compareUtf8(left.ownership_id, right.ownership_id))) {
    if (artifact.kind !== "json-member") continue;
    const projectedUnit = projected.get(artifact.ownership_id);
    if (projectedUnit?.intent.kind !== "json-member") {
      diagnostics.push(
        planningDiagnostic(
          "planning.projection.lock-mismatch",
          path,
          [artifact.ownership_id],
          "The portable lock has no matching JSON member projection.",
          "Regenerate the projection and lock from one catalog snapshot.",
        ),
      );
      return;
    }
    const current = getJsonMember(desired, artifact.pointer);
    if (!owned.has(artifact.ownership_id) && current !== undefined) {
      diagnostics.push(
        planningDiagnostic(
          "planning.json-member.foreign",
          path,
          [artifact.pointer.join(".")],
          `${artifact.pointer.join(".")} already exists in ${path} without Railguard ownership.`,
          "Railguard will not adopt or overwrite a foreign configuration entry; merge it manually or remove it.",
        ),
      );
      continue;
    }
    const updated = setJsonMember(desired, artifact.pointer, projectedUnit.intent.value);
    if (updated.kind === "invalid") {
      diagnostics.push(jsonContainerDiagnostic(path, updated.evidence));
      return;
    }
    desired = updated.value;
    if (jsonMemberDigest(artifact.pointer, getJsonMember(desired, artifact.pointer)) !== artifact.content_digest) {
      diagnostics.push(
        planningDiagnostic(
          "planning.projection.lock-mismatch",
          path,
          [artifact.ownership_id],
          "Rendered JSON member does not match its portable lock digest.",
          "Regenerate the projection and lock from the same snapshot.",
        ),
      );
      return;
    }
  }
  const representative = next.find((artifact) => artifact.kind === "json-member") ??
    previous.find((artifact) => artifact.kind === "json-member");
  if (representative?.kind !== "json-member") return;
  const unitId = `container.${sha256(path).slice("sha256:".length, "sha256:".length + 16)}`;
  const target = Object.freeze({ kind: "json-member" as const, path, pointer: representative.pointer });
  if (Object.keys(desired).length === 0) {
    if (entry?.kind === "file") {
      operations.push(
        Object.freeze({
          kind: "remove-file",
          unitId,
          path,
          target,
          before: Object.freeze({ kind: "file", digest: entry.digest, mode: entry.mode }),
        }),
      );
    }
    return;
  }
  const bytes = new ReadonlyBytes(Buffer.from(renderJsonContainer(desired), "utf8"));
  if (entry?.kind === "file" && entry.digest === bytes.digest()) return;
  const projectedMode = next
    .map((artifact) => projected.get(artifact.ownership_id)?.intent)
    .find((intent) => intent?.kind === "json-member");
  operations.push(
    Object.freeze({
      kind: "write-file",
      unitId,
      path,
      target,
      bytes,
      mode: entry?.kind === "file" ? entry.mode : projectedMode?.kind === "json-member" ? projectedMode.mode : 0o644,
      before:
        entry?.kind === "file"
          ? Object.freeze({ kind: "file", digest: entry.digest, mode: entry.mode })
          : Object.freeze({ kind: "absent" }),
    }),
  );
}

function jsonContainerDiagnostic(path: RelativePosixPath, evidence: readonly string[]): Diagnostic {
  return planningDiagnostic(
    "planning.json-member.container-invalid",
    path,
    evidence,
    `${path} is not a JSON object Railguard can update safely.`,
    "Fix the JSON file, then plan again.",
  );
}

async function planLocalEffects(
  request: DurableProjectPlanRequest,
  lockAfter: ReadyPortableLock | null,
  operations: TransactionOperation[],
  diagnostics: Diagnostic[],
  gitConfig: GitConfigPort,
): Promise<void> {
  const previous = request.lockBefore?.state.local_effects ?? [];
  const next = lockAfter?.state.local_effects ?? [];
  const ids = new Set([...previous, ...next].map((effect) => effect.effect_id));
  for (const id of [...ids].sort(compareUtf8)) {
    const oldEffect = previous.find((effect) => effect.effect_id === id);
    const newEffect = next.find((effect) => effect.effect_id === id);
    let current: GitConfigValue;
    try {
      current = await gitConfig.get(request.snapshot.realRoot, "core.hooksPath");
    } catch (error) {
      diagnostics.push(
        planningDiagnostic(
          "planning.git-config.unavailable",
          relativePosixPath(".git/config"),
          [errorMessage(error)],
          "Repository-local Git config could not be read.",
          "Railguard cannot establish a precondition for the local effect.",
        ),
      );
      continue;
    }
    if (newEffect !== undefined) {
      if (oldEffect === undefined && current.kind === "value") {
        diagnostics.push(
          planningDiagnostic(
            "planning.git-config.foreign",
            relativePosixPath(".git/config"),
            [current.value],
            "core.hooksPath already has a value without Railguard ownership.",
            "The existing local Git policy is preserved.",
          ),
        );
        continue;
      }
      if (
        oldEffect !== undefined &&
        current.kind === "value" &&
        current.value !== oldEffect.expected_value &&
        current.value !== newEffect.expected_value &&
        request.mode !== "repair"
      ) {
        diagnostics.push(
          gitConfigDriftDiagnostic(current.value, oldEffect.expected_value),
        );
        continue;
      }
      if (current.kind === "value" && current.value === newEffect.expected_value) continue;
      operations.push(
        Object.freeze({
          kind: "configure-git",
          unitId: id,
          path: relativePosixPath(".git/config"),
          key: "core.hooksPath",
          value: newEffect.expected_value,
          before: current,
        }),
      );
    } else if (
      oldEffect !== undefined &&
      current.kind === "value" &&
      current.value !== oldEffect.expected_value
    ) {
      diagnostics.push(gitConfigDriftDiagnostic(current.value, oldEffect.expected_value));
    } else if (oldEffect !== undefined && current.kind === "value") {
      operations.push(
        Object.freeze({
          kind: "configure-git",
          unitId: id,
          path: relativePosixPath(".git/config"),
          key: "core.hooksPath",
          value: null,
          before: current,
        }),
      );
    }
  }
}

function gitConfigDriftDiagnostic(current: string, expected: string): Diagnostic {
  return planningDiagnostic(
    "planning.git-config.drift",
    relativePosixPath(".git/config"),
    [current, expected],
    "The managed core.hooksPath value was changed outside Railguard.",
    "Removal or ordinary reconciliation would overwrite local Git policy.",
  );
}

function planStateFile(
  snapshot: RepositorySnapshot,
  path: RelativePosixPath,
  unitId: string,
  beforeBytes: ReadonlyBytes | null,
  afterBytes: ReadonlyBytes,
  operations: TransactionOperation[],
  diagnostics: Diagnostic[],
): void {
  const entry = snapshot.entries.find((candidate) => candidate.path === path);
  if (entry !== undefined && entry.kind !== "file") {
    diagnostics.push(unsafePathDiagnostic(path, entry.kind));
    return;
  }
  if (beforeBytes === null && entry !== undefined) {
    diagnostics.push(
      planningDiagnostic(
        "planning.project-state.foreign",
        path,
        [entry.digest],
        "A project state path exists without a validated durable state.",
        "Railguard will not overwrite unknown control data.",
      ),
    );
    return;
  }
  if (beforeBytes !== null && entry?.kind === "file" && entry.digest !== beforeBytes.digest()) {
    diagnostics.push(
      planningDiagnostic(
        "planning.project-state.changed",
        path,
        [entry.digest, beforeBytes.digest()],
        "Project state changed after it was loaded.",
        "Reload state and generate a new plan.",
      ),
    );
    return;
  }
  if (entry?.kind === "file" && entry.digest === afterBytes.digest() && entry.mode === 0o644) return;
  operations.push(
    Object.freeze({
      kind: "write-file",
      unitId,
      path,
      target: Object.freeze({ kind: "file", path }),
      bytes: afterBytes,
      mode: 0o644,
      before:
        entry?.kind === "file"
          ? Object.freeze({ kind: "file", digest: entry.digest, mode: entry.mode })
          : Object.freeze({ kind: "absent" }),
    }),
  );
}

function planStateFileRemoval(
  snapshot: RepositorySnapshot,
  path: RelativePosixPath,
  unitId: string,
  beforeBytes: ReadonlyBytes | null,
  operations: TransactionOperation[],
  diagnostics: Diagnostic[],
): void {
  const entry = snapshot.entries.find((candidate) => candidate.path === path);
  if (entry === undefined && beforeBytes === null) return;
  if (entry === undefined && beforeBytes !== null) {
    diagnostics.push(
      planningDiagnostic(
        "planning.project-state.missing",
        path,
        [beforeBytes.digest()],
        "A validated project state file is missing before full uninstall.",
        "Railguard cannot prove a complete control-state removal.",
      ),
    );
    return;
  }
  if (entry?.kind !== "file") {
    diagnostics.push(unsafePathDiagnostic(path, entry?.kind ?? "directory"));
    return;
  }
  if (beforeBytes === null || entry.digest !== beforeBytes.digest()) {
    diagnostics.push(
      planningDiagnostic(
        "planning.project-state.changed",
        path,
        [entry.digest, beforeBytes?.digest() ?? "unowned"],
        "Project state changed after it was loaded.",
        "Full uninstall will not remove unknown control data.",
      ),
    );
    return;
  }
  operations.push(
    Object.freeze({
      kind: "remove-file",
      unitId,
      path,
      target: Object.freeze({ kind: "file", path }),
      before: Object.freeze({ kind: "file", digest: entry.digest, mode: entry.mode }),
    }),
  );
}

function planManagedDirectories(
  snapshot: RepositorySnapshot,
  lockBefore: ReadyPortableLock | null,
  lockAfter: ReadyPortableLock | null,
  operations: TransactionOperation[],
  diagnostics: Diagnostic[],
): void {
  const entries = new Map(snapshot.entries.map((entry) => [entry.path, entry]));
  const previous = new Map(
    (lockBefore?.state.directories ?? []).map((directory) => [directory.path, directory]),
  );
  const next = new Map(
    (lockAfter?.state.directories ?? []).map((directory) => [directory.path, directory]),
  );
  const creates = [...next.values()]
    .filter((directory) => !entries.has(directory.path))
    .sort((left, right) => {
      const depth = left.path.split("/").length - right.path.split("/").length;
      return depth !== 0 ? depth : compareUtf8(left.path, right.path);
    })
    .map<TransactionOperation>((directory) =>
      Object.freeze({
        kind: "create-directory",
        unitId: directory.ownership_id,
        path: directory.path,
        mode: 0o755,
      }),
    );
  operations.unshift(...creates);

  const removedFiles = new Set(
    operations
      .filter((operation) => operation.kind === "remove-file" || operation.kind === "remove-symlink")
      .map((operation) => operation.path),
  );
  const removable = [...previous.values()]
    .filter((directory) => !next.has(directory.path))
    .sort((left, right) => {
      const depth = right.path.split("/").length - left.path.split("/").length;
      return depth !== 0 ? depth : compareUtf8(left.path, right.path);
    });
  const scheduledDirectories = new Set<RelativePosixPath>();
  for (const directory of removable) {
    const entry = entries.get(directory.path);
    if (entry === undefined) continue;
    if (entry.kind !== "directory") {
      diagnostics.push(unsafePathDiagnostic(directory.path, entry.kind));
      continue;
    }
    const foreign = snapshot.entries.filter((candidate) => {
      if (!candidate.path.startsWith(`${directory.path}/`)) return false;
      if ((candidate.kind === "file" || candidate.kind === "symlink") && removedFiles.has(candidate.path)) return false;
      if (candidate.kind === "directory" && scheduledDirectories.has(candidate.path)) return false;
      return true;
    });
    if (foreign.length > 0) {
      diagnostics.push(
        planningWarning(
          "planning.directory.not-empty",
          directory.path,
          foreign.map((candidate) => `${candidate.kind}:${candidate.path}`),
          "A previously created managed directory now contains retained entries.",
          "The directory itself will remain after its managed contents are removed.",
        ),
      );
      continue;
    }
    operations.push(
      Object.freeze({
        kind: "remove-directory",
        unitId: directory.ownership_id,
        path: directory.path,
        mode: entry.mode,
      }),
    );
    scheduledDirectories.add(directory.path);
  }
}

function compareOperations(left: TransactionOperation, right: TransactionOperation): number {
  const rank = (operation: TransactionOperation): number => {
    if (operation.kind === "create-directory") return 0;
    if (operation.kind === "write-file" || operation.kind === "remove-file" || operation.kind === "write-symlink" || operation.kind === "remove-symlink") {
      if (operation.path === desiredPath) return 2;
      if (operation.path === lockPath) return 3;
      return 1;
    }
    if (operation.kind === "configure-git") return 4;
    return 5;
  };
  const difference = rank(left) - rank(right);
  if (difference !== 0) return difference;
  if (left.kind === "create-directory" && right.kind === "create-directory") {
    const depth = left.path.split("/").length - right.path.split("/").length;
    if (depth !== 0) return depth;
  }
  if (left.kind === "remove-directory" && right.kind === "remove-directory") {
    const depth = right.path.split("/").length - left.path.split("/").length;
    if (depth !== 0) return depth;
  }
  return compareUtf8(`${left.path}\0${left.unitId}`, `${right.path}\0${right.unitId}`);
}

function operationIdentity(operation: TransactionOperation): unknown {
  if (operation.kind === "create-directory" || operation.kind === "remove-directory") {
    return { kind: operation.kind, unit_id: operation.unitId, path: operation.path, mode: operation.mode };
  }
  if (operation.kind === "configure-git") {
    return {
      kind: operation.kind,
      unit_id: operation.unitId,
      key: operation.key,
      value_digest: operation.value === null ? null : sha256(operation.value),
      before: operation.before.kind === "absent" ? null : sha256(operation.before.value),
    };
  }
  return {
    kind: operation.kind,
    unit_id: operation.unitId,
    path: operation.path,
    before: operation.before,
    after:
      operation.kind === "write-file"
        ? { digest: operation.bytes.digest(), mode: operation.mode }
        : operation.kind === "write-symlink"
          ? { target: operation.target }
        : null,
  };
}

function invalidMarkersDiagnostic(path: RelativePosixPath, evidence: readonly string[]): Diagnostic {
  return planningDiagnostic(
    "planning.managed-section.invalid",
    path,
    evidence,
    "Managed markers are duplicate, incomplete, malformed, nested, or misplaced.",
    "Railguard cannot identify a unique owned envelope.",
  );
}

function unsafePathDiagnostic(path: RelativePosixPath, kind: RepositoryEntry["kind"]): Diagnostic {
  return planningDiagnostic(
    "planning.path.unsafe",
    path,
    [kind],
    "A planned destination is not a regular file or directory of the expected kind.",
    "No mutation can safely target this path.",
  );
}

function planningDiagnostic(
  code: string,
  path: RelativePosixPath | null,
  evidence: readonly string[],
  message: string,
  impact: string,
): Diagnostic {
  return Object.freeze({
    code,
    severity: "blocked",
    phase: "planning",
    subjects: Object.freeze([]),
    location: path === null ? null : Object.freeze({ path }),
    message,
    evidence: Object.freeze([...evidence].sort(compareUtf8)),
    impact,
    action: "Resolve the reported collision or unsafe evidence, then generate a new plan.",
  });
}

function planningWarning(
  code: string,
  path: RelativePosixPath,
  evidence: readonly string[],
  message: string,
  impact: string,
): Diagnostic {
  return Object.freeze({
    code,
    severity: "warning",
    phase: "planning",
    subjects: Object.freeze([]),
    location: Object.freeze({ path }),
    message,
    evidence: Object.freeze([...evidence].sort(compareUtf8)),
    impact,
    action: "Remove retained entries manually if the empty managed directory should also disappear.",
  });
}

function hasBlockers(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some(
    (diagnostic) => diagnostic.severity === "blocked" || diagnostic.severity === "failed",
  );
}

function blocked(
  request: DurableProjectPlanRequest,
  diagnostics: readonly Diagnostic[],
): Extract<DurableProjectPlan, { readonly kind: "blocked" }> {
  const sorted = [...diagnostics].sort(compareDiagnostics);
  const first = sorted[0];
  if (first === undefined) throw new Error("A blocked plan requires a diagnostic");
  return Object.freeze({
    kind: "blocked",
    mode: request.mode,
    rootRealPath: request.snapshot.realRoot,
    snapshotFingerprint: request.snapshot.fingerprint,
    diagnostics: Object.freeze([first, ...sorted.slice(1)]) as readonly [
      Diagnostic,
      ...Diagnostic[],
    ],
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

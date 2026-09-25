import type { CatalogSnapshot } from "../catalog/model.js";
import type { ObservedProjectState, ObservedUnitStatus } from "../observation/model.js";
import type { RepositoryAssessmentResult } from "../repository/model.js";
import { projectProjectionTargetId } from "../projection/model.js";
import type { ResolutionResult } from "../resolution/model.js";
import {
  compareDiagnostics,
  compareUtf8,
  relativePosixPath,
  type ComponentRef,
  type Diagnostic,
  type Sha256Digest,
} from "../shared/types.js";
import type { DesiredState } from "../../project-state/desired-state.js";
import type { LockState } from "../../project-state/lock-state.js";

export type ManagementState = "uninitialized" | "managed" | "partial";
export type IntegrityState = "clean" | "drifted" | "unknown";
export type ReadinessState = "ready" | "blocked";
export type ReconciledUnitClassification =
  | "clean"
  | "missing"
  | "drifted"
  | "unknown"
  | "removal-pending"
  | "lock-stale";

export interface DurableDesiredState {
  readonly state: DesiredState;
  readonly digest: Sha256Digest;
}

export interface DurableLockState {
  readonly state: LockState;
  readonly digest: Sha256Digest;
}

export interface ReconciliationRequest {
  readonly desired: DurableDesiredState | null;
  readonly lock: DurableLockState | null;
  readonly observed: ObservedProjectState | null;
  readonly catalog: CatalogSnapshot;
  readonly assessment: RepositoryAssessmentResult;
  readonly resolution: ResolutionResult | null;
}

export interface ReconciledUnit {
  readonly ownershipId: string;
  readonly classification: ReconciledUnitClassification;
  readonly sources: readonly ComponentRef[];
}

export interface ReconciliationResult {
  readonly management: ManagementState;
  readonly integrity: IntegrityState;
  readonly updates: {
    readonly kind: "none" | "components" | "unknown";
    readonly components: readonly ComponentRef[];
  };
  readonly readiness: ReadinessState;
  readonly units: readonly ReconciledUnit[];
  readonly pendingComponents: readonly ComponentRef[];
  readonly orphanedComponents: readonly ComponentRef[];
  readonly orphanedUnits: readonly string[];
  readonly resolution: ResolutionResult | null;
  readonly diagnostics: readonly Diagnostic[];
}

export interface Reconciler {
  reconcile(request: ReconciliationRequest): ReconciliationResult;
}

export class DefaultReconciler implements Reconciler {
  public reconcile(request: ReconciliationRequest): ReconciliationResult {
    const diagnostics = [
      ...request.assessment.diagnostics,
      ...(request.observed?.diagnostics ?? []),
      ...(request.resolution?.diagnostics ?? []),
    ];
    const desiredRefs = resolvedRefs(request);
    const lockedRefs = new Set(request.lock?.state.components.map((component) => component.ref) ?? []);
    const pendingComponents = desiredRefs === null
      ? []
      : [...desiredRefs].filter((ref) => !lockedRefs.has(ref)).sort(compareUtf8);
    const orphanedComponents = desiredRefs === null
      ? request.desired === null
        ? [...lockedRefs].sort(compareUtf8)
        : []
      : [...lockedRefs].filter((ref) => !desiredRefs.has(ref)).sort(compareUtf8);

    const observedById = new Map(
      request.observed?.units.map((unit) => [unit.ownershipId, unit]) ?? [],
    );
    const units: ReconciledUnit[] = [];
    for (const managed of managedUnits(request.lock?.state ?? null)) {
      const observed = observedById.get(managed.ownershipId);
      let classification: ReconciledUnitClassification;
      if (observed === undefined) {
        classification = "unknown";
        diagnostics.push(
          reconciliationDiagnostic(
            "reconciliation.observation-missing",
            "A locked managed unit has no observed evidence.",
            [managed.ownershipId],
            managed.sources,
            "Run a complete repository scan before planning a change.",
          ),
        );
      } else if (desiredRefs === null && request.desired !== null) {
        classification = "unknown";
      } else {
        const stillDesired =
          desiredRefs !== null && managed.sources.some((source) => desiredRefs.has(source));
        classification = stillDesired
          ? installedClassification(observed.status)
          : removalClassification(observed.status);
      }
      units.push(
        Object.freeze({
          ownershipId: managed.ownershipId,
          classification,
          sources: Object.freeze([...managed.sources].sort(compareUtf8)),
        }),
      );
    }
    units.sort((left, right) => compareUtf8(left.ownershipId, right.ownershipId));

    if (
      request.observed !== null &&
      request.observed.snapshotFingerprint !== request.assessment.snapshotFingerprint
    ) {
      diagnostics.push(
        reconciliationDiagnostic(
          "reconciliation.snapshot-mismatch",
          "Observed ownership and repository assessment came from different snapshots.",
          [request.observed.snapshotFingerprint, request.assessment.snapshotFingerprint],
          [],
          "Scan the repository again before reviewing state.",
        ),
      );
    }
    const lockedIds = new Set(units.map((unit) => unit.ownershipId));
    for (const observed of request.observed?.units ?? []) {
      if (!lockedIds.has(observed.ownershipId)) {
        diagnostics.push(
          reconciliationDiagnostic(
            "reconciliation.observation-orphaned",
            "Observed evidence names a unit that is absent from the portable lock.",
            [observed.ownershipId],
            [],
            "Run a complete scan and regenerate observed state from the current lock.",
          ),
        );
      }
    }

    const management = managementState(request, desiredRefs, lockedRefs);
    const integrity = integrityState(request.lock, request.observed, units, diagnostics);
    const updates = componentUpdates(request.lock, request.catalog);
    const orphanedUnits = units
      .filter(
        (unit) =>
          unit.classification === "removal-pending" || unit.classification === "lock-stale",
      )
      .map((unit) => unit.ownershipId);
    diagnostics.sort(compareDiagnostics);
    const readiness =
      request.resolution?.kind === "blocked" ||
      integrity === "unknown" && request.lock !== null ||
      diagnostics.some(
        (diagnostic) => diagnostic.severity === "blocked" || diagnostic.severity === "failed",
      )
        ? "blocked"
        : "ready";

    return Object.freeze({
      management,
      integrity,
      updates,
      readiness,
      units: Object.freeze(units),
      pendingComponents: Object.freeze(pendingComponents),
      orphanedComponents: Object.freeze(orphanedComponents),
      orphanedUnits: Object.freeze(orphanedUnits),
      resolution: request.resolution,
      diagnostics: Object.freeze(diagnostics),
    });
  }
}

function resolvedRefs(request: ReconciliationRequest): ReadonlySet<ComponentRef> | null {
  if (request.desired === null) return new Set<ComponentRef>();
  if (request.resolution === null) return null;
  return new Set(request.resolution.components.map((component) => component.ref));
}

function managedUnits(lock: LockState | null): readonly {
  readonly ownershipId: string;
  readonly sources: readonly ComponentRef[];
}[] {
  if (lock === null) return [];
  return [
    ...lock.directories.map((directory) => ({
      ownershipId: directory.ownership_id,
      sources: directory.sources,
    })),
    ...lock.artifacts.map((artifact) => ({
      ownershipId: artifact.ownership_id,
      sources: artifact.sources,
    })),
    ...lock.local_effects.map((effect) => ({
      ownershipId: effect.effect_id,
      sources: effect.sources,
    })),
  ];
}

function installedClassification(status: ObservedUnitStatus): ReconciledUnitClassification {
  return status;
}

function removalClassification(status: ObservedUnitStatus): ReconciledUnitClassification {
  if (status === "unknown") return "unknown";
  return status === "missing" ? "lock-stale" : "removal-pending";
}

function managementState(
  request: ReconciliationRequest,
  desiredRefs: ReadonlySet<ComponentRef> | null,
  lockedRefs: ReadonlySet<ComponentRef>,
): ManagementState {
  if (request.desired === null && request.lock === null) return "uninitialized";
  if (request.desired === null || request.lock === null || desiredRefs === null) return "partial";
  if (request.lock.state.desired_digest !== request.desired.digest) return "partial";
  const desiredTargets = [...request.desired.state.targets].sort(compareUtf8);
  const lockedTargets = request.lock.state.targets
    .map((entry) => entry.id)
    .filter((target) => target !== projectProjectionTargetId)
    .sort(compareUtf8);
  if (!sameStrings(desiredTargets, lockedTargets)) return "partial";
  if (!sameStrings([...desiredRefs].sort(compareUtf8), [...lockedRefs].sort(compareUtf8))) {
    return "partial";
  }
  return "managed";
}

function integrityState(
  lock: DurableLockState | null,
  observed: ObservedProjectState | null,
  units: readonly ReconciledUnit[],
  diagnostics: readonly Diagnostic[],
): IntegrityState {
  if (lock === null || observed === null) return "unknown";
  if (
    units.some((unit) => unit.classification === "unknown") ||
    diagnostics.some((diagnostic) => diagnostic.phase === "observation")
  ) {
    return "unknown";
  }
  return units.some(
    (unit) => unit.classification === "missing" || unit.classification === "drifted",
  )
    ? "drifted"
    : "clean";
}

function componentUpdates(
  lock: DurableLockState | null,
  catalog: CatalogSnapshot,
): ReconciliationResult["updates"] {
  if (lock === null) return Object.freeze({ kind: "unknown", components: Object.freeze([]) });
  const current = new Map(catalog.components.map((component) => [component.ref, component]));
  const components = lock.state.components
    .filter((locked) => {
      const candidate = current.get(locked.ref);
      return (
        candidate === undefined ||
        candidate.version !== locked.version ||
        candidate.integrity.component !== locked.digest
      );
    })
    .map((component) => component.ref)
    .sort(compareUtf8);
  return Object.freeze({
    kind: components.length === 0 ? "none" : "components",
    components: Object.freeze(components),
  });
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function reconciliationDiagnostic(
  code: string,
  message: string,
  evidence: readonly string[],
  subjects: readonly ComponentRef[],
  action: string,
): Diagnostic {
  return Object.freeze({
    code,
    severity: "blocked",
    phase: "reconciliation",
    subjects: Object.freeze([...subjects].sort(compareUtf8)),
    location: Object.freeze({ path: relativePosixPath(".railguard/lock.json") }),
    message,
    evidence: Object.freeze([...evidence].sort(compareUtf8)),
    impact: "Railguard cannot claim a converged project state from inconsistent evidence.",
    action,
  });
}

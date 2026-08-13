import type { CatalogComponent } from "../catalog/model.js";
import type {
  RecommendationCandidate,
  RecommendationReason,
  RecommendationRequest,
  RecommendationSet,
} from "./model.js";
import {
  compareDiagnostics,
  compareUtf8,
  sortedUnique,
  type ComponentRef,
  type Diagnostic,
  type ProjectUnitId,
} from "../shared/types.js";

export function recommend(request: RecommendationRequest): RecommendationSet {
  const components = new Map(
    request.catalog.components.map((component) => [component.ref, component]),
  );
  const activeComponents = sortedUnique(request.activeComponents);
  const activeSet = new Set(activeComponents);
  const reasonsByComponent = new Map<ComponentRef, RecommendationReason[]>();
  const diagnostics: Diagnostic[] = [];

  for (const component of request.catalog.components) {
    if (component.kind !== "skill") {
      continue;
    }
    for (const language of component.applies?.languages ?? []) {
      const matchingUnits = sortedUnique<ProjectUnitId>(
        request.projectUnits
          .filter((unit) => unit.languages.includes(language))
          .map((unit) => unit.id),
      );
      if (matchingUnits.length > 0) {
        addReason(reasonsByComponent, component.ref, {
          kind: "language-match",
          language,
          matchingUnits,
        });
      }
    }
  }

  for (const from of activeComponents) {
    const source = components.get(from);
    if (source === undefined) {
      diagnostics.push(unknownActiveDiagnostic(from));
      continue;
    }
    for (const relation of source.relations) {
      if (relation.kind !== "recommends") {
        continue;
      }
      addReason(reasonsByComponent, relation.target, {
        kind: "catalog-recommends",
        from,
        reason: relation.reason,
      });
    }
  }

  const candidates = [...reasonsByComponent]
    .filter(([ref]) => !activeSet.has(ref))
    .map<RecommendationCandidate>(([ref, reasons]) => {
      const component = requireComponent(components, ref);
      return Object.freeze({
        ref,
        version: component.version,
        reasons: Object.freeze([...reasons].sort(compareReasons)),
      });
    })
    .sort((left, right) => compareUtf8(left.ref, right.ref));

  return Object.freeze({
    catalogDigest: request.catalog.digest,
    candidates: Object.freeze(candidates),
    diagnostics: Object.freeze(diagnostics.sort(compareDiagnostics)),
  });
}

function addReason(
  reasonsByComponent: Map<ComponentRef, RecommendationReason[]>,
  ref: ComponentRef,
  reason: RecommendationReason,
): void {
  const reasons = reasonsByComponent.get(ref) ?? [];
  const key = reasonKey(reason);
  if (!reasons.some((candidate) => reasonKey(candidate) === key)) {
    reasons.push(reason);
    reasonsByComponent.set(ref, reasons);
  }
}

function compareReasons(left: RecommendationReason, right: RecommendationReason): number {
  return compareUtf8(reasonKey(left), reasonKey(right));
}

function reasonKey(reason: RecommendationReason): string {
  return reason.kind === "language-match"
    ? `0\0${reason.language}\0${reason.matchingUnits.join("\0")}`
    : `1\0${reason.from}\0${reason.reason}`;
}

function requireComponent(
  components: ReadonlyMap<ComponentRef, CatalogComponent>,
  ref: ComponentRef,
): CatalogComponent {
  const component = components.get(ref);
  if (component === undefined) {
    throw new TypeError(`Catalog invariant violated by missing recommendation target: ${ref}`);
  }
  return component;
}

function unknownActiveDiagnostic(ref: ComponentRef): Diagnostic {
  return Object.freeze({
    code: "recommendation.active.unknown",
    severity: "warning",
    phase: "recommendation",
    subjects: Object.freeze([ref]),
    location: null,
    message: "An active component is absent from this catalog snapshot.",
    evidence: Object.freeze([ref]),
    impact: "Relations from that stale active component cannot produce recommendations.",
    action: "Resolve desired state against the current catalog before applying recommendations.",
  });
}

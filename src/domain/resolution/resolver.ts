import type {
  CatalogComponent,
  CatalogRelation,
  CatalogSnapshot,
} from "../catalog/model.js";
import { recommend } from "../recommendation/recommend.js";
import {
  compareDiagnostics,
  compareUtf8,
  sortedUnique,
  type ComponentRef,
  type Diagnostic,
} from "../shared/types.js";
import type {
  ApplicabilityEvidence,
  BlockedResolutionPreview,
  InclusionCause,
  ProjectUnitFact,
  ReadyResolution,
  RelationEvidence,
  ResolutionBlocker,
  ResolutionRequest,
  ResolutionResult,
  ResolvedAssociation,
  ResolvedComponent,
  ResolvedRecommendation,
  Resolver,
} from "./model.js";

const readyBrand = Symbol("ReadyResolution");

export class DefaultResolver implements Resolver {
  public resolve(request: ResolutionRequest): ResolutionResult {
    const byRef = new Map(
      request.catalog.components.map((component) => [component.ref, component]),
    );
    const directSelections = sortedUnique(request.directSelections);
    const knownDirectSelections = directSelections.filter((ref) => byRef.has(ref));
    const selectableDirectSelections = knownDirectSelections.filter(
      (ref) => requireComponent(byRef, ref).kind !== "instruction-fragment",
    );
    const closure = hardClosure(selectableDirectSelections, byRef);
    const orderedRefs = topologicalOrder(closure, byRef);
    const directSet = new Set(directSelections);
    const causes = inclusionCauses(closure, byRef);
    const projectUnits = canonicalProjectUnits(request.projectUnits);
    const components = orderedRefs.map<ResolvedComponent>((ref) => {
      const component = requireComponent(byRef, ref);
      return Object.freeze({
        ref,
        version: component.version,
        componentDigest: component.integrity.component,
        direct: directSet.has(ref),
        includedBy: Object.freeze([...(causes.get(ref) ?? [])]),
        applicability: applicability(component, projectUnits),
      });
    });

    const recommendations = resolvedRecommendations(
      request.catalog,
      closure,
      projectUnits,
      byRef,
    );
    const associations = resolvedAssociations(closure, byRef);
    const blockers: ResolutionBlocker[] = [
      ...directSelections
        .filter((ref) => !byRef.has(ref))
        .map<ResolutionBlocker>((component) =>
          Object.freeze({ kind: "unknown-selection", component }),
        ),
      ...knownDirectSelections
        .filter((ref) => requireComponent(byRef, ref).kind === "instruction-fragment")
        .map<ResolutionBlocker>((component) =>
          Object.freeze({ kind: "non-selectable-component", component }),
        ),
      ...conflictBlockers(closure, byRef),
      ...gateProfileBlockers(closure, byRef),
      ...capabilityBlockers(closure, byRef, request.targets),
    ];
    blockers.sort(compareBlockers);

    const diagnostics = [
      ...blockers.map(blockerDiagnostic),
      ...components
        .filter((component) => component.direct && component.applicability.kind === "unverified")
        .map(unverifiedDiagnostic),
    ].sort(compareDiagnostics);
    const view = {
      catalogDigest: request.catalog.digest,
      components: Object.freeze(components),
      recommendations: Object.freeze(recommendations),
      associations: Object.freeze(associations),
      diagnostics: Object.freeze(diagnostics),
    };

    if (blockers.length > 0) {
      return Object.freeze({
        kind: "blocked",
        ...view,
        blockers: Object.freeze(blockers) as readonly [
          ResolutionBlocker,
          ...ResolutionBlocker[],
        ],
      }) satisfies BlockedResolutionPreview;
    }

    return Object.freeze({
      kind: "ready",
      ...view,
      blockers: Object.freeze([]) as readonly [],
      readyBrand,
    }) satisfies ReadyResolution;
  }
}

function hardClosure(
  selections: readonly ComponentRef[],
  byRef: ReadonlyMap<ComponentRef, CatalogComponent>,
): ReadonlySet<ComponentRef> {
  const closure = new Set<ComponentRef>();
  const pending = [...selections].sort(compareUtf8).reverse();
  while (pending.length > 0) {
    const ref = pending.pop();
    if (ref === undefined || closure.has(ref)) {
      continue;
    }
    closure.add(ref);
    const component = requireComponent(byRef, ref);
    const dependencies = component.relations
      .filter(isHardRelation)
      .map((relation) => relation.target)
      .sort(compareUtf8)
      .reverse();
    for (const dependency of dependencies) {
      if (!byRef.has(dependency)) {
        throw new TypeError(`Catalog invariant violated by missing dependency: ${dependency}`);
      }
      pending.push(dependency);
    }
  }
  return closure;
}

function topologicalOrder(
  closure: ReadonlySet<ComponentRef>,
  byRef: ReadonlyMap<ComponentRef, CatalogComponent>,
): readonly ComponentRef[] {
  const dependencyCounts = new Map<ComponentRef, number>();
  const consumers = new Map<ComponentRef, ComponentRef[]>();
  for (const ref of closure) {
    const dependencies = requireComponent(byRef, ref).relations
      .filter(isHardRelation)
      .map((relation) => relation.target)
      .filter((target) => closure.has(target));
    dependencyCounts.set(ref, dependencies.length);
    for (const dependency of dependencies) {
      const values = consumers.get(dependency) ?? [];
      values.push(ref);
      consumers.set(dependency, values);
    }
  }

  const available = [...dependencyCounts]
    .filter(([, count]) => count === 0)
    .map(([ref]) => ref)
    .sort(compareUtf8);
  const ordered: ComponentRef[] = [];
  while (available.length > 0) {
    const ref = available.shift();
    if (ref === undefined) {
      break;
    }
    ordered.push(ref);
    for (const consumer of [...(consumers.get(ref) ?? [])].sort(compareUtf8)) {
      const next = (dependencyCounts.get(consumer) ?? 0) - 1;
      dependencyCounts.set(consumer, next);
      if (next === 0) {
        insertSorted(available, consumer);
      }
    }
  }
  if (ordered.length !== closure.size) {
    throw new TypeError("Catalog invariant violated by a hard dependency cycle");
  }
  return Object.freeze(ordered);
}

function inclusionCauses(
  closure: ReadonlySet<ComponentRef>,
  byRef: ReadonlyMap<ComponentRef, CatalogComponent>,
): ReadonlyMap<ComponentRef, readonly InclusionCause[]> {
  const causes = new Map<ComponentRef, InclusionCause[]>();
  for (const from of [...closure].sort(compareUtf8)) {
    for (const relation of requireComponent(byRef, from).relations.filter(isHardRelation)) {
      if (!closure.has(relation.target)) {
        continue;
      }
      const values = causes.get(relation.target) ?? [];
      values.push(Object.freeze({ kind: relation.kind, from, reason: relation.reason }));
      causes.set(relation.target, values);
    }
  }
  for (const [ref, values] of causes) {
    causes.set(ref, Object.freeze(values.sort(compareCauses)) as InclusionCause[]);
  }
  return causes;
}

function resolvedRecommendations(
  catalog: CatalogSnapshot,
  closure: ReadonlySet<ComponentRef>,
  projectUnits: readonly ProjectUnitFact[],
  byRef: ReadonlyMap<ComponentRef, CatalogComponent>,
): readonly ResolvedRecommendation[] {
  const set = recommend({
    catalog,
    projectUnits,
    activeComponents: [...closure],
  });
  return Object.freeze(
    set.candidates
      .map<ResolvedRecommendation | null>((candidate) => {
        const recommendedBy = candidate.reasons
          .filter(
            (reason): reason is Extract<typeof reason, { readonly kind: "catalog-recommends" }> =>
              reason.kind === "catalog-recommends",
          )
          .map<RelationEvidence<"recommends">>((reason) =>
            Object.freeze({
              kind: "recommends",
              from: reason.from,
              to: candidate.ref,
              reason: reason.reason,
            }),
          )
          .sort(compareRelationEvidence);
        if (recommendedBy.length === 0) {
          return null;
        }
        const component = requireComponent(byRef, candidate.ref);
        return Object.freeze({
          ref: candidate.ref,
          version: component.version,
          componentDigest: component.integrity.component,
          recommendedBy: Object.freeze(recommendedBy),
          applicability: applicability(component, projectUnits),
        });
      })
      .filter((candidate): candidate is ResolvedRecommendation => candidate !== null)
      .sort((left, right) => compareUtf8(left.ref, right.ref)),
  );
}

function resolvedAssociations(
  closure: ReadonlySet<ComponentRef>,
  byRef: ReadonlyMap<ComponentRef, CatalogComponent>,
): readonly ResolvedAssociation[] {
  const declarations = new Map<string, RelationEvidence<"composes">[]>();
  for (const from of [...closure].sort(compareUtf8)) {
    for (const relation of requireComponent(byRef, from).relations) {
      if (relation.kind !== "composes" || !closure.has(relation.target)) {
        continue;
      }
      const pair = normalizedPair(from, relation.target);
      const key = pair.join("\0");
      const values = declarations.get(key) ?? [];
      values.push(
        Object.freeze({
          kind: "composes",
          from,
          to: relation.target,
          reason: relation.reason,
        }),
      );
      declarations.set(key, values);
    }
  }
  return Object.freeze(
    [...declarations]
      .map<ResolvedAssociation>(([key, values]) => {
        const [left, right] = key.split("\0") as [ComponentRef, ComponentRef];
        return Object.freeze({
          pair: Object.freeze([left, right] as const),
          declaredBy: Object.freeze(values.sort(compareRelationEvidence)),
        });
      })
      .sort((left, right) => compareUtf8(left.pair.join("\0"), right.pair.join("\0"))),
  );
}

function conflictBlockers(
  closure: ReadonlySet<ComponentRef>,
  byRef: ReadonlyMap<ComponentRef, CatalogComponent>,
): readonly ResolutionBlocker[] {
  const declarations = new Map<string, RelationEvidence<"conflicts">[]>();
  for (const from of [...closure].sort(compareUtf8)) {
    for (const relation of requireComponent(byRef, from).relations) {
      if (relation.kind !== "conflicts" || !closure.has(relation.target)) {
        continue;
      }
      const pair = normalizedPair(from, relation.target);
      const key = pair.join("\0");
      const values = declarations.get(key) ?? [];
      values.push(
        Object.freeze({
          kind: "conflicts",
          from,
          to: relation.target,
          reason: relation.reason,
        }),
      );
      declarations.set(key, values);
    }
  }
  return Object.freeze(
    [...declarations]
      .map<ResolutionBlocker>(([key, values]) => {
        const [left, right] = key.split("\0") as [ComponentRef, ComponentRef];
        return Object.freeze({
          kind: "conflict",
          pair: Object.freeze([left, right] as const),
          declaredBy: Object.freeze(values.sort(compareRelationEvidence)),
        });
      })
      .sort(compareBlockers),
  );
}

function gateProfileBlockers(
  closure: ReadonlySet<ComponentRef>,
  byRef: ReadonlyMap<ComponentRef, CatalogComponent>,
): readonly ResolutionBlocker[] {
  const components = [...closure].map((ref) => requireComponent(byRef, ref));
  if (components.some((component) => component.kind === "verification-profile")) {
    return Object.freeze([]);
  }
  return Object.freeze(
    components
      .filter((component) => component.kind === "git-gate")
      .map<ResolutionBlocker>((component) =>
        Object.freeze({ kind: "git-gate-without-profile", component: component.ref }),
      )
      .sort(compareBlockers),
  );
}

function capabilityBlockers(
  closure: ReadonlySet<ComponentRef>,
  byRef: ReadonlyMap<ComponentRef, CatalogComponent>,
  targets: ResolutionRequest["targets"],
): readonly ResolutionBlocker[] {
  const blockers: ResolutionBlocker[] = [];
  const capabilitiesByTarget = new Map<
    ResolutionRequest["targets"][number]["target"],
    Set<ResolutionRequest["targets"][number]["capabilities"][number]>
  >();
  for (const target of targets) {
    const capabilities = capabilitiesByTarget.get(target.target) ?? new Set();
    for (const capability of target.capabilities) {
      capabilities.add(capability);
    }
    capabilitiesByTarget.set(target.target, capabilities);
  }
  const canonicalTargets = [...capabilitiesByTarget]
    .map(([target, capabilities]) => ({ target, capabilities }))
    .sort((left, right) => compareUtf8(left.target, right.target));
  for (const ref of [...closure].sort(compareUtf8)) {
    const component = requireComponent(byRef, ref);
    for (const target of canonicalTargets) {
      for (const capability of component.capabilities) {
        if (!target.capabilities.has(capability)) {
          blockers.push(
            Object.freeze({
              kind: "unsupported-capability",
              component: ref,
              target: target.target,
              capability,
            }),
          );
        }
      }
    }
  }
  return Object.freeze(blockers.sort(compareBlockers));
}

function applicability(
  component: CatalogComponent,
  projectUnits: readonly ProjectUnitFact[],
): ApplicabilityEvidence {
  if (component.applies === null) {
    return Object.freeze({ kind: "portable" });
  }
  const declaredLanguages = sortedUnique(component.applies.languages);
  const matchingUnits = sortedUnique(
    projectUnits
      .filter((unit) => unit.languages.some((language) => declaredLanguages.includes(language)))
      .map((unit) => unit.id),
  );
  if (matchingUnits.length > 0) {
    return Object.freeze({
      kind: "matched",
      declaredLanguages,
      matchingUnits,
    });
  }
  return Object.freeze({
    kind: "unverified",
    declaredLanguages,
    observedLanguages: sortedUnique(projectUnits.flatMap((unit) => unit.languages)),
  });
}

function canonicalProjectUnits(units: readonly ProjectUnitFact[]): readonly ProjectUnitFact[] {
  return Object.freeze(
    [...units]
      .map((unit) =>
        Object.freeze({
          id: unit.id,
          root: unit.root,
          languages: sortedUnique(unit.languages),
        }),
      )
      .sort((left, right) => compareUtf8(`${left.root}\0${left.id}`, `${right.root}\0${right.id}`)),
  );
}

function compareCauses(left: InclusionCause, right: InclusionCause): number {
  const leftKind = left.kind === "includes" ? "0" : "1";
  const rightKind = right.kind === "includes" ? "0" : "1";
  return compareUtf8(
    `${leftKind}\0${left.from}\0${left.reason}`,
    `${rightKind}\0${right.from}\0${right.reason}`,
  );
}

function compareRelationEvidence(
  left: RelationEvidence<"recommends" | "composes" | "conflicts">,
  right: RelationEvidence<"recommends" | "composes" | "conflicts">,
): number {
  return compareUtf8(
    `${left.from}\0${left.to}\0${left.reason}`,
    `${right.from}\0${right.to}\0${right.reason}`,
  );
}

function compareBlockers(left: ResolutionBlocker, right: ResolutionBlocker): number {
  return compareUtf8(blockerKey(left), blockerKey(right));
}

function blockerKey(blocker: ResolutionBlocker): string {
  switch (blocker.kind) {
    case "conflict":
      return `conflict\0${blocker.pair.join("\0")}`;
    case "unknown-selection":
      return `unknown-selection\0${blocker.component}`;
    case "non-selectable-component":
      return `non-selectable-component\0${blocker.component}`;
    case "git-gate-without-profile":
      return `git-gate-without-profile\0${blocker.component}`;
    case "unsupported-capability":
      return `unsupported-capability\0${blocker.component}\0${blocker.target}\0${blocker.capability}`;
  }
}

function blockerDiagnostic(blocker: ResolutionBlocker): Diagnostic {
  switch (blocker.kind) {
    case "unknown-selection":
      return diagnostic({
        code: "resolution.selection.unknown",
        subjects: [blocker.component],
        evidence: [blocker.component],
        message: "A direct selection is absent from the catalog snapshot.",
        impact: "The desired component set cannot be planned.",
        action: "Choose a component present in the current catalog.",
      });
    case "non-selectable-component":
      return diagnostic({
        code: "resolution.selection.non-selectable",
        subjects: [blocker.component],
        evidence: [blocker.component],
        message: "Managed instruction mappings are internal and cannot be selected directly.",
        impact: "The desired component set cannot be planned.",
        action: "Select a skill, MCP integration, agent, quality profile, Git gate, or pack.",
      });
    case "git-gate-without-profile":
      return diagnostic({
        code: "resolution.git-gate.profile-missing",
        subjects: [blocker.component],
        evidence: [blocker.component],
        message: "A Git gate runs the checks of the selected verification profiles, and none is selected.",
        impact: "The hook would run no check and pass every commit or push.",
        action: "Select at least one verification profile, or remove the Git gate.",
      });
    case "conflict":
      return diagnostic({
        code: "resolution.component.conflict",
        subjects: blocker.pair,
        evidence: blocker.declaredBy.map(
          (entry) => `${entry.from}->${entry.to}:${entry.reason}`,
        ),
        message: "The resolved closure contains conflicting components.",
        impact: "The desired component set cannot be planned safely.",
        action: "Remove one of the conflicting direct selections.",
      });
    case "unsupported-capability":
      return diagnostic({
        code: "resolution.capability.unsupported",
        subjects: [blocker.component],
        evidence: [blocker.target, blocker.capability],
        message: "A target does not provide a capability required by the resolved component.",
        impact: "The component cannot be projected to every desired target.",
        action: "Remove the target or select a compatible target adapter.",
      });
  }
}

function unverifiedDiagnostic(component: ResolvedComponent): Diagnostic {
  if (component.applicability.kind !== "unverified") {
    throw new TypeError("Expected an unverified resolved component");
  }
  return Object.freeze({
    code: "resolution.selection.applicability-unverified",
    severity: "info",
    phase: "resolution",
    subjects: Object.freeze([component.ref]),
    location: null,
    message: "No detected project unit matches this explicit selection.",
    evidence: Object.freeze([
      `declared:${component.applicability.declaredLanguages.join(",")}`,
      `observed:${component.applicability.observedLanguages.join(",")}`,
    ]),
    impact: "The selection remains valid but its language applicability is unverified.",
    action: "Review the selection before applying it.",
  });
}

function diagnostic(input: {
  readonly code: string;
  readonly subjects: readonly ComponentRef[];
  readonly evidence: readonly string[];
  readonly message: string;
  readonly impact: string;
  readonly action: string;
}): Diagnostic {
  return Object.freeze({
    code: input.code,
    severity: "blocked",
    phase: "resolution",
    subjects: Object.freeze([...input.subjects].sort(compareUtf8)),
    location: null,
    message: input.message,
    evidence: Object.freeze([...input.evidence].sort(compareUtf8)),
    impact: input.impact,
    action: input.action,
  });
}

function isHardRelation(
  relation: CatalogRelation,
): relation is CatalogRelation & { readonly kind: "includes" | "requires" } {
  return relation.kind === "includes" || relation.kind === "requires";
}

function normalizedPair(
  left: ComponentRef,
  right: ComponentRef,
): readonly [ComponentRef, ComponentRef] {
  return compareUtf8(left, right) <= 0
    ? Object.freeze([left, right])
    : Object.freeze([right, left]);
}

function requireComponent(
  byRef: ReadonlyMap<ComponentRef, CatalogComponent>,
  ref: ComponentRef,
): CatalogComponent {
  const component = byRef.get(ref);
  if (component === undefined) {
    throw new TypeError(`Catalog invariant violated by missing component: ${ref}`);
  }
  return component;
}

function insertSorted(values: ComponentRef[], value: ComponentRef): void {
  const index = values.findIndex((candidate) => compareUtf8(value, candidate) < 0);
  if (index === -1) {
    values.push(value);
    return;
  }
  values.splice(index, 0, value);
}

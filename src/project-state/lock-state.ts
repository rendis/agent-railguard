import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import projectStateSchema from "../../schemas/project-state.v1.schema.json" with {
  type: "json",
};
import type { CatalogSnapshot } from "../domain/catalog/model.js";
import {
  managedSectionDigest,
  type ManagedMarkerStyle,
  type ManagedSectionPlacement,
} from "../domain/managed-section/managed-section.js";
import type {
  ManagedArtifactOwnership,
  ManagedDirectoryOwnership,
  ManagedGitConfigOwnership,
} from "../domain/ownership/model.js";
import type { ReadyResolution } from "../domain/resolution/model.js";
import type { ManagedProjection } from "../domain/projection/model.js";
import {
  ReadonlyBytes,
  canonicalJson,
  compareDiagnostics,
  compareUtf8,
  relativePosixPath,
  sha256,
  type CapabilityId,
  type ComponentRef,
  type Diagnostic,
  type HarnessTargetId,
  type RelativePosixPath,
  type SemVer,
  type Sha256Digest,
} from "../domain/shared/types.js";
import { parseSafeJson } from "../shared/safe-json.js";

export interface LockTargetDraft {
  readonly id: HarnessTargetId;
  readonly adapter: { readonly id: HarnessTargetId; readonly version: SemVer };
  readonly capabilities: readonly CapabilityId[];
}

interface LockArtifactBaseDraft {
  readonly ownershipId: string;
  readonly target: HarnessTargetId;
  readonly adapter: HarnessTargetId;
  readonly path: RelativePosixPath;
  readonly sources: readonly ComponentRef[];
  readonly contentDigest: Sha256Digest;
}

export type LockArtifactDraft =
  | (LockArtifactBaseDraft & {
      readonly kind: "file";
      readonly portableMode: "regular" | "executable";
    })
  | (LockArtifactBaseDraft & {
      readonly kind: "managed-section";
      readonly sectionId: string;
      readonly placement: "whole-file" | "append";
      readonly markerStyle: ManagedMarkerStyle;
    })
  | (LockArtifactBaseDraft & {
      readonly kind: "symlink";
      readonly linkTarget: string;
    });

export interface LockLocalEffectDraft {
  readonly kind: "git-config";
  readonly effectId: string;
  readonly sources: readonly ComponentRef[];
  readonly key: "core.hooksPath";
  readonly expectedValue: string;
}

export interface LockDirectoryDraft {
  readonly ownershipId: string;
  readonly path: RelativePosixPath;
  readonly sources: readonly ComponentRef[];
}

export interface LockBuildInput {
  readonly desiredDigest: Sha256Digest;
  readonly catalog: CatalogSnapshot;
  readonly resolution: ReadyResolution;
  readonly targets: readonly LockTargetDraft[];
  readonly directories?: readonly LockDirectoryDraft[];
  readonly artifacts: readonly LockArtifactDraft[];
  readonly localEffects: readonly LockLocalEffectDraft[];
}

export interface ProjectionLockBuildInput {
  readonly desiredDigest: Sha256Digest;
  readonly catalog: CatalogSnapshot;
  readonly resolution: ReadyResolution;
  readonly projections: readonly ManagedProjection[];
  readonly managedSectionPlacements: ReadonlyMap<string, ManagedSectionPlacement>;
  readonly managedDirectories?: readonly LockDirectoryDraft[];
}

export interface LockDecodeContext {
  readonly desiredDigest: Sha256Digest;
  readonly catalog: CatalogSnapshot;
}

export type LockedArtifact = ManagedArtifactOwnership;
export type LockedDirectory = ManagedDirectoryOwnership;
export type LockedGitConfigEffect = ManagedGitConfigOwnership;

export interface LockState {
  readonly schema: "ai-harness/lock/v1";
  readonly desired_digest: Sha256Digest;
  readonly catalog: {
    readonly revision: SemVer;
    readonly digest: Sha256Digest;
  };
  readonly targets: readonly {
    readonly id: HarnessTargetId;
    readonly adapter: { readonly id: HarnessTargetId; readonly version: SemVer };
    readonly capabilities: readonly CapabilityId[];
  }[];
  readonly components: readonly {
    readonly ref: ComponentRef;
    readonly version: SemVer;
    readonly digest: Sha256Digest;
    readonly direct: boolean;
    readonly causes: readonly {
      readonly kind: "includes" | "requires";
      readonly from: ComponentRef;
      readonly reason: string;
    }[];
  }[];
  readonly directories: readonly LockedDirectory[];
  readonly artifacts: readonly LockedArtifact[];
  readonly local_effects: readonly LockedGitConfigEffect[];
}

export type LockStateResult =
  | {
      readonly kind: "ready";
      readonly state: LockState;
      readonly bytes: ReadonlyBytes;
      readonly digest: Sha256Digest;
      readonly diagnostics: readonly [];
    }
  | {
      readonly kind: "invalid";
      readonly diagnostics: readonly [Diagnostic, ...Diagnostic[]];
    };

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateLock = ajv.compile<LockState>(projectStateSchema);
const lockPath = relativePosixPath(".ai-harness/lock.json");

export class LockStateModule {
  public buildFromProjections(input: ProjectionLockBuildInput): LockStateResult {
    const missingPlacements = input.projections
      .flatMap((projection) => projection.units)
      .filter((unit) => unit.kind === "artifact" && unit.intent.kind === "managed-section")
      .filter((unit) => !input.managedSectionPlacements.has(unit.ownershipId));
    if (missingPlacements.length > 0) {
      return invalid(
        missingPlacements.map((unit) =>
          lockDiagnostic(
            "lock.managed-section-placement-missing",
            "Every projected managed section must declare its observed placement.",
            [unit.ownershipId],
            unit.sources,
          ),
        ),
      );
    }
    const targets: LockTargetDraft[] = input.projections.map((projection) =>
      Object.freeze({
        id: projection.identity.target,
        adapter: projection.identity.adapter,
        capabilities: projection.identity.capabilities,
      }),
    );
    const artifacts: LockArtifactDraft[] = [];
    const localEffects: LockLocalEffectDraft[] = [];
    for (const projection of input.projections) {
      for (const unit of projection.units) {
        if (unit.kind === "local-effect") {
          localEffects.push(
            Object.freeze({
              kind: "git-config",
              effectId: unit.ownershipId,
              sources: unit.sources,
              key: unit.intent.key,
              expectedValue: unit.intent.value,
            }),
          );
          continue;
        }
        const common = {
          ownershipId: unit.ownershipId,
          target: projection.identity.target,
          adapter: projection.identity.adapter.id,
          path: unit.intent.path,
          sources: unit.sources,
        };
        if (unit.intent.kind === "file") {
          artifacts.push(
            Object.freeze({
              ...common,
              kind: "file",
              contentDigest: unit.intent.bytes.digest(),
              portableMode: (unit.intent.mode & 0o111) === 0 ? "regular" : "executable",
            }),
          );
        } else if (unit.intent.kind === "symlink") {
          artifacts.push(
            Object.freeze({
              ...common,
              kind: "symlink",
              contentDigest: sha256(unit.intent.target),
              linkTarget: unit.intent.target,
            }),
          );
        } else {
          const placement = input.managedSectionPlacements.get(unit.ownershipId)!;
          artifacts.push(
            Object.freeze({
              ...common,
              kind: "managed-section",
              sectionId: unit.intent.sectionId,
              placement,
              markerStyle: unit.intent.markerStyle ?? "markdown",
              contentDigest: managedSectionDigest(
                unit.intent.sectionId,
                unit.intent.body,
                unit.intent.markerStyle ?? "markdown",
                placement,
              ),
            }),
          );
        }
      }
    }
    return this.build({
      desiredDigest: input.desiredDigest,
      catalog: input.catalog,
      resolution: input.resolution,
      targets,
      directories: input.managedDirectories ?? [],
      artifacts,
      localEffects,
    });
  }

  public build(input: LockBuildInput): LockStateResult {
    const diagnostics = validateSemantics(input);
    if (diagnostics.length > 0) return invalid(diagnostics);

    const state: LockState = Object.freeze({
      schema: "ai-harness/lock/v1",
      desired_digest: input.desiredDigest,
      catalog: Object.freeze({
        revision: input.catalog.revision,
        digest: input.catalog.digest,
      }),
      targets: Object.freeze(normalizeTargets(input.targets)),
      components: Object.freeze(normalizeComponents(input.resolution)),
      directories: Object.freeze(normalizeDirectories(input.directories ?? [])),
      artifacts: Object.freeze(normalizeArtifacts(input.artifacts)),
      local_effects: Object.freeze(normalizeEffects(input.localEffects)),
    });
    if (!validateLock(state)) return invalid([schemaDiagnostic(validateLock.errors)]);

    return ready(state);
  }

  public decode(source: string, context: LockDecodeContext): LockStateResult {
    const parsed = parseSafeJson(source);
    if (parsed.kind === "invalid") {
      return invalid([
        lockDiagnostic("lock.json-invalid", "The portable lock is not valid JSON.", parsed.errors),
      ]);
    }
    if (!validateLock(parsed.value) || parsed.value.schema !== "ai-harness/lock/v1") {
      return invalid([schemaDiagnostic(validateLock.errors)]);
    }
    const state = deepFreeze(parsed.value as LockState);
    const diagnostics: Diagnostic[] = [];
    if (
      state.catalog.revision === context.catalog.revision &&
      state.catalog.digest === context.catalog.digest
    ) {
      const byRef = new Map(context.catalog.components.map((component) => [component.ref, component]));
      for (const component of state.components) {
        const expected = byRef.get(component.ref);
        if (
          expected === undefined ||
          expected.version !== component.version ||
          expected.integrity.component !== component.digest
        ) {
          diagnostics.push(
            lockDiagnostic(
              "lock.component-catalog-mismatch",
              `Locked component ${component.ref} does not match its exact catalog snapshot.`,
              [component.version, component.digest],
              [component.ref],
            ),
          );
        }
      }
    }
    diagnostics.push(...validateDecodedOwnership(state));
    const canonicalSource = `${JSON.stringify(state, null, 2)}\n`;
    if (source !== canonicalSource) {
      diagnostics.push(
        lockDiagnostic(
          "lock.non-canonical",
          "The generated lock was edited or serialized non-canonically.",
          [sha256(source), sha256(canonicalSource)],
        ),
      );
    }
    return diagnostics.length === 0 ? ready(state) : invalid(diagnostics);
  }
}

function validateDecodedOwnership(state: LockState): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const components = new Set(state.components.map((component) => component.ref));
  const targets = new Map(state.targets.map((target) => [target.id, target]));
  collectDuplicates(
    state.directories.map((directory) => directory.ownership_id),
    "lock.directory-ownership-duplicate",
    "A directory ownership ID appears more than once.",
    diagnostics,
  );
  collectDuplicates(
    state.directories.map((directory) => directory.path),
    "lock.directory-path-duplicate",
    "A managed directory path appears more than once.",
    diagnostics,
  );
  collectDuplicates(
    state.targets.map((target) => target.id),
    "lock.target-duplicate",
    "A target appears more than once.",
    diagnostics,
  );
  collectDuplicates(
    state.components.map((component) => component.ref),
    "lock.component-duplicate",
    "A component appears more than once.",
    diagnostics,
  );
  collectDuplicates(
    state.artifacts.map((artifact) => artifact.ownership_id),
    "lock.ownership-duplicate",
    "An artifact ownership ID appears more than once.",
    diagnostics,
  );
  collectDuplicates(
    state.local_effects.map((effect) => effect.effect_id),
    "lock.effect-duplicate",
    "A local effect ID appears more than once.",
    diagnostics,
  );
  collectDuplicates(
    state.local_effects.map((effect) => effect.key),
    "lock.effect-key-duplicate",
    "A local configuration key is governed by more than one effect.",
    diagnostics,
  );
  for (const artifact of state.artifacts) {
    const target = targets.get(artifact.target);
    if (target === undefined || target.adapter.id !== artifact.adapter) {
      diagnostics.push(
        lockDiagnostic(
          "lock.artifact-target-invalid",
          "Every artifact must name a locked projection target and its exact adapter.",
          [artifact.target, artifact.adapter],
          artifact.sources,
        ),
      );
    }
  }
  for (const directory of state.directories) {
    const unknown = directory.sources.filter((source) => !components.has(source));
    if (unknown.length > 0) {
      diagnostics.push(
        lockDiagnostic(
          "lock.source-invalid",
          "Managed directory sources must name locked components when present.",
          unknown,
          unknown,
        ),
      );
    }
  }
  for (const unit of [...state.artifacts, ...state.local_effects]) {
    const unknown = unit.sources.filter((source) => !components.has(source));
    if (unit.sources.length === 0 || unknown.length > 0) {
      diagnostics.push(
        lockDiagnostic(
          "lock.source-invalid",
          "Every managed unit must name one or more locked component sources.",
          unit.sources.length === 0 ? ["sources:empty"] : unknown,
          unknown,
        ),
      );
    }
  }
  return diagnostics;
}

function ready(state: LockState): Extract<LockStateResult, { readonly kind: "ready" }> {
  const bytes = new ReadonlyBytes(Buffer.from(`${JSON.stringify(state, null, 2)}\n`, "utf8"));
  return Object.freeze({
    kind: "ready",
    state,
    bytes,
    digest: sha256(canonicalJson(state)),
    diagnostics: Object.freeze([]) as readonly [],
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function validateSemantics(input: LockBuildInput): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (input.resolution.catalogDigest !== input.catalog.digest) {
    diagnostics.push(
      lockDiagnostic(
        "lock.catalog-mismatch",
        "The resolution was produced from a different catalog snapshot.",
        [input.resolution.catalogDigest, input.catalog.digest],
      ),
    );
  }
  const catalogComponents = new Map(
    input.catalog.components.map((component) => [component.ref, component]),
  );
  const resolvedRefs = new Set<ComponentRef>();
  for (const component of input.resolution.components) {
    if (resolvedRefs.has(component.ref)) {
      diagnostics.push(
        lockDiagnostic(
          "lock.component-duplicate",
          `Resolved component ${component.ref} appears more than once.`,
          [component.ref],
          [component.ref],
        ),
      );
    }
    resolvedRefs.add(component.ref);
    const catalogComponent = catalogComponents.get(component.ref);
    if (
      catalogComponent === undefined ||
      catalogComponent.version !== component.version ||
      catalogComponent.integrity.component !== component.componentDigest
    ) {
      diagnostics.push(
        lockDiagnostic(
          "lock.component-catalog-mismatch",
          `Resolved component ${component.ref} does not match the catalog.`,
          [component.version, component.componentDigest],
          [component.ref],
        ),
      );
    }
  }
  collectDuplicates(
    (input.directories ?? []).map((directory) => directory.ownershipId),
    "lock.directory-ownership-duplicate",
    "A directory ownership ID appears more than once.",
    diagnostics,
  );
  collectDuplicates(
    (input.directories ?? []).map((directory) => directory.path),
    "lock.directory-path-duplicate",
    "A managed directory path appears more than once.",
    diagnostics,
  );
  collectDuplicates(
    input.targets.map((target) => target.id),
    "lock.target-duplicate",
    "A target appears more than once.",
    diagnostics,
  );
  collectDuplicates(
    input.artifacts.map((artifact) => artifact.ownershipId),
    "lock.ownership-duplicate",
    "An artifact ownership ID appears more than once.",
    diagnostics,
  );
  collectDuplicates(
    input.localEffects.map((effect) => effect.effectId),
    "lock.effect-duplicate",
    "A local effect ID appears more than once.",
    diagnostics,
  );
  collectDuplicates(
    input.localEffects.map((effect) => effect.key),
    "lock.effect-key-duplicate",
    "A local configuration key is governed by more than one effect.",
    diagnostics,
  );
  const targetsById = new Map(input.targets.map((target) => [target.id, target]));
  for (const artifact of input.artifacts) {
    const target = targetsById.get(artifact.target);
    if (target === undefined || target.adapter.id !== artifact.adapter) {
      diagnostics.push(
        lockDiagnostic(
          "lock.artifact-target-invalid",
          "Every artifact must name a locked projection target and its exact adapter.",
          [artifact.target, artifact.adapter],
          artifact.sources,
        ),
      );
    }
  }
  for (const directory of input.directories ?? []) {
    const unknown = directory.sources.filter((source) => !resolvedRefs.has(source));
    if (unknown.length > 0) {
      diagnostics.push(
        lockDiagnostic(
          "lock.source-invalid",
          "Managed directory sources must name resolved components when present.",
          unknown,
          unknown,
        ),
      );
    }
  }
  for (const unit of [...input.artifacts, ...input.localEffects]) {
    const unknown = unit.sources.filter((source) => !resolvedRefs.has(source));
    if (unit.sources.length === 0 || unknown.length > 0) {
      diagnostics.push(
        lockDiagnostic(
          "lock.source-invalid",
          "Every managed unit must name one or more resolved component sources.",
          unit.sources.length === 0 ? ["sources:empty"] : unknown,
          unknown,
        ),
      );
    }
  }
  return diagnostics;
}

function normalizeDirectories(
  directories: readonly LockDirectoryDraft[],
): readonly LockedDirectory[] {
  return [...directories]
    .sort((left, right) => compareUtf8(left.path, right.path))
    .map((directory) =>
      Object.freeze({
        ownership_id: directory.ownershipId,
        path: directory.path,
        sources: Object.freeze([...directory.sources].sort(compareUtf8)),
      }),
    );
}

function normalizeTargets(targets: readonly LockTargetDraft[]): LockState["targets"] {
  return [...targets]
    .sort((left, right) => compareUtf8(left.id, right.id))
    .map((target) =>
      Object.freeze({
        id: target.id,
        adapter: Object.freeze({ id: target.adapter.id, version: target.adapter.version }),
        capabilities: Object.freeze([...target.capabilities].sort(compareUtf8)),
      }),
    );
}

function normalizeComponents(resolution: ReadyResolution): LockState["components"] {
  return [...resolution.components]
    .sort((left, right) => compareUtf8(left.ref, right.ref))
    .map((component) =>
      Object.freeze({
        ref: component.ref,
        version: component.version,
        digest: component.componentDigest,
        direct: component.direct,
        causes: Object.freeze(
          [...component.includedBy]
            .sort((left, right) =>
              compareUtf8(
                `${left.kind}\0${left.from}\0${left.reason}`,
                `${right.kind}\0${right.from}\0${right.reason}`,
              ),
            )
            .map((cause) => Object.freeze({ ...cause })),
        ),
      }),
    );
}

function normalizeArtifacts(
  artifacts: readonly LockArtifactDraft[],
): readonly LockedArtifact[] {
  return [...artifacts]
    .sort((left, right) =>
      compareUtf8(
        `${left.path}\0${left.kind}\0${left.ownershipId}`,
        `${right.path}\0${right.kind}\0${right.ownershipId}`,
      ),
    )
    .map((artifact) => {
      const common = {
        ownership_id: artifact.ownershipId,
        target: artifact.target,
        adapter: artifact.adapter,
        path: artifact.path,
        sources: Object.freeze([...artifact.sources].sort(compareUtf8)),
        content_digest: artifact.contentDigest,
      };
      return artifact.kind === "file"
        ? Object.freeze({ ...common, kind: "file" as const, portable_mode: artifact.portableMode })
        : artifact.kind === "symlink"
          ? Object.freeze({ ...common, kind: "symlink" as const, link_target: artifact.linkTarget })
          : Object.freeze({
            ...common,
            kind: "managed-section" as const,
            section_id: artifact.sectionId,
            placement: artifact.placement,
            marker_style: artifact.markerStyle,
          });
    });
}

function normalizeEffects(
  effects: readonly LockLocalEffectDraft[],
): readonly LockedGitConfigEffect[] {
  return [...effects]
    .sort((left, right) => compareUtf8(left.effectId, right.effectId))
    .map((effect) =>
      Object.freeze({
        kind: effect.kind,
        effect_id: effect.effectId,
        sources: Object.freeze([...effect.sources].sort(compareUtf8)),
        key: effect.key,
        expected_value: effect.expectedValue,
      }),
    );
}

function collectDuplicates(
  values: readonly string[],
  code: string,
  message: string,
  diagnostics: Diagnostic[],
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) diagnostics.push(lockDiagnostic(code, message, [value]));
    seen.add(value);
  }
}

function schemaDiagnostic(errors: readonly ErrorObject[] | null | undefined): Diagnostic {
  return lockDiagnostic(
    "lock.schema-invalid",
    "The portable lock does not satisfy ai-harness/lock/v1.",
    (errors ?? []).map(
      (error) => `${error.instancePath || "/"}:${error.keyword}:${error.message ?? "invalid"}`,
    ),
  );
}

function lockDiagnostic(
  code: string,
  message: string,
  evidence: readonly string[],
  subjects: readonly ComponentRef[] = [],
): Diagnostic {
  return Object.freeze({
    code,
    severity: "failed",
    phase: "project-state",
    subjects: Object.freeze([...subjects]),
    location: Object.freeze({ path: lockPath }),
    message,
    evidence: Object.freeze([...evidence].sort(compareUtf8)),
    impact: "The portable lock cannot be used for reconciliation.",
    action: "Regenerate the lock from a valid desired state and catalog snapshot.",
  });
}

function invalid(diagnostics: readonly Diagnostic[]): LockStateResult & { readonly kind: "invalid" } {
  const sorted = [...diagnostics].sort(compareDiagnostics);
  const first = sorted[0];
  if (first === undefined) throw new Error("Invalid lock state requires a diagnostic");
  return Object.freeze({
    kind: "invalid",
    diagnostics: Object.freeze([first, ...sorted.slice(1)]) as readonly [
      Diagnostic,
      ...Diagnostic[],
    ],
  });
}

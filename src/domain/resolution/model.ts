import type { CatalogSnapshot } from "../catalog/model.js";
import type {
  CapabilityId,
  ComponentRef,
  Diagnostic,
  HarnessTargetId,
  LanguageId,
  ProjectUnitId,
  RelativePosixPath,
  SemVer,
  Sha256Digest,
} from "../shared/types.js";

export interface ProjectUnitFact {
  readonly id: ProjectUnitId;
  readonly root: RelativePosixPath;
  readonly languages: readonly LanguageId[];
}

export interface TargetCapabilities {
  readonly target: HarnessTargetId;
  readonly capabilities: readonly CapabilityId[];
}

export interface ResolutionRequest {
  readonly catalog: CatalogSnapshot;
  readonly directSelections: readonly ComponentRef[];
  readonly projectUnits: readonly ProjectUnitFact[];
  readonly targets: readonly TargetCapabilities[];
}

export interface InclusionCause {
  readonly kind: "includes" | "requires";
  readonly from: ComponentRef;
  readonly reason: string;
}

export type ApplicabilityEvidence =
  | { readonly kind: "portable" }
  | {
      readonly kind: "matched";
      readonly declaredLanguages: readonly LanguageId[];
      readonly matchingUnits: readonly ProjectUnitId[];
    }
  | {
      readonly kind: "unverified";
      readonly declaredLanguages: readonly LanguageId[];
      readonly observedLanguages: readonly LanguageId[];
    };

export interface ResolvedComponent {
  readonly ref: ComponentRef;
  readonly version: SemVer;
  readonly componentDigest: Sha256Digest;
  readonly direct: boolean;
  readonly includedBy: readonly InclusionCause[];
  readonly applicability: ApplicabilityEvidence;
}

export interface RelationEvidence<Kind extends "recommends" | "composes" | "conflicts"> {
  readonly kind: Kind;
  readonly from: ComponentRef;
  readonly to: ComponentRef;
  readonly reason: string;
}

export interface ResolvedRecommendation {
  readonly ref: ComponentRef;
  readonly version: SemVer;
  readonly componentDigest: Sha256Digest;
  readonly recommendedBy: readonly RelationEvidence<"recommends">[];
  readonly applicability: ApplicabilityEvidence;
}

export interface ResolvedAssociation {
  readonly pair: readonly [ComponentRef, ComponentRef];
  readonly declaredBy: readonly RelationEvidence<"composes">[];
}

export type ResolutionBlocker =
  | { readonly kind: "unknown-selection"; readonly component: ComponentRef }
  | { readonly kind: "non-selectable-component"; readonly component: ComponentRef }
  | { readonly kind: "git-gate-without-profile"; readonly component: ComponentRef }
  | {
      readonly kind: "conflict";
      readonly pair: readonly [ComponentRef, ComponentRef];
      readonly declaredBy: readonly RelationEvidence<"conflicts">[];
    }
  | {
      readonly kind: "unsupported-capability";
      readonly component: ComponentRef;
      readonly target: HarnessTargetId;
      readonly capability: CapabilityId;
    };

interface ResolutionView {
  readonly catalogDigest: Sha256Digest;
  readonly components: readonly ResolvedComponent[];
  readonly recommendations: readonly ResolvedRecommendation[];
  readonly associations: readonly ResolvedAssociation[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface ReadyResolution extends ResolutionView {
  readonly kind: "ready";
  readonly blockers: readonly [];
  readonly readyBrand: symbol;
}

export interface BlockedResolutionPreview extends ResolutionView {
  readonly kind: "blocked";
  readonly blockers: readonly [ResolutionBlocker, ...ResolutionBlocker[]];
}

export type ResolutionResult = ReadyResolution | BlockedResolutionPreview;

export interface Resolver {
  resolve(request: ResolutionRequest): ResolutionResult;
}

import type { CatalogSnapshot } from "../catalog/model.js";
import type { ProjectUnit } from "../repository/model.js";
import type {
  ComponentRef,
  Diagnostic,
  LanguageId,
  ProjectUnitId,
  SemVer,
  Sha256Digest,
} from "../shared/types.js";

export type RecommendationReason =
  | {
      readonly kind: "language-match";
      readonly language: LanguageId;
      readonly matchingUnits: readonly ProjectUnitId[];
    }
  | {
      readonly kind: "catalog-recommends";
      readonly from: ComponentRef;
      readonly reason: string;
    };

export interface RecommendationCandidate {
  readonly ref: ComponentRef;
  readonly version: SemVer;
  readonly reasons: readonly RecommendationReason[];
}

export interface RecommendationRequest {
  readonly catalog: CatalogSnapshot;
  readonly projectUnits: readonly Pick<ProjectUnit, "id" | "root" | "languages">[];
  readonly activeComponents: readonly ComponentRef[];
}

export interface RecommendationSet {
  readonly catalogDigest: Sha256Digest;
  readonly candidates: readonly RecommendationCandidate[];
  readonly diagnostics: readonly Diagnostic[];
}

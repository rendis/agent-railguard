import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import planSchema from "../../../schemas/plan.v1.schema.json" with { type: "json" };
import type { AiHarnessCases, InstallPreparation } from "../model.js";
import type { CatalogSnapshot } from "../../domain/catalog/model.js";
import { buildReviewModel, type ReviewModel } from "../../domain/review/review-model.js";
import type { ReadyResolution } from "../../domain/resolution/model.js";
import {
  compareUtf8,
  type ComponentRef,
  type Diagnostic,
  type HarnessTargetId,
  type Sha256Digest,
} from "../../domain/shared/types.js";
import type {
  DurableProjectPlan,
  ReadyDesiredState,
} from "../../domain/transaction/model.js";

const maximumPublicPlanBytes = 1024 * 1024;
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validatePublicPlan = ajv.compile<PublicPlan>(planSchema);

export interface PublicPlanBasis {
  readonly repository_fingerprint: Sha256Digest;
  readonly catalog_digest: Sha256Digest;
  readonly desired_before_digest: Sha256Digest | null;
  readonly desired_after_digest: Sha256Digest | null;
  readonly lock_before_digest: Sha256Digest | null;
  readonly lock_after_digest: Sha256Digest | null;
}

export interface PublicDesiredState {
  readonly schema: "ai-harness/project/v1";
  readonly targets: readonly HarnessTargetId[];
  readonly selections: readonly {
    readonly ref: ComponentRef;
    readonly inputs: Readonly<Record<string, readonly string[]>>;
  }[];
}

export interface PublicReviewModel {
  readonly plan_id: Sha256Digest;
  readonly mode: ReviewModel["mode"];
  readonly direct: ReviewModel["direct"];
  readonly required: ReviewModel["required"];
  readonly changes: ReviewModel["changes"];
  readonly git_config: ReviewModel["gitConfig"];
  readonly hooks: ReviewModel["hooks"];
  readonly runtimes: ReviewModel["runtimes"];
  readonly prerequisites: ReviewModel["prerequisites"];
  readonly apply_executes: ReviewModel["applyExecutes"];
}

export interface PublicPlan {
  readonly schema: "ai-harness/plan/v1";
  readonly plan_id: Sha256Digest;
  readonly mode: "reconcile" | "repair" | "remove";
  readonly basis: PublicPlanBasis;
  readonly desired_after: PublicDesiredState | null;
  readonly review: PublicReviewModel;
}

export type PublicPlanReplayResult =
  | {
      readonly kind: "ready";
      readonly scan: Extract<Awaited<ReturnType<AiHarnessCases["scan"]>>, { readonly kind: "ready" }>;
      readonly preparation: InstallPreparation;
      readonly plan: Extract<DurableProjectPlan, { readonly kind: "ready" }>;
      readonly diagnostics: readonly Diagnostic[];
    }
  | {
      readonly kind: "stale";
      readonly scan: Awaited<ReturnType<AiHarnessCases["scan"]>>;
      readonly diagnostics: readonly [Diagnostic, ...Diagnostic[]];
    };

export class PublicPlanValidationError extends TypeError {
  public constructor(readonly issues: readonly string[]) {
    super(`Public plan failed schema validation: ${issues.join("; ")}`);
    this.name = "PublicPlanValidationError";
  }
}

export function exportPublicPlan(input: {
  readonly catalog: CatalogSnapshot;
  readonly resolution: ReadyResolution;
  readonly plan: Extract<DurableProjectPlan, { readonly kind: "ready" }>;
}): PublicPlan {
  const review = buildReviewModel(input);
  const value: PublicPlan = {
    schema: "ai-harness/plan/v1",
    plan_id: input.plan.id,
    mode: input.plan.mode,
    basis: {
      repository_fingerprint: input.plan.snapshotFingerprint,
      catalog_digest: input.catalog.digest,
      desired_before_digest: input.plan.desiredBefore?.digest ?? null,
      desired_after_digest: input.plan.desiredAfter?.digest ?? null,
      lock_before_digest: input.plan.lockBefore?.digest ?? null,
      lock_after_digest: input.plan.lockAfter?.digest ?? null,
    },
    desired_after:
      input.plan.desiredAfter === null
        ? null
        : publicDesiredState(input.plan.desiredAfter),
    review: {
      plan_id: review.planId,
      mode: review.mode,
      direct: review.direct,
      required: review.required,
      changes: review.changes,
      git_config: review.gitConfig,
      hooks: review.hooks,
      runtimes: review.runtimes,
      prerequisites: review.prerequisites,
      apply_executes: review.applyExecutes,
    },
  };
  assertValidPublicPlan(value);
  return deepFreeze(value);
}

export function decodePublicPlan(source: string | unknown): PublicPlan {
  let value: unknown = source;
  if (typeof source === "string") {
    if (Buffer.byteLength(source, "utf8") > maximumPublicPlanBytes) {
      throw new PublicPlanValidationError([
        `document exceeds ${maximumPublicPlanBytes} UTF-8 bytes`,
      ]);
    }
    try {
      value = JSON.parse(source) as unknown;
    } catch (error) {
      throw new PublicPlanValidationError([
        error instanceof Error ? error.message : String(error),
      ]);
    }
  }
  assertValidPublicPlan(value);
  return deepFreeze(value);
}

export function encodePublicPlan(plan: PublicPlan): string {
  assertValidPublicPlan(plan);
  return `${JSON.stringify(plan, null, 2)}\n`;
}

export async function rehydratePublicPlan(
  application: AiHarnessCases,
  root: string,
  publicPlan: PublicPlan,
): Promise<PublicPlanReplayResult> {
  assertValidPublicPlan(publicPlan);
  const scan = await application.scan(root);
  if (scan.kind !== "ready") {
    return stale(scan, [
      ...scan.diagnostics,
      planImportDiagnostic(
        "plan-import.repository-unavailable",
        "The reviewed repository cannot be scanned as a mutable project.",
        "No plan was reconstructed and no mutation was attempted.",
        "Resolve the repository diagnostics, then generate and review a new plan.",
      ),
    ]);
  }
  if (scan.snapshot.fingerprint !== publicPlan.basis.repository_fingerprint) {
    return stale(scan, [
      planImportDiagnostic(
        "plan-import.repository-fingerprint-changed",
        "The repository fingerprint differs from the reviewed plan.",
        "Applying the exported intent could act on evidence the user did not review.",
        "Generate and review a new plan for the current repository state.",
        [publicPlan.basis.repository_fingerprint, scan.snapshot.fingerprint],
      ),
    ]);
  }
  if (scan.catalog.digest !== publicPlan.basis.catalog_digest) {
    return stale(scan, [
      planImportDiagnostic(
        "plan-import.catalog-changed",
        "The current project-content catalog differs from the catalog used for review.",
        "Component payloads or projections could differ from the reviewed outcome.",
        "Generate and review a new plan with this AI Harness version.",
        [publicPlan.basis.catalog_digest, scan.catalog.digest],
      ),
    ]);
  }

  const desired = publicPlan.desired_after;
  const preparation =
    desired === null
      ? await application.prepareRemove(scan, { all: true })
      : await application.preparePlan(
          scan,
          desired.selections,
          desired.targets,
          publicPlan.mode,
        );
  const candidate = preparation.plan;
  if (candidate?.kind !== "ready") {
    return stale(scan, [
      ...preparation.diagnostics,
      ...(candidate?.diagnostics ?? []),
      planImportDiagnostic(
        "plan-import.reconstruction-blocked",
        "The reviewed plan can no longer be reconstructed from current evidence.",
        "No mutation was attempted.",
        "Resolve the reported blockers, then generate and review a new plan.",
      ),
    ]);
  }
  const mismatches = compareBasis(publicPlan, candidate, scan.catalog.digest);
  if (candidate.id !== publicPlan.plan_id || mismatches.length > 0) {
    return stale(scan, [
      planImportDiagnostic(
        "plan-import.plan-id-changed",
        "Deterministic reconstruction produced a different plan identity.",
        "The exported review does not authorize the reconstructed mutations.",
        "Generate and review a new plan for the current state.",
        [publicPlan.plan_id, candidate.id, ...mismatches],
      ),
    ]);
  }
  return Object.freeze({
    kind: "ready",
    scan,
    preparation,
    plan: candidate,
    diagnostics: Object.freeze([...preparation.diagnostics]),
  });
}

function publicDesiredState(desired: ReadyDesiredState): PublicDesiredState {
  return {
    schema: desired.state.schema,
    targets: desired.state.targets,
    selections: desired.state.selections.map((selection) => ({
      ref: selection.ref,
      inputs: selection.inputs,
    })),
  };
}

function compareBasis(
  exported: PublicPlan,
  candidate: Extract<DurableProjectPlan, { readonly kind: "ready" }>,
  catalogDigest: Sha256Digest,
): readonly string[] {
  const actual: PublicPlanBasis = {
    repository_fingerprint: candidate.snapshotFingerprint,
    catalog_digest: catalogDigest,
    desired_before_digest: candidate.desiredBefore?.digest ?? null,
    desired_after_digest: candidate.desiredAfter?.digest ?? null,
    lock_before_digest: candidate.lockBefore?.digest ?? null,
    lock_after_digest: candidate.lockAfter?.digest ?? null,
  };
  return Object.keys(exported.basis)
    .filter((key) => {
      const field = key as keyof PublicPlanBasis;
      return exported.basis[field] !== actual[field];
    })
    .sort(compareUtf8)
    .map((key) => `${key}:${exported.basis[key as keyof PublicPlanBasis]}!=${actual[key as keyof PublicPlanBasis]}`);
}

function assertValidPublicPlan(value: unknown): asserts value is PublicPlan {
  if (!validatePublicPlan(value)) {
    throw new PublicPlanValidationError(validationIssues(validatePublicPlan.errors));
  }
}

function validationIssues(
  errors: readonly ErrorObject[] | null | undefined,
): readonly string[] {
  return Object.freeze(
    (errors ?? [])
      .map((error) => `${error.instancePath || "/"} ${error.message ?? error.keyword}`)
      .sort(compareUtf8),
  );
}

function stale(
  scan: Awaited<ReturnType<AiHarnessCases["scan"]>>,
  diagnostics: readonly Diagnostic[],
): Extract<PublicPlanReplayResult, { readonly kind: "stale" }> {
  const unique = new Map(diagnostics.map((diagnostic) => [
    `${diagnostic.phase}\0${diagnostic.code}\0${diagnostic.message}`,
    diagnostic,
  ]));
  const values = [...unique.values()];
  const first = values[0];
  if (first === undefined) throw new Error("A stale public plan requires a diagnostic");
  return Object.freeze({
    kind: "stale",
    scan,
    diagnostics: Object.freeze([first, ...values.slice(1)]) as readonly [
      Diagnostic,
      ...Diagnostic[],
    ],
  });
}

function planImportDiagnostic(
  code: string,
  message: string,
  impact: string,
  action: string,
  evidence: readonly string[] = [],
): Diagnostic {
  return Object.freeze({
    code,
    severity: "blocked",
    phase: "planning",
    subjects: Object.freeze([]),
    location: null,
    message,
    evidence: Object.freeze([...evidence].sort(compareUtf8)),
    impact,
    action,
  });
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

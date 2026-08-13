import type { PublicPlan } from "../application/serialization/public-plan.js";
import type {
  ComponentRef,
  Diagnostic,
  HarnessTargetId,
  Sha256Digest,
} from "../domain/shared/types.js";
import type {
  DiagnosticView,
  CatalogItemView,
  DraftComponentView,
  InteractionEvent,
  InteractionSnapshot,
  InteractionTask,
  RecommendationView,
  ReceiptVerdict,
} from "./model.js";
import type {
  McpSessionAggregateResult,
  McpSessionResult,
} from "../domain/mcp/session.js";

export type CommandName =
  | "scan"
  | "status"
  | "init"
  | "plan"
  | "apply"
  | "remove"
  | "sync"
  | "repair"
  | "catalog-list"
  | "catalog-show"
  | "doctor"
  | "mcp-status"
  | "mcp-login"
  | "mcp-logout"
  | "update";

export type CommandVerdict =
  | "READY"
  | "PLAN_READY"
  | "SUCCEEDED"
  | "NO_CHANGES"
  | "ALREADY_INITIALIZED"
  | "INVALID_INPUT"
  | "INVALID_SCOPE"
  | "READINESS_BLOCKED"
  | "BLOCKED"
  | "REJECTED"
  | "CHANGES_AVAILABLE"
  | "ROLLED_BACK"
  | "RECOVERY_REQUIRED"
  | "FAILED"
  | "VERIFICATION_FAILED"
  | "CANCELLED"
  | "INTERNAL_ERROR";

export type CommandData =
  | {
      readonly kind: "catalog-list";
      readonly components: readonly CatalogComponentSummary[];
    }
  | {
      readonly kind: "catalog-show";
      readonly component: CatalogComponentSummary;
    }
  | {
      readonly kind: "doctor";
      readonly checks: readonly {
        readonly id: "catalog" | "recovery" | "repository" | "materialization";
        readonly status: "passed" | "warning" | "failed";
        readonly message: string;
      }[];
    }
  | {
      readonly kind: "update";
      readonly current_version: string;
      readonly latest_version: string | null;
      readonly status: "current" | "available" | "unknown";
    }
  | {
      readonly kind: "mcp-session";
      readonly component: ComponentRef;
      readonly operation: "inspect" | "login" | "logout";
      readonly results: readonly McpSessionResult[];
    };

export interface CatalogComponentSummary {
  readonly ref: ComponentRef;
  readonly kind:
    | "skill"
    | "mcp-integration"
    | "verification-profile"
    | "git-gate"
    | "instruction-fragment"
    | "pack"
    | "agent";
  readonly version: string;
  readonly description: string;
  readonly details: string;
  readonly trust:
    | "passive"
    | "project-write"
    | "local-git-execution"
    | "third-party-network"
    | "agent-instruction";
  readonly applies_languages: readonly string[];
  readonly relations: readonly {
    readonly kind: "includes" | "requires" | "recommends" | "composes" | "conflicts";
    readonly target: ComponentRef;
    readonly reason: string;
  }[];
}

export interface PublicRepositoryView {
  readonly root: string;
  readonly fingerprint: Sha256Digest | string;
  readonly languages: readonly string[];
  readonly management: "uninitialized" | "managed" | "partial";
  readonly integrity: "clean" | "drifted" | "unknown";
  readonly readiness: "ready" | "blocked" | "unknown";
  readonly updates: "none" | "available" | "unknown";
  readonly installed_direct_selections: readonly ComponentRef[];
  readonly installed_components: readonly ComponentRef[];
  readonly installed_targets: readonly HarnessTargetId[];
  readonly harnesses: readonly {
    readonly id: HarnessTargetId;
    readonly detected: boolean;
    readonly version: string | null;
    readonly ready: boolean;
  }[];
}

export interface PublicDraftView {
  readonly direct_selections: readonly ComponentRef[];
  readonly targets: readonly HarnessTargetId[];
  readonly components: readonly DraftComponentView[];
  readonly blocked: boolean;
}

export interface PublicReceiptView {
  readonly operation_id: string;
  readonly plan_id: string | null;
  readonly result: ReceiptVerdict;
  readonly materialization: "unchanged" | "committed" | "rolled-back" | "unknown";
  readonly certification: "verified" | "failed" | "unknown" | "not-run";
  readonly changed_paths: readonly string[];
  readonly diagnostics: readonly DiagnosticView[];
}

interface PublicEventBase {
  readonly schema: "ai-harness/interaction-event/v1";
  readonly operation_id: string;
  readonly sequence: number;
}

export type PublicInteractionEvent = PublicEventBase &
  (
    | {
        readonly type: "state";
        readonly phase: InteractionSnapshot["phase"];
        readonly cancellation_requested?: boolean;
      }
    | { readonly type: "task"; readonly task: InteractionTask }
    | {
        readonly type: "scan-result";
        readonly repository: PublicRepositoryView;
        readonly catalog: readonly CatalogItemView[];
        readonly recommendations: readonly RecommendationView[];
        readonly diagnostics: readonly DiagnosticView[];
      }
    | {
        readonly type: "draft-resolved";
        readonly draft: PublicDraftView;
        readonly diagnostics: readonly DiagnosticView[];
      }
    | {
        readonly type: "plan-ready";
        readonly plan: PublicPlan | null;
        readonly blocked: boolean;
        readonly diagnostics: readonly DiagnosticView[];
      }
    | { readonly type: "receipt"; readonly receipt: PublicReceiptView }
    | { readonly type: "mcp-session-result"; readonly result: McpSessionAggregateResult }
  );

export function publicRepository(
  repository: NonNullable<InteractionSnapshot["repository"]>,
): PublicRepositoryView {
  return Object.freeze({
    root: repository.root,
    fingerprint: repository.fingerprint,
    languages: repository.languages,
    management: repository.management,
    integrity: repository.integrity,
    readiness: repository.readiness,
    updates: repository.updates,
    installed_direct_selections: repository.installedDirectSelections,
    installed_components: repository.installedComponents,
    installed_targets: repository.installedTargets,
    harnesses: repository.harnesses,
  });
}

export function publicDraft(
  draft: NonNullable<InteractionSnapshot["draft"]>,
): PublicDraftView {
  return Object.freeze({
    direct_selections: draft.directSelections,
    targets: draft.targets,
    components: draft.components,
    blocked: draft.blocked,
  });
}

export function publicReceipt(
  receipt: NonNullable<InteractionSnapshot["receipt"]>,
): PublicReceiptView {
  return Object.freeze({
    operation_id: receipt.operationId,
    plan_id: receipt.planId,
    result: receipt.result,
    materialization: receipt.materialization,
    certification: receipt.certification,
    changed_paths: receipt.changedPaths,
    diagnostics: receipt.diagnostics,
  });
}

export function toPublicEvent(event: InteractionEvent): PublicInteractionEvent {
  const base = {
    schema: event.schema,
    operation_id: event.operation_id,
    sequence: event.sequence,
  } as const;
  switch (event.type) {
    case "state":
      return Object.freeze({
        ...base,
        type: event.type,
        phase: event.phase,
        ...(event.cancellation_requested === undefined
          ? {}
          : { cancellation_requested: event.cancellation_requested }),
      });
    case "task":
      return Object.freeze({ ...base, type: event.type, task: event.task });
    case "scan-result":
      return Object.freeze({
        ...base,
        type: event.type,
        repository: publicRepository(event.repository),
        catalog: event.catalog,
        recommendations: event.recommendations,
        diagnostics: event.diagnostics,
      });
    case "draft-resolved":
      return Object.freeze({
        ...base,
        type: event.type,
        draft: publicDraft(event.draft),
        diagnostics: event.diagnostics,
      });
    case "plan-ready":
      return Object.freeze({
        ...base,
        type: event.type,
        plan: event.plan.publicPlan,
        blocked: event.plan.kind === "blocked",
        diagnostics: event.diagnostics,
      });
    case "receipt":
      return Object.freeze({
        ...base,
        type: event.type,
        receipt: publicReceipt(event.receipt),
      });
    case "mcp-session-result":
      return Object.freeze({ ...base, type: event.type, result: event.result });
  }
}

export function publicDiagnostics(
  diagnostics: readonly Diagnostic[],
): readonly DiagnosticView[] {
  return Object.freeze(
    diagnostics.map((diagnostic) =>
      Object.freeze({
        code: diagnostic.code,
        severity: diagnostic.severity,
        message: diagnostic.message,
        impact: diagnostic.impact,
        action: diagnostic.action,
      }),
    ),
  );
}

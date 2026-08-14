import type { ComponentRef, HarnessTargetId } from "../domain/shared/types.js";
import type { ReviewModel } from "../domain/review/review-model.js";
import type { ComponentSelectionDraft } from "../application/model.js";
import type { PublicPlan } from "../application/serialization/public-plan.js";
import type { McpSessionAggregateResult, McpSessionOperation } from "../domain/mcp/session.js";

export type InteractionPhase =
  | "idle"
  | "scanning"
  | "browsing"
  | "drafting"
  | "planning"
  | "reviewing"
  | "applying"
  | "verifying"
  | "authenticating"
  | "receipted"
  | "blocked"
  | "cancelled";

export type InteractionTaskState =
  | "waiting"
  | "running"
  | "done"
  | "warning"
  | "failed"
  | "skipped";

export interface InteractionTask {
  readonly id: string;
  readonly label: string;
  readonly detail: string | null;
  readonly state: InteractionTaskState;
  readonly current?: number;
  readonly total?: number;
}

export interface DiagnosticView {
  readonly code: string;
  readonly severity: "info" | "warning" | "blocked" | "failed";
  readonly location: {
    readonly path: string;
    readonly pointer?: string;
  } | null;
  readonly message: string;
  readonly evidence: readonly string[];
  readonly impact: string;
  readonly action: string | null;
  readonly resolutions?: readonly {
    readonly action: "replace";
    readonly label: string;
    readonly destructive: boolean;
  }[];
}

export interface RepositoryView {
  readonly root: string;
  readonly fingerprint: string;
  readonly languages: readonly string[];
  readonly management: "uninitialized" | "managed" | "partial";
  readonly integrity: "clean" | "drifted" | "unknown";
  readonly readiness: "ready" | "blocked" | "unknown";
  readonly updates: "none" | "available" | "unknown";
  readonly installedDirectSelections: readonly ComponentRef[];
  readonly installedComponents: readonly ComponentRef[];
  readonly installedTargets: readonly HarnessTargetId[];
  readonly harnesses: readonly {
    readonly id: HarnessTargetId;
    readonly detected: boolean;
    readonly version: string | null;
    readonly ready: boolean;
  }[];
}

export interface RecommendationView {
  readonly ref: ComponentRef;
  readonly version: string;
  readonly reasons: readonly string[];
}

export interface CatalogItemView {
  readonly ref: ComponentRef;
  readonly kind:
    | "skill"
    | "mcp-integration"
    | "verification-profile"
    | "git-gate"
    | "pack"
    | "agent";
  readonly version: string;
  readonly description: string;
  readonly details: string;
  readonly impact: {
    readonly changes: string;
    readonly workflow: string;
  };
  readonly trust:
    | "passive"
    | "project-write"
    | "local-git-execution"
    | "third-party-network"
    | "agent-instruction";
  readonly recommended: boolean;
  readonly mcpAuth?: "none" | "oauth";
  readonly gitGate?: {
    readonly event: "pre-commit" | "pre-push";
    readonly operation: string;
    readonly provider: ComponentRef;
  };
}

export interface DraftComponentView {
  readonly ref: ComponentRef;
  readonly version: string;
  readonly origin: "direct" | "required";
  readonly causes: readonly string[];
  readonly applicability: "portable" | "matched" | "unverified";
}

export interface DraftView {
  readonly directSelections: readonly ComponentRef[];
  readonly selectionInputs: readonly ComponentSelectionDraft[];
  readonly targets: readonly HarnessTargetId[];
  readonly components: readonly DraftComponentView[];
  readonly blocked: boolean;
}

export interface PlannedChangeView {
  readonly action: "create" | "replace" | "remove";
  readonly path: string;
  readonly owner: string;
}

export interface PlanView {
  readonly kind: "ready" | "blocked";
  readonly id: string | null;
  readonly mode: "reconcile" | "repair" | "remove";
  readonly changes: readonly PlannedChangeView[];
  readonly approvable: boolean;
  readonly review: ReviewModel | null;
  readonly publicPlan: PublicPlan | null;
}

export type ReceiptVerdict =
  | "succeeded"
  | "no-changes"
  | "rejected"
  | "cancelled"
  | "rolled-back"
  | "verification-failed"
  | "recovery-required"
  | "failed";

export interface ReceiptView {
  readonly operationId: string;
  readonly planId: string | null;
  readonly result: ReceiptVerdict;
  readonly materialization: "unchanged" | "committed" | "rolled-back" | "unknown";
  readonly certification: "verified" | "failed" | "unknown" | "not-run";
  readonly changedPaths: readonly string[];
  readonly diagnostics: readonly DiagnosticView[];
}

export interface InteractionSnapshot {
  readonly operationId: string;
  readonly phase: InteractionPhase;
  readonly tasks: readonly InteractionTask[];
  readonly repository: RepositoryView | null;
  readonly catalog: readonly CatalogItemView[];
  readonly recommendations: readonly RecommendationView[];
  readonly draft: DraftView | null;
  readonly plan: PlanView | null;
  readonly receipt: ReceiptView | null;
  readonly mcpSession: McpSessionAggregateResult | null;
  readonly diagnostics: readonly DiagnosticView[];
  readonly cancellationRequested: boolean;
}

interface EventBase {
  readonly schema: "ai-harness/interaction-event/v1";
  readonly operation_id: string;
  readonly sequence: number;
}

export type InteractionEvent = EventBase &
  (
    | {
        readonly type: "state";
        readonly phase: InteractionPhase;
        readonly cancellation_requested?: boolean;
      }
    | { readonly type: "task"; readonly task: InteractionTask }
    | {
        readonly type: "scan-result";
        readonly repository: RepositoryView;
        readonly catalog: readonly CatalogItemView[];
        readonly recommendations: readonly RecommendationView[];
        readonly diagnostics: readonly DiagnosticView[];
      }
    | {
        readonly type: "draft-resolved";
        readonly draft: DraftView;
        readonly diagnostics: readonly DiagnosticView[];
      }
    | {
        readonly type: "plan-ready";
        readonly plan: PlanView;
        readonly diagnostics: readonly DiagnosticView[];
      }
    | { readonly type: "receipt"; readonly receipt: ReceiptView }
    | { readonly type: "mcp-session-result"; readonly result: McpSessionAggregateResult }
  );

type WithoutEventEnvelope<Event> = Event extends unknown
  ? Omit<Event, "schema" | "operation_id" | "sequence">
  : never;

export type InteractionEventPayload = WithoutEventEnvelope<InteractionEvent>;

export type InteractionAction =
  | { readonly type: "scan"; readonly root: string }
  | { readonly type: "show-overview" }
  | {
      readonly type: "replace-draft";
      readonly selections: readonly ComponentSelectionDraft[];
      readonly targets: readonly HarnessTargetId[];
    }
  | {
      readonly type: "compose-draft";
      readonly base: "empty" | "installed";
      readonly recommended: boolean;
      readonly add: readonly ComponentSelectionDraft[];
      readonly remove: readonly ComponentRef[];
      readonly setInputs: readonly {
        readonly ref: ComponentRef;
        readonly input: string;
        readonly values: readonly string[];
      }[];
      readonly targets: readonly HarnessTargetId[] | null;
    }
  | {
      readonly type: "request-plan";
      readonly mode: "reconcile" | "repair" | "remove";
    }
  | {
      readonly type: "resolve-plan-blocker";
      readonly code: "quality.make.target-collision";
      readonly resolution: "replace";
    }
  | { readonly type: "load-plan"; readonly root: string; readonly plan: PublicPlan }
  | { readonly type: "request-managed-plan"; readonly mode: "sync" | "repair" }
  | { readonly type: "approve-plan"; readonly planId: string }
  | {
      readonly type: "mcp-session";
      readonly component: ComponentRef;
      readonly targets: readonly HarnessTargetId[];
      readonly operation: McpSessionOperation;
    }
  | { readonly type: "cancel-operation" };

export interface InteractionUpdate {
  readonly event: InteractionEvent;
  readonly snapshot: InteractionSnapshot;
}

export type InteractionSubscriber = (update: InteractionUpdate) => void;

export interface InteractionSession {
  readonly snapshot: InteractionSnapshot;
  dispatch(action: InteractionAction): Promise<InteractionSnapshot>;
  subscribe(subscriber: InteractionSubscriber): () => void;
}

export function initialInteractionSnapshot(operationId: string): InteractionSnapshot {
  return Object.freeze({
    operationId,
    phase: "idle",
    tasks: Object.freeze([]),
    repository: null,
    catalog: Object.freeze([]),
    recommendations: Object.freeze([]),
    draft: null,
    plan: null,
    receipt: null,
    mcpSession: null,
    diagnostics: Object.freeze([]),
    cancellationRequested: false,
  });
}

export function reduceInteraction(
  snapshot: InteractionSnapshot,
  event: InteractionEvent,
): InteractionSnapshot {
  switch (event.type) {
    case "state":
      return Object.freeze({
        ...snapshot,
        phase: event.phase,
        cancellationRequested:
          event.cancellation_requested ?? snapshot.cancellationRequested,
        ...(event.phase === "scanning"
          ? {
              tasks: Object.freeze([]),
              repository: null,
              catalog: Object.freeze([]),
              recommendations: Object.freeze([]),
              draft: null,
              plan: null,
              receipt: null,
              mcpSession: null,
              diagnostics: Object.freeze([]),
              cancellationRequested: false,
            }
          : {}),
      });
    case "task": {
      const index = snapshot.tasks.findIndex((task) => task.id === event.task.id);
      const tasks = [...snapshot.tasks];
      if (index === -1) {
        tasks.push(event.task);
      } else {
        tasks[index] = event.task;
      }
      return Object.freeze({ ...snapshot, tasks: Object.freeze(tasks) });
    }
    case "scan-result":
      return Object.freeze({
        ...snapshot,
        repository: event.repository,
        catalog: Object.freeze([...event.catalog]),
        recommendations: Object.freeze([...event.recommendations]),
        diagnostics: Object.freeze([...event.diagnostics]),
      });
    case "draft-resolved":
      return Object.freeze({
        ...snapshot,
        draft: event.draft,
        plan: null,
        receipt: null,
        diagnostics: Object.freeze([...event.diagnostics]),
      });
    case "plan-ready":
      return Object.freeze({
        ...snapshot,
        plan: event.plan,
        receipt: null,
        diagnostics: Object.freeze([...event.diagnostics]),
      });
    case "receipt":
      return Object.freeze({
        ...snapshot,
        receipt: event.receipt,
        diagnostics: event.receipt.diagnostics,
      });
    case "mcp-session-result":
      return Object.freeze({ ...snapshot, mcpSession: event.result });
  }
}

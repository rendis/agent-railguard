import { randomUUID } from "node:crypto";
import {
  createDefaultApplication,
  type DefaultApplicationOptions,
  type DefaultApplicationRuntime,
} from "../application/composition-root.js";
import type {
  RailguardCases,
  ApplicationEvent,
  ComponentSelectionDraft,
  ScanResult,
} from "../application/model.js";
import type {
  DurableApplyResult,
  DurableProjectPlan,
} from "../domain/transaction/model.js";
import type { RecommendationSet } from "../domain/recommendation/model.js";
import type { CatalogComponent } from "../domain/catalog/model.js";
import type { ResolutionResult } from "../domain/resolution/model.js";
import {
  compareUtf8,
  type ComponentRef,
  type Diagnostic,
  type HarnessTargetId,
} from "../domain/shared/types.js";
import type { VerificationResult } from "../domain/verification/model.js";
import { buildReviewModel } from "../domain/review/review-model.js";
import type { McpSessionAggregateResult } from "../domain/mcp/session.js";
import {
  exportPublicPlan,
  rehydratePublicPlan,
  type PublicPlan,
} from "../application/serialization/public-plan.js";
import {
  initialInteractionSnapshot,
  reduceInteraction,
  type DiagnosticView,
  type CatalogItemView,
  type DraftView,
  type InteractionAction,
  type InteractionEvent,
  type InteractionEventPayload,
  type InteractionPhase,
  type InteractionSession,
  type InteractionSnapshot,
  type InteractionSubscriber,
  type InteractionTask,
  type PlanView,
  type ReceiptView,
  type RecommendationView,
  type RepositoryView,
} from "./model.js";
import { componentImpact } from "./component-impact.js";

type AttachApplicationEvents = (sink: (event: ApplicationEvent) => void) => void;

export interface InteractionRuntime {
  readonly session: InteractionSession;
  readonly applicationRuntime: DefaultApplicationRuntime;
  dispose(): Promise<void>;
}

export interface DefaultInteractionSessionOptions {
  readonly operationId?: string;
  readonly attachApplicationEvents?: AttachApplicationEvents;
}

export class DefaultInteractionSession implements InteractionSession {
  readonly #application: RailguardCases;
  readonly #operationId: string;
  readonly #subscribers = new Set<InteractionSubscriber>();
  #snapshot: InteractionSnapshot;
  #sequence = 0;
  #scan: ScanResult | null = null;
  #plan: Extract<DurableProjectPlan, { readonly kind: "ready" }> | null = null;
  #selections: readonly ComponentSelectionDraft[] = Object.freeze([]);
  #targets: readonly HarnessTargetId[] = Object.freeze([]);
  #inFlight = false;
  #cancellationRequested = false;
  #activeAbortController: AbortController | null = null;
  #taskScope: string | null = null;

  public constructor(
    application: RailguardCases,
    options: DefaultInteractionSessionOptions = {},
  ) {
    this.#application = application;
    this.#operationId = options.operationId ?? randomUUID();
    this.#snapshot = initialInteractionSnapshot(this.#operationId);
    options.attachApplicationEvents?.((event) => this.#acceptApplicationEvent(event));
  }

  public get snapshot(): InteractionSnapshot {
    return this.#snapshot;
  }

  public subscribe(subscriber: InteractionSubscriber): () => void {
    this.#subscribers.add(subscriber);
    return () => this.#subscribers.delete(subscriber);
  }

  public async dispatch(action: InteractionAction): Promise<InteractionSnapshot> {
    if (action.type === "cancel-operation") {
      return this.#cancel();
    }
    if (this.#inFlight) {
      throw new TypeError("Another interaction action is already running");
    }
    this.#inFlight = true;
    try {
      switch (action.type) {
        case "scan":
          return await this.#scanRepository(action.root);
        case "show-overview":
          return this.#showOverview();
        case "replace-draft":
          return this.#replaceDraft(action.selections, action.targets);
        case "compose-draft":
          return this.#composeDraft(action);
        case "request-plan":
          return await this.#requestPlan(action.mode);
        case "load-plan":
          return await this.#loadPlan(action.root, action.plan);
        case "request-managed-plan":
          return await this.#requestManagedPlan(action.mode);
        case "approve-plan":
          return await this.#approvePlan(action.planId);
        case "mcp-session":
          return await this.#runMcpSession(action.component, action.targets, action.operation);
      }
    } finally {
      this.#inFlight = false;
    }
  }

  #showOverview(): InteractionSnapshot {
    this.#requireReadyScan();
    this.#emitState("browsing");
    return this.#snapshot;
  }

  async #scanRepository(root: string): Promise<InteractionSnapshot> {
    this.#cancellationRequested = false;
    this.#scan = null;
    this.#plan = null;
    this.#selections = Object.freeze([]);
    this.#targets = Object.freeze([]);
    this.#emitState("scanning");
    const scan = await this.#withAsyncTaskScope("scan", () => this.#application.scan(root));
    this.#scan = scan;

    if (scan.kind === "blocked") {
      this.#emit({
        type: "scan-result",
        repository: blockedRepositoryView(scan),
        catalog: Object.freeze([]),
        recommendations: Object.freeze([]),
        diagnostics: diagnosticViews(scan.diagnostics),
      });
      this.#emitState(this.#cancellationRequested ? "cancelled" : "blocked");
      if (this.#cancellationRequested) {
        this.#emitCancellationReceipt(null);
      }
      return this.#snapshot;
    }

    const recommendations = await this.#withAsyncTaskScope("recommend", () =>
      this.#application.recommendations(scan),
    );
    this.#emit({
      type: "scan-result",
      repository: repositoryView(scan),
      catalog: catalogItemViews(scan, recommendations),
      recommendations: recommendationViews(recommendations),
      diagnostics: diagnosticViews([
        ...scan.diagnostics,
        ...recommendations.diagnostics,
      ]),
    });
    if (this.#cancellationRequested) {
      this.#emitState("cancelled");
      this.#emitCancellationReceipt(null);
    } else {
      this.#emitState("browsing");
    }
    return this.#snapshot;
  }

  #replaceDraft(
    selections: readonly ComponentSelectionDraft[],
    targets: readonly HarnessTargetId[],
  ): InteractionSnapshot {
    const scan = this.#requireReadyScan();
    this.#selections = canonicalSelections(selections);
    this.#targets = canonical(targets);
    this.#plan = null;
    this.#emitState("drafting");
    const resolution = this.#withTaskScope("resolve", () =>
      this.#application.resolve(
        scan,
        this.#selections.map((selection) => selection.ref),
        this.#targets,
      ),
    );
    this.#emit({
      type: "draft-resolved",
      draft: draftView(resolution, this.#selections, this.#targets),
      diagnostics: diagnosticViews(resolution.diagnostics),
    });
    return this.#snapshot;
  }

  #composeDraft(
    action: Extract<InteractionAction, { readonly type: "compose-draft" }>,
  ): InteractionSnapshot {
    const scan = this.#requireReadyScan();
    const base = action.base === "installed" ? scan.desired?.state.selections ?? [] : [];
    const selections = new Map<ComponentRef, ComponentSelectionDraft>(
      base.map((selection) => [
        selection.ref,
        { ref: selection.ref, inputs: selection.inputs },
      ]),
    );
    if (action.recommended) {
      for (const recommendation of this.#snapshot.recommendations) {
        if (!selections.has(recommendation.ref)) {
          selections.set(recommendation.ref, { ref: recommendation.ref });
        }
      }
    }
    for (const selection of action.add) {
      selections.set(selection.ref, selection);
    }
    for (const assignment of action.setInputs) {
      const selection = selections.get(assignment.ref);
      if (selection === undefined) {
        throw new TypeError(
          `${assignment.ref} must be selected before setting input ${assignment.input}`,
        );
      }
      selections.set(assignment.ref, {
        ref: assignment.ref,
        inputs: {
          ...(selection.inputs ?? {}),
          [assignment.input]: assignment.values,
        },
      });
    }
    for (const ref of action.remove) {
      if (!selections.delete(ref)) {
        throw new TypeError(`${ref} is not a direct selection in the chosen draft base`);
      }
    }
    const targets =
      action.targets ??
      (action.base === "installed" ? scan.desired?.state.targets ?? [] : []);
    return this.#replaceDraft([...selections.values()], targets);
  }

  async #requestPlan(
    mode: "reconcile" | "repair" | "remove",
  ): Promise<InteractionSnapshot> {
    const scan = this.#requireReadyScan();
    if (this.#snapshot.draft === null) {
      throw new TypeError("A resolved draft is required before planning");
    }
    this.#cancellationRequested = false;
    this.#plan = null;
    this.#emitState("planning");
    const preparation = await this.#withAsyncTaskScope("plan", async () =>
      mode === "remove" && this.#selections.length === 0
        ? await this.#application.prepareRemove(scan, { all: true })
        : await this.#application.preparePlan(
            scan,
            this.#selections,
            this.#targets,
            mode,
          ),
    );
    this.#plan = preparation.plan?.kind === "ready" ? preparation.plan : null;
    const diagnostics = preparation.diagnostics;
    this.#emit({
      type: "plan-ready",
      plan: planView(
        preparation.plan,
        mode,
        this.#requireReadyScan().catalog,
        preparation.resolution,
      ),
      diagnostics: diagnosticViews(diagnostics),
    });
    if (this.#cancellationRequested) {
      this.#emitState("cancelled");
      this.#emitCancellationReceipt(this.#plan?.id ?? null);
    } else {
      this.#emitState("reviewing");
    }
    return this.#snapshot;
  }

  async #requestManagedPlan(
    mode: "sync" | "repair",
  ): Promise<InteractionSnapshot> {
    const scan = this.#requireReadyScan();
    const selections = scan.desired?.state.selections ?? [];
    const targets = scan.desired?.state.targets ?? [];
    this.#replaceDraft(selections, targets);
    this.#cancellationRequested = false;
    this.#plan = null;
    this.#emitState("planning");
    const preparation = await this.#withAsyncTaskScope("plan", () =>
      mode === "sync"
        ? this.#application.prepareSync(scan)
        : this.#application.prepareRepair(scan),
    );
    this.#plan = preparation.plan?.kind === "ready" ? preparation.plan : null;
    const planMode = preparation.plan?.mode ?? (mode === "repair" ? "repair" : "reconcile");
    const diagnostics = [
      ...preparation.resolution.diagnostics,
      ...preparation.diagnostics,
      ...(preparation.plan?.diagnostics ?? []),
    ];
    this.#emit({
      type: "plan-ready",
      plan: planView(
        preparation.plan,
        planMode,
        scan.catalog,
        preparation.resolution,
      ),
      diagnostics: diagnosticViews(diagnostics),
    });
    this.#emitState(this.#plan === null ? "blocked" : "reviewing");
    return this.#snapshot;
  }

  async #loadPlan(root: string, publicPlan: PublicPlan): Promise<InteractionSnapshot> {
    this.#cancellationRequested = false;
    this.#scan = null;
    this.#plan = null;
    this.#selections = Object.freeze([]);
    this.#targets = Object.freeze([]);
    this.#emitState("scanning");
    const replay = await this.#withAsyncTaskScope("plan-import", () =>
      rehydratePublicPlan(this.#application, root, publicPlan),
    );
    this.#scan = replay.scan;

    if (replay.kind === "stale") {
      this.#emit({
        type: "scan-result",
        repository:
          replay.scan.kind === "ready"
            ? repositoryView(replay.scan)
            : blockedRepositoryView(replay.scan),
        catalog:
          replay.scan.kind === "ready"
            ? catalogItemViews(replay.scan, null)
            : Object.freeze([]),
        recommendations: Object.freeze([]),
        diagnostics: diagnosticViews(replay.diagnostics),
      });
      this.#emit({
        type: "plan-ready",
        plan: importedBlockedPlanView(publicPlan),
        diagnostics: diagnosticViews(replay.diagnostics),
      });
      this.#emitState("blocked");
      return this.#snapshot;
    }

    this.#selections = canonicalSelections(
      publicPlan.desired_after?.selections ?? [],
    );
    this.#targets = canonical(publicPlan.desired_after?.targets ?? []);
    this.#plan = replay.plan;
    this.#emit({
      type: "scan-result",
      repository: repositoryView(replay.scan),
      catalog: catalogItemViews(replay.scan, null),
      recommendations: Object.freeze([]),
      diagnostics: diagnosticViews([
        ...replay.scan.diagnostics,
        ...replay.diagnostics,
      ]),
    });
    this.#emit({
      type: "draft-resolved",
      draft: draftView(replay.preparation.resolution, this.#selections, this.#targets),
      diagnostics: diagnosticViews(replay.preparation.resolution.diagnostics),
    });
    this.#emit({
      type: "plan-ready",
      plan: planView(
        replay.plan,
        publicPlan.mode,
        replay.scan.catalog,
        replay.preparation.resolution,
      ),
      diagnostics: diagnosticViews(replay.diagnostics),
    });
    this.#emitState("reviewing");
    return this.#snapshot;
  }

  async #approvePlan(planId: string): Promise<InteractionSnapshot> {
    const plan = this.#plan;
    if (plan === null || plan.id !== planId) {
      const diagnostic = interactionDiagnostic(
        "interaction.approval.plan-id-mismatch",
        "blocked",
        "The approval does not name the exact plan currently under review.",
        "No repository mutation was attempted.",
        "Review the current plan and approve its exact plan ID.",
      );
      this.#emitReceipt(
        Object.freeze({
          operationId: this.#operationId,
          planId: plan?.id ?? null,
          result: "rejected",
          materialization: "unchanged",
          certification: "not-run",
          changedPaths: Object.freeze([]),
          diagnostics: Object.freeze([diagnostic]),
        }),
      );
      this.#emitState("receipted");
      return this.#snapshot;
    }

    this.#cancellationRequested = false;
    const abortController = new AbortController();
    this.#activeAbortController = abortController;
    this.#emitState("applying");
    let apply: DurableApplyResult;
    try {
      apply = await this.#withAsyncTaskScope("apply", () =>
        this.#application.apply(plan, { signal: abortController.signal }),
      );
    } finally {
      this.#activeAbortController = null;
    }
    if (apply.kind !== "applied" && apply.kind !== "no-changes") {
      this.#emitReceipt(receiptFromApply(this.#operationId, apply, null));
      this.#emitState("receipted");
      return this.#snapshot;
    }

    this.#emitState("verifying");
    const status = await this.#withAsyncTaskScope("verify", () =>
      this.#application.status(plan.rootRealPath, this.#targets),
    );
    const cancellationDiagnostics = this.#cancellationRequested
      ? [
          interactionDiagnostic(
            "interaction.cancellation.safe-boundary-passed",
            "warning",
            "Cancellation was requested after the current mutation engine crossed its last observable safe boundary.",
            "The completed materialization was verified instead of being reported as cancelled.",
            "The mutation crossed its last observable safe cancellation boundary and completed verification.",
          ),
        ]
      : [];
    this.#emitReceipt(
      receiptFromApply(
        this.#operationId,
        apply,
        status.verification,
        cancellationDiagnostics,
      ),
    );
    this.#emitState("receipted");
    return this.#snapshot;
  }

  async #runMcpSession(
    component: ComponentRef,
    targets: readonly HarnessTargetId[],
    operation: "inspect" | "login" | "logout",
  ): Promise<InteractionSnapshot> {
    const scan = this.#requireReadyScan();
    this.#cancellationRequested = false;
    const abortController = new AbortController();
    this.#activeAbortController = abortController;
    this.#emitState("authenticating");
    let result: McpSessionAggregateResult;
    try {
      result = await this.#withAsyncTaskScope("mcp-session", () =>
        this.#application.mcpSession(
          scan.snapshot.realRoot,
          component,
          targets,
          operation,
          abortController.signal,
        ),
      );
    } finally {
      this.#activeAbortController = null;
    }
    this.#emit({ type: "mcp-session-result", result });
    this.#emitState("receipted");
    return this.#snapshot;
  }

  #cancel(): InteractionSnapshot {
    this.#cancellationRequested = true;
    this.#activeAbortController?.abort();
    this.#emitState(this.#snapshot.phase, true);
    if (
      this.#snapshot.phase === "scanning" ||
      this.#snapshot.phase === "planning" ||
      this.#snapshot.phase === "applying" ||
      this.#snapshot.phase === "verifying" ||
      this.#snapshot.phase === "authenticating"
    ) {
      return this.#snapshot;
    }
    this.#emitState("cancelled", true);
    this.#emitCancellationReceipt(this.#plan?.id ?? null);
    return this.#snapshot;
  }

  #emitCancellationReceipt(planId: string | null): void {
    this.#emitReceipt(
      Object.freeze({
        operationId: this.#operationId,
        planId,
        result: "cancelled",
        materialization: "unchanged",
        certification: "not-run",
        changedPaths: Object.freeze([]),
        diagnostics: Object.freeze([]),
      }),
    );
  }

  #emitReceipt(receipt: ReceiptView): void {
    this.#emit({ type: "receipt", receipt });
  }

  #acceptApplicationEvent(event: ApplicationEvent): void {
    const baseId = `${event.operation}.${event.phase.replaceAll(":", ".")}`;
    const id =
      this.#taskScope === null || this.#taskScope === event.operation
        ? baseId
        : `${this.#taskScope}.${baseId}`;
    const previous = this.#snapshot.tasks.find((task) => task.id === id);
    const state =
      event.status === "started"
        ? "running"
        : event.status === "completed"
          ? "done"
          : "failed";
    const task: InteractionTask = Object.freeze({
      id,
      label: previous?.label ?? taskLabel(event),
      detail: event.message,
      state,
      ...(event.current === undefined ? {} : { current: event.current }),
      ...(event.total === undefined ? {} : { total: event.total }),
    });
    this.#emit({ type: "task", task });
  }

  #withTaskScope<Result>(scope: string, operation: () => Result): Result {
    const previous = this.#taskScope;
    this.#taskScope = scope;
    try {
      return operation();
    } finally {
      this.#taskScope = previous;
    }
  }

  async #withAsyncTaskScope<Result>(
    scope: string,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const previous = this.#taskScope;
    this.#taskScope = scope;
    try {
      return await operation();
    } finally {
      this.#taskScope = previous;
    }
  }

  #emitState(
    phase: InteractionPhase,
    cancellationRequested?: boolean,
  ): void {
    this.#emit({
      type: "state",
      phase,
      ...(cancellationRequested === undefined
        ? {}
        : { cancellation_requested: cancellationRequested }),
    });
  }

  #emit(event: InteractionEventPayload): void {
    const complete = Object.freeze({
      schema: "railguard/interaction-event/v1" as const,
      operation_id: this.#operationId,
      sequence: ++this.#sequence,
      ...event,
    }) as InteractionEvent;
    this.#snapshot = reduceInteraction(this.#snapshot, complete);
    const update = Object.freeze({ event: complete, snapshot: this.#snapshot });
    for (const subscriber of this.#subscribers) {
      subscriber(update);
    }
  }

  #requireReadyScan(): Extract<ScanResult, { readonly kind: "ready" }> {
    if (this.#scan?.kind !== "ready") {
      throw new TypeError("A ready scan is required before changing the draft");
    }
    return this.#scan;
  }
}

export async function createInteractionRuntime(
  options: Omit<DefaultApplicationOptions, "events"> & {
    readonly operationId?: string;
  } = {},
): Promise<InteractionRuntime> {
  let forwardApplicationEvent = (_event: ApplicationEvent): void => undefined;
  const { operationId, ...applicationOptions } = options;
  const applicationRuntime = await createDefaultApplication({
    ...applicationOptions,
    events: (event) => forwardApplicationEvent(event),
  });
  const session = new DefaultInteractionSession(applicationRuntime.application, {
    ...(operationId === undefined ? {} : { operationId }),
    attachApplicationEvents: (sink) => {
      forwardApplicationEvent = sink;
    },
  });
  return Object.freeze({
    session,
    applicationRuntime,
    async dispose() {
      await applicationRuntime.dispose();
    },
  });
}

function repositoryView(
  scan: Extract<ScanResult, { readonly kind: "ready" }>,
): RepositoryView {
  return Object.freeze({
    root: scan.snapshot.realRoot,
    fingerprint: scan.snapshot.fingerprint,
    languages: Object.freeze(
      [...new Set(scan.assessment.projectUnits.flatMap((unit) => unit.languages))].sort(
        compareUtf8,
      ),
    ),
    management: scan.reconciliation.management,
    integrity: scan.reconciliation.integrity,
    readiness: scan.reconciliation.readiness,
    updates:
      scan.reconciliation.updates.kind === "none"
        ? "none"
        : scan.reconciliation.updates.kind === "components"
          ? "available"
          : "unknown",
    installedDirectSelections: Object.freeze(
      scan.desired?.state.selections.map((selection) => selection.ref) ?? [],
    ),
    installedComponents: Object.freeze(
      scan.lock?.state.components.map((component) => component.ref) ?? [],
    ),
    installedTargets: Object.freeze(scan.desired?.state.targets ?? []),
    harnesses: Object.freeze(
      scan.harnesses.map((inspection) =>
        Object.freeze({
          id: inspection.target,
          detected: inspection.detected,
          version: inspection.version,
          ready:
            inspection.capabilities.length > 0 &&
            inspection.diagnostics.every(
              (diagnostic) => diagnostic.severity !== "blocked" && diagnostic.severity !== "failed",
            ),
        }),
      ),
    ),
  });
}

function blockedRepositoryView(
  scan: Extract<ScanResult, { readonly kind: "blocked" }>,
): RepositoryView {
  return Object.freeze({
    root: scan.snapshot.realRoot,
    fingerprint: scan.snapshot.fingerprint,
    languages: Object.freeze([]),
    management: "uninitialized",
    integrity: "unknown",
    readiness: "blocked",
    updates: "unknown",
    installedDirectSelections: Object.freeze([]),
    installedComponents: Object.freeze([]),
    installedTargets: Object.freeze([]),
    harnesses: Object.freeze([]),
  });
}

function recommendationViews(
  recommendations: RecommendationSet,
): readonly RecommendationView[] {
  return Object.freeze(
    recommendations.candidates.map((candidate) =>
      Object.freeze({
        ref: candidate.ref,
        version: candidate.version,
        reasons: Object.freeze(
          candidate.reasons.map((reason) =>
            reason.kind === "language-match"
              ? `language:${reason.language}`
              : `${reason.kind}:${reason.from}`,
          ),
        ),
      }),
    ),
  );
}

function catalogItemViews(
  scan: Extract<ScanResult, { readonly kind: "ready" }>,
  recommendations: RecommendationSet | null,
): readonly CatalogItemView[] {
  const recommended = new Set(
    recommendations?.candidates.map((candidate) => candidate.ref) ?? [],
  );
  return Object.freeze(
    scan.catalog.components
      .filter(
        (component): component is Exclude<CatalogComponent, { readonly kind: "instruction-fragment" }> =>
          component.kind !== "instruction-fragment",
      )
      .map((component) => {
      const provider = component.kind === "git-gate"
        ? component.relations.find((relation) => relation.kind === "requires")?.target
        : undefined;
      return Object.freeze({
        ref: component.ref,
        kind: component.kind,
        version: component.version,
        description: component.description,
        details: component.details,
        impact: componentImpact(component),
        trust: component.trust,
        recommended: recommended.has(component.ref),
        ...(component.kind === "mcp-integration" ? { mcpAuth: component.auth.type } : {}),
        ...(component.kind === "git-gate" && provider !== undefined
          ? {
              gitGate: Object.freeze({
                event: component.event,
                operation: component.operation,
                provider,
              }),
            }
          : {}),
      });
      }),
  );
}

function draftView(
  resolution: ResolutionResult,
  selections: readonly ComponentSelectionDraft[],
  targets: readonly HarnessTargetId[],
): DraftView {
  return Object.freeze({
    directSelections: Object.freeze(selections.map((selection) => selection.ref)),
    selectionInputs: selections,
    targets: Object.freeze([...targets]),
    components: Object.freeze(
      resolution.components.map((component) =>
        Object.freeze({
          ref: component.ref,
          version: component.version,
          origin: component.direct ? ("direct" as const) : ("required" as const),
          causes: Object.freeze(
            component.includedBy.map(
              (cause) => `${cause.kind} by ${cause.from}: ${cause.reason}`,
            ),
          ),
          applicability: component.applicability.kind,
        }),
      ),
    ),
    blocked: resolution.kind === "blocked",
  });
}

function planView(
  plan: DurableProjectPlan | null,
  mode: "reconcile" | "repair" | "remove",
  catalog: Extract<ScanResult, { readonly kind: "ready" }>["catalog"],
  resolution: ResolutionResult,
): PlanView {
  if (plan === null || plan.kind === "blocked") {
    return Object.freeze({
      kind: "blocked",
      id: null,
      mode,
      changes: Object.freeze([]),
      approvable: false,
      review: null,
      publicPlan: null,
    });
  }
  return Object.freeze({
    kind: "ready",
    id: plan.id,
    mode,
    changes: Object.freeze(
      plan.operations.map((operation) =>
        Object.freeze({
          action:
            operation.kind === "write-file" || operation.kind === "write-symlink"
              ? operation.before.kind === "absent"
                ? ("create" as const)
                : ("replace" as const)
              : operation.kind === "create-directory"
                ? ("create" as const)
                : operation.kind === "remove-file" || operation.kind === "remove-symlink" || operation.kind === "remove-directory"
                  ? ("remove" as const)
                  : operation.kind === "configure-git" && operation.value === null
                    ? ("remove" as const)
                  : ("replace" as const),
          path: operation.path,
          owner: operation.unitId,
        }),
      ),
    ),
    approvable: true,
    review:
      resolution.kind === "ready"
        ? buildReviewModel({ catalog, resolution, plan })
        : null,
    publicPlan:
      resolution.kind === "ready"
        ? exportPublicPlan({ catalog, resolution, plan })
        : null,
  });
}

function importedBlockedPlanView(plan: PublicPlan): PlanView {
  return Object.freeze({
    kind: "blocked",
    id: plan.plan_id,
    mode: plan.mode,
    changes: plan.review.changes,
    approvable: false,
    review: null,
    publicPlan: plan,
  });
}

function receiptFromApply(
  operationId: string,
  apply: DurableApplyResult,
  verification: VerificationResult | null,
  extraDiagnostics: readonly DiagnosticView[] = [],
): ReceiptView {
  const diagnostics = Object.freeze([
    ...diagnosticViews(apply.diagnostics),
    ...(verification === null ? [] : diagnosticViews(verification.diagnostics)),
    ...extraDiagnostics,
  ]);
  if (apply.kind === "rejected") {
    return Object.freeze({
      operationId,
      planId: apply.planId,
      result: "rejected",
      materialization: "unchanged",
      certification: "not-run",
      changedPaths: Object.freeze([]),
      diagnostics,
    });
  }
  if (apply.kind === "cancelled") {
    return Object.freeze({
      operationId,
      planId: apply.planId,
      result: "cancelled",
      materialization: "unchanged",
      certification: "not-run",
      changedPaths: Object.freeze([]),
      diagnostics,
    });
  }
  if (apply.kind === "failed") {
    return Object.freeze({
      operationId,
      planId: apply.planId,
      result: "failed",
      materialization: "unknown",
      certification: "not-run",
      changedPaths: Object.freeze([]),
      diagnostics,
    });
  }
  if (apply.kind === "rolled-back" || apply.kind === "recovery-required") {
    return Object.freeze({
      operationId,
      planId: apply.planId,
      result: apply.kind,
      materialization: apply.kind === "rolled-back" ? "rolled-back" : "unknown",
      certification: "not-run",
      changedPaths: Object.freeze([...apply.changedPaths]),
      diagnostics,
    });
  }
  const verified = verification?.materialization === "verified";
  return Object.freeze({
    operationId,
    planId: apply.planId,
    result:
      apply.kind === "no-changes"
        ? "no-changes"
        : verified
          ? "succeeded"
          : "verification-failed",
    materialization:
      apply.kind === "no-changes" ? "unchanged" : verified ? "committed" : "unknown",
    certification:
      verification?.hostDiscovery === "not-observable" ? "unknown" : "not-run",
    changedPaths: Object.freeze([...apply.changedPaths]),
    diagnostics,
  });
}

function diagnosticViews(diagnostics: readonly Diagnostic[]): readonly DiagnosticView[] {
  return Object.freeze(
    diagnostics.map((diagnostic) =>
      Object.freeze({
        code: diagnostic.code,
        severity: diagnostic.severity,
        location: diagnostic.location,
        message: diagnostic.message,
        evidence: diagnostic.evidence,
        impact: diagnostic.impact,
        action: diagnostic.action,
      }),
    ),
  );
}

function interactionDiagnostic(
  code: string,
  severity: DiagnosticView["severity"],
  message: string,
  impact: string,
  action: string | null,
): DiagnosticView {
  return Object.freeze({
    code,
    severity,
    location: null,
    message,
    evidence: Object.freeze([]),
    impact,
    action,
  });
}

function taskLabel(event: ApplicationEvent): string {
  return `${title(event.operation)} · ${event.phase.replaceAll(":", " / ")}`;
}

function title(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function canonical<T extends string>(values: readonly T[]): readonly T[] {
  return Object.freeze([...new Set(values)].sort(compareUtf8));
}

function canonicalSelections(
  selections: readonly ComponentSelectionDraft[],
): readonly ComponentSelectionDraft[] {
  const refs = new Set<ComponentRef>();
  const canonicalized = selections.map((selection) => {
    if (refs.has(selection.ref)) {
      throw new TypeError(`Component ${selection.ref} is selected more than once`);
    }
    refs.add(selection.ref);
    const inputs = Object.freeze(
      Object.fromEntries(
        Object.entries(selection.inputs ?? {})
          .sort(([left], [right]) => compareUtf8(left, right))
          .map(([id, values]) => [id, Object.freeze([...values])]),
      ),
    );
    return Object.freeze({ ref: selection.ref, inputs });
  });
  canonicalized.sort((left, right) => compareUtf8(left.ref, right.ref));
  return Object.freeze(canonicalized);
}

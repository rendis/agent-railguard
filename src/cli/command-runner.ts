import type { InteractionRuntime } from "../interaction/interaction-session.js";
import type { InteractionSnapshot } from "../interaction/model.js";
import {
  publicDiagnostics,
  toPublicEvent,
  type CatalogComponentSummary,
  type CommandData,
  type CommandName,
  type CommandVerdict,
  type PublicInteractionEvent,
} from "../interaction/public-output.js";
import type { PublicPlan } from "../application/serialization/public-plan.js";
import type { CatalogComponent } from "../domain/catalog/model.js";
import {
  compareUtf8,
  type ComponentRef,
  type HarnessTargetId,
} from "../domain/shared/types.js";
import {
  buildCommandResult,
  type CommandResultEnvelope,
  type CommandRun,
} from "./command-result.js";

export interface InputAssignment {
  readonly ref: ComponentRef;
  readonly input: string;
  readonly values: readonly string[];
}

export type ProductCommandRequest =
  | { readonly command: "scan"; readonly root: string }
  | { readonly command: "status"; readonly root: string }
  | {
      readonly command: "init";
      readonly root: string;
      readonly recommended: boolean;
      readonly add: readonly ComponentRef[];
      readonly targets: readonly HarnessTargetId[];
      readonly setInputs: readonly InputAssignment[];
      readonly approve: boolean;
    }
  | {
      readonly command: "plan";
      readonly root: string;
      readonly add: readonly ComponentRef[];
      readonly remove: readonly ComponentRef[];
      readonly targets: readonly HarnessTargetId[] | null;
      readonly setInputs: readonly InputAssignment[];
    }
  | {
      readonly command: "apply";
      readonly root: string;
      readonly plan: PublicPlan;
    }
  | {
      readonly command: "remove";
      readonly root: string;
      readonly all: boolean;
      readonly components: readonly ComponentRef[];
      readonly approve: boolean;
    }
  | {
      readonly command: "sync";
      readonly root: string;
      readonly action: "check" | "plan" | "apply";
    }
  | {
      readonly command: "repair";
      readonly root: string;
      readonly approve: boolean;
    }
  | {
      readonly command: "catalog-list";
      readonly kind: CatalogComponent["kind"] | null;
    }
  | { readonly command: "catalog-show"; readonly ref: ComponentRef }
  | { readonly command: "doctor"; readonly root: string }
  | {
      readonly command: "mcp-status" | "mcp-login" | "mcp-logout";
      readonly root: string;
      readonly component: ComponentRef;
      readonly targets: readonly HarnessTargetId[];
      readonly approve: boolean;
    }
;

export async function runProductCommand(
  runtime: InteractionRuntime,
  request: ProductCommandRequest,
): Promise<CommandRun> {
  const events: PublicInteractionEvent[] = [];
  const unsubscribe = runtime.session.subscribe(({ event }) => {
    events.push(toPublicEvent(event));
  });
  let result: CommandResultEnvelope;
  try {
    result = await execute(runtime, request);
  } finally {
    unsubscribe();
  }
  return Object.freeze({ events: Object.freeze(events), result });
}

async function execute(
  runtime: InteractionRuntime,
  request: ProductCommandRequest,
): Promise<CommandResultEnvelope> {
  switch (request.command) {
    case "scan": {
      const snapshot = await runtime.session.dispatch({ type: "scan", root: request.root });
      return buildCommandResult("scan", snapshot);
    }
    case "status": {
      const snapshot = await runtime.session.dispatch({ type: "scan", root: request.root });
      return buildCommandResult("status", snapshot);
    }
    case "init": {
      let snapshot = await runtime.session.dispatch({ type: "scan", root: request.root });
      if (snapshot.phase !== "browsing") return buildCommandResult("init", snapshot);
      if (snapshot.repository?.management !== "uninitialized") {
        return buildCommandResult("init", snapshot, { verdict: "ALREADY_INITIALIZED" });
      }
      snapshot = await runtime.session.dispatch({
        type: "compose-draft",
        base: "empty",
        recommended: request.recommended,
        add: request.add.map((ref) => ({ ref })),
        remove: [],
        setInputs: request.setInputs,
        targets: request.targets,
      });
      snapshot = await requestPlan(runtime, snapshot, "reconcile", request.approve);
      return buildPlanResult("init", snapshot, request.approve ? null : "PLAN_READY");
    }
    case "plan": {
      let snapshot = await runtime.session.dispatch({ type: "scan", root: request.root });
      if (snapshot.phase !== "browsing") return buildCommandResult("plan", snapshot);
      snapshot = await runtime.session.dispatch({
        type: "compose-draft",
        base: "installed",
        recommended: false,
        add: request.add.map((ref) => ({ ref })),
        remove: request.remove,
        setInputs: request.setInputs,
        targets: request.targets,
      });
      snapshot = await requestPlan(runtime, snapshot, "reconcile", false);
      return buildPlanResult("plan", snapshot, "PLAN_READY");
    }
    case "apply": {
      let snapshot = await runtime.session.dispatch({
        type: "load-plan",
        root: request.root,
        plan: request.plan,
      });
      if (snapshot.phase === "reviewing" && snapshot.plan?.id !== null) {
        snapshot = await runtime.session.dispatch({
          type: "approve-plan",
          planId: snapshot.plan!.id!,
        });
      }
      return buildCommandResult("apply", snapshot);
    }
    case "remove": {
      let snapshot = await runtime.session.dispatch({ type: "scan", root: request.root });
      if (snapshot.phase !== "browsing") return buildCommandResult("remove", snapshot);
      const remove = request.all
        ? snapshot.repository?.installedDirectSelections ?? []
        : request.components;
      snapshot = await runtime.session.dispatch({
        type: "compose-draft",
        base: "installed",
        recommended: false,
        add: [],
        remove,
        setInputs: [],
        targets: null,
      });
      snapshot = await requestPlan(runtime, snapshot, "remove", request.approve);
      return buildPlanResult("remove", snapshot, request.approve ? null : "PLAN_READY");
    }
    case "sync": {
      let snapshot = await runtime.session.dispatch({ type: "scan", root: request.root });
      if (snapshot.phase !== "browsing") return buildCommandResult("sync", snapshot);
      snapshot = await runtime.session.dispatch({ type: "request-managed-plan", mode: "sync" });
      if (request.action === "apply" && snapshot.plan?.id !== null) {
        snapshot = await runtime.session.dispatch({
          type: "approve-plan",
          planId: snapshot.plan!.id!,
        });
      }
      if (request.action === "check" && snapshot.plan?.kind === "ready") {
        return buildCommandResult("sync", snapshot, {
          verdict: snapshot.plan.changes.length > 0 ? "CHANGES_AVAILABLE" : "NO_CHANGES",
        });
      }
      return buildPlanResult("sync", snapshot, request.action === "plan" ? "PLAN_READY" : null);
    }
    case "repair": {
      let snapshot = await runtime.session.dispatch({ type: "scan", root: request.root });
      if (snapshot.phase !== "browsing") return buildCommandResult("repair", snapshot);
      snapshot = await runtime.session.dispatch({ type: "request-managed-plan", mode: "repair" });
      if (request.approve && snapshot.plan?.id !== null) {
        snapshot = await runtime.session.dispatch({
          type: "approve-plan",
          planId: snapshot.plan!.id!,
        });
      }
      return buildPlanResult("repair", snapshot, request.approve ? null : "PLAN_READY");
    }
    case "catalog-list":
      return await catalogList(runtime, request.kind);
    case "catalog-show":
      return await catalogShow(runtime, request.ref);
    case "doctor":
      return await doctor(runtime, request.root);
    case "mcp-status":
    case "mcp-login":
    case "mcp-logout":
      return await mcpSession(runtime, request);
  }
}

async function mcpSession(
  runtime: InteractionRuntime,
  request: Extract<ProductCommandRequest, { readonly command: "mcp-status" | "mcp-login" | "mcp-logout" }>,
): Promise<CommandResultEnvelope> {
  const snapshot = await runtime.session.dispatch({ type: "scan", root: request.root });
  if (snapshot.phase !== "browsing") return buildCommandResult(request.command, snapshot);
  const operation = request.command === "mcp-status"
    ? "inspect"
    : request.command === "mcp-login"
      ? "login"
      : "logout";
  const effectiveOperation = operation === "inspect" || request.approve ? operation : "inspect";
  const result = await runtime.applicationRuntime.application.mcpSession(
    request.root,
    request.component,
    request.targets,
    effectiveOperation,
  );
  const actionRequired = operation !== effectiveOperation || result.results.some(
    (entry) => entry.action?.kind === "guided"
      || (operation === "login" && entry.state === "authentication-required"),
  );
  const succeeded = !actionRequired && result.results.every((entry) =>
    operation === "logout"
      ? entry.state === "authentication-required" || entry.state === "authenticated"
      : entry.state === "authenticated",
  );
  return buildCommandResult(request.command, runtime.session.snapshot, {
    verdict: succeeded ? "SUCCEEDED" : "READY",
    data: Object.freeze({
      kind: "mcp-session",
      component: result.component,
      operation: result.operation,
      results: result.results,
    }),
  });
}

async function requestPlan(
  runtime: InteractionRuntime,
  snapshot: InteractionSnapshot,
  mode: "reconcile" | "remove",
  approve: boolean,
): Promise<InteractionSnapshot> {
  if (snapshot.draft?.blocked === true) return snapshot;
  let next = await runtime.session.dispatch({ type: "request-plan", mode });
  if (approve && next.phase === "reviewing" && next.plan?.id !== null) {
    next = await runtime.session.dispatch({
      type: "approve-plan",
      planId: next.plan!.id!,
    });
  }
  return next;
}

function buildPlanResult(
  command: CommandName,
  snapshot: InteractionSnapshot,
  plannedVerdict: CommandVerdict | null,
): CommandResultEnvelope {
  if (
    plannedVerdict !== null &&
    (snapshot.phase !== "reviewing" || snapshot.plan?.kind !== "ready")
  ) {
    return buildCommandResult(command, snapshot);
  }
  if (
    plannedVerdict !== null &&
    snapshot.plan?.kind === "ready" &&
    snapshot.plan.changes.length === 0
  ) {
    return buildCommandResult(command, snapshot, { verdict: "NO_CHANGES" });
  }
  return buildCommandResult(command, snapshot, {
    ...(plannedVerdict === null ? {} : { verdict: plannedVerdict }),
  });
}

async function catalogList(
  runtime: InteractionRuntime,
  kind: CatalogComponent["kind"] | null,
): Promise<CommandResultEnvelope> {
  const loaded = await runtime.applicationRuntime.application.catalog();
  if (loaded.kind !== "ready") {
    return buildCommandResult("catalog-list", runtime.session.snapshot, {
      verdict: "BLOCKED",
      diagnostics: publicDiagnostics(loaded.diagnostics),
    });
  }
  const components = loaded.catalog.components
    .filter(
      (component) =>
        component.kind !== "instruction-fragment" && (kind === null || component.kind === kind),
    )
    .map(catalogSummary)
    .sort((left, right) => compareUtf8(left.ref, right.ref));
  const data: CommandData = Object.freeze({
    kind: "catalog-list",
    components: Object.freeze(components),
  });
  return buildCommandResult("catalog-list", runtime.session.snapshot, {
    verdict: "READY",
    data,
    diagnostics: publicDiagnostics(loaded.diagnostics),
  });
}

async function catalogShow(
  runtime: InteractionRuntime,
  ref: ComponentRef,
): Promise<CommandResultEnvelope> {
  const loaded = await runtime.applicationRuntime.application.catalog();
  if (loaded.kind !== "ready") {
    return buildCommandResult("catalog-show", runtime.session.snapshot, {
      verdict: "BLOCKED",
      diagnostics: publicDiagnostics(loaded.diagnostics),
    });
  }
  const component = loaded.catalog.components.find((candidate) => candidate.ref === ref);
  if (component === undefined) {
    throw new CommandInputError(`Catalog component not found: ${ref}`);
  }
  return buildCommandResult("catalog-show", runtime.session.snapshot, {
    verdict: "READY",
    data: Object.freeze({ kind: "catalog-show", component: catalogSummary(component) }),
    diagnostics: publicDiagnostics(loaded.diagnostics),
  });
}

async function doctor(
  runtime: InteractionRuntime,
  root: string,
): Promise<CommandResultEnvelope> {
  await runtime.session.dispatch({ type: "scan", root });
  const result = await runtime.applicationRuntime.application.doctor(root);
  return buildCommandResult("doctor", runtime.session.snapshot, {
    verdict: result.kind === "ready" ? "READY" : "BLOCKED",
    data: Object.freeze({ kind: "doctor", checks: result.checks }),
    diagnostics: publicDiagnostics(result.diagnostics),
  });
}

function catalogSummary(component: CatalogComponent): CatalogComponentSummary {
  return Object.freeze({
    ref: component.ref,
    kind: component.kind,
    version: component.version,
    description: component.description,
    details: component.details,
    trust: component.trust,
    applies_languages: component.applies?.languages ?? Object.freeze([]),
    relations: component.relations,
  });
}

export class CommandInputError extends TypeError {
  public constructor(message: string) {
    super(message);
    this.name = "CommandInputError";
  }
}

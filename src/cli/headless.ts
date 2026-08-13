import type {
  ComponentRef,
  HarnessTargetId,
} from "../domain/shared/types.js";
import type {
  DiagnosticView,
  InteractionSession,
  InteractionSnapshot,
  ReceiptVerdict,
} from "../interaction/model.js";
import {
  publicReceipt,
  publicRepository,
  toPublicEvent,
  type CommandVerdict,
  type CommandName,
  type CommandData,
  type PublicInteractionEvent,
  type PublicReceiptView,
  type PublicRepositoryView,
} from "../interaction/public-output.js";
import type { PublicPlan } from "../application/serialization/public-plan.js";
import {
  encodePublicEvent,
  encodePublicResult,
} from "../application/serialization/public-contracts.js";
import { exitCodeForVerdict } from "./exit-codes.js";

export { exitCodeForVerdict } from "./exit-codes.js";

export type PrototypeCommand = "scan" | "init" | "apply" | "remove";

export type HeadlessRequest =
  | {
      readonly command: "scan";
      readonly root: string;
    }
  | {
      readonly command: "init";
      readonly root: string;
      readonly recommended: boolean;
      readonly directSelections: readonly ComponentRef[];
      readonly targets: readonly HarnessTargetId[];
      readonly approve: boolean;
    }
  | {
      readonly command: "remove";
      readonly root: string;
      readonly remainingDirectSelections: readonly ComponentRef[];
      readonly targets: readonly HarnessTargetId[];
      readonly approve: boolean;
    }
  | {
      readonly command: "apply";
      readonly root: string;
      readonly plan: PublicPlan;
      readonly approve: boolean;
    };

export interface CommandResultEnvelope {
  readonly schema: "ai-harness/command-result/v1";
  readonly type: "result";
  readonly command: CommandName;
  readonly operation_id: string;
  readonly verdict: CommandVerdict;
  readonly exit_code: number;
  readonly repository: PublicRepositoryView | null;
  readonly direct_selections: readonly ComponentRef[];
  readonly components: NonNullable<InteractionSnapshot["draft"]>["components"];
  readonly plan: PublicPlan | null;
  readonly receipt: PublicReceiptView | null;
  readonly data: CommandData | null;
  readonly diagnostics: readonly DiagnosticView[];
}

export interface HeadlessRun {
  readonly events: readonly PublicInteractionEvent[];
  readonly result: CommandResultEnvelope;
}

export async function runHeadless(
  session: InteractionSession,
  request: HeadlessRequest,
): Promise<HeadlessRun> {
  const events: PublicInteractionEvent[] = [];
  const unsubscribe = session.subscribe(({ event }) => events.push(toPublicEvent(event)));
  let snapshot: InteractionSnapshot;
  try {
    if (request.command === "apply") {
      snapshot = await session.dispatch({
        type: "load-plan",
        root: request.root,
        plan: request.plan,
      });
    } else {
      snapshot = await session.dispatch({ type: "scan", root: request.root });
    }
    if (
      request.command !== "scan" &&
      request.command !== "apply" &&
      snapshot.phase === "browsing"
    ) {
      const directSelections =
        request.command === "init"
          ? canonical([
              ...request.directSelections,
              ...(request.recommended
                ? snapshot.recommendations.map((recommendation) => recommendation.ref)
                : []),
            ])
          : canonical(request.remainingDirectSelections);
      snapshot = await session.dispatch({
        type: "replace-draft",
        selections: directSelections.map((ref) => Object.freeze({ ref })),
        targets: request.targets,
      });
      if (snapshot.draft?.blocked !== true) {
        snapshot = await session.dispatch({
          type: "request-plan",
          mode: request.command === "remove" ? "remove" : "reconcile",
        });
      }
    }
    if (
      request.command !== "scan" &&
      request.approve &&
      snapshot.phase === "reviewing" &&
      snapshot.plan?.approvable === true &&
      snapshot.plan.id !== null
    ) {
      snapshot = await session.dispatch({
        type: "approve-plan",
        planId: snapshot.plan.id,
      });
    }
  } finally {
    unsubscribe();
  }
  return Object.freeze({
    events: Object.freeze(events),
    result: buildCommandResult(request.command, snapshot!),
  });
}

export function serializeHeadlessRun(
  run: HeadlessRun,
  format: "json" | "ndjson",
): string {
  if (format === "json") {
    return encodePublicResult(run.result);
  }
  return `${[
    ...run.events.map((event) => encodePublicEvent(event).trimEnd()),
    encodePublicResult(run.result).trimEnd(),
  ].join("\n")}\n`;
}

export function buildCommandResult(
  command: CommandName,
  snapshot: InteractionSnapshot,
  overrides: {
    readonly verdict?: CommandVerdict;
    readonly data?: CommandData | null;
    readonly diagnostics?: readonly DiagnosticView[];
  } = {},
): CommandResultEnvelope {
  const verdict = overrides.verdict ?? verdictForSnapshot(snapshot);
  return Object.freeze({
    schema: "ai-harness/command-result/v1",
    type: "result",
    command,
    operation_id: snapshot.operationId,
    verdict,
    exit_code: exitCodeForVerdict(verdict),
    repository: snapshot.repository === null ? null : publicRepository(snapshot.repository),
    direct_selections: snapshot.draft?.directSelections ?? Object.freeze([]),
    components: snapshot.draft?.components ?? Object.freeze([]),
    plan: snapshot.plan?.publicPlan ?? null,
    receipt: snapshot.receipt === null ? null : publicReceipt(snapshot.receipt),
    data: overrides.data ?? null,
    diagnostics: overrides.diagnostics ?? snapshot.diagnostics,
  });
}

function verdictForSnapshot(snapshot: InteractionSnapshot): CommandVerdict {
  if (snapshot.receipt !== null) {
    return receiptVerdict(snapshot.receipt.result);
  }
  if (snapshot.phase === "reviewing" && snapshot.plan?.approvable === true) {
    return "PLAN_READY";
  }
  if (snapshot.phase === "browsing") {
    return "READY";
  }
  if (snapshot.phase === "cancelled") {
    return "CANCELLED";
  }
  return "BLOCKED";
}

function receiptVerdict(verdict: ReceiptVerdict): CommandVerdict {
  return verdict.replaceAll("-", "_").toUpperCase() as CommandVerdict;
}

function canonical<T extends string>(values: readonly T[]): readonly T[] {
  return Object.freeze([...new Set(values)].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
  ));
}

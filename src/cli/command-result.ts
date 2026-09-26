import type { ComponentRef } from "../domain/shared/types.js";
import type {
  DiagnosticView,
  InteractionSnapshot,
  ReceiptVerdict,
} from "../interaction/model.js";
import {
  publicReceipt,
  publicRepository,
  type CommandVerdict,
  type CommandName,
  type CommandData,
  type PublicInteractionEvent,
  type PublicReceiptView,
  type PublicRepositoryView,
} from "../interaction/public-output.js";
import type { PublicPlan } from "../application/serialization/public-plan.js";
import { exitCodeForVerdict } from "./exit-codes.js";

export interface CommandResultEnvelope {
  readonly schema: "railguard/command-result/v1";
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

export interface CommandRun {
  readonly events: readonly PublicInteractionEvent[];
  readonly result: CommandResultEnvelope;
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
    schema: "railguard/command-result/v1",
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

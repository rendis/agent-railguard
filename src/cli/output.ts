import { randomUUID } from "node:crypto";
import { encodePublicResult } from "../application/serialization/public-contracts.js";
import type { DiagnosticView, InteractionTask } from "../interaction/model.js";
import type {
  CommandName,
  PublicInteractionEvent,
} from "../interaction/public-output.js";
import type { CommandResultEnvelope, HeadlessRun } from "./headless.js";
import { exitCodeForVerdict } from "./exit-codes.js";

export type OutputFormat = "text" | "json" | "ndjson";

export function renderRun(run: HeadlessRun, format: OutputFormat): string {
  if (format === "json") return encodePublicResult(run.result);
  if (format === "ndjson") {
    return `${[
      ...run.events.map((event) => JSON.stringify(event)),
      JSON.stringify(run.result),
    ].join("\n")}\n`;
  }
  return renderHumanResult(run.result);
}

export function renderProgress(event: PublicInteractionEvent): string | null {
  if (event.type !== "task") return null;
  const suffix =
    event.task.current === undefined || event.task.total === undefined
      ? ""
      : ` ${event.task.current}/${event.task.total}`;
  return `${taskMark(event.task.state)} ${event.task.label}${suffix} — ${event.task.detail ?? event.task.state}\n`;
}

export function invalidInputRun(
  command: CommandName,
  message: string,
): HeadlessRun {
  return errorRun(command, "INVALID_INPUT", "cli.input-invalid", message, "Run ai-harness --help or the command-specific --help and correct the input.");
}

export function internalErrorRun(
  command: CommandName,
  message: string,
): HeadlessRun {
  return errorRun(
    command,
    "INTERNAL_ERROR",
    "cli.internal-error",
    message,
    "Retry with --format ndjson for operation events; report the diagnostic if it persists.",
  );
}

function errorRun(
  command: CommandName,
  verdict: "INVALID_INPUT" | "INTERNAL_ERROR",
  code: string,
  message: string,
  action: string,
): HeadlessRun {
  const diagnostic: DiagnosticView = Object.freeze({
    code,
    severity: "failed",
    message,
    impact: "No repository mutation was attempted.",
    action,
  });
  const result: CommandResultEnvelope = Object.freeze({
    schema: "ai-harness/command-result/v1",
    type: "result",
    command,
    operation_id: randomUUID(),
    verdict,
    exit_code: exitCodeForVerdict(verdict),
    repository: null,
    direct_selections: Object.freeze([]),
    components: Object.freeze([]),
    plan: null,
    receipt: null,
    data: null,
    diagnostics: Object.freeze([diagnostic]),
  });
  return Object.freeze({ events: Object.freeze([]), result });
}

function renderHumanResult(result: CommandResultEnvelope): string {
  const lines = [
    `AI Harness · ${result.command}`,
    `Verdict: ${result.verdict}`,
  ];
  if (result.repository !== null) {
    lines.push(`Repository: ${result.repository.root}`);
    lines.push(`Stack: ${result.repository.languages.join(", ") || "not detected"}`);
    lines.push(
      `State: ${result.repository.management} · ${result.repository.integrity} · ${result.repository.readiness}`,
    );
  }
  if (result.plan !== null) {
    lines.push(`Plan: ${result.plan.plan_id}`);
    lines.push(
      `Changes: ${result.plan.review.changes.length} · Direct: ${result.plan.review.direct.length} · Required: ${result.plan.review.required.length}`,
    );
    for (const change of result.plan.review.changes) {
      lines.push(`  ${change.action.padEnd(7)} ${change.path}`);
    }
  }
  if (result.receipt !== null) {
    lines.push(`Receipt: ${result.receipt.result} · ${result.receipt.materialization}`);
    lines.push(`Changed paths: ${result.receipt.changed_paths.length}`);
  }
  if (result.data?.kind === "catalog-list") {
    lines.push(`Catalog components: ${result.data.components.length}`);
    for (const component of result.data.components) {
      lines.push(`  ${component.ref} ${component.version} · ${component.description}`);
    }
  } else if (result.data?.kind === "catalog-show") {
    const component = result.data.component;
    lines.push(`${component.ref} ${component.version}`);
    lines.push(`${component.kind} · ${component.trust}`);
    lines.push(component.description);
    lines.push("");
    lines.push(component.details);
    for (const relation of component.relations) {
      lines.push(`  ${relation.kind} ${relation.target} — ${relation.reason}`);
    }
  } else if (result.data?.kind === "doctor") {
    for (const check of result.data.checks) {
      lines.push(`  ${check.status.padEnd(7)} ${check.id} — ${check.message}`);
    }
  } else if (result.data?.kind === "update") {
    lines.push(
      `Update: ${result.data.status} · current ${result.data.current_version} · latest ${result.data.latest_version ?? "unknown"}`,
    );
  } else if (result.data?.kind === "mcp-session") {
    lines.push(`MCP: ${result.data.component} · ${result.data.operation}`);
    for (const target of result.data.results) {
      lines.push(`  ${target.target.padEnd(12)} ${target.state} — ${target.message}`);
      if (target.action !== null) lines.push(`    Next: ${target.action.description}`);
    }
  }
  for (const diagnostic of result.diagnostics) {
    lines.push(`${diagnostic.severity.toUpperCase()} ${diagnostic.code}: ${diagnostic.message}`);
    if (diagnostic.action !== null) lines.push(`  Next: ${diagnostic.action}`);
  }
  return `${lines.join("\n")}\n`;
}

function taskMark(state: InteractionTask["state"]): string {
  switch (state) {
    case "done":
      return "✓";
    case "failed":
      return "×";
    case "warning":
      return "!";
    case "skipped":
      return "–";
    case "running":
      return "›";
    default:
      return "·";
  }
}

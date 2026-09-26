import type {
  CatalogItemView,
  DiagnosticView,
  InteractionSnapshot,
  ReceiptView,
} from "../interaction/model.js";

/** Plain-text views of the interaction snapshot shown by the interactive wizard. */

export const families = [
  { id: "pack", label: "Packs" },
  { id: "skill", label: "Skills" },
  { id: "mcp-integration", label: "MCP" },
  { id: "agent", label: "Agents" },
  { id: "verification-profile", label: "Quality" },
  { id: "git-gate", label: "Git hooks" },
  { id: "agent-hook", label: "Agent hooks" },
] as const satisfies readonly { readonly id: CatalogItemView["kind"]; readonly label: string }[];

export function scanSummary(snapshot: InteractionSnapshot): string {
  const repository = snapshot.repository;
  if (repository === null) return "No repository information.";
  const harnesses = repository.harnesses
    .map((harness) => `${harness.id}${harness.detected ? "" : " (not detected)"}`)
    .join(", ");
  const lines = [
    `Repository   ${repository.root}`,
    `Stack        ${repository.languages.length === 0 ? "none detected" : repository.languages.join(", ")}`,
    `Harnesses    ${harnesses}`,
    `Project      ${projectState(snapshot)}`,
  ];
  if (repository.management !== "uninitialized") {
    lines.push(`Installed    ${repository.installedDirectSelections.join(", ") || "nothing"}`);
    lines.push(`Targets      ${repository.installedTargets.join(", ") || "none"}`);
  }
  if (snapshot.recommendations.length > 0) {
    lines.push(`Recommended  ${snapshot.recommendations.map((entry) => entry.ref).join(", ")}`);
  }
  const warnings = snapshot.diagnostics.filter((diagnostic) => diagnostic.severity !== "info");
  if (warnings.length > 0) lines.push(`Warnings     ${warnings.length}`);
  return lines.join("\n");
}

function projectState(snapshot: InteractionSnapshot): string {
  const repository = snapshot.repository;
  if (repository === null) return "unknown";
  if (repository.management === "uninitialized") return "not configured by Railguard";
  const parts: string[] = [repository.management, repository.integrity];
  if (repository.updates === "available") parts.push("content updates available");
  return parts.join(", ");
}

export function scanDetails(snapshot: InteractionSnapshot): string {
  const tasks = snapshot.tasks.map((task) => `${taskMark(task.state)} ${task.label}${task.detail === null ? "" : ` — ${task.detail}`}`);
  const diagnostics = snapshot.diagnostics.map(diagnosticLine);
  return [...tasks, ...(diagnostics.length === 0 ? [] : ["", ...diagnostics])].join("\n");
}

export function componentLabel(item: CatalogItemView): string {
  return item.ref.slice(item.ref.indexOf(":") + 1);
}

export function componentHint(item: CatalogItemView): string {
  const text = item.recommended ? `recommended · ${item.description}` : item.description;
  return truncate(text, 90);
}

export function componentDetails(item: CatalogItemView): string {
  return [
    `${item.ref} ${item.version}`,
    "",
    item.details,
    "",
    `Changes   ${item.impact.changes}`,
    `Workflow  ${item.impact.workflow}`,
    `Trust     ${item.trust}`,
  ].join("\n");
}

export function draftSummary(snapshot: InteractionSnapshot): string {
  const draft = snapshot.draft;
  if (draft === null) return "No selection.";
  const direct = draft.components.filter((component) => component.origin === "direct");
  const required = draft.components.filter((component) => component.origin === "required");
  return [
    `Selected (${direct.length})`,
    ...direct.map((component) => `  ${component.ref}`),
    ...(required.length === 0
      ? []
      : [`Included as dependencies (${required.length})`, ...required.map((component) => `  + ${component.ref}  ← ${component.causes.join("; ")}`)]),
    `Targets   ${draft.targets.join(", ") || "none yet"}`,
  ].join("\n");
}

export function planReview(snapshot: InteractionSnapshot): string {
  const plan = snapshot.plan;
  const review = plan?.review ?? null;
  if (plan === null) return "No plan.";
  if (review === null) {
    return plan.changes.map((change) => `${change.action.padEnd(8)}${change.path}`).join("\n") || "No changes.";
  }
  const lines: string[] = [];
  lines.push(`Components  ${review.direct.map((component) => component.ref).join(", ") || "none"}`);
  if (review.required.length > 0) {
    lines.push(`Required    ${review.required.map((component) => component.ref).join(", ")}`);
  }
  lines.push("", `File changes (${review.changes.length})`);
  for (const change of review.changes) {
    lines.push(`  ${change.action.padEnd(8)}${change.path}${change.section === null ? "" : `  [${change.section}]`}`);
  }
  for (const entry of review.gitConfig) {
    lines.push("", `Git config  ${entry.action} ${entry.key}${entry.value === null ? "" : ` = ${entry.value}`}`);
  }
  if (review.hooks.length > 0) {
    lines.push("", "Git hooks");
    for (const hook of review.hooks) lines.push(`  ${hook.event.padEnd(11)}${hook.command}`);
  }
  if (review.runtimes.length > 0) {
    lines.push("", "MCP runtimes");
    for (const runtime of review.runtimes) {
      const connection = runtime.connection.type === "stdio" ? runtime.connection.command.join(" ") : runtime.connection.url;
      lines.push(`  ${runtime.component}  ${connection}  (auth: ${runtime.auth})`);
    }
  }
  if (review.prerequisites.length > 0) {
    lines.push("", "Prerequisites", ...review.prerequisites.map((entry) => `  ${entry}`));
  }
  if (review.applyExecutes.length > 0) {
    lines.push("", "Apply runs", ...review.applyExecutes.map((entry) => `  ${entry}`));
  }
  return lines.join("\n");
}

export function receiptSummary(receipt: ReceiptView): string {
  return [
    `Result   ${receipt.result}`,
    `Changed  ${receipt.changedPaths.length} path(s)`,
    ...receipt.changedPaths.slice(0, 12).map((path) => `  ${path}`),
    ...(receipt.changedPaths.length > 12 ? [`  … ${receipt.changedPaths.length - 12} more`] : []),
    ...receipt.diagnostics.filter((diagnostic) => diagnostic.severity !== "info").map(diagnosticLine),
  ].join("\n");
}

export function mcpSessionSummary(snapshot: InteractionSnapshot): string {
  const session = snapshot.mcpSession;
  if (session === null) return "No MCP session result.";
  return [
    `${session.component} · ${session.operation}`,
    ...session.results.map((result) => {
      const action = result.action === null
        ? ""
        : `\n    next: ${result.action.command === null ? result.action.description : result.action.command.join(" ")}`;
      return `  ${result.target.padEnd(12)}${result.state}  ${result.message}${action}`;
    }),
  ].join("\n");
}

export function diagnosticLine(diagnostic: DiagnosticView): string {
  const where = diagnostic.location === null ? "" : ` (${diagnostic.location.path})`;
  const next = diagnostic.action === null ? "" : `\n    next: ${diagnostic.action}`;
  return `${diagnostic.severity.toUpperCase()} ${diagnostic.code}${where}: ${diagnostic.message}${next}`;
}

export function exitSummary(snapshot: InteractionSnapshot): string {
  const receipt = snapshot.receipt;
  if (receipt === null) return "No repository changes applied.";
  return `${receipt.result}: ${receipt.changedPaths.length} path(s) changed.`;
}

function taskMark(state: string): string {
  switch (state) {
    case "done": return "✓";
    case "failed": return "✗";
    case "warning": return "!";
    case "running": return "…";
    default: return "·";
  }
}

function truncate(text: string, length: number): string {
  return text.length <= length ? text : `${text.slice(0, length - 1)}…`;
}

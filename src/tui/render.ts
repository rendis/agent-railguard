import { styleText } from "node:util";
import type {
  CatalogItemView,
  DiagnosticView,
  InteractionSnapshot,
  ReceiptView,
} from "../interaction/model.js";

/** Plain-text views of the interaction snapshot shown by the interactive wizard. */

// Every icon is a double-width emoji without a variation selector, so labels stay aligned.
export const families = [
  { id: "pack", icon: "📦", label: "Packs" },
  { id: "skill", icon: "🧠", label: "Skills" },
  { id: "mcp-integration", icon: "🔌", label: "MCP" },
  { id: "agent", icon: "🤖", label: "Agents" },
  { id: "verification-profile", icon: "🧪", label: "Quality" },
  { id: "git-gate", icon: "🌿", label: "Git hooks" },
  { id: "agent-hook", icon: "🪝", label: "Agent hooks" },
] as const satisfies readonly {
  readonly id: CatalogItemView["kind"];
  readonly icon: string;
  readonly label: string;
}[];

export function familyTitle(family: (typeof families)[number]): string {
  return `${family.icon} ${family.label}`;
}

export function scanSummary(snapshot: InteractionSnapshot, home = process.env["HOME"] ?? ""): string {
  const repository = snapshot.repository;
  if (repository === null) return "No repository information.";
  const managed = repository.management !== "uninitialized";
  const configured = new Set<string>(managed ? repository.installedTargets : []);
  const harnessGroups = [
    { label: "configured", ids: repository.harnesses.filter((harness) => configured.has(harness.id)) },
    {
      label: managed ? "detected, not configured" : "detected",
      ids: repository.harnesses.filter((harness) => harness.detected && !configured.has(harness.id)),
    },
    { label: "not detected", ids: repository.harnesses.filter((harness) => !harness.detected && !configured.has(harness.id)) },
  ]
    .filter((group) => group.ids.length > 0)
    .map((group) => `${group.ids.map((harness) => harness.id).join(", ")} (${group.label})`);
  const lines = [
    `Path         ${homeRelative(repository.root, home)}`,
    `Stack        ${repository.languages.length === 0 ? "none detected" : repository.languages.join(", ")}`,
    `Status       ${projectState(snapshot)}`,
    ...(harnessGroups.length === 0 ? ["none"] : harnessGroups).map((group, index) => `${index === 0 ? "Harnesses" : ""}`.padEnd(13) + group),
  ];
  if (managed) {
    lines.push("", ...refsByFamily(`Installed (${repository.installedDirectSelections.length})`, repository.installedDirectSelections));
  }
  if (snapshot.recommendations.length > 0) {
    const recommended = snapshot.recommendations.map((entry) => entry.ref);
    lines.push("", ...refsByFamily(`Recommended (${recommended.length})`, recommended));
  }
  const warnings = snapshot.diagnostics.filter((diagnostic) => diagnostic.severity !== "info");
  if (warnings.length > 0) lines.push("", `${warnings.length} warning(s): choose "Show scan details" to read them.`);
  return lines.join("\n");
}

function refsByFamily(title: string, refs: readonly string[]): string[] {
  if (refs.length === 0) return [`${title.replace(/ \(0\)$/, "")}  nothing`];
  const groups = new Map<string, string[]>();
  for (const ref of refs) {
    const kind = ref.slice(0, ref.indexOf(":"));
    groups.set(kind, [...(groups.get(kind) ?? []), ref.slice(ref.indexOf(":") + 1)]);
  }
  const known = new Set<string>(families.map((family) => family.id));
  const lines = families
    .filter((family) => groups.has(family.id))
    .map((family) => `  ${family.icon} ${family.label.padEnd(12)}${(groups.get(family.id) ?? []).join(", ")}`);
  for (const [kind, names] of groups) {
    if (!known.has(kind)) lines.push(`     ${kind.padEnd(12)}${names.join(", ")}`);
  }
  return [title, ...lines];
}

function homeRelative(path: string, home: string): string {
  return home !== "" && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}

function projectState(snapshot: InteractionSnapshot): string {
  const repository = snapshot.repository;
  if (repository === null) return "unknown";
  if (repository.management === "uninitialized") return "not configured by Railguard yet";
  const parts = [repository.management === "managed" ? "configured by Railguard" : "partially applied: run Configure to finish"];
  if (repository.integrity === "clean") parts.push("managed files unchanged");
  if (repository.integrity === "drifted") parts.push("managed files edited or missing");
  if (repository.updates === "available") parts.push("content updates available");
  return parts.join("; ");
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
  return `${styleText(severityColor(diagnostic.severity), diagnostic.severity.toUpperCase())} ${diagnostic.code}${where}: ${diagnostic.message}${next}`;
}

export function exitSummary(snapshot: InteractionSnapshot): string {
  const receipt = snapshot.receipt;
  if (receipt === null) return "No repository changes applied.";
  return `${receipt.result}: ${receipt.changedPaths.length} path(s) changed.`;
}

function taskMark(state: string): string {
  switch (state) {
    case "done": return styleText("green", "✓");
    case "failed": return styleText("red", "✗");
    case "warning": return styleText("yellow", "!");
    case "running": return styleText("cyan", "…");
    default: return styleText("dim", "·");
  }
}

function severityColor(severity: DiagnosticView["severity"]): "red" | "yellow" | "dim" {
  if (severity === "info") return "dim";
  return severity === "warning" ? "yellow" : "red";
}

function truncate(text: string, length: number): string {
  return text.length <= length ? text : `${text.slice(0, length - 1)}…`;
}

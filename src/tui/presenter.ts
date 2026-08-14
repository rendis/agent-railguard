import type {
  DraftView,
  InteractionPhase,
  InteractionSnapshot,
  InteractionTask,
} from "../interaction/model.js";

export type LayoutMode = "wide" | "medium" | "compact" | "unsupported";
export type SemanticTone = "cyan" | "green" | "yellow" | "red" | "gray";

export interface KeyAction {
  readonly key: string;
  readonly label: string;
}

export interface ConfigureKeyContext {
  readonly stage: "components" | "targets";
  readonly focus: "filters" | "items";
  readonly filterCount: number;
  readonly componentCount: number;
  readonly targetCount: number;
  readonly canContinue: boolean;
}

export interface PaneWidths {
  readonly navigation: number;
  readonly detail: number;
}

export function isResumableDraft(draft: DraftView | null): draft is DraftView {
  return draft !== null && (draft.directSelections.length > 0 || draft.targets.length > 0);
}

export function asciiMode(): boolean {
  if (process.env.AI_HARNESS_ASCII === "1") return true;
  if (process.env.AI_HARNESS_ASCII === "0") return false;
  return process.env.TERM === "dumb";
}

export function terminalText(value: string): string {
  if (!asciiMode()) return value;
  return value
    .replaceAll(" · ", " | ")
    .replaceAll("→", "->")
    .replaceAll("…", "~")
    .replaceAll("✓", "v")
    .replaceAll("○", "o")
    .replaceAll("◐", ">")
    .replaceAll("×", "x")
    .replaceAll("–", "-")
    .replaceAll("├─", "|-")
    .replaceAll("└─", "\\-");
}

export function tuiBorderStyle(): "single" | "classic" {
  return asciiMode() ? "classic" : "single";
}

export const configureFilters = [
  "Recommended",
  "All",
  "Packs",
  "Skills",
  "MCP",
  "Agents",
  "Quality",
  "Git Hooks",
  "Installed",
] as const;

export const transactionSteps = ["Review", "Apply", "Verify", "Receipt"] as const;

export function layoutMode(columns: number, rows: number): LayoutMode {
  if (columns < 60 || rows < 18) {
    return "unsupported";
  }
  if (columns >= 140 && rows >= 30) {
    return "wide";
  }
  if (columns >= 90 && rows >= 24) {
    return "medium";
  }
  return "compact";
}

export function paneWidths(
  layout: Exclude<LayoutMode, "unsupported">,
  columns: number,
): PaneWidths {
  if (layout === "wide") {
    return {
      navigation: clamp(Math.floor(columns * 0.2), 36, 44),
      detail: clamp(Math.floor(columns * 0.28), 40, 56),
    };
  }
  if (layout === "medium") {
    return {
      navigation: clamp(Math.floor(columns * 0.36), 34, 40),
      detail: 0,
    };
  }
  return { navigation: 0, detail: 0 };
}

export function transactionStep(phase: InteractionPhase): number {
  if (phase === "applying") {
    return 1;
  }
  if (phase === "verifying") {
    return 2;
  }
  if (phase === "receipted" || phase === "cancelled") {
    return 3;
  }
  return 0;
}

export function isTransaction(phase: InteractionPhase): boolean {
  return (
    phase === "planning" ||
    phase === "reviewing" ||
    phase === "applying" ||
    phase === "verifying" ||
    phase === "receipted" ||
    phase === "cancelled"
  );
}

export function healthFacets(snapshot: InteractionSnapshot, updates?: string): readonly {
  readonly label: string;
  readonly value: string;
  readonly tone: SemanticTone;
}[] {
  const blocked = snapshot.phase === "blocked";
  const successful =
    snapshot.receipt?.result === "succeeded" ||
    snapshot.receipt?.result === "no-changes";
  const removed = successful && snapshot.plan?.mode === "remove";
  const management = successful
    ? removed
      ? "uninitialized"
      : "managed"
    : snapshot.repository?.management ?? "uninitialized";
  const integrity = blocked
    ? "blocked"
    : successful
      ? "clean"
      : snapshot.repository?.integrity ?? "unknown";
  const ready = snapshot.repository?.readiness === "ready";
  const readiness = blocked
    ? "blocked"
    : ready
      ? "ready"
      : snapshot.phase === "scanning"
        ? "checking"
        : "unknown";
  return [
    { label: "Management", value: management, tone: healthTone(management) },
    { label: "Integrity", value: integrity, tone: healthTone(integrity) },
    { label: "Readiness", value: readiness, tone: healthTone(readiness) },
    {
      label: "Updates",
      value: updates ?? snapshot.repository?.updates ?? "unknown",
      tone: healthTone(updates ?? snapshot.repository?.updates ?? "unknown"),
    },
  ];
}

export function keyActions(
  snapshot: InteractionSnapshot,
  configure?: ConfigureKeyContext,
): readonly KeyAction[] {
  switch (snapshot.phase) {
    case "browsing":
      return [
        { key: "Enter", label: "Configure components" },
        ...(hasInstalledOauthMcp(snapshot)
          ? [
              { key: "c", label: "Check MCP authentication" },
              { key: "a", label: "Authenticate MCP" },
              { key: "l", label: "Logout MCP" },
            ]
          : []),
        { key: "d", label: "Scan details" },
        { key: "q", label: "Quit" },
      ];
    case "drafting":
      {
        const stage = configure?.stage ?? "components";
        const focus = configure?.focus ?? "items";
        const focusedCount = stage === "targets"
          ? configure?.targetCount
          : focus === "filters"
            ? configure?.filterCount
            : configure?.componentCount;
        const actions: KeyAction[] = [];
        if (focusedCount === undefined || focusedCount > 1) {
          actions.push({ key: asciiMode() ? "Up/Down" : "↑↓", label: "Move" });
        }
        if (stage === "components" && focus === "filters") {
          actions.push({ key: asciiMode() ? "Right" : "→", label: "Browse components" });
        } else if (focusedCount === undefined || focusedCount > 0) {
          actions.push({ key: "Space", label: "Toggle" });
        }
        if (stage === "components" && focus === "items") {
          actions.push({ key: asciiMode() ? "Left" : "←", label: "Catalog views" });
        }
        if (configure?.canContinue !== false) {
          actions.push({
            key: "Enter",
            label: stage === "components" ? "Select targets" : "Review exact plan",
          });
        }
        if (stage === "targets") {
          actions.push({ key: asciiMode() ? "Left" : "←", label: "Components" });
        }
        actions.push({ key: "s", label: "Installation summary" }, { key: "q", label: "Quit" });
        return actions;
      }
    case "reviewing":
      return [
        ...(snapshot.plan?.approvable === true && snapshot.plan.id !== null
          ? [{ key: "Enter", label: "Apply exact plan" }]
          : []),
        ...(snapshot.diagnostics.some(
          (diagnostic) =>
            diagnostic.code === "quality.make.target-collision" &&
            diagnostic.resolutions?.some((resolution) => resolution.action === "replace") === true,
        )
          ? [{ key: "o", label: "Replace conflicting targets" }]
          : []),
        { key: "e", label: "Edit draft" },
        { key: "Esc", label: "Cancel" },
        { key: "q", label: "Quit" },
      ];
    case "applying":
    case "verifying":
      return [{ key: "Esc", label: "Request safe cancellation" }];
    case "receipted":
      return [
        ...(hasInstalledOauthMcp(snapshot) || snapshot.plan?.review?.runtimes.some((runtime) => runtime.auth === "oauth") === true
          ? [
              { key: "c", label: "Check MCP authentication" },
              { key: "a", label: snapshot.mcpSession === null ? "Authenticate MCP" : "Authenticate again" },
              { key: "l", label: "Logout MCP" },
            ]
          : []),
        { key: "o", label: "Scan again" },
        { key: "m", label: "Review remove all" },
        { key: "q", label: "Quit" },
      ];
    case "blocked":
      return [
        { key: "r", label: "Rescan" },
        { key: "q", label: "Quit" },
      ];
    default:
      return [
        { key: "Esc", label: "Cancel" },
        { key: "q", label: "Quit" },
      ];
  }
}

function hasInstalledOauthMcp(snapshot: InteractionSnapshot): boolean {
  const installed = new Set(snapshot.repository?.installedComponents ?? []);
  return snapshot.catalog.some(
    (item) => item.kind === "mcp-integration" && item.mcpAuth === "oauth" && installed.has(item.ref),
  );
}

export function taskSymbol(state: InteractionTask["state"]): string {
  if (asciiMode()) {
    switch (state) {
      case "waiting":
        return "o";
      case "running":
        return ">";
      case "done":
        return "v";
      case "warning":
        return "!";
      case "failed":
        return "x";
      case "skipped":
        return "-";
    }
  }
  switch (state) {
    case "waiting":
      return "○";
    case "running":
      return "◐";
    case "done":
      return "✓";
    case "warning":
      return "!";
    case "failed":
      return "×";
    case "skipped":
      return "–";
  }
}

export function taskTone(
  state: InteractionTask["state"],
): SemanticTone | undefined {
  switch (state) {
    case "running":
      return "cyan";
    case "done":
      return "green";
    case "warning":
      return "yellow";
    case "failed":
      return "red";
    case "waiting":
    case "skipped":
      return undefined;
  }
}

export function formatComponent(value: string): string {
  const identifier = value.includes(":") ? value.slice(value.indexOf(":") + 1) : value;
  return identifier
    .split("-")
    .map((part) => acronym(part) ?? `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function formatIdentifier(value: string): string {
  return acronym(value) ?? `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

export function shortenMiddle(value: string, maximum: number): string {
  if (value.length <= maximum) {
    return value;
  }
  const side = Math.max(1, Math.floor((maximum - 1) / 2));
  return `${value.slice(0, side)}${asciiMode() ? "~" : "…"}${value.slice(-side)}`;
}

export function basename(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/$/, "");
  return normalized.split("/").at(-1) || "resolving-repository";
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function isMutating(phase: InteractionPhase): boolean {
  return phase === "applying" || phase === "verifying";
}

export function isCancellable(phase: InteractionPhase): boolean {
  return (
    phase === "scanning" ||
    phase === "planning" ||
    phase === "reviewing" ||
    phase === "applying" ||
    phase === "verifying" ||
    phase === "authenticating"
  );
}

function healthTone(value: string): SemanticTone {
  if (value === "managed" || value === "clean" || value === "ready" || value === "current") {
    return "green";
  }
  if (value === "blocked") {
    return "red";
  }
  return "yellow";
}

function acronym(value: string): string | undefined {
  const known: Readonly<Record<string, string>> = {
    api: "API",
    cli: "CLI",
    codex: "Codex",
    e2e: "E2E",
    go: "Go",
    mcp: "MCP",
    tdd: "TDD",
  };
  return known[value.toLowerCase()];
}

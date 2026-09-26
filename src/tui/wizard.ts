import type { ComponentSelectionDraft } from "../application/model.js";
import type {
  CatalogItemView,
  InteractionAction,
  InteractionSession,
  InteractionSnapshot,
} from "../interaction/model.js";
import type { ComponentRef, HarnessTargetId } from "../domain/shared/types.js";
import {
  componentDetails,
  componentHint,
  componentLabel,
  diagnosticLine,
  draftSummary,
  exitSummary,
  families,
  mcpSessionSummary,
  planReview,
  receiptSummary,
  scanDetails,
  scanSummary,
} from "./render.js";

export interface Choice<Value> {
  readonly value: Value;
  readonly label: string;
  readonly hint?: string;
}

export interface Progress {
  update(message: string): void;
  stop(message: string): void;
}

/**
 * The prompts the wizard needs. Every prompt resolves to `null` when the user cancels it
 * (Esc or Ctrl+C), which the wizard treats as "go back".
 */
export interface WizardUi {
  intro(title: string): void;
  outro(message: string): void;
  note(message: string, title?: string): void;
  warn(message: string): void;
  error(message: string): void;
  select<Value>(message: string, options: readonly Choice<Value>[]): Promise<Value | null>;
  multiselect<Value>(
    message: string,
    options: readonly Choice<Value>[],
    initial: readonly Value[],
  ): Promise<Value[] | null>;
  groupMultiselect<Value>(
    message: string,
    groups: Readonly<Record<string, readonly Choice<Value>[]>>,
    initial: readonly Value[],
  ): Promise<Value[] | null>;
  searchMultiselect<Value>(
    message: string,
    options: readonly Choice<Value>[],
    initial: readonly Value[],
  ): Promise<Value[] | null>;
  confirm(message: string): Promise<boolean | null>;
  progress(message: string): Progress;
  /** Registers a handler for Ctrl+C while a mutation runs; returns the unregister function. */
  onInterrupt(handler: () => void): () => void;
}

type MenuAction =
  | "configure"
  | "details"
  | "remove-all"
  | "rescan"
  | "quit"
  | { readonly mcp: ComponentRef; readonly operation: "inspect" | "login" | "logout" };

/**
 * Linear interactive flow over the same interaction session the CLI uses: scan, choose
 * components and harnesses, review the exact plan, apply it, and see the receipt.
 */
export async function runWizard(
  session: InteractionSession,
  root: string,
  ui: WizardUi,
  version: string,
): Promise<InteractionSnapshot> {
  ui.intro(`Railguard ${version}`);
  let snapshot = await withProgress(ui, session, "Scanning the repository", { type: "scan", root });
  for (;;) {
    if (snapshot.phase === "blocked") {
      ui.error(snapshot.diagnostics.map(diagnosticLine).join("\n") || "The scan is blocked.");
      const next = await ui.select("The repository cannot be configured yet.", [
        { value: "rescan", label: "Scan again" },
        { value: "quit", label: "Quit" },
      ] as const);
      if (next !== "rescan") break;
      snapshot = await withProgress(ui, session, "Scanning the repository", { type: "scan", root });
      continue;
    }
    ui.note(scanSummary(snapshot), "Repository");
    const action = await ui.select<MenuAction>("What do you want to do?", menu(snapshot));
    if (action === null || action === "quit") break;
    if (action === "details") {
      ui.note(scanDetails(snapshot), "Scan details");
      continue;
    }
    if (action === "rescan") {
      snapshot = await withProgress(ui, session, "Scanning the repository", { type: "scan", root });
      continue;
    }
    if (typeof action === "object") {
      snapshot = await runMcpSession(session, ui, snapshot, action.mcp, action.operation);
      continue;
    }
    const applied = action === "configure"
      ? await configure(session, ui, snapshot)
      : await removeEverything(session, ui, root);
    snapshot = applied ?? snapshot;
    if (applied !== null && applied.receipt !== null) {
      snapshot = await withProgress(ui, session, "Scanning the repository", { type: "scan", root });
    }
  }
  ui.outro(exitSummary(snapshot));
  return snapshot;
}

function menu(snapshot: InteractionSnapshot): Choice<MenuAction>[] {
  const managed = snapshot.repository?.management !== "uninitialized";
  const choices: Choice<MenuAction>[] = [
    {
      value: "configure",
      label: managed ? "Change components or harnesses" : "Configure this repository",
      ...(managed ? {} : { hint: "choose components, then harnesses, then review" }),
    },
  ];
  for (const mcp of installedOauthMcps(snapshot)) {
    const name = mcp.slice(mcp.indexOf(":") + 1);
    choices.push(
      { value: { mcp, operation: "inspect" }, label: `MCP ${name}: check authentication` },
      { value: { mcp, operation: "login" }, label: `MCP ${name}: log in` },
      { value: { mcp, operation: "logout" }, label: `MCP ${name}: log out` },
    );
  }
  if (managed) choices.push({ value: "remove-all", label: "Remove everything Railguard manages" });
  choices.push(
    { value: "details", label: "Show scan details" },
    { value: "rescan", label: "Scan again" },
    { value: "quit", label: "Quit" },
  );
  return choices;
}

async function configure(
  session: InteractionSession,
  ui: WizardUi,
  scanned: InteractionSnapshot,
): Promise<InteractionSnapshot | null> {
  const managed = scanned.repository?.management !== "uninitialized";
  let snapshot = await session.dispatch({
    type: "compose-draft",
    base: managed ? "installed" : "empty",
    recommended: false,
    add: [],
    remove: [],
    setInputs: [],
    targets: managed ? null : [],
  });
  if (!managed) {
    const picked = await pickComponents(ui, snapshot, "family");
    if (picked === null) return null;
    snapshot = await replaceSelections(session, snapshot, picked);
  }
  for (;;) {
    ui.note(draftSummary(snapshot), "Selection");
    showBlockers(ui, snapshot);
    const step = await ui.select("Next step", [
      ...(snapshot.draft?.blocked === true || (snapshot.draft?.directSelections.length ?? 0) === 0 && !managed
        ? []
        : [{ value: "targets" as const, label: "Choose harnesses and review the plan" }]),
      { value: "family" as const, label: "Change components by family" },
      { value: "search" as const, label: "Change components by search" },
      { value: "info" as const, label: "Read a component's details" },
      { value: "back" as const, label: "Back to the main menu" },
    ]);
    if (step === null || step === "back") return null;
    if (step === "info") {
      await showComponentInformation(ui, snapshot);
      continue;
    }
    if (step === "family" || step === "search") {
      const picked = await pickComponents(ui, snapshot, step);
      if (picked !== null) snapshot = await replaceSelections(session, snapshot, picked);
      continue;
    }
    const targets = await pickTargets(ui, snapshot);
    if (targets === null) continue;
    snapshot = await session.dispatch({
      type: "replace-draft",
      selections: snapshot.draft?.selectionInputs ?? [],
      targets,
    });
    if (snapshot.draft?.blocked === true) continue;
    const reviewed = await reviewAndApply(session, ui, { type: "request-plan", mode: "reconcile" });
    if (reviewed === "edit") continue;
    return reviewed;
  }
}

async function removeEverything(
  session: InteractionSession,
  ui: WizardUi,
  root: string,
): Promise<InteractionSnapshot | null> {
  const scanned = await session.dispatch({ type: "scan", root });
  if (scanned.phase !== "browsing") return scanned;
  const drafted = await session.dispatch({
    type: "compose-draft",
    base: "installed",
    recommended: false,
    add: [],
    remove: scanned.repository?.installedDirectSelections ?? [],
    setInputs: [],
    targets: null,
  });
  if (drafted.draft?.blocked === true) {
    showBlockers(ui, drafted);
    return null;
  }
  const reviewed = await reviewAndApply(session, ui, { type: "request-plan", mode: "remove" });
  return reviewed === "edit" ? null : reviewed;
}

/** Shows the exact plan and applies it only after an explicit confirmation. */
async function reviewAndApply(
  session: InteractionSession,
  ui: WizardUi,
  request: Extract<InteractionAction, { readonly type: "request-plan" }>,
): Promise<InteractionSnapshot | "edit" | null> {
  const planned = await withProgress(ui, session, "Preparing the exact plan", request);
  ui.note(planReview(planned), planned.plan?.mode === "remove" ? "Removal plan" : "Plan");
  if (planned.plan?.approvable !== true || planned.plan.id === null) {
    showBlockers(ui, planned);
    const next = await ui.select("The plan cannot be applied.", [
      { value: "edit" as const, label: "Change the selection" },
      { value: "back" as const, label: "Back to the main menu" },
    ]);
    return next === "edit" ? "edit" : null;
  }
  const decision = await ui.select("Apply this exact plan?", [
    { value: "apply" as const, label: "Apply", hint: `${planned.plan.changes.length} change(s)` },
    { value: "edit" as const, label: "Change the selection" },
    { value: "cancel" as const, label: "Cancel" },
  ]);
  if (decision === "edit") return "edit";
  if (decision !== "apply") return null;
  const unregister = ui.onInterrupt(() => {
    void session.dispatch({ type: "cancel-operation" });
  });
  try {
    const applied = await withProgress(ui, session, "Applying", { type: "approve-plan", planId: planned.plan.id });
    if (applied.receipt !== null) ui.note(receiptSummary(applied.receipt), "Receipt");
    return applied;
  } finally {
    unregister();
  }
}

async function pickComponents(
  ui: WizardUi,
  snapshot: InteractionSnapshot,
  mode: "family" | "search",
): Promise<ComponentRef[] | null> {
  const selected = snapshot.draft?.directSelections ?? [];
  const catalog = snapshot.catalog;
  const choice = (item: CatalogItemView): Choice<ComponentRef> => ({
    value: item.ref,
    label: componentLabel(item),
    hint: componentHint(item),
  });
  if (mode === "search") {
    return await ui.searchMultiselect(
      "Type to filter; Space selects, Enter confirms",
      catalog.map((item) => ({ ...choice(item), label: item.ref })),
      selected,
    );
  }
  const groups: Record<string, Choice<ComponentRef>[]> = {};
  for (const family of families) {
    const items = catalog.filter((item) => item.kind === family.id);
    if (items.length > 0) groups[family.label] = items.map(choice);
  }
  return await ui.groupMultiselect("Select components (Space toggles, Enter confirms)", groups, selected);
}

async function pickTargets(ui: WizardUi, snapshot: InteractionSnapshot): Promise<HarnessTargetId[] | null> {
  const harnesses = [...(snapshot.repository?.harnesses ?? [])].sort(
    (left, right) => Number(right.detected) - Number(left.detected) || left.id.localeCompare(right.id),
  );
  return await ui.multiselect(
    "Configure these harnesses (Space toggles, Enter confirms)",
    harnesses.map((harness) => ({
      value: harness.id,
      label: harness.id,
      hint: harness.detected ? `detected ${firstLine(harness.version)}`.trim() : "not detected",
    })),
    snapshot.draft?.targets ?? [],
  );
}

async function showComponentInformation(ui: WizardUi, snapshot: InteractionSnapshot): Promise<void> {
  const ref = await ui.select(
    "Which component?",
    snapshot.catalog.map((item) => ({ value: item.ref, label: item.ref, hint: componentHint(item) })),
  );
  const item = snapshot.catalog.find((entry) => entry.ref === ref);
  if (item !== undefined) ui.note(componentDetails(item), componentLabel(item));
}

async function runMcpSession(
  session: InteractionSession,
  ui: WizardUi,
  snapshot: InteractionSnapshot,
  component: ComponentRef,
  operation: "inspect" | "login" | "logout",
): Promise<InteractionSnapshot> {
  if (operation === "logout") {
    const confirmed = await ui.confirm(`Log out ${component} in every configured harness? The MCP stays installed.`);
    if (confirmed !== true) return snapshot;
  }
  const result = await withProgress(ui, session, `MCP ${operation}`, {
    type: "mcp-session",
    component,
    targets: snapshot.repository?.installedTargets ?? [],
    operation,
  });
  ui.note(mcpSessionSummary(result), "MCP authentication");
  return result;
}

async function replaceSelections(
  session: InteractionSession,
  snapshot: InteractionSnapshot,
  refs: readonly ComponentRef[],
): Promise<InteractionSnapshot> {
  const previous = new Map((snapshot.draft?.selectionInputs ?? []).map((entry) => [entry.ref, entry]));
  const selections: ComponentSelectionDraft[] = refs.map((ref) => previous.get(ref) ?? { ref });
  return await session.dispatch({
    type: "replace-draft",
    selections,
    targets: snapshot.draft?.targets ?? [],
  });
}

function showBlockers(ui: WizardUi, snapshot: InteractionSnapshot): void {
  const blockers = snapshot.diagnostics.filter(
    (diagnostic) => diagnostic.severity === "blocked" || diagnostic.severity === "failed",
  );
  if (blockers.length > 0) ui.warn(blockers.map(diagnosticLine).join("\n"));
}

/** Dispatches an action while a spinner mirrors the session's running task. */
async function withProgress(
  ui: WizardUi,
  session: InteractionSession,
  message: string,
  action: InteractionAction,
): Promise<InteractionSnapshot> {
  const progress = ui.progress(message);
  const unsubscribe = session.subscribe(({ event }) => {
    if (event.type === "task" && event.task.state === "running") {
      const count = event.task.current !== undefined && event.task.total !== undefined
        ? ` (${event.task.current}/${event.task.total})`
        : "";
      progress.update(`${message}: ${event.task.label}${count}`);
    }
  });
  try {
    const snapshot = await session.dispatch(action);
    progress.stop(`${message}: done`);
    return snapshot;
  } catch (error) {
    progress.stop(`${message}: failed`);
    throw error;
  } finally {
    unsubscribe();
  }
}

function installedOauthMcps(snapshot: InteractionSnapshot): ComponentRef[] {
  const installed = new Set(snapshot.repository?.installedComponents ?? []);
  return snapshot.catalog
    .filter((item) => item.kind === "mcp-integration" && item.mcpAuth === "oauth" && installed.has(item.ref))
    .map((item) => item.ref);
}

function firstLine(value: string | null): string {
  return (value ?? "").split("\n")[0] ?? "";
}

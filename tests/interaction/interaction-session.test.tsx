import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import React from "react";
import { render } from "ink-testing-library";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExecutableProbe } from "../../src/domain/harness/model.js";
import {
  componentRef,
  harnessTargetId,
} from "../../src/domain/shared/types.js";
import {
  exitCodeForVerdict,
  runHeadless,
  serializeHeadlessRun,
} from "../../src/cli/headless.js";
import { createInteractionRuntime } from "../../src/interaction/interaction-session.js";
import { AiHarnessTui } from "../../src/tui/app.js";
import {
  layoutMode,
  paneWidths,
} from "../../src/tui/presenter.js";
import { createTempRepository } from "../helpers/temp-repository.js";

const probe: ExecutableProbe = {
  async probe() {
    return {
      detected: true,
      path: "/test/bin/codex",
      version: "codex interaction contract",
      diagnostics: [],
    };
  },
};

const codex = harnessTargetId("codex");
const goHexagonal = componentRef("skill:develop-go-hexagonal-service");
const execute = promisify(execFile);
const originalAsciiMode = process.env.AI_HARNESS_ASCII;

beforeAll(() => {
  process.env.AI_HARNESS_ASCII = "0";
});

afterAll(() => {
  if (originalAsciiMode === undefined) delete process.env.AI_HARNESS_ASCII;
  else process.env.AI_HARNESS_ASCII = originalAsciiMode;
});

describe("production shared CLI/TUI interaction contract", () => {
  it("opens an empty non-Git directory without blocking or creating project metadata", async () => {
    const repository = await createTempRepository({});
    const interaction = await runtime("0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a");
    const tui = render(<AiHarnessTui session={interaction.session} root={repository.root} />);
    try {
      await waitForFrame(tui, "SCAN COMPLETE");

      expect(tui.lastFrame()).toContain("Stack");
      expect(tui.lastFrame()).toContain("not detected");
      expect(tui.lastFrame()).toContain("Repository discovery is ready");
      expect(tui.lastFrame()).toContain("[Enter] Configure components");
      expect(tui.lastFrame()).not.toContain("recovery.repository-gate.failed");
      expect(await readdir(repository.root)).toEqual([]);
    } finally {
      tui.unmount();
      await Promise.all([interaction.dispose(), repository.cleanup()]);
    }
  });

  it("projects the same real plan and dependency closure through headless and TUI surfaces", async () => {
    const headlessRepository = await goRepository();
    const tuiRepository = await goRepository();
    const headlessRuntime = await runtime("11111111-1111-4111-8111-111111111111");
    const tuiRuntime = await runtime("22222222-2222-4222-8222-222222222222");
    const tui = render(
      <AiHarnessTui session={tuiRuntime.session} root={tuiRepository.root} />,
    );
    try {
      const headless = await runHeadless(headlessRuntime.session, {
        command: "init",
        root: headlessRepository.root,
        recommended: true,
        directSelections: [],
        targets: [codex],
        approve: false,
      });

      await waitForFrame(tui, "SCAN COMPLETE");
      expect(tui.lastFrame()).toContain("AI HARNESS");
      expect(tui.lastFrame()).toContain("4 component recommendations");
      expect(tui.lastFrame()).not.toContain("TASKS");
      expect(tui.lastFrame()).not.toContain("…");
      tui.stdin.write("d");
      await waitForFrame(tui, "[d] Back to scan summary");
      expect(tui.lastFrame()).toContain("SCAN DETAILS");
      expect(tui.lastFrame()).toContain("Scan · inventory · done");
      tui.stdin.write("d");
      await waitForFrame(tui, "SCAN COMPLETE");
      const goQuality = tuiRuntime.session.snapshot.catalog.find(
        (component) => component.ref === "verification-profile:go-quality",
      );
      expect(tuiRuntime.session.snapshot.catalog.every(
        (component) => component.impact.changes.length > 0 && component.impact.workflow.length > 0,
      )).toBe(true);
      expect(goQuality?.impact.changes).toContain("root Makefile");
      expect(goQuality?.impact.workflow).toContain("does not enable a hook");
      tui.stdin.write("\r");
      await waitForFrame(tui, "COMPONENTS");
      tui.stdin.write("\u001B[C");
      for (let index = 0; index < 4; index += 1) {
        tui.stdin.write(" ");
        await waitForDraftCount(tuiRuntime.session, index + 1);
        if (index < 3) tui.stdin.write("\u001B[B");
      }
      tui.stdin.write("s");
      await waitForFrame(tui, "DIRECT SELECTIONS (4)");
      tui.stdin.write("s");
      await waitForFrame(tui, "COMPONENTS");
      tui.stdin.write("\r");
      await waitForFrame(tui, "TARGETS");
      tui.stdin.write(" ");
      await waitForFrame(tui, "[x] Codex");
      tui.stdin.write("\r");
      await waitForFrame(tui, "REVIEW EXACT PLAN");
      expect(tui.lastFrame()).toContain("SELECTION SUMMARY");
      expect(tui.lastFrame()).toContain("Configure Go Quality");
      expect(tui.lastFrame()).toContain("INCLUDED DEPENDENCIES");

      expect(tuiRuntime.session.snapshot.plan?.id).toBe(headless.result.plan?.plan_id);
      expect(
        [...(tuiRuntime.session.snapshot.plan?.changes ?? [])].sort((left, right) =>
          left.path.localeCompare(right.path),
        ),
      ).toEqual(
        [...(headless.result.plan?.review.changes ?? [])]
          .map(({ action, path, owner }) => ({ action, path, owner }))
          .sort((left, right) => left.path.localeCompare(right.path)),
      );
      expect(tuiRuntime.session.snapshot.draft?.components).toEqual(
        headless.result.components,
      );
      expect(headless.result.direct_selections).toContain(goHexagonal);
      expect(headless.result.components.filter((entry) => entry.origin === "required").length).toBeGreaterThan(0);

      tui.stdin.write("\r");
      await waitForFrame(tui, "RECEIPT");
      await waitForFrame(tui, "Verdict: succeeded");
      expect(tuiRuntime.session.snapshot.receipt?.planId).toBe(headless.result.plan?.plan_id);

      tui.stdin.write("m");
      await waitForFrame(tui, "Mode: remove");
      expect(tuiRuntime.session.snapshot.plan).toMatchObject({
        kind: "ready",
        mode: "remove",
        approvable: true,
      });
      expect(tuiRuntime.session.snapshot.draft?.components).toEqual([]);
      tui.stdin.write("\r");
      await waitForFrame(tui, "Verdict: succeeded");
    } finally {
      tui.unmount();
      await Promise.all([
        headlessRuntime.dispose(),
        tuiRuntime.dispose(),
        headlessRepository.cleanup(),
        tuiRepository.cleanup(),
      ]);
    }
  }, 90_000);

  it("runs install and direct-selection removal through one resolver and mutation pipeline", async () => {
    const repository = await goRepository();
    const interaction = await runtime("33333333-3333-4333-8333-333333333333");
    try {
      const baseline = await interaction.applicationRuntime.application.scan(repository.root);
      expect(baseline.kind).toBe("ready");
      const install = await runHeadless(interaction.session, {
        command: "init",
        root: repository.root,
        recommended: false,
        directSelections: [goHexagonal],
        targets: [codex],
        approve: true,
      });
      expect(install.result.verdict).toBe("SUCCEEDED");
      expect(install.result.receipt?.materialization).toBe("committed");
      expect(install.result.components).toHaveLength(8);

      const removal = await runHeadless(interaction.session, {
        command: "remove",
        root: repository.root,
        remainingDirectSelections: [],
        targets: [codex],
        approve: true,
      });
      expect(removal.result.verdict).toBe("SUCCEEDED");
      expect(removal.result.direct_selections).toEqual([]);
      expect(removal.result.components).toEqual([]);
      expect(removal.result.plan?.mode).toBe("remove");
      expect(removal.result.plan?.review.changes.every((change) => change.action === "remove")).toBe(true);

      const restored = await interaction.applicationRuntime.application.scan(repository.root);
      expect(restored.kind).toBe("ready");
      if (baseline.kind === "ready" && restored.kind === "ready") {
        expect(restored.snapshot.fingerprint).toBe(baseline.snapshot.fingerprint);
      }
    } finally {
      await Promise.all([interaction.dispose(), repository.cleanup()]);
    }
  });

  it("applies an exported plan through a fresh interaction session", async () => {
    const repository = await goRepository();
    const planner = await runtime("99999999-9999-4999-8999-999999999999");
    const applier = await runtime("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    try {
      const planned = await runHeadless(planner.session, {
        command: "init",
        root: repository.root,
        recommended: false,
        directSelections: [goHexagonal],
        targets: [codex],
        approve: false,
      });
      if (planned.result.plan === null) throw new Error("Expected exported plan");

      const applied = await runHeadless(applier.session, {
        command: "apply",
        root: repository.root,
        plan: planned.result.plan,
        approve: true,
      });

      expect(applied.result.verdict).toBe("SUCCEEDED");
      expect(applied.result.receipt?.plan_id).toBe(planned.result.plan.plan_id);
      expect(applied.result.plan?.plan_id).toBe(planned.result.plan.plan_id);
    } finally {
      await Promise.all([planner.dispose(), applier.dispose(), repository.cleanup()]);
    }
  });

  it("lets a developer browse non-recommended families and select targets explicitly", async () => {
    const repository = await goRepository();
    const interaction = await runtime("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    const tui = render(<AiHarnessTui session={interaction.session} root={repository.root} />);
    try {
      await waitForFrame(tui, "SCAN COMPLETE");
      tui.stdin.write("\r");
      await waitForFrame(tui, "COMPONENTS");
      for (let index = 0; index < 4; index += 1) tui.stdin.write("\u001B[B");
      tui.stdin.write("\u001B[C");
      await waitForFrame(tui, "MCP");
      expect(tui.lastFrame()).toContain("Context7");
      tui.stdin.write("\u001B[B");
      await waitForFrame(tui, "> [ ] Context7");
      expect(tui.lastFrame()).toContain("[i] Information");
      tui.stdin.write("i");
      await waitForFrame(tui, "COMPONENT INFORMATION");
      expect(tui.lastFrame()).toContain("Install Context7 as a project-scoped MCP integration");
      tui.stdin.write("\u001B");
      await waitForFrame(tui, "COMPONENTS");
      tui.stdin.write(" ");
      await waitForDraftCount(interaction.session, 1);
      tui.stdin.write("s");
      await waitForFrame(tui, "DIRECT SELECTIONS (1)");
      expect(tui.lastFrame()).toContain("INCLUDED DEPENDENCIES (0)");
      tui.stdin.write("s");
      await waitForFrame(tui, "COMPONENTS");
      tui.stdin.write("\r");
      await waitForFrame(tui, "TARGETS");
      tui.stdin.write("\u001B[B");
      tui.stdin.write(" ");
      await waitForFrame(tui, "[x] Claude-code");
      tui.stdin.write("\r");
      await waitForFrame(tui, "REVIEW EXACT PLAN");

      expect(interaction.session.snapshot.draft?.directSelections).toEqual([
        "mcp:context7",
      ]);
      expect(interaction.session.snapshot.draft?.targets).toEqual(["claude-code"]);
      expect(interaction.session.snapshot.draft?.components.map((entry) => entry.ref)).toEqual([
        "mcp:context7",
      ]);
    } finally {
      tui.unmount();
      await Promise.all([interaction.dispose(), repository.cleanup()]);
    }
  });

  it("preserves the in-session draft when a developer moves between components and targets", async () => {
    const repository = await goRepository();
    const interaction = await runtime("9a9a9a9a-9a9a-4a9a-8a9a-9a9a9a9a9a9a");
    const tui = render(<AiHarnessTui session={interaction.session} root={repository.root} />);
    try {
      await waitForFrame(tui, "SCAN COMPLETE");
      tui.stdin.write("\r");
      await waitForFrame(tui, "COMPONENTS");
      for (let index = 0; index < 4; index += 1) tui.stdin.write("\u001B[B");
      tui.stdin.write("\u001B[C");
      await waitForFrame(tui, "MCP");
      tui.stdin.write("\u001B[B");
      await waitForFrame(tui, "> [ ] Context7");
      tui.stdin.write(" ");
      await waitForDraftCount(interaction.session, 1);
      tui.stdin.write("s");
      await waitForFrame(tui, "DIRECT SELECTIONS (1)");
      tui.stdin.write("s");
      await waitForFrame(tui, "COMPONENTS");
      expect(tui.lastFrame()).toContain("[x] Context7");

      tui.stdin.write("\r");
      await waitForFrame(tui, "TARGETS");
      tui.stdin.write("\u001B[D");
      await waitForFrame(tui, "COMPONENTS");

      expect(tui.lastFrame()).toContain("[x] Context7");
      expect(interaction.session.snapshot.draft?.directSelections).toEqual([
        "mcp:context7",
      ]);
    } finally {
      tui.unmount();
      await Promise.all([interaction.dispose(), repository.cleanup()]);
    }
  });

  it("shows all component families in one grouped catalog view", async () => {
    const repository = await goRepository();
    const interaction = await runtime("8a8a8a8a-8a8a-4a8a-8a8a-8a8a8a8a8a8a");
    const tui = render(<AiHarnessTui session={interaction.session} root={repository.root} />);
    try {
      await waitForFrame(tui, "SCAN COMPLETE");
      tui.stdin.write("\r");
      await waitForFrame(tui, "COMPONENTS");
      tui.stdin.write("\u001B[B");
      tui.stdin.write("\u001B[C");
      await waitForFrame(tui, "COMPONENTS");
      expect(tui.lastFrame()).toContain("PACKS");
      expect(tui.lastFrame()).toContain("SKILLS");
      expect(tui.lastFrame()).toContain("MCP");
      expect(interaction.session.snapshot.draft?.directSelections).toEqual([]);
    } finally {
      tui.unmount();
      await Promise.all([interaction.dispose(), repository.cleanup()]);
    }
  });

  it("searches the active component view without losing the draft", async () => {
    const repository = await goRepository();
    const interaction = await runtime("8b8b8b8b-8b8b-4b8b-8b8b-8b8b8b8b8b8b");
    const tui = render(<AiHarnessTui session={interaction.session} root={repository.root} />);
    try {
      await waitForFrame(tui, "SCAN COMPLETE");
      tui.stdin.write("\r");
      await waitForFrame(tui, "COMPONENTS");
      for (let index = 0; index < 4; index += 1) tui.stdin.write("\u001B[B");
      tui.stdin.write("\u001B[C");
      tui.stdin.write("/");
      tui.stdin.write("context7");
      await waitForFrame(tui, "SEARCH > context7");
      expect(tui.lastFrame()).toMatch(/CATALOG\s+[|·]\s+1 items/);
      expect(tui.lastFrame()).toContain("Context7");
      expect(tui.lastFrame()).not.toContain("TDD");
      expect(tui.lastFrame()).toContain("[Esc] Clear search");
      expect(tui.lastFrame()).not.toContain("[i] Information");

      tui.stdin.write("\r");
      tui.stdin.write(" ");
      await waitForDraftCount(interaction.session, 1);
      tui.stdin.write("/");
      tui.stdin.write("\u001B");
      await waitForFrame(tui, "Press / to search");

      expect(tui.lastFrame()).toContain("[x] Context7");
      expect(interaction.session.snapshot.draft?.directSelections).toEqual([
        "mcp:context7",
      ]);
    } finally {
      tui.unmount();
      await Promise.all([interaction.dispose(), repository.cleanup()]);
    }
  });

  it("cancels a reviewed plan without mutating the repository", async () => {
    const repository = await goRepository();
    const interaction = await runtime("44444444-4444-4444-8444-444444444444");
    try {
      const baseline = await interaction.applicationRuntime.application.scan(repository.root);
      const planned = await runHeadless(interaction.session, {
        command: "init",
        root: repository.root,
        recommended: false,
        directSelections: [goHexagonal],
        targets: [codex],
        approve: false,
      });
      expect(planned.result.verdict).toBe("PLAN_READY");

      await interaction.session.dispatch({ type: "cancel-operation" });
      expect(interaction.session.snapshot.receipt).toMatchObject({
        planId: planned.result.plan?.plan_id,
        result: "cancelled",
        materialization: "unchanged",
      });

      const after = await interaction.applicationRuntime.application.scan(repository.root);
      if (baseline.kind === "ready" && after.kind === "ready") {
        expect(after.snapshot.fingerprint).toBe(baseline.snapshot.fingerprint);
      }
    } finally {
      await Promise.all([interaction.dispose(), repository.cleanup()]);
    }
  });

  it("honors cancellation at the apply pre-mutation boundary", async () => {
    const repository = await goRepository();
    const interaction = await runtime("77777777-7777-4777-8777-777777777777");
    try {
      const baseline = await interaction.applicationRuntime.application.scan(repository.root);
      if (baseline.kind !== "ready") throw new Error("Expected ready baseline");
      await interaction.session.dispatch({ type: "scan", root: repository.root });
      await interaction.session.dispatch({
        type: "replace-draft",
        selections: [{ ref: goHexagonal }],
        targets: [codex],
      });
      const reviewed = await interaction.session.dispatch({
        type: "request-plan",
        mode: "reconcile",
      });
      if (reviewed.plan?.id === null || reviewed.plan?.id === undefined) {
        throw new Error("Expected reviewable plan");
      }
      let cancellation: Promise<unknown> | null = null;
      let cancellationRequested = false;
      const unsubscribe = interaction.session.subscribe(({ snapshot }) => {
        if (snapshot.phase === "applying" && !cancellationRequested) {
          cancellationRequested = true;
          cancellation = interaction.session.dispatch({ type: "cancel-operation" });
        }
      });
      const finished = await interaction.session.dispatch({
        type: "approve-plan",
        planId: reviewed.plan.id,
      });
      unsubscribe();
      await cancellation;

      expect(["cancelled", "rolled-back"]).toContain(finished.receipt?.result);
      const after = await interaction.applicationRuntime.application.scan(repository.root);
      expect(after.snapshot.fingerprint).toBe(baseline.snapshot.fingerprint);
    } finally {
      await Promise.all([interaction.dispose(), repository.cleanup()]);
    }
  });

  it("rolls back when cancellation arrives after a journaled unit starts", async () => {
    const repository = await goRepository();
    const interaction = await runtime("88888888-8888-4888-8888-888888888888");
    try {
      const baseline = await interaction.applicationRuntime.application.scan(repository.root);
      if (baseline.kind !== "ready") throw new Error("Expected ready baseline");
      await interaction.session.dispatch({ type: "scan", root: repository.root });
      await interaction.session.dispatch({
        type: "replace-draft",
        selections: [{ ref: goHexagonal }],
        targets: [codex],
      });
      const reviewed = await interaction.session.dispatch({ type: "request-plan", mode: "reconcile" });
      if (reviewed.plan?.id === null || reviewed.plan?.id === undefined) {
        throw new Error("Expected reviewable plan");
      }
      let cancellationRequested = false;
      let cancellation: Promise<unknown> | null = null;
      const unsubscribe = interaction.session.subscribe(({ event }) => {
        if (
          event.type === "task" &&
          event.task.id.startsWith("apply.apply.") &&
          event.task.state === "running" &&
          !cancellationRequested
        ) {
          cancellationRequested = true;
          cancellation = interaction.session.dispatch({ type: "cancel-operation" });
        }
      });
      const finished = await interaction.session.dispatch({
        type: "approve-plan",
        planId: reviewed.plan.id,
      });
      unsubscribe();
      await cancellation;

      expect(
        finished.receipt?.result,
        JSON.stringify(finished.receipt?.diagnostics),
      ).toBe("rolled-back");
      const after = await interaction.applicationRuntime.application.scan(repository.root);
      expect(after.snapshot.fingerprint).toBe(baseline.snapshot.fingerprint);
    } finally {
      await Promise.all([interaction.dispose(), repository.cleanup()]);
    }
  });

  it("keeps JSON atomic, NDJSON ordered, and exit meanings explicit", async () => {
    const repository = await goRepository();
    const interaction = await runtime("55555555-5555-4555-8555-555555555555");
    try {
      const run = await runHeadless(interaction.session, {
        command: "init",
        root: repository.root,
        recommended: false,
        directSelections: [goHexagonal],
        targets: [codex],
        approve: false,
      });
      const jsonLines = serializeHeadlessRun(run, "json").trimEnd().split("\n");
      expect(jsonLines).toHaveLength(1);
      expect(JSON.parse(jsonLines[0]!)).toEqual(run.result);

      const ndjson = serializeHeadlessRun(run, "ndjson")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(ndjson.at(-1)).toEqual(run.result);
      expect(ndjson.slice(0, -1).map((entry) => entry.sequence)).toEqual(
        run.events.map((_, index) => index + 1),
      );
      expect(run.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "task",
            task: expect.objectContaining({ id: "scan.catalog", state: "running" }),
          }),
          expect.objectContaining({
            type: "task",
            task: expect.objectContaining({ id: "scan.catalog", state: "done" }),
          }),
          expect.objectContaining({
            type: "task",
            task: expect.objectContaining({ id: "scan.harness.codex", state: "done" }),
          }),
        ]),
      );
      const terminalTasks = new Set<string>();
      for (const event of run.events) {
        if (event.type !== "task") {
          continue;
        }
        expect(
          terminalTasks.has(event.task.id) && event.task.state === "running",
          `${event.task.id} regressed from a terminal state to running`,
        ).toBe(false);
        if (["done", "warning", "failed", "skipped"].includes(event.task.state)) {
          terminalTasks.add(event.task.id);
        }
      }

      expect({
        ready: exitCodeForVerdict("READY"),
        invalid: exitCodeForVerdict("INVALID_INPUT"),
        scope: exitCodeForVerdict("INVALID_SCOPE"),
        readiness: exitCodeForVerdict("READINESS_BLOCKED"),
        conflict: exitCodeForVerdict("BLOCKED"),
        changes: exitCodeForVerdict("CHANGES_AVAILABLE"),
        apply: exitCodeForVerdict("FAILED"),
        verification: exitCodeForVerdict("VERIFICATION_FAILED"),
        cancelled: exitCodeForVerdict("CANCELLED"),
        internal: exitCodeForVerdict("UNKNOWN"),
      }).toEqual({
        ready: 0,
        invalid: 2,
        scope: 3,
        readiness: 4,
        conflict: 5,
        changes: 6,
        apply: 7,
        verification: 8,
        cancelled: 130,
        internal: 70,
      });
    } finally {
      await Promise.all([interaction.dispose(), repository.cleanup()]);
    }
  });

  it("degrades the approved composer layout at the specified terminal breakpoints", () => {
    expect(layoutMode(140, 30)).toBe("wide");
    expect(layoutMode(120, 30)).toBe("medium");
    expect(layoutMode(100, 24)).toBe("medium");
    expect(layoutMode(80, 24)).toBe("compact");
    expect(layoutMode(59, 40)).toBe("unsupported");
    expect(layoutMode(120, 17)).toBe("unsupported");
    expect(paneWidths("wide", 190)).toEqual({ navigation: 38, detail: 53 });
    expect(paneWidths("wide", 150)).toEqual({ navigation: 36, detail: 42 });
    expect(paneWidths("wide", 120)).toEqual({ navigation: 36, detail: 40 });
    expect(paneWidths("medium", 100)).toEqual({ navigation: 36, detail: 0 });
    expect(paneWidths("compact", 80)).toEqual({ navigation: 0, detail: 0 });
  });

  it("rejects approval of any plan ID other than the reviewed plan", async () => {
    const repository = await goRepository();
    const interaction = await runtime("66666666-6666-4666-8666-666666666666");
    try {
      const baseline = await interaction.applicationRuntime.application.scan(repository.root);
      await runHeadless(interaction.session, {
        command: "init",
        root: repository.root,
        recommended: false,
        directSelections: [goHexagonal],
        targets: [codex],
        approve: false,
      });
      await interaction.session.dispatch({
        type: "approve-plan",
        planId: `sha256:${"0".repeat(64)}`,
      });
      expect(interaction.session.snapshot.receipt).toMatchObject({
        result: "rejected",
        materialization: "unchanged",
      });
      expect(interaction.session.snapshot.diagnostics.map((entry) => entry.code)).toContain(
        "interaction.approval.plan-id-mismatch",
      );
      const after = await interaction.applicationRuntime.application.scan(repository.root);
      if (baseline.kind === "ready" && after.kind === "ready") {
        expect(after.snapshot.fingerprint).toBe(baseline.snapshot.fingerprint);
      }
    } finally {
      await Promise.all([interaction.dispose(), repository.cleanup()]);
    }
  });
});

async function runtime(operationId: string) {
  return await createInteractionRuntime({
    operationId,
    executableProbe: probe,
    catalogFile: resolve("ai-harness.yaml"),
  });
}

async function goRepository() {
  const repository = await createTempRepository({
    "go.mod": "module example.com/shared-surface\n\ngo 1.24\n",
    "README.md": "# Shared surface fixture\n",
  });
  await execute("git", ["init", "--quiet", repository.root]);
  return repository;
}

async function waitForFrame(
  instance: ReturnType<typeof render>,
  expected: string,
): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (instance.lastFrame()?.includes(expected) === true) {
      return;
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`Timed out waiting for TUI frame containing: ${expected}\n${instance.lastFrame() ?? "<no frame>"}`);
}

async function waitForDraftCount(
  session: { readonly snapshot: { readonly draft: { readonly directSelections: readonly unknown[] } | null } },
  expected: number,
): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if ((session.snapshot.draft?.directSelections.length ?? 0) === expected) return;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`Timed out waiting for ${expected} direct selections`);
}

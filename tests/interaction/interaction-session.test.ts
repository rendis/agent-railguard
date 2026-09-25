import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
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
const originalAsciiMode = process.env.RAILGUARD_ASCII;

beforeAll(() => {
  process.env.RAILGUARD_ASCII = "0";
});

afterAll(() => {
  if (originalAsciiMode === undefined) delete process.env.RAILGUARD_ASCII;
  else process.env.RAILGUARD_ASCII = originalAsciiMode;
});

describe("production shared CLI/TUI interaction contract", () => {
  it("preserves preflight diagnostics when planning stops before creating a plan", async () => {
    const repository = await createTempRepository({});
    const interaction = await runtime("44444444-4444-4444-8444-444444444444");
    try {
      const result = await runHeadless(interaction.session, {
        command: "init",
        root: repository.root,
        recommended: false,
        directSelections: [componentRef("pack:testing-foundation")],
        targets: [codex],
        approve: false,
      });
      expect(result.result.verdict).toBe("BLOCKED");
      expect(result.result.diagnostics).toContainEqual(expect.objectContaining({
        code: "repository.gate.git-uninitialized",
        severity: "blocked",
      }));
      expect(interaction.session.snapshot.diagnostics).toContainEqual(expect.objectContaining({
        code: "repository.gate.git-uninitialized",
      }));
    } finally {
      await Promise.all([interaction.dispose(), repository.cleanup()]);
    }
  });

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
    catalogFile: resolve("railguard.yaml"),
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

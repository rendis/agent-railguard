import { describe, expect, it } from "vitest";
import type { CommandResultEnvelope, HeadlessRun } from "../../src/cli/headless.js";
import {
  internalErrorRun,
  invalidInputRun,
  renderProgress,
  renderRun,
} from "../../src/cli/output.js";
import type { PublicInteractionEvent } from "../../src/interaction/public-output.js";
import { componentRef, harnessTargetId } from "../../src/domain/shared/types.js";
import { encodePublicEvent } from "../../src/application/serialization/public-contracts.js";

describe("CLI output renderer", () => {
  it("keeps JSON atomic and NDJSON event-first", () => {
    const run = invalidInputRun("scan", "bad input");
    expect(JSON.parse(renderRun(run, "json"))).toMatchObject({
      verdict: "INVALID_INPUT",
      exit_code: 2,
    });
    const lines = renderRun(run, "ndjson").trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: "result" });

    const withEvent: HeadlessRun = Object.freeze({
      events: Object.freeze([taskEvent("running", 1, 2)]),
      result: run.result,
    });
    const eventLines = renderRun(withEvent, "ndjson").trimEnd().split("\n");
    expect(eventLines).toHaveLength(2);
    expect(JSON.parse(eventLines[0]!)).toMatchObject({ type: "task", sequence: 1 });
    expect(JSON.parse(eventLines[1]!)).toMatchObject({ type: "result" });
  });

  it("renders every human result section without hiding effects", () => {
    const output = renderRun({ events: [], result: fullResult() }, "text");
    expect(output).toContain("Repository: /tmp/project");
    expect(output).toContain("Stack: go, typescript");
    expect(output).toContain("State: managed · clean · ready");
    expect(output).toContain("Plan: sha256:");
    expect(output).toContain("create  AGENTS.md");
    expect(output).toContain("Receipt: succeeded · committed");
    expect(output).toContain("Changed paths: 1");
    expect(output).toContain("FAILED example.failure");
    expect(output).toContain("At: Makefile:113");
    expect(output).toContain('Evidence: target "check" at line 113: check: fmt test');
    expect(output).toContain("Next: Fix it");
  });

  it("renders each query data family", () => {
    const component = catalogComponent();
    const list = renderRun({
      events: [],
      result: resultWithData({ kind: "catalog-list", components: [component] }),
    }, "text");
    expect(list).toContain("Catalog components: 1");
    expect(list).toContain("skill:tdd 0.1.0");

    const show = renderRun({
      events: [],
      result: resultWithData({ kind: "catalog-show", component }),
    }, "text");
    expect(show).toContain("skill · passive");
    expect(show).toContain("Detailed guidance for applying test-driven development");
    expect(show).toContain("requires skill:design-tests");

    const doctor = renderRun({
      events: [],
      result: resultWithData({
        kind: "doctor",
        checks: [{ id: "catalog", status: "passed", message: "Catalog is valid" }],
      }),
    }, "text");
    expect(doctor).toContain("passed  catalog");

    const update = renderRun({
      events: [],
      result: resultWithData({
        kind: "update",
        current_version: "0.1.0",
        latest_version: null,
        status: "unknown",
      }),
    }, "text");
    expect(update).toContain("latest unknown");
  });

  it("renders all task states, optional progress and both error classes", () => {
    const marks = new Map([
      ["waiting", "·"],
      ["running", "›"],
      ["done", "✓"],
      ["warning", "!"],
      ["failed", "×"],
      ["skipped", "–"],
    ] as const);
    for (const [state, mark] of marks) {
      const rendered = renderProgress(taskEvent(state));
      expect(rendered).toContain(`${mark} Task ${state}`);
      expect(rendered).toContain("— detail");
    }
    expect(renderProgress(taskEvent("running", 2, 4))).toContain("2/4");
    expect(renderProgress({
      schema: "railguard/interaction-event/v1",
      operation_id: "11111111-1111-4111-8111-111111111111",
      sequence: 1,
      type: "state",
      phase: "browsing",
    })).toBeNull();

    expect(invalidInputRun("plan", "invalid").result).toMatchObject({
      verdict: "INVALID_INPUT",
      exit_code: 2,
    });
    expect(internalErrorRun("apply", "boom").result).toMatchObject({
      verdict: "INTERNAL_ERROR",
      exit_code: 70,
    });
  });

  it("validates stable MCP session results and events without credentials", () => {
    const session = Object.freeze({
      operation: "inspect" as const,
      component: componentRef("mcp:atlassian-rovo"),
      results: Object.freeze([
        Object.freeze({
          target: harnessTargetId("claude-code"),
          state: "authentication-unknown" as const,
          action: Object.freeze({
            kind: "guided" as const,
            description: "Open Claude Code and run /mcp.",
            command: null,
          }),
          message: "Claude Code owns the OAuth session.",
        }),
      ]),
    });
    const result: CommandResultEnvelope = Object.freeze({
      ...invalidInputRun("mcp-status", "fixture").result,
      verdict: "READY",
      exit_code: 0,
      data: Object.freeze({ kind: "mcp-session" as const, ...session }),
      diagnostics: Object.freeze([]),
    });
    const encodedResult = renderRun({ events: [], result }, "json");
    expect(JSON.parse(encodedResult)).toMatchObject({
      command: "mcp-status",
      data: { kind: "mcp-session", results: [{ state: "authentication-unknown" }] },
    });

    const event: PublicInteractionEvent = Object.freeze({
      schema: "railguard/interaction-event/v1",
      operation_id: "11111111-1111-4111-8111-111111111111",
      sequence: 1,
      type: "mcp-session-result",
      result: session,
    });
    expect(JSON.parse(encodePublicEvent(event))).toMatchObject({
      type: "mcp-session-result",
      result: { component: "mcp:atlassian-rovo" },
    });
    expect(encodedResult).not.toMatch(/access_token|refresh_token|Authorization|Cookie/i);
  });
});

function taskEvent(
  state: "waiting" | "running" | "done" | "warning" | "failed" | "skipped",
  current?: number,
  total?: number,
): PublicInteractionEvent {
  return Object.freeze({
    schema: "railguard/interaction-event/v1",
    operation_id: "11111111-1111-4111-8111-111111111111",
    sequence: 1,
    type: "task",
    task: Object.freeze({
      id: `task.${state}`,
      label: `Task ${state}`,
      detail: "detail",
      state,
      ...(current === undefined ? {} : { current }),
      ...(total === undefined ? {} : { total }),
    }),
  });
}

function resultWithData(data: CommandResultEnvelope["data"]): CommandResultEnvelope {
  return Object.freeze({ ...invalidInputRun("scan", "fixture").result, data });
}

function catalogComponent() {
  return Object.freeze({
    ref: componentRef("skill:tdd"),
    kind: "skill" as const,
    version: "0.1.0",
    description: "Use test-driven development.",
    details: "Detailed guidance for applying test-driven development safely and effectively.",
    trust: "passive" as const,
    applies_languages: Object.freeze([]),
    relations: Object.freeze([
      Object.freeze({
        kind: "requires" as const,
        target: componentRef("skill:design-tests"),
        reason: "Tests require a proof contract.",
      }),
    ]),
  });
}

function fullResult(): CommandResultEnvelope {
  const digest = `sha256:${"a".repeat(64)}`;
  const base = invalidInputRun("init", "fixture").result;
  return Object.freeze({
    ...base,
    verdict: "SUCCEEDED",
    exit_code: 0,
    repository: Object.freeze({
      root: "/tmp/project",
      fingerprint: digest,
      languages: Object.freeze(["go", "typescript"]),
      management: "managed",
      integrity: "clean",
      readiness: "ready",
      updates: "none",
      installed_direct_selections: Object.freeze([componentRef("skill:tdd")]),
      installed_components: Object.freeze([componentRef("skill:tdd")]),
      installed_targets: Object.freeze([harnessTargetId("codex")]),
      harnesses: Object.freeze([]),
    }),
    plan: Object.freeze({
      plan_id: digest,
      review: Object.freeze({
        changes: Object.freeze([
          Object.freeze({ action: "create", path: "AGENTS.md", owner: "project.instructions" }),
        ]),
        direct: Object.freeze([Object.freeze({ ref: "skill:tdd" })]),
        required: Object.freeze([Object.freeze({ ref: "skill:design-tests" })]),
      }),
    }) as CommandResultEnvelope["plan"],
    receipt: Object.freeze({
      operation_id: base.operation_id,
      plan_id: digest,
      result: "succeeded",
      materialization: "committed",
      certification: "verified",
      changed_paths: Object.freeze(["AGENTS.md"]),
      diagnostics: Object.freeze([]),
    }),
    diagnostics: Object.freeze([
      Object.freeze({
        code: "example.failure",
        severity: "failed",
        location: Object.freeze({ path: "Makefile", pointer: "line:113" }),
        message: "Example failed",
        evidence: Object.freeze(['target "check" at line 113: check: fmt test']),
        impact: "Visible impact",
        action: "Fix it",
      }),
    ]),
  });
}

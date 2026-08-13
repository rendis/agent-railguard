import { describe, expect, it } from "vitest";
import type { InteractionSnapshot } from "../../src/interaction/model.js";
import {
  beginTuiTerminal,
  renderTuiExitSummary,
} from "../../src/tui/terminal.js";

describe("TUI terminal lifecycle", () => {
  it("enters alternate screen, hides the cursor, and restores exactly once", () => {
    const output: string[] = [];
    const stdout = {
      isTTY: true,
      write(value: string) {
        output.push(value);
        return true;
      },
    } as unknown as NodeJS.WriteStream;

    const terminal = beginTuiTerminal(stdout);
    terminal.restore();
    terminal.restore();

    expect(output).toEqual([
      "\u001B[?1049h\u001B[?25l",
      "\u001B[?25h\u001B[?1049l",
    ]);
  });

  it("does not emit terminal controls to a non-TTY", () => {
    const output: string[] = [];
    const stdout = {
      isTTY: false,
      write(value: string) {
        output.push(value);
        return true;
      },
    } as unknown as NodeJS.WriteStream;

    const terminal = beginTuiTerminal(stdout);
    terminal.restore();

    expect(output).toEqual([]);
  });

  it("leaves a plain, actionable summary in scrollback", () => {
    expect(renderTuiExitSummary(snapshot())).toBe(
      "AI Harness: succeeded | management=managed | integrity=clean | changed_paths=2 | plan=sha256:abc\n",
    );
  });
});

function snapshot(): InteractionSnapshot {
  return {
    operationId: "test",
    phase: "receipted",
    tasks: [],
    repository: {
      root: "/tmp/repo",
      fingerprint: `sha256:${"1".repeat(64)}`,
      languages: ["go"],
      management: "managed",
      integrity: "clean",
      readiness: "ready",
      updates: "none",
      installedDirectSelections: [],
      installedComponents: [],
      installedTargets: [],
      harnesses: [],
    },
    catalog: [],
    recommendations: [],
    draft: null,
    plan: null,
    receipt: {
      operationId: "test",
      planId: "sha256:abc",
      result: "succeeded",
      materialization: "committed",
      certification: "verified",
      changedPaths: ["AGENTS.md", ".agents/skills/tdd/SKILL.md"],
      diagnostics: [],
    },
    mcpSession: null,
    diagnostics: [],
    cancellationRequested: false,
  };
}

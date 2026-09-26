import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { editFeedbackKinds, runEditFeedbackHook } from "../../src/application/agent-edit-feedback.js";
import type { StopHookHarness } from "../../src/application/agent-stop-hook.js";
import type { AgentActivity } from "../../src/domain/activity/model.js";
import type { VerificationReport, VerificationRequest, VerificationVerdict } from "../../src/application/verification-service.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  recorded.splice(0);
});

async function repository(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "railguard-edit-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

function verification(verdict: VerificationVerdict) {
  const requests: VerificationRequest[] = [];
  return {
    requests,
    async run(request: VerificationRequest): Promise<VerificationReport> {
      requests.push(request);
      return { stage: "check", mode: "changed", base: null, baseRef: null, verdict, results: [], diagnostics: [] };
    },
  };
}

const recorded: AgentActivity[] = [];

async function edit(harness: StopHookHarness, root: string, input: object, fake: ReturnType<typeof verification>) {
  return await runEditFeedbackHook(
    { harness, root, input: JSON.stringify(input) },
    fake,
    (report) => `REPORT ${report.verdict}`,
    { async append(_root, entry) { recorded.push(entry); } },
  );
}

describe("edit feedback", () => {
  it("runs only the file-scoped checks on the files the tool edited", async () => {
    const root = await repository();
    const fake = verification("passed");

    expect(await edit("claude-code", root, { tool_name: "Edit", tool_input: { file_path: join(root, "internal/app.go") } }, fake)).toBe("");
    expect(await edit("codex", root, {
      cwd: root, tool_name: "apply_patch", tool_input: { command: "*** Begin Patch\n*** Update File: a.go\n*** Delete File: a_test.go\n*** End Patch" },
    }, fake)).toBe("");

    expect(fake.requests).toEqual([
      { root, stage: "check", changed: true, paths: ["internal/app.go"], kinds: editFeedbackKinds },
      { root, stage: "check", changed: true, paths: ["a.go", "a_test.go"], kinds: editFeedbackKinds },
    ]);
    expect(editFeedbackKinds).toEqual(["change-integrity", "secret-exposure"]);
  });

  it("returns failures as context in each harness's PostToolUse format", async () => {
    const root = await repository();
    const input = { tool_name: "Write", tool_input: { file_path: join(root, "config.env") } };

    const claude = JSON.parse(await edit("claude-code", root, input, verification("failed")));
    const cursor = JSON.parse(await edit("cursor", root, input, verification("failed")));

    expect(claude).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: "Railguard found problems in config.env right after your edit. Fix the cause now instead of hiding it:\n\nREPORT failed",
      },
    });
    expect(cursor).toEqual({ additional_context: claude.hookSpecificOutput.additionalContext });
    expect(recorded).toEqual([
      { type: "edit-flagged", harness: "claude-code", checks: [] },
      { type: "edit-flagged", harness: "cursor", checks: [] },
    ]);
  });

  it("stays quiet for shell commands, edits outside the repository and unavailable checks", async () => {
    const root = await repository();
    const fake = verification("unavailable");

    expect(await edit("cursor", root, { tool_name: "Shell", tool_input: { command: "ls" } }, fake)).toBe("{}\n");
    expect(await edit("claude-code", root, { tool_name: "Write", tool_input: { file_path: join(tmpdir(), "elsewhere.txt") } }, fake)).toBe("");
    expect(await edit("claude-code", root, { tool_name: "Write", tool_input: { file_path: join(root, "a.go") } }, fake)).toBe("");
    expect(fake.requests).toHaveLength(1);
    expect(recorded).toEqual([]);
  });
});

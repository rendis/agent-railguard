import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { NodeProcessRunner } from "../../src/adapters/platform/process/node-process-runner.js";
import { UnverifiedChangeStore } from "../../src/adapters/verification/unverified-change-store.js";
import { runSessionStartHook } from "../../src/application/agent-session-start.js";
import { runStopHook, type StopHookHarness } from "../../src/application/agent-stop-hook.js";
import type { UnverifiedChange, UnverifiedChanges } from "../../src/domain/verification/unverified-change.js";
import type {
  VerificationReport,
  VerificationRequest,
  VerificationVerdict,
} from "../../src/application/verification-service.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("runStopHook", () => {
  it("lets the agent finish when the change passes and runs the check on the change", async () => {
    const verification = fakeVerification(["passed"]);

    const response = await hook("claude-code", verification, { session_id: "s1" });

    expect(response).toEqual({ stdout: "", stderr: "" });
    expect(verification.requests).toEqual([{ root: "/repo", stage: "check", changed: true }]);
  });

  it("blocks with the report in each harness's own protocol", async () => {
    const claude = JSON.parse((await hook("claude-code", fakeVerification(["failed"]), { session_id: "a" })).stdout);
    const codex = JSON.parse((await hook("codex", fakeVerification(["failed"]), { session_id: "b" })).stdout);
    const cursor = JSON.parse((await hook("cursor", fakeVerification(["failed"]), { conversation_id: "c", status: "completed" })).stdout);

    expect(claude).toMatchObject({ decision: "block", reason: expect.stringContaining("REPORT failed") });
    expect(codex.decision).toBe("block");
    expect(cursor).toEqual({ followup_message: expect.stringContaining("attempt 1 of 3") });
  });

  it("stops blocking after the retry limit and reports the change as not verified", async () => {
    const state = await stateDirectory();
    const verification = fakeVerification(["failed", "failed", "failed", "failed", "failed"]);
    const outputs: string[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await hook("claude-code", verification, { session_id: "loop" }, state);
      outputs.push(response.stdout === "" ? `allow:${response.stderr}` : "block");
    }

    expect(outputs.slice(0, 3)).toEqual(["block", "block", "block"]);
    expect(outputs[3]).toContain("NOT verified");
    expect(outputs[4]).toBe("block");
  });

  it("remembers a change left unverified until a later run passes, and tells the next session", async () => {
    const state = await stateDirectory();
    const store = memoryStore();
    const verification = fakeVerification(["failed", "failed", "failed", "failed", "passed"]);
    for (let attempt = 0; attempt < 4; attempt += 1) await hook("codex", verification, { session_id: "s" }, state, store);

    expect(store.change).toMatchObject({
      schema: "railguard/unverified/v1",
      stage: "check",
      attempts: 3,
      failures: ["secret-guard/secrets: 1 secret(s) exposed by the change"],
    });
    const claude = JSON.parse(await runSessionStartHook("claude-code", "/repo", store));
    const cursor = JSON.parse(await runSessionStartHook("cursor", "/repo", store));
    expect(claude.hookSpecificOutput).toEqual({
      hookEventName: "SessionStart",
      additionalContext: expect.stringContaining("NOT verified:\n- secret-guard/secrets: 1 secret(s) exposed by the change\nBefore other work"),
    });
    expect(cursor).toEqual({ additional_context: claude.hookSpecificOutput.additionalContext });

    await hook("codex", verification, { session_id: "s" }, state, store);
    expect(store.change).toBeNull();
    expect(await runSessionStartHook("codex", "/repo", store)).toBe("");
    expect(await runSessionStartHook("cursor", "/repo", store)).toBe("{}\n");
  });

  it("keeps the unverified record in the worktree's Git directory, out of versioned files", async () => {
    const root = await stateDirectory();
    await promisify(execFile)("git", ["init", "-q"], { cwd: root });
    const store = new UnverifiedChangeStore(new NodeProcessRunner());
    const change: UnverifiedChange = { schema: "railguard/unverified/v1", stage: "check", attempts: 3, recordedAt: "t", failures: ["x"] };

    await store.record(root, change);
    expect(await store.read(root)).toEqual(change);
    expect(await readdir(join(root, ".git", "railguard"))).toEqual(["unverified.json"]);
    await store.clear(root);
    expect(await store.read(root)).toBeNull();
    expect(await new UnverifiedChangeStore(new NodeProcessRunner()).read(tmpdir())).toBeNull();
  });

  it("keeps separate retry budgets per session and resets after a pass", async () => {
    const state = await stateDirectory();
    const verification = fakeVerification(["failed", "failed", "passed", "failed"]);

    await hook("claude-code", verification, { session_id: "one" }, state);
    const other = JSON.parse((await hook("claude-code", verification, { session_id: "two" }, state)).stdout);
    await hook("claude-code", verification, { session_id: "one" }, state);
    const afterPass = JSON.parse((await hook("claude-code", verification, { session_id: "one" }, state)).stdout);

    expect(other.reason).toContain("attempt 1 of 3");
    expect(afterPass.reason).toContain("attempt 1 of 3");
  });

  it("never traps the agent on readiness problems", async () => {
    for (const verdict of ["unavailable", "blocked"] as const) {
      const response = await hook("codex", fakeVerification([verdict]), { session_id: verdict });
      expect(response.stdout).toBe("");
      expect(response.stderr).toContain(`could not verify this change (${verdict})`);
    }
  });

  it("does nothing when Cursor reports an aborted turn", async () => {
    const verification = fakeVerification(["failed"]);

    const response = await hook("cursor", verification, { conversation_id: "x", status: "aborted" });

    expect(response).toEqual({ stdout: "", stderr: "" });
    expect(verification.requests).toEqual([]);
  });
});

async function hook(
  harness: StopHookHarness,
  verification: ReturnType<typeof fakeVerification>,
  input: Readonly<Record<string, unknown>>,
  state?: string,
  unverified: Pick<UnverifiedChanges, "record" | "clear"> = memoryStore(),
) {
  return await runStopHook(
    {
      harness,
      root: "/repo",
      stage: "check",
      input: JSON.stringify(input),
      stateDirectory: state ?? (await stateDirectory()),
    },
    verification,
    (report) => `REPORT ${report.verdict}`,
    unverified,
  );
}

function memoryStore() {
  let change: UnverifiedChange | null = null;
  return {
    get change() { return change; },
    async read() { return change; },
    async record(_root: string, value: UnverifiedChange) { change = value; },
    async clear() { change = null; },
  };
}

function fakeVerification(verdicts: readonly VerificationVerdict[]) {
  const requests: VerificationRequest[] = [];
  let index = 0;
  return {
    requests,
    async run(request: VerificationRequest): Promise<VerificationReport> {
      requests.push(request);
      const verdict = verdicts[Math.min(index, verdicts.length - 1)]!;
      index += 1;
      const results = verdict === "failed"
        ? [{
            profile: "verification-profile:secret-guard" as never,
            check: "secrets",
            kind: "secret-exposure",
            unit: ".",
            outcome: { status: "failed" as const, summary: "1 secret(s) exposed by the change", details: [] },
          }]
        : [];
      return { stage: "check", mode: "changed", base: null, baseRef: null, verdict, results, diagnostics: [] };
    },
  };
}

async function stateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "railguard-stop-state-"));
  directories.push(directory);
  return directory;
}

import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { guardAction, type ActionGuardRequest } from "../../src/application/agent-action-guard.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/** The repository as the harness spells it (on macOS under /var) and as the engine resolves it. */
async function repository() {
  const spelled = await mkdtemp(join(tmpdir(), "railguard-guard-"));
  cleanups.push(() => rm(spelled, { recursive: true, force: true }));
  return { spelled, root: await realpath(spelled) };
}

function guard(harness: ActionGuardRequest["harness"], root: string, input: object, protectedPaths: readonly string[] = []) {
  return guardAction({ harness, root, input: JSON.stringify(input), protectedPaths });
}

function denial(response: { readonly stdout: string }): string | null {
  if (response.stdout === "") return null;
  const payload = JSON.parse(response.stdout) as {
    hookSpecificOutput?: { permissionDecision: string; permissionDecisionReason: string };
    permission?: string;
    agent_message?: string;
  };
  if (payload.hookSpecificOutput !== undefined) {
    expect(payload.hookSpecificOutput.permissionDecision).toBe("deny");
    return payload.hookSpecificOutput.permissionDecisionReason;
  }
  return payload.permission === "deny" ? (payload.agent_message ?? "") : null;
}

describe("action guard", () => {
  it("refuses shell commands that skip hooks, accept findings or move the hooks", async () => {
    const { root } = await repository();
    const shell = (command: string) => denial(guard("claude-code", root, { tool_name: "Bash", tool_input: { command } }));

    expect(shell("git commit --no-verify -m 'feat: x'")).toContain("Do not skip the Git hooks");
    expect(shell("git commit -n -m wip")).toContain("Do not skip the Git hooks");
    expect(shell("git push --no-verify origin feature")).toContain("Do not skip the Git hooks");
    expect(shell("git commit -m 'fix' -m 'Railguard-Allow: change-size: big'")).toContain("Only a person may add");
    expect(shell("git config core.hooksPath /dev/null")).toContain("core.hooksPath");
    expect(shell("git -c core.hooksPath=/tmp commit -m x")).toContain("core.hooksPath");
    expect(shell("git config --get core.hooksPath")).toBeNull();
    expect(shell("git commit -m 'feat: add client'")).toBeNull();
    expect(shell("go test ./...")).toBeNull();
  });

  it("refuses file edits to the guardrails, Git internals and protected configuration", async () => {
    const { spelled, root } = await repository();
    const write = (path: string, protectedPaths: readonly string[] = []) =>
      denial(guard("claude-code", root, { cwd: spelled, tool_name: "Write", tool_input: { file_path: path, content: "x" } }, protectedPaths));

    expect(write(join(spelled, ".railguard/project.yaml"))).toContain(".railguard/project.yaml belongs to the guardrails");
    expect(write(".git/hooks/pre-commit")).toContain(".git/hooks/pre-commit belongs to the guardrails or to Git itself");
    expect(write(join(spelled, ".cursor/hooks.json"))).toContain("belongs to the guardrails");
    expect(write(join(spelled, "config/.golangci.yml"), [".golangci.*"])).toContain(
      "config/.golangci.yml is a protected quality configuration",
    );
    expect(write(join(spelled, "config/.golangci.yml"))).toBeNull();
    expect(write(join(spelled, "internal/app.go"), [".golangci.*"])).toBeNull();
    expect(write(join(tmpdir(), "outside", ".railguard/project.yaml"))).toBeNull();
    expect(
      denial(guard("claude-code", root, {
        tool_name: "MultiEdit",
        tool_input: { file_path: join(root, "app.go"), edits: [{ file_path: join(root, ".golangci.yml"), old_string: "a", new_string: "b" }] },
      }, [".golangci.*"])),
    ).toContain(".golangci.yml is a protected quality configuration");
  });

  it("reads Codex patches and answers in the PreToolUse format", async () => {
    const { spelled, root } = await repository();
    const patch = (body: string) => guard("codex", root, { cwd: spelled, tool_name: "apply_patch", tool_input: { command: body } }, [".gremlins.yaml"]);

    const refused = patch("*** Begin Patch\n*** Update File: src/app.go\n@@\n-a\n+b\n*** Delete File: .gremlins.yaml\n*** End Patch\n");
    expect(JSON.parse(refused.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringContaining(".gremlins.yaml is a protected quality configuration"),
      },
    });
    expect(denial(patch("*** Begin Patch\n*** Update File: a.go\n*** Move to: .railguard/bin/railguard\n*** End Patch\n"))).toContain(
      ".railguard/bin/railguard belongs to the guardrails",
    );
    expect(patch("*** Begin Patch\n*** Add File: src/new.go\n+package src\n*** End Patch\n")).toEqual({ stdout: "", stderr: "" });
    expect(denial(guard("codex", root, { tool_name: "Bash", tool_input: { command: "git commit --no-verify" } }))).toContain(
      "Do not skip the Git hooks",
    );
  });

  it("always answers Cursor with an explicit permission", async () => {
    const { root } = await repository();

    const refused = JSON.parse(guard("cursor", root, { tool_name: "Shell", tool_input: { command: "git push --no-verify" } }).stdout);
    expect(refused).toEqual({
      permission: "deny",
      user_message: expect.stringContaining("Railguard refused this action: Do not skip the Git hooks"),
      agent_message: expect.stringContaining("Do not skip the Git hooks"),
    });
    expect(denial(guard("cursor", root, { tool_name: "Delete", tool_input: { path: ".railguard/lock.json" } }))).toContain(
      ".railguard/lock.json belongs to the guardrails",
    );
    expect(JSON.parse(guard("cursor", root, { tool_name: "Shell", tool_input: { command: "ls" } }).stdout)).toEqual({ permission: "allow" });
    expect(guardAction({ harness: "cursor", root, input: "not json", protectedPaths: [] }).stdout).toBe('{"permission":"allow"}\n');
    expect(guardAction({ harness: "claude-code", root, input: "", protectedPaths: [] })).toEqual({ stdout: "", stderr: "" });
  });
});

import { describe, expect, it } from "vitest";
import { ClaudeCodeMcpSessionAdapter } from "../../src/adapters/harness/claude-code/claude-code-mcp-session-adapter.js";
import { CodexMcpSessionAdapter } from "../../src/adapters/harness/codex/codex-mcp-session-adapter.js";
import { CursorMcpSessionAdapter } from "../../src/adapters/harness/cursor/cursor-mcp-session-adapter.js";
import { OpenCodeMcpSessionAdapter } from "../../src/adapters/harness/opencode/opencode-mcp-session-adapter.js";
import { VsCodeMcpSessionAdapter } from "../../src/adapters/harness/vscode/vscode-mcp-session-adapter.js";
import type { CommandRequest, CommandRunner } from "../../src/domain/process/command-runner.js";
import type { McpSessionRequest } from "../../src/domain/mcp/session.js";
import type { ExecutableProbe } from "../../src/domain/harness/model.js";
import { componentRef } from "../../src/domain/shared/types.js";

const request: McpSessionRequest = {
  root: "/workspace/repository",
  component: componentRef("mcp:atlassian-rovo"),
  serverId: "atlassian-rovo",
  auth: { type: "oauth", activation: "harness-native" },
};

describe("MCP session adapter contract", () => {
  it.each([
    ["claude-code", (runner: CommandRunner) => new ClaudeCodeMcpSessionAdapter(runner), ["mcp", "login", "atlassian-rovo"], ["mcp", "logout", "atlassian-rovo"]],
    ["codex", (runner: CommandRunner) => new CodexMcpSessionAdapter(runner), ["mcp", "login", "atlassian-rovo"], ["mcp", "logout", "atlassian-rovo"]],
  ] as const)("%s delegates OAuth lifecycle to its official CLI", async (_id, create, loginArgs, logoutArgs) => {
    const runner = new RecordingRunner();
    const adapter = create(runner);

    const inspection = await adapter.inspect(request);
    expect(inspection.state).toBe("authentication-unknown");
    expect(inspection.action).toMatchObject({ kind: "command" });
    expect((await adapter.login(request)).state).toBe("authenticated");
    expect((await adapter.logout(request)).state).toBe("authentication-required");
    expect(runner.requests.map((entry) => entry.args)).toEqual([loginArgs, logoutArgs]);
    expect(runner.requests.every((entry) => entry.cwd === request.root)).toBe(true);
  });

  it("confirms OpenCode OAuth lifecycle through its native status", async () => {
    const runner = new OpenCodeRunner([
      oauthStatus("not authenticated"),
      { exitCode: 0, stdout: "", stderr: "" },
      oauthStatus("authenticated"),
      { exitCode: 0, stdout: "", stderr: "" },
    ]);
    const adapter = new OpenCodeMcpSessionAdapter(runner);

    expect(await adapter.inspect(request)).toMatchObject({ state: "authentication-required" });
    expect(await adapter.login(request)).toMatchObject({ state: "authenticated" });
    expect(await adapter.logout(request)).toMatchObject({ state: "authentication-required" });
    expect(runner.requests.map((entry) => entry.args)).toEqual([
      ["mcp", "auth", "list"],
      ["mcp", "auth", "atlassian-rovo"],
      ["mcp", "auth", "list"],
      ["mcp", "logout", "atlassian-rovo"],
    ]);
  });

  it("does not claim OpenCode authentication when its native OAuth flow is cancelled", async () => {
    const runner = new OpenCodeRunner([
      oauthStatus("not authenticated"),
      { exitCode: 0, stdout: "", stderr: "" },
      oauthStatus("not authenticated"),
    ]);
    const adapter = new OpenCodeMcpSessionAdapter(runner);

    expect(await adapter.inspect(request)).toMatchObject({
      state: "authentication-required",
    });
    expect(await adapter.login(request)).toMatchObject({
      state: "authentication-required",
    });
    expect(runner.requests.map((entry) => entry.args)).toEqual([
      ["mcp", "auth", "list"],
      ["mcp", "auth", "atlassian-rovo"],
      ["mcp", "auth", "list"],
    ]);
  });

  it("uses Cursor Agent native MCP login when that official CLI is available", async () => {
    const runner = new RecordingRunner();
    const adapter = new CursorMcpSessionAdapter(runner, probe(true));

    expect(await adapter.inspect(request)).toMatchObject({
      state: "authentication-unknown",
      action: { kind: "command", command: ["cursor-agent", "mcp", "list"] },
    });
    expect(await adapter.login(request)).toMatchObject({ state: "authenticated" });
    expect(runner.requests).toEqual([
      expect.objectContaining({
        command: "cursor-agent",
        args: ["mcp", "login", "atlassian-rovo"],
        cwd: request.root,
      }),
    ]);
    expect(await adapter.logout(request)).toMatchObject({
      state: "authentication-unknown",
      action: { kind: "guided", command: null },
    });
  });

  it("keeps Cursor OAuth actionable through its native UI when Cursor Agent is unavailable", async () => {
    const runner = new RecordingRunner();
    const result = await new CursorMcpSessionAdapter(runner, probe(false)).login(request);

    expect(result).toMatchObject({
      state: "authentication-required",
      action: { kind: "guided", command: null },
    });
    expect(result.action?.description).toContain("Settings > MCP");
    expect(result.action?.description).toContain("project source");
    expect(result.action?.description).toContain("Authenticate");
    expect(result.action?.description).toContain("Connected");
    expect(runner.requests).toEqual([]);
  });

  it.each([
    ["vscode", new VsCodeMcpSessionAdapter(), "VS Code"],
  ] as const)("%s returns an exact guided action without claiming success", async (_id, adapter, needle) => {
    const result = await adapter.login({
      ...request,
      component: componentRef("mcp:authoring-only-fixture"),
      serverId: "authoring-only-fixture",
    });
    expect(result.state).toBe("authentication-required");
    expect(result.action).toMatchObject({ kind: "guided", command: null });
    expect(result.action?.description).toContain(needle);
    expect(result.action?.description).toContain("authoring-only-fixture");
    expect(result.action?.description).not.toContain("atlassian-rovo");
  });

  it.each([
    new ClaudeCodeMcpSessionAdapter(new RecordingRunner()),
    new CodexMcpSessionAdapter(new RecordingRunner()),
    new CursorMcpSessionAdapter(new RecordingRunner(), probe(false)),
    new OpenCodeMcpSessionAdapter(new RecordingRunner()),
    new VsCodeMcpSessionAdapter(),
  ])("treats a configured no-auth MCP as ready without starting an auth action", async (adapter) => {
    const result = await adapter.inspect({
      ...request,
      component: componentRef("mcp:context7"),
      serverId: "context7",
      auth: { type: "none" },
    });
    expect(result).toMatchObject({ state: "authenticated", action: null });
  });
});

class RecordingRunner implements CommandRunner {
  readonly requests: CommandRequest[] = [];

  public async run(request: CommandRequest) {
    this.requests.push(request);
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

class OpenCodeRunner implements CommandRunner {
  readonly requests: CommandRequest[] = [];
  readonly #results: Array<{ exitCode: number; stdout: string; stderr: string }>;

  public constructor(results: Array<{ exitCode: number; stdout: string; stderr: string }>) {
    this.#results = [...results];
  }

  public async run(request: CommandRequest) {
    this.requests.push(request);
    const result = this.#results.shift();
    if (result === undefined) throw new Error("Unexpected OpenCode command");
    return result;
  }
}

function oauthStatus(state: "authenticated" | "not authenticated") {
  return {
    exitCode: 0,
    stdout: `\u001b[32m●  ${request.serverId}\u001b[0m ${state}\n`,
    stderr: "",
  };
}

function probe(detected: boolean): ExecutableProbe {
  return {
    async probe(command) {
      return {
        detected,
        path: detected ? `/test/bin/${command}` : null,
        version: detected ? "test" : null,
        diagnostics: [],
      };
    },
  };
}

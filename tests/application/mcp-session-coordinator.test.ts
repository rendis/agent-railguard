import { describe, expect, it } from "vitest";
import { McpSessionCoordinator } from "../../src/application/mcp-session-coordinator.js";
import type {
  McpSessionAdapter,
  McpSessionRequest,
  McpSessionResult,
} from "../../src/domain/mcp/session.js";
import { componentRef, harnessTargetId } from "../../src/domain/shared/types.js";

const request: McpSessionRequest = {
  root: "/workspace/project",
  component: componentRef("mcp:atlassian-rovo"),
  serverId: "atlassian-rovo",
  auth: { type: "oauth", activation: "harness-native" },
};

describe("McpSessionCoordinator", () => {
  it("orders targets and isolates a failed native login", async () => {
    const events: string[] = [];
    const coordinator = new McpSessionCoordinator({
      adapters: [
        adapter("opencode", "authenticated"),
        adapter("codex", "authentication-required", true),
      ],
      progress: (event) => events.push(`${event.target}:${event.status}`),
    });

    const result = await coordinator.execute("login", request, [
      harnessTargetId("opencode"),
      harnessTargetId("codex"),
      harnessTargetId("vscode"),
    ]);

    expect(result.results.map((entry) => [entry.target, entry.state])).toEqual([
      ["codex", "authentication-unknown"],
      ["opencode", "authenticated"],
      ["vscode", "unsupported"],
    ]);
    expect(events).toEqual([
      "codex:started",
      "codex:failed",
      "opencode:started",
      "opencode:completed",
      "vscode:started",
      "vscode:completed",
    ]);
  });

  it("rejects a duplicate adapter id", () => {
    expect(() => new McpSessionCoordinator({
      adapters: [adapter("codex", "authentication-unknown"), adapter("codex", "authenticated")],
    })).toThrow("MCP session adapter IDs must be unique");
  });

  it("redacts sensitive values from adapter failures before returning diagnostics", async () => {
    const coordinator = new McpSessionCoordinator({
      adapters: [throwingAdapter("codex", "Authorization: Bearer SYNTHETIC_SECRET callback?code=SYNTHETIC_CODE")],
    });

    const result = await coordinator.execute("login", request, [harnessTargetId("codex")]);

    expect(result.results[0]?.message).toContain("Authorization: [REDACTED]");
    expect(result.results[0]?.message).toContain("callback?code=[REDACTED]");
    expect(result.results[0]?.message).not.toContain("SYNTHETIC_SECRET");
    expect(result.results[0]?.message).not.toContain("SYNTHETIC_CODE");
  });
});

function adapter(
  id: "codex" | "opencode",
  state: McpSessionResult["state"],
  fail = false,
): McpSessionAdapter {
  const result = (): McpSessionResult => ({
    target: harnessTargetId(id),
    state,
    action: null,
    message: `${id}:${state}`,
  });
  return {
    id: harnessTargetId(id),
    async inspect() { return result(); },
    async login() {
      if (fail) throw new Error("synthetic login failure");
      return result();
    },
    async logout() { return result(); },
  };
}

function throwingAdapter(id: "codex", message: string): McpSessionAdapter {
  const fail = async (): Promise<McpSessionResult> => {
    throw new Error(message);
  };
  return {
    id: harnessTargetId(id),
    inspect: fail,
    login: fail,
    logout: fail,
  };
}

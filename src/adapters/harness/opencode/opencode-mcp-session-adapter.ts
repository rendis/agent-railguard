import type { McpSessionAdapter, McpSessionRequest, McpSessionResult } from "../../../domain/mcp/session.js";
import type { CommandRunner } from "../../../domain/process/command-runner.js";
import { harnessTargetId } from "../../../domain/shared/types.js";

export class OpenCodeMcpSessionAdapter implements McpSessionAdapter {
  public readonly id = harnessTargetId("opencode");
  readonly #runner: CommandRunner;

  public constructor(runner: CommandRunner) { this.#runner = runner; }

  public async inspect(request: McpSessionRequest): Promise<McpSessionResult> {
    const command = ["opencode", "mcp", "auth", "list"] as const;
    if (request.auth.type === "none") return result("authenticated", "This MCP does not require authentication.");
    const outcome = await this.#runner.run({ command: command[0], args: command.slice(1), cwd: request.root, ...(request.signal === undefined ? {} : { signal: request.signal }) });
    if (outcome.exitCode !== 0) return result("authentication-unknown", "OpenCode could not inspect its native MCP OAuth status.", command);
    const state = parseAuthState(`${outcome.stdout}\n${outcome.stderr}`, request.serverId);
    if (state === "authenticated") return result("authenticated", "OpenCode reports an active native MCP OAuth session.", command);
    if (state === "authentication-required") return result("authentication-required", "OpenCode reports that this MCP is not authenticated.", command);
    return result("authentication-unknown", "OpenCode did not return a conclusive native MCP OAuth status.", command);
  }

  public async login(request: McpSessionRequest): Promise<McpSessionResult> {
    if (request.auth.type === "none") return result("authenticated", "This MCP does not require authentication.");
    const command = ["opencode", "mcp", "auth", request.serverId] as const;
    const outcome = await this.#runner.run({ command: command[0], args: command.slice(1), cwd: request.root, ...(request.signal === undefined ? {} : { signal: request.signal }) });
    if (outcome.exitCode !== 0) throw new Error(`opencode mcp auth exited with ${outcome.exitCode}`);
    const inspection = await this.inspect(request);
    if (inspection.state !== "authenticated") {
      return result(inspection.state, "OpenCode's native OAuth flow ended without an authenticated session.", command);
    }
    return result("authenticated", "OpenCode completed and confirmed the native MCP OAuth login.", command);
  }

  public async logout(request: McpSessionRequest): Promise<McpSessionResult> {
    if (request.auth.type === "none") return result("authenticated", "This MCP does not have an authentication session.");
    const command = ["opencode", "mcp", "logout", request.serverId] as const;
    const outcome = await this.#runner.run({ command: command[0], args: command.slice(1), cwd: request.root, ...(request.signal === undefined ? {} : { signal: request.signal }) });
    if (outcome.exitCode !== 0) throw new Error(`opencode mcp logout exited with ${outcome.exitCode}`);
    return result("authentication-required", "OpenCode removed its local MCP OAuth session.", command);
  }
}

function parseAuthState(output: string, serverId: string): "authenticated" | "authentication-required" | "authentication-unknown" {
  const plain = output.replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "");
  const line = plain.split(/\r?\n/u).find((entry) => entry.includes(serverId));
  if (line === undefined) return "authentication-unknown";
  if (/\bnot authenticated\b/iu.test(line)) return "authentication-required";
  if (/\bauthenticated\b/iu.test(line)) return "authenticated";
  return "authentication-unknown";
}

function result(state: McpSessionResult["state"], message: string, command?: readonly string[]): McpSessionResult {
  return Object.freeze({
    target: harnessTargetId("opencode"), state, message,
    action: command === undefined ? null : Object.freeze({ kind: "command" as const, description: command.join(" "), command: Object.freeze([...command]) }),
  });
}

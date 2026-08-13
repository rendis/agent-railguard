import type { McpSessionAdapter, McpSessionRequest, McpSessionResult } from "../../../domain/mcp/session.js";
import type { CommandRunner } from "../../../domain/process/command-runner.js";
import { harnessTargetId } from "../../../domain/shared/types.js";

export class CodexMcpSessionAdapter implements McpSessionAdapter {
  public readonly id = harnessTargetId("codex");
  readonly #runner: CommandRunner;

  public constructor(runner: CommandRunner) {
    this.#runner = runner;
  }

  public async inspect(request: McpSessionRequest): Promise<McpSessionResult> {
    const command = ["codex", "mcp", "list"] as const;
    return result(request.auth.type === "none" ? "authenticated" : "authentication-unknown",
      "Codex does not expose a stable machine-readable OAuth status contract for this project server; inspect its native server list.",
      request.auth.type === "none" ? undefined : command);
  }

  public async login(request: McpSessionRequest): Promise<McpSessionResult> {
    if (request.auth.type === "none") return result("authenticated", "This MCP does not require authentication.");
    const command = ["codex", "mcp", "login", request.serverId] as const;
    const outcome = await this.#runner.run({ command: command[0], args: command.slice(1), cwd: request.root, ...(request.signal === undefined ? {} : { signal: request.signal }) });
    if (outcome.exitCode !== 0) throw new Error(`codex mcp login exited with ${outcome.exitCode}`);
    return result("authenticated", "Codex completed the native MCP OAuth login.", command);
  }

  public async logout(request: McpSessionRequest): Promise<McpSessionResult> {
    if (request.auth.type === "none") return result("authenticated", "This MCP does not have an authentication session.");
    const command = ["codex", "mcp", "logout", request.serverId] as const;
    const outcome = await this.#runner.run({ command: command[0], args: command.slice(1), cwd: request.root, ...(request.signal === undefined ? {} : { signal: request.signal }) });
    if (outcome.exitCode !== 0) throw new Error(`codex mcp logout exited with ${outcome.exitCode}`);
    return result("authentication-required", "Codex removed its local MCP OAuth session.", command);
  }
}

function result(state: McpSessionResult["state"], message: string, command?: readonly string[]): McpSessionResult {
  return Object.freeze({
    target: harnessTargetId("codex"), state, message,
    action: command === undefined ? null : Object.freeze({ kind: "command" as const, description: command.join(" "), command: Object.freeze([...command]) }),
  });
}

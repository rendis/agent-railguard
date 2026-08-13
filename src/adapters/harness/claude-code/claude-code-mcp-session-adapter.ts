import type {
  McpSessionAdapter,
  McpSessionRequest,
  McpSessionResult,
} from "../../../domain/mcp/session.js";
import type { CommandRunner } from "../../../domain/process/command-runner.js";
import { harnessTargetId } from "../../../domain/shared/types.js";

export class ClaudeCodeMcpSessionAdapter implements McpSessionAdapter {
  public readonly id = harnessTargetId("claude-code");
  readonly #runner: CommandRunner;

  public constructor(runner: CommandRunner) {
    this.#runner = runner;
  }

  public async inspect(request: McpSessionRequest): Promise<McpSessionResult> {
    if (request.auth.type === "none") {
      return result("authenticated", "This MCP does not require authentication.");
    }
    return result(
      "authentication-unknown",
      "Claude Code exposes connection and approval state through its native MCP list and /mcp panel.",
      ["claude", "mcp", "list"],
    );
  }

  public async login(request: McpSessionRequest): Promise<McpSessionResult> {
    if (request.auth.type === "none") {
      return result("authenticated", "This MCP does not require authentication.");
    }
    const command = ["claude", "mcp", "login", request.serverId] as const;
    const outcome = await this.#runner.run({
      command: command[0],
      args: command.slice(1),
      cwd: request.root,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    if (outcome.exitCode !== 0) {
      throw new Error(`claude mcp login exited with ${outcome.exitCode}`);
    }
    return result("authenticated", "Claude Code completed the native MCP OAuth login.", command);
  }

  public async logout(request: McpSessionRequest): Promise<McpSessionResult> {
    if (request.auth.type === "none") {
      return result("authenticated", "This MCP does not have an authentication session.");
    }
    const command = ["claude", "mcp", "logout", request.serverId] as const;
    const outcome = await this.#runner.run({
      command: command[0],
      args: command.slice(1),
      cwd: request.root,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    if (outcome.exitCode !== 0) {
      throw new Error(`claude mcp logout exited with ${outcome.exitCode}`);
    }
    return result("authentication-required", "Claude Code cleared its native MCP OAuth credentials.", command);
  }
}

function result(
  state: McpSessionResult["state"],
  message: string,
  command?: readonly string[],
): McpSessionResult {
  return Object.freeze({
    target: harnessTargetId("claude-code"),
    state,
    message,
    action: command === undefined
      ? null
      : Object.freeze({
          kind: "command" as const,
          description: command.join(" "),
          command: Object.freeze([...command]),
        }),
  });
}

import type { ExecutableProbe } from "../../../domain/harness/model.js";
import type {
  McpSessionAdapter,
  McpSessionRequest,
  McpSessionResult,
} from "../../../domain/mcp/session.js";
import type { CommandRunner } from "../../../domain/process/command-runner.js";
import { harnessTargetId } from "../../../domain/shared/types.js";

export class CursorMcpSessionAdapter implements McpSessionAdapter {
  public readonly id = harnessTargetId("cursor");
  readonly #runner: CommandRunner;
  readonly #probe: ExecutableProbe;

  public constructor(runner: CommandRunner, probe: ExecutableProbe) {
    this.#runner = runner;
    this.#probe = probe;
  }

  public async inspect(request: McpSessionRequest): Promise<McpSessionResult> {
    if (request.auth.type === "none") {
      return result("authenticated", "This MCP does not require authentication.");
    }
    if (await this.#hasAgentCli()) {
      return result(
        "authentication-unknown",
        "Cursor Agent exposes configured MCP server status through its native list command.",
        ["cursor-agent", "mcp", "list"],
      );
    }
    return guided(
      request,
      "authentication-unknown",
      `Open Cursor MCP settings for this repository and inspect ${request.serverId}.`,
    );
  }

  public async login(request: McpSessionRequest): Promise<McpSessionResult> {
    if (request.auth.type === "none") {
      return result("authenticated", "This MCP does not require authentication.");
    }
    if (!(await this.#hasAgentCli())) {
      return guided(
        request,
        "authentication-required",
        `Open this repository in Cursor, go to Settings > MCP, open ${request.serverId}, enable its project source, select Authenticate, complete OAuth in the browser, and verify that Cursor shows it under Connected.`,
      );
    }
    const command = ["cursor-agent", "mcp", "login", request.serverId] as const;
    const outcome = await this.#runner.run({
      command: command[0],
      args: command.slice(1),
      cwd: request.root,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    if (outcome.exitCode !== 0) {
      throw new Error(`cursor-agent mcp login exited with ${outcome.exitCode}`);
    }
    return result("authenticated", "Cursor Agent completed the native MCP OAuth login.", command);
  }

  public async logout(request: McpSessionRequest): Promise<McpSessionResult> {
    if (request.auth.type === "none") {
      return result("authenticated", "This MCP does not have an authentication session.");
    }
    return guided(
      request,
      "authentication-unknown",
      `Open Cursor MCP settings and disconnect or clear the ${request.serverId} authentication explicitly.`,
    );
  }

  async #hasAgentCli(): Promise<boolean> {
    return (await this.#probe.probe("cursor-agent", ["--version"])).detected;
  }
}

function result(
  state: McpSessionResult["state"],
  message: string,
  command?: readonly string[],
): McpSessionResult {
  return Object.freeze({
    target: harnessTargetId("cursor"),
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

function guided(
  request: McpSessionRequest,
  state: McpSessionResult["state"],
  description: string,
): McpSessionResult {
  return Object.freeze({
    target: harnessTargetId("cursor"),
    state,
    message: description,
    action: request.auth.type === "none"
      ? null
      : Object.freeze({ kind: "guided" as const, description, command: null }),
  });
}

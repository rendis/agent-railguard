import type { McpSessionAdapter, McpSessionRequest, McpSessionResult } from "../../../domain/mcp/session.js";
import { harnessTargetId } from "../../../domain/shared/types.js";

export class VsCodeMcpSessionAdapter implements McpSessionAdapter {
  public readonly id = harnessTargetId("vscode");
  public async inspect(request: McpSessionRequest) { return guided(request, request.auth.type === "none" ? "authenticated" : "authentication-unknown", `Open VS Code MCP management for this workspace and inspect ${request.serverId}.`); }
  public async login(request: McpSessionRequest) { return guided(request, request.auth.type === "none" ? "authenticated" : "authentication-required", `Open VS Code for this workspace, start the ${request.serverId} MCP server, and complete its OAuth prompt.`); }
  public async logout(request: McpSessionRequest) { return guided(request, request.auth.type === "none" ? "authenticated" : "authentication-unknown", `Open VS Code MCP management and disconnect or clear ${request.serverId} authentication explicitly.`); }
}

function guided(request: McpSessionRequest, state: McpSessionResult["state"], description: string): McpSessionResult {
  return Object.freeze({ target: harnessTargetId("vscode"), state, message: description, action: request.auth.type === "none" ? null : Object.freeze({ kind: "guided" as const, description, command: null }) });
}

import type { CatalogMcpIntegrationComponent } from "../catalog/model.js";
import type { ComponentRef, HarnessTargetId } from "../shared/types.js";

export type McpAuthenticationState =
  | "authenticated"
  | "authentication-required"
  | "authentication-unknown"
  | "unsupported"
  | "not-configured";

export interface McpSessionRequest {
  readonly root: string;
  readonly component: ComponentRef;
  readonly serverId: string;
  readonly auth: CatalogMcpIntegrationComponent["auth"];
  readonly signal?: AbortSignal;
}

export interface McpSessionAction {
  readonly kind: "command" | "guided";
  readonly description: string;
  readonly command: readonly string[] | null;
}

export interface McpSessionResult {
  readonly target: HarnessTargetId;
  readonly state: McpAuthenticationState;
  readonly action: McpSessionAction | null;
  readonly message: string;
}

export interface McpSessionAdapter {
  readonly id: HarnessTargetId;
  inspect(request: McpSessionRequest): Promise<McpSessionResult>;
  login(request: McpSessionRequest): Promise<McpSessionResult>;
  logout(request: McpSessionRequest): Promise<McpSessionResult>;
}

export type McpSessionOperation = "inspect" | "login" | "logout";

export interface McpSessionProgress {
  readonly target: HarnessTargetId;
  readonly operation: McpSessionOperation;
  readonly status: "started" | "completed" | "failed";
  readonly message: string;
}

export interface McpSessionAggregateResult {
  readonly operation: McpSessionOperation;
  readonly component: ComponentRef;
  readonly results: readonly McpSessionResult[];
}

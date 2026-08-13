import type {
  McpSessionAdapter,
  McpSessionAggregateResult,
  McpSessionOperation,
  McpSessionProgress,
  McpSessionRequest,
  McpSessionResult,
} from "../domain/mcp/session.js";
import { compareUtf8, type HarnessTargetId } from "../domain/shared/types.js";
import { redactSensitiveText } from "../domain/process/redact-sensitive-text.js";

export interface McpSessionCoordinatorOptions {
  readonly adapters: readonly McpSessionAdapter[];
  readonly progress?: (event: McpSessionProgress) => void;
}

export class McpSessionCoordinator {
  readonly #adapters: ReadonlyMap<HarnessTargetId, McpSessionAdapter>;
  readonly #progress: (event: McpSessionProgress) => void;

  public constructor(options: McpSessionCoordinatorOptions) {
    const entries = [...options.adapters]
      .sort((left, right) => compareUtf8(left.id, right.id))
      .map((adapter) => [adapter.id, adapter] as const);
    if (new Set(entries.map(([id]) => id)).size !== entries.length) {
      throw new TypeError("MCP session adapter IDs must be unique");
    }
    this.#adapters = new Map(entries);
    this.#progress = options.progress ?? (() => undefined);
  }

  public async execute(
    operation: McpSessionOperation,
    request: McpSessionRequest,
    targets: readonly HarnessTargetId[],
  ): Promise<McpSessionAggregateResult> {
    const results: McpSessionResult[] = [];
    for (const target of [...new Set(targets)].sort(compareUtf8)) {
      this.#emit(target, operation, "started", `Starting MCP ${operation} for ${target}`);
      const adapter = this.#adapters.get(target);
      if (adapter === undefined) {
        results.push(Object.freeze({
          target,
          state: "unsupported",
          action: null,
          message: `No MCP session adapter is registered for ${target}.`,
        }));
        this.#emit(target, operation, "completed", `MCP ${operation} is unsupported for ${target}`);
        continue;
      }
      try {
        const result = await adapter[operation](request);
        results.push(Object.freeze(result));
        this.#emit(target, operation, "completed", result.message);
      } catch (error) {
        const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
        results.push(Object.freeze({
          target,
          state: "authentication-unknown",
          action: null,
          message: `MCP ${operation} failed for ${target}: ${message}`,
        }));
        this.#emit(target, operation, "failed", `MCP ${operation} failed for ${target}`);
      }
    }
    return Object.freeze({
      operation,
      component: request.component,
      results: Object.freeze(results),
    });
  }

  #emit(
    target: HarnessTargetId,
    operation: McpSessionOperation,
    status: McpSessionProgress["status"],
    message: string,
  ): void {
    this.#progress(Object.freeze({ target, operation, status, message }));
  }
}

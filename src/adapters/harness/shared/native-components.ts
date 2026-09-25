import type {
  CatalogAgentComponent,
  CatalogAgentHookComponent,
  CatalogComponent,
  CatalogMcpIntegrationComponent,
  CatalogSnapshot,
} from "../../../domain/catalog/model.js";
import type { ReadyResolution } from "../../../domain/resolution/model.js";
import { compareUtf8 } from "../../../domain/shared/types.js";

export interface NativeComponents {
  readonly agents: readonly CatalogAgentComponent[];
  readonly agentHooks: readonly CatalogAgentHookComponent[];
  readonly mcps: readonly CatalogMcpIntegrationComponent[];
}

export function nativeComponents(
  resolution: ReadyResolution,
  catalog: CatalogSnapshot,
): NativeComponents {
  const byRef = new Map(catalog.components.map((component) => [component.ref, component]));
  const resolved = resolution.components
    .map((entry) => requireComponent(byRef, entry.ref))
    .sort((left, right) => compareUtf8(left.ref, right.ref));
  return Object.freeze({
    agents: Object.freeze(
      resolved.filter(
        (component): component is CatalogAgentComponent => component.kind === "agent",
      ),
    ),
    agentHooks: Object.freeze(
      resolved.filter(
        (component): component is CatalogAgentHookComponent => component.kind === "agent-hook",
      ),
    ),
    mcps: Object.freeze(
      resolved.filter(
        (component): component is CatalogMcpIntegrationComponent =>
          component.kind === "mcp-integration",
      ),
    ),
  });
}

function requireComponent(
  byRef: ReadonlyMap<string, CatalogComponent>,
  ref: string,
): CatalogComponent {
  const component = byRef.get(ref);
  if (component === undefined) {
    throw new TypeError(`Resolution/catalog mismatch for component: ${ref}`);
  }
  return component;
}

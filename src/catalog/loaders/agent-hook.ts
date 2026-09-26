import type { CatalogComponent } from "../../domain/catalog/model.js";
import { capabilityId, componentRef, relativePosixPath, semVer, sha256 } from "../../domain/shared/types.js";
import {
  inlineIntegrity,
  normalizeRelations,
  type LoadedComponent,
  type RelationDefinition,
} from "./shared.js";

export interface AgentHookDefinition {
  readonly version: string;
  readonly description: string;
  readonly details: string;
  readonly event: "stop";
  readonly operation: "check" | "verify";
  readonly relations?: readonly RelationDefinition[];
}

export function loadAgentHook(id: string, definition: AgentHookDefinition): LoadedComponent {
  const ref = componentRef(`agent-hook:${id}`);
  const version = semVer(definition.version);
  const relations = normalizeRelations(definition.relations ?? []);
  const definitionDigest = sha256(
    JSON.stringify({
      ref,
      version,
      description: definition.description,
      details: definition.details,
      event: definition.event,
      operation: definition.operation,
      relations,
    }),
  );
  const payloadDigest = sha256("");
  const component: CatalogComponent = Object.freeze({
    kind: "agent-hook",
    ref,
    version,
    description: definition.description,
    details: definition.details,
    capabilities: Object.freeze([capabilityId("project.agent-hooks")]),
    trust: "local-agent-execution",
    applies: null,
    relations,
    payload: null,
    event: definition.event,
    operation: definition.operation,
    integrity: inlineIntegrity(ref, version, definitionDigest, payloadDigest),
  });
  return Object.freeze({
    component,
    sourceDirectory: relativePosixPath("railguard.yaml"),
    authoringPointer: `/catalog/agent-hooks/${id}`,
  });
}

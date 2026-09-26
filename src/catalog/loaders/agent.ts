import type { CatalogComponent } from "../../domain/catalog/model.js";
import { capabilityId, componentRef, relativePosixPath, semVer, sha256 } from "../../domain/shared/types.js";
import {
  inlineIntegrity,
  normalizeApplies,
  normalizeRelations,
  type AppliesDefinition,
  type LoadedComponent,
  type RelationDefinition,
} from "./shared.js";

export interface AgentDefinition {
  readonly version: string;
  readonly description: string;
  readonly details: string;
  readonly prompt: string;
  readonly applies?: AppliesDefinition;
  readonly relations?: readonly RelationDefinition[];
}

export function loadAgent(id: string, definition: AgentDefinition): LoadedComponent {
  const ref = componentRef(`agent:${id}`);
  const version = semVer(definition.version);
  const relations = normalizeRelations(definition.relations ?? []);
  const applies = definition.applies === undefined ? null : normalizeApplies(definition.applies);
  const prompt = normalizeTextBody(definition.prompt);
  const definitionDigest = sha256(
    JSON.stringify({
      ref,
      version,
      description: definition.description,
      details: definition.details,
      prompt,
      applies,
      relations,
    }),
  );
  const payloadDigest = sha256("");
  const component: CatalogComponent = Object.freeze({
    kind: "agent",
    ref,
    version,
    description: definition.description,
    details: definition.details,
    capabilities: Object.freeze([capabilityId("project.agents")]),
    trust: "agent-instruction",
    applies,
    relations,
    payload: null,
    prompt,
    integrity: inlineIntegrity(ref, version, definitionDigest, payloadDigest),
  });
  return Object.freeze({
    component,
    sourceDirectory: relativePosixPath("railguard.yaml"),
    authoringPointer: `/catalog/agents/${id}`,
  });
}

function normalizeTextBody(body: string): string {
  const normalized = body.replaceAll("\r\n", "\n");
  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

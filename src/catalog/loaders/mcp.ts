import type { CatalogComponent } from "../../domain/catalog/model.js";
import { capabilityId, compareUtf8, componentRef, relativePosixPath, semVer, sha256 } from "../../domain/shared/types.js";
import {
  inlineIntegrity,
  normalizeApplies,
  normalizeRelations,
  type AppliesDefinition,
  type LoadedComponent,
  type RelationDefinition,
} from "./shared.js";

export interface McpDefinition {
  readonly version: string;
  readonly description: string;
  readonly details: string;
  readonly trust: "third-party-network";
  readonly connection:
    | { readonly type: "stdio"; readonly command: string; readonly args: readonly string[] }
    | { readonly type: "remote-http"; readonly url: string };
  readonly tools: readonly string[];
  readonly network: "runtime-required";
  readonly auth:
    | { readonly type: "none" }
    | { readonly type: "oauth"; readonly activation: "harness-native" };
  readonly applies?: AppliesDefinition;
  readonly relations?: readonly RelationDefinition[];
}

export function loadMcp(id: string, definition: McpDefinition): LoadedComponent {
  const ref = componentRef(`mcp:${id}`);
  const version = semVer(definition.version);
  const relations = normalizeRelations(definition.relations ?? []);
  const applies = definition.applies === undefined ? null : normalizeApplies(definition.applies);
  const connection = definition.connection.type === "stdio"
    ? Object.freeze({
        type: "stdio" as const,
        command: definition.connection.command,
        args: Object.freeze([...definition.connection.args]),
      })
    : Object.freeze({
        type: "remote-http" as const,
        url: definition.connection.url,
      });
  const auth = definition.auth.type === "none"
    ? Object.freeze({ type: "none" as const })
    : Object.freeze({ type: "oauth" as const, activation: "harness-native" as const });
  const tools = Object.freeze([...definition.tools].sort(compareUtf8));
  const definitionDigest = sha256(
    JSON.stringify({
      ref,
      version,
      description: definition.description,
      details: definition.details,
      trust: definition.trust,
      connection,
      tools,
      network: definition.network,
      auth,
      applies,
      relations,
    }),
  );
  const payloadDigest = sha256("");
  const component: CatalogComponent = Object.freeze({
    kind: "mcp-integration",
    ref,
    version,
    description: definition.description,
    details: definition.details,
    capabilities: Object.freeze([capabilityId("project.mcp")]),
    trust: definition.trust,
    applies,
    relations,
    payload: null,
    connection,
    tools,
    network: definition.network,
    auth,
    integrity: inlineIntegrity(ref, version, definitionDigest, payloadDigest),
  });
  return Object.freeze({
    component,
    sourceDirectory: relativePosixPath("railguard.yaml"),
    authoringPointer: `/catalog/mcps/${id}`,
  });
}

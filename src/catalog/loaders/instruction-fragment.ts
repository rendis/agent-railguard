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

export interface InstructionFragmentDefinition {
  readonly version: string;
  readonly description: string;
  readonly details: string;
  readonly section: string;
  readonly content: {
    readonly kind: "catalog-index";
    readonly group: "skills" | "mcps" | "agents" | "automation" | "quality";
  };
  readonly applies?: AppliesDefinition;
  readonly relations?: readonly RelationDefinition[];
}

export function loadInstructionFragment(
  id: string,
  definition: InstructionFragmentDefinition,
): LoadedComponent {
  const ref = componentRef(`instruction-fragment:${id}`);
  const version = semVer(definition.version);
  const relations = normalizeRelations(definition.relations ?? []);
  const applies = definition.applies === undefined ? null : normalizeApplies(definition.applies);
  const content = Object.freeze({
    kind: "catalog-index" as const,
    group: definition.content.group,
  });
  const definitionDigest = sha256(
    JSON.stringify({
      ref,
      version,
      description: definition.description,
      details: definition.details,
      section: definition.section,
      content,
      applies,
      relations,
    }),
  );
  const payloadDigest = sha256("");
  const component: CatalogComponent = Object.freeze({
    kind: "instruction-fragment",
    ref,
    version,
    description: definition.description,
    details: definition.details,
    capabilities: Object.freeze([capabilityId("project.instructions")]),
    trust: "project-write",
    applies,
    relations,
    payload: null,
    section: definition.section,
    content,
    integrity: inlineIntegrity(ref, version, definitionDigest, payloadDigest),
  });
  return Object.freeze({
    component,
    sourceDirectory: relativePosixPath("railguard.yaml"),
    authoringPointer: `/catalog/instruction-fragments/${id}`,
  });
}

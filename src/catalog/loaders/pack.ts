import type { CatalogComponent } from "../../domain/catalog/model.js";
import { componentRef, relativePosixPath, semVer, sha256 } from "../../domain/shared/types.js";
import {
  inlineIntegrity,
  normalizeApplies,
  normalizeRelations,
  type AppliesDefinition,
  type IncludeRelationDefinition,
  type LoadedComponent,
} from "./shared.js";

export interface PackDefinition {
  readonly version: string;
  readonly description: string;
  readonly details: string;
  readonly applies?: AppliesDefinition;
  readonly relations: readonly IncludeRelationDefinition[];
}

export function loadPack(id: string, definition: PackDefinition): LoadedComponent {
  const ref = componentRef(`pack:${id}`);
  const version = semVer(definition.version);
  const relations = normalizeRelations(definition.relations);
  const applies = definition.applies === undefined ? null : normalizeApplies(definition.applies);
  const definitionDigest = sha256(
    JSON.stringify({
      ref,
      version,
      description: definition.description,
      details: definition.details,
      applies,
      relations,
    }),
  );
  const payloadDigest = sha256("");
  const component: CatalogComponent = Object.freeze({
    kind: "pack",
    ref,
    version,
    description: definition.description,
    details: definition.details,
    capabilities: Object.freeze([]),
    trust: "passive",
    applies,
    relations,
    payload: null,
    integrity: inlineIntegrity(ref, version, definitionDigest, payloadDigest),
  });
  return Object.freeze({
    component,
    sourceDirectory: relativePosixPath("railguard.yaml"),
    authoringPointer: `/catalog/packs/${id}`,
  });
}

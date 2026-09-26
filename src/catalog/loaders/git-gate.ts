import type { CatalogComponent } from "../../domain/catalog/model.js";
import { componentRef, relativePosixPath, semVer, sha256 } from "../../domain/shared/types.js";
import { normalizeRelations, type LoadedComponent, type RelationDefinition } from "./shared.js";

export interface GitGateDefinition {
  readonly version: string;
  readonly description: string;
  readonly details: string;
  readonly event: "pre-commit" | "pre-push";
  readonly operation: "check" | "verify";
  readonly relations: readonly RelationDefinition[];
}

export function loadGitGate(id: string, definition: GitGateDefinition): LoadedComponent {
  const ref = componentRef(`git-gate:${id}`);
  const version = semVer(definition.version);
  const relations = normalizeRelations(definition.relations);
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
    kind: "git-gate",
    ref,
    version,
    description: definition.description,
    details: definition.details,
    capabilities: Object.freeze([]),
    trust: "local-git-execution",
    applies: null,
    relations,
    payload: null,
    event: definition.event,
    operation: definition.operation,
    integrity: Object.freeze({
      definition: definitionDigest,
      payload: payloadDigest,
      component: sha256(`${ref}\0${version}\0${definitionDigest}\0${payloadDigest}\n`),
    }),
  });
  return Object.freeze({
    component,
    sourceDirectory: relativePosixPath("railguard.yaml"),
    authoringPointer: `/catalog/git-gates/${id}`,
  });
}

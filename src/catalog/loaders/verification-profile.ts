import type { CatalogComponent } from "../../domain/catalog/model.js";
import { componentRef, compareUtf8, relativePosixPath, semVer, sha256 } from "../../domain/shared/types.js";
import {
  normalizeApplies,
  normalizeRelations,
  type AppliesDefinition,
  type LoadedComponent,
  type RelationDefinition,
} from "./shared.js";

export interface VerificationProfileDefinition {
  readonly version: string;
  readonly description: string;
  readonly details: string;
  readonly applies?: AppliesDefinition;
  readonly executables: readonly string[];
  readonly inputs: Readonly<
    Record<
      string,
      {
        readonly type: "string-list";
        readonly default: readonly string[];
        readonly item_pattern: string;
      }
    >
  >;
  readonly checks: readonly {
    readonly id: string;
    readonly kind: string;
    readonly stage: "check" | "verify";
    readonly params?: Readonly<Record<string, string | number | boolean>>;
  }[];
  readonly relations?: readonly RelationDefinition[];
}

export function loadVerificationProfile(
  id: string,
  definition: VerificationProfileDefinition,
): LoadedComponent {
  const ref = componentRef(`verification-profile:${id}`);
  const version = semVer(definition.version);
  const relations = normalizeRelations(definition.relations ?? []);
  const applies = definition.applies === undefined ? null : normalizeApplies(definition.applies);
  const inputs = Object.freeze(
    Object.entries(definition.inputs ?? {})
      .sort(([left], [right]) => compareUtf8(left, right))
      .map(([id, input]) =>
        Object.freeze({
          id,
          type: input.type,
          default: Object.freeze([...input.default].sort(compareUtf8)),
          itemPattern: input.item_pattern,
        }),
      ),
  );
  const checks = Object.freeze(
    definition.checks.map((check) =>
      Object.freeze({
        id: check.id,
        kind: check.kind,
        stage: check.stage,
        params: Object.freeze(
          Object.fromEntries(
            Object.entries(check.params ?? {}).sort(([left], [right]) => compareUtf8(left, right)),
          ),
        ),
      }),
    ),
  );
  const definitionDigest = sha256(
    JSON.stringify({
      ref,
      version,
      description: definition.description,
      details: definition.details,
      applies,
      executables: [...definition.executables].sort(compareUtf8),
      inputs,
      relations,
      checks,
    }),
  );
  const payloadDigest = sha256("");
  const component: CatalogComponent = Object.freeze({
    kind: "verification-profile",
    ref,
    version,
    description: definition.description,
    details: definition.details,
    capabilities: Object.freeze([]),
    trust: "project-write",
    applies,
    relations,
    payload: null,
    executables: Object.freeze([...definition.executables].sort(compareUtf8)),
    inputs,
    checks,
    integrity: Object.freeze({
      definition: definitionDigest,
      payload: payloadDigest,
      component: sha256(`${ref}\0${version}\0${definitionDigest}\0${payloadDigest}\n`),
    }),
  });
  return Object.freeze({
    component,
    sourceDirectory: relativePosixPath("railguard.yaml"),
    authoringPointer: `/catalog/verification-profiles/${id}`,
  });
}

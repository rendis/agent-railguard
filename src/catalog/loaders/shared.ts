import type { CatalogComponent, CatalogRelation, CatalogRelationKind } from "../../domain/catalog/model.js";
import {
  compareUtf8,
  componentRef,
  languageId,
  sha256,
  type ComponentRef,
  type Diagnostic,
  type LanguageId,
  type ReadonlyBytes,
  type RelativePosixPath,
  type SemVer,
  type Sha256Digest,
} from "../../domain/shared/types.js";

export interface RelationDefinition {
  readonly kind: Exclude<CatalogRelationKind, "includes">;
  readonly target: string;
  readonly reason: string;
}

export interface IncludeRelationDefinition {
  readonly kind: "includes";
  readonly target: string;
  readonly reason: string;
}

export interface AppliesDefinition {
  readonly languages: readonly string[];
}

export interface SourceFile {
  readonly path: RelativePosixPath;
  readonly mode: "100644" | "100755";
  readonly bytes: ReadonlyBytes;
}

export interface LoadedComponent {
  readonly component: CatalogComponent;
  readonly sourceDirectory: RelativePosixPath;
  readonly authoringPointer: string;
}

const relationOrder: Readonly<Record<CatalogRelationKind, number>> = Object.freeze({
  includes: 0,
  requires: 1,
  recommends: 2,
  composes: 3,
  conflicts: 4,
});

function compareRelations(left: CatalogRelation, right: CatalogRelation): number {
  const kindDifference = relationOrder[left.kind] - relationOrder[right.kind];
  if (kindDifference !== 0) {
    return kindDifference;
  }
  return compareUtf8(`${left.target}\0${left.reason}`, `${right.target}\0${right.reason}`);
}

export function normalizeRelations(
  relations: readonly (RelationDefinition | IncludeRelationDefinition)[],
): readonly CatalogRelation[] {
  return Object.freeze(
    relations
      .map<CatalogRelation>((relation) =>
        Object.freeze({
          kind: relation.kind,
          target: componentRef(relation.target),
          reason: relation.reason,
        }),
      )
      .sort(compareRelations),
  );
}

export function normalizeApplies(applies: {
  readonly languages: readonly string[];
}): { readonly languages: readonly LanguageId[] } {
  return Object.freeze({
    languages: Object.freeze(
      [...applies.languages].map((value) => languageId(value)).sort(compareUtf8),
    ),
  });
}

export function inlineIntegrity(
  ref: ComponentRef,
  version: SemVer,
  definition: Sha256Digest,
  payload: Sha256Digest,
) {
  return Object.freeze({
    definition,
    payload,
    component: sha256(`${ref}\0${version}\0${definition}\0${payload}\n`),
  });
}

export function normalizeSourceMode(
  mode: number,
  path: RelativePosixPath,
): SourceFile["mode"] {
  const groupOrWorldWritable = (mode & 0o022) !== 0;
  const ownerReadable = (mode & 0o400) !== 0;
  const executable = (mode & 0o111) !== 0;
  const ownerExecutable = (mode & 0o100) !== 0;
  if (
    !ownerReadable ||
    groupOrWorldWritable ||
    (executable && !ownerExecutable)
  ) {
    throw new Error(`Source file mode is unsafe: ${path}:${mode.toString(8)}`);
  }
  return executable ? "100755" : "100644";
}

export function diagnostic(input: {
  readonly code: string;
  readonly phase: Diagnostic["phase"];
  readonly message: string;
  readonly path?: RelativePosixPath | null;
  readonly pointer?: string;
  readonly subjects?: readonly ComponentRef[];
  readonly evidence: readonly string[];
}): Diagnostic {
  const location =
    input.path === undefined || input.path === null
      ? null
      : input.pointer === undefined
        ? Object.freeze({ path: input.path })
        : Object.freeze({ path: input.path, pointer: input.pointer });
  return Object.freeze({
    code: input.code,
    severity: "failed",
    phase: input.phase,
    subjects: Object.freeze([...(input.subjects ?? [])]),
    location,
    message: input.message,
    evidence: Object.freeze([...input.evidence].sort(compareUtf8)),
    impact: "The catalog snapshot is invalid and cannot be resolved.",
    action: "Correct the catalog authoring input and load the complete snapshot again.",
  });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

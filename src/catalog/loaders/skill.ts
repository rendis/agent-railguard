import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { posix, relative, resolve, sep } from "node:path";
import type { CatalogComponent, CatalogFile } from "../../domain/catalog/model.js";
import {
  ReadonlyBytes,
  capabilityId,
  compareUtf8,
  componentRef,
  relativePosixPath,
  semVer,
  sha256,
  type Diagnostic,
  type RelativePosixPath,
} from "../../domain/shared/types.js";
import { parseSafeYaml } from "../../shared/safe-yaml.js";
import {
  diagnostic,
  errorMessage,
  normalizeApplies,
  normalizeRelations,
  normalizeSourceMode,
  type AppliesDefinition,
  type LoadedComponent,
  type RelationDefinition,
  type SourceFile,
} from "./shared.js";

const maximumSkillDescriptionLength = 320;

export interface SkillDefinition {
  readonly version: string;
  readonly details: string;
  readonly source: string;
  readonly applies?: AppliesDefinition;
  readonly relations?: readonly RelationDefinition[];
}

export async function loadSkill(
  id: string,
  definition: SkillDefinition,
  authoringRoot: string,
): Promise<{
  readonly loaded: LoadedComponent | null;
  readonly diagnostics: readonly Diagnostic[];
}> {
  const authoringPointer = `/catalog/skills/${id}`;
  const sourceDirectory = relativePosixPath(definition.source);
  const absoluteRoot = resolve(authoringRoot, ...definition.source.split("/"));
  const diagnostics: Diagnostic[] = [];
  const relativeSource = relative(authoringRoot, absoluteRoot);
  if (
    relativeSource === "" ||
    relativeSource === ".." ||
    relativeSource.startsWith(`..${sep}`) ||
    resolve(authoringRoot, relativeSource) !== absoluteRoot
  ) {
    return {
      loaded: null,
      diagnostics: [
        diagnostic({
          code: "catalog.payload.invalid",
          phase: "payload",
          message: "A component source must remain below the authoring root.",
          path: relativePosixPath("railguard.yaml"),
          pointer: `${authoringPointer}/source`,
          evidence: [definition.source],
        }),
      ],
    };
  }
  let files: readonly SourceFile[];
  try {
    files = await readComponentFiles(absoluteRoot, sourceDirectory);
  } catch (error) {
    diagnostics.push(
      diagnostic({
        code: "catalog.payload.invalid",
        phase: "payload",
        message: "The component payload could not be inventoried safely.",
        path: sourceDirectory,
        evidence: [errorMessage(error)],
      }),
    );
    return { loaded: null, diagnostics };
  }

  const entry = files.find((file) => file.path === "SKILL.md");
  if (entry === undefined) {
    diagnostics.push(
      diagnostic({
        code: "catalog.skill.standard-invalid",
        phase: "skill",
        message: "A skill requires one adjacent SKILL.md entry.",
        path: relativePosixPath(`${sourceDirectory}/SKILL.md`),
        evidence: [],
      }),
    );
  }
  if (entry === undefined) {
    return { loaded: null, diagnostics };
  }

  const skillMetadata = parseSkillMetadata(entry.bytes.toString());
  if (
    skillMetadata.kind === "invalid" ||
    skillMetadata.name !== id ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillMetadata.name) ||
    skillMetadata.description.length === 0 ||
    skillMetadata.description.length > maximumSkillDescriptionLength
  ) {
    diagnostics.push(
      diagnostic({
        code: "catalog.skill.standard-invalid",
        phase: "skill",
        message: "SKILL.md frontmatter must identify its directory and a valid description.",
        path: relativePosixPath(`${sourceDirectory}/SKILL.md`),
        evidence:
          skillMetadata.kind === "invalid"
            ? skillMetadata.errors
            : [
                `catalog-id:${id}`,
                `name:${skillMetadata.name}`,
                `description-length:${skillMetadata.description.length}`,
                `description-limit:${maximumSkillDescriptionLength}`,
              ],
      }),
    );
    return { loaded: null, diagnostics };
  }

  const payloadFiles = files;
  const payloadPaths = new Set(payloadFiles.map((file) => file.path));
  const directSkillTargets = new Set<RelativePosixPath>();
  for (const target of localMarkdownTargets(entry.bytes.toString())) {
    const resolvedTarget = resolvePayloadLink(entry.path, target);
    if (resolvedTarget !== null) directSkillTargets.add(resolvedTarget);
  }
  for (const reference of payloadFiles.filter(
    (file) => file.path.startsWith("references/") && file.path.endsWith(".md"),
  )) {
    if (directSkillTargets.has(reference.path)) continue;
    diagnostics.push(
      diagnostic({
        code: "catalog.skill.reference-unreachable",
        phase: "skill",
        message: "Every skill reference must be linked directly from SKILL.md.",
        path: relativePosixPath(`${sourceDirectory}/${reference.path}`),
        evidence: [reference.path],
      }),
    );
  }
  const collision = findCaseInsensitiveCollision(payloadFiles.map((file) => file.path));
  if (collision !== null) {
    diagnostics.push(
      diagnostic({
        code: "catalog.payload.invalid",
        phase: "payload",
        message: "Payload paths collide after ASCII lowercase normalization.",
          path: relativePosixPath(`${sourceDirectory}/${collision[0]}`),
        evidence: collision,
      }),
    );
  }
  for (const file of payloadFiles.filter((candidate) => candidate.path.endsWith(".md"))) {
    for (const target of localMarkdownTargets(file.bytes.toString())) {
      const resolvedTarget = resolvePayloadLink(file.path, target);
      if (resolvedTarget === null || !payloadPaths.has(resolvedTarget)) {
        diagnostics.push(
          diagnostic({
            code: "catalog.payload.invalid",
            phase: "payload",
            message: "A local Markdown link must resolve to a file in the same payload.",
            path: relativePosixPath(`${sourceDirectory}/${file.path}`),
            evidence: [target],
          }),
        );
      }
    }
  }
  if (diagnostics.length > 0) {
    return { loaded: null, diagnostics };
  }

  const normalizedFiles: CatalogFile[] = payloadFiles
    .map((file) =>
      Object.freeze({
        path: file.path,
        mode: file.mode,
        digest: file.bytes.digest(),
        bytes: new ReadonlyBytes(file.bytes.copy()),
      }),
    )
    .sort((left, right) => compareUtf8(left.path, right.path));
  const payloadDigest = sha256(
    normalizedFiles
      .map((file) => `${file.mode}\0${file.path}\0${file.digest}\n`)
      .join(""),
  );
  const ref = componentRef(`skill:${skillMetadata.name}`);
  const version = semVer(definition.version);
  const relations = normalizeRelations(definition.relations ?? []);
  const applies =
    definition.applies === undefined ? null : normalizeApplies(definition.applies);
  const definitionDigest = sha256(
    JSON.stringify({
      ref,
      version,
      source: sourceDirectory,
      details: definition.details,
      applies,
      relations,
    }),
  );
  const componentDigest = sha256(
    `${ref}\0${version}\0${definitionDigest}\0${payloadDigest}\n`,
  );
  const component: CatalogComponent = Object.freeze({
    kind: "skill",
    ref,
    version,
    description: skillMetadata.description,
    details: definition.details,
    capabilities: Object.freeze([capabilityId("project.skills")]),
    trust: "passive",
    applies,
    relations,
    payload: Object.freeze({
      entry: relativePosixPath("SKILL.md"),
      files: Object.freeze(normalizedFiles),
    }),
    integrity: Object.freeze({
      definition: definitionDigest,
      payload: payloadDigest,
      component: componentDigest,
    }),
  });

  return {
    loaded: Object.freeze({ component, sourceDirectory, authoringPointer }),
    diagnostics: Object.freeze([]),
  };
}

async function readComponentFiles(
  root: string,
  sourceDirectory: RelativePosixPath,
): Promise<readonly SourceFile[]> {
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Component root is not a regular directory: ${sourceDirectory}`);
  }
  const files: SourceFile[] = [];
  await walk("");
  files.sort((left, right) => compareUtf8(left.path, right.path));
  return Object.freeze(files);

  async function walk(relativeDirectory: string): Promise<void> {
    const absoluteDirectory =
      relativeDirectory.length === 0 ? root : resolve(root, ...relativeDirectory.split("/"));
    const directory = await opendir(absoluteDirectory);
    const entries = [];
    for await (const entry of directory) {
      entries.push(entry);
    }
    entries.sort((left, right) => compareUtf8(left.name, right.name));
    for (const entry of entries) {
      const value = relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`;
      const path = catalogPath(value);
      const absolutePath = resolve(root, ...value.split("/"));
      const pathStat = await lstat(absolutePath);
      if (pathStat.isSymbolicLink()) {
        throw new Error(`Payload symlink is forbidden: ${path}`);
      }
      if (pathStat.isDirectory()) {
        await walk(value);
        continue;
      }
      if (!pathStat.isFile()) {
        throw new Error(`Payload entry must be a regular file: ${path}`);
      }
      const portableMode = normalizeSourceMode(pathStat.mode & 0o777, path);
      const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
      const handle = await open(absolutePath, constants.O_RDONLY | noFollow);
      let bytes: Uint8Array;
      try {
        const openedStat = await handle.stat();
        if (
          !openedStat.isFile() ||
          openedStat.dev !== pathStat.dev ||
          openedStat.ino !== pathStat.ino ||
          normalizeSourceMode(openedStat.mode & 0o777, path) !== portableMode
        ) {
          throw new Error(`Payload entry changed during read: ${path}`);
        }
        bytes = await handle.readFile();
      } finally {
        await handle.close();
      }
      files.push(
        Object.freeze({
          path,
          mode: portableMode,
          bytes: new ReadonlyBytes(bytes),
        }),
      );
    }
  }
}

function catalogPath(value: string): RelativePosixPath {
  const path = relativePosixPath(value);
  if (path.split("/").some((segment) => !/^[A-Za-z0-9._-]+$/.test(segment))) {
    throw new Error(`Catalog payload path contains a non-portable segment: ${value}`);
  }
  return path;
}

function parseSkillMetadata(source: string):
  | { readonly kind: "ready"; readonly name: string; readonly description: string }
  | { readonly kind: "invalid"; readonly errors: readonly string[] } {
  const normalized = source.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) {
    return { kind: "invalid", errors: Object.freeze(["Missing YAML frontmatter start"]) };
  }
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) {
    return { kind: "invalid", errors: Object.freeze(["Missing YAML frontmatter end"]) };
  }
  const parsed = parseSafeYaml(normalized.slice(4, end));
  if (parsed.kind === "invalid") {
    return parsed;
  }
  const value = parsed.value as Readonly<Record<string, unknown>>;
  if (typeof value.name !== "string" || typeof value.description !== "string") {
    return {
      kind: "invalid",
      errors: Object.freeze(["Frontmatter requires string name and description"]),
    };
  }
  return { kind: "ready", name: value.name, description: value.description.trim() };
}

function findCaseInsensitiveCollision(
  paths: readonly RelativePosixPath[],
): readonly [RelativePosixPath, RelativePosixPath] | null {
  const seen = new Map<string, RelativePosixPath>();
  for (const path of paths) {
    const normalized = path.toLowerCase();
    const previous = seen.get(normalized);
    if (previous !== undefined && previous !== path) {
      return Object.freeze([previous, path]);
    }
    seen.set(normalized, path);
  }
  return null;
}

function localMarkdownTargets(source: string): readonly string[] {
  const targets: string[] = [];
  for (const match of source.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    let target = match[1]?.trim() ?? "";
    if (target.startsWith("<") && target.endsWith(">")) {
      target = target.slice(1, -1);
    }
    if (target.length === 0 || target.startsWith("#") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) {
      continue;
    }
    targets.push(target.split("#", 1)[0] ?? target);
  }
  return targets;
}

function resolvePayloadLink(
  source: RelativePosixPath,
  target: string,
): RelativePosixPath | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    return null;
  }
  const resolved = posix.normalize(posix.join(posix.dirname(source), decoded));
  try {
    return catalogPath(resolved);
  } catch {
    return null;
  }
}

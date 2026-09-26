import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ErrorObject } from "ajv/dist/2020.js";
import authoringSchema from "../../schemas/railguard.v1.schema.json" with {
  type: "json",
};
import type {
  Catalog,
  CatalogLoadResult,
  CatalogSnapshot,
} from "../domain/catalog/model.js";
import {
  ReadonlyBytes,
  compareDiagnostics,
  compareUtf8,
  relativePosixPath,
  semVer,
  sha256,
  type Diagnostic,
  type LanguageId,
  type RelativePosixPath,
} from "../domain/shared/types.js";
import { parseSafeYaml } from "../shared/safe-yaml.js";
import { lazyValidator } from "../shared/schema-validator.js";
import { validateCatalog } from "./catalog-validation.js";
import { loadAgent, type AgentDefinition } from "./loaders/agent.js";
import { loadAgentHook, type AgentHookDefinition } from "./loaders/agent-hook.js";
import { loadGitGate, type GitGateDefinition } from "./loaders/git-gate.js";
import {
  loadInstructionFragment,
  type InstructionFragmentDefinition,
} from "./loaders/instruction-fragment.js";
import { loadMcp, type McpDefinition } from "./loaders/mcp.js";
import { loadPack, type PackDefinition } from "./loaders/pack.js";
import { diagnostic, errorMessage, normalizeSourceMode, type LoadedComponent, type SourceFile } from "./loaders/shared.js";
import { loadSkill, type SkillDefinition } from "./loaders/skill.js";
import {
  loadVerificationProfile,
  type VerificationProfileDefinition,
} from "./loaders/verification-profile.js";

interface RailguardAuthoring {
  readonly schema: "railguard/v1";
  readonly version: string;
  readonly catalog: {
    readonly skills: Readonly<Record<string, SkillDefinition>>;
    readonly mcps: Readonly<Record<string, McpDefinition>>;
    readonly "verification-profiles": Readonly<Record<string, VerificationProfileDefinition>>;
    readonly "git-gates": Readonly<Record<string, GitGateDefinition>>;
    readonly "agent-hooks"?: Readonly<Record<string, AgentHookDefinition>>;
    readonly "instruction-fragments": Readonly<Record<string, InstructionFragmentDefinition>>;
    readonly packs: Readonly<Record<string, PackDefinition>>;
    readonly agents: Readonly<Record<string, AgentDefinition>>;
  };
}

export interface FilesystemCatalogOptions {
  readonly catalogFile: string;
  readonly supportedLanguages: readonly LanguageId[];
}

const authoringValidator = lazyValidator<RailguardAuthoring>(authoringSchema);

export class FilesystemCatalog implements Catalog {
  readonly #catalogFile: string;
  readonly #authoringRoot: string;
  readonly #supportedLanguages: ReadonlySet<LanguageId>;

  public constructor(options: FilesystemCatalogOptions) {
    this.#catalogFile = resolve(options.catalogFile);
    this.#authoringRoot = dirname(this.#catalogFile);
    this.#supportedLanguages = new Set(options.supportedLanguages);
  }

  public async load(): Promise<CatalogLoadResult> {
    let source: SourceFile;
    try {
      source = await readRegularSourceFile(this.#catalogFile, relativePosixPath("railguard.yaml"));
      if (source.mode !== "100644") {
        throw new Error("railguard.yaml must use mode 100644");
      }
    } catch (error) {
      return invalidResult([
        diagnostic({
          code: "catalog.source.unreadable",
          phase: "source",
          message: "The catalog source could not be enumerated safely.",
          evidence: [errorMessage(error)],
        }),
      ]);
    }

    const parsed = parseSafeYaml(source.bytes.toString());
    if (parsed.kind === "invalid") {
      return invalidResult([
        diagnostic({
          code: "catalog.authoring.parse-invalid",
          phase: "parse",
          message: "railguard.yaml is not the required safe YAML mapping.",
          path: relativePosixPath("railguard.yaml"),
          evidence: parsed.errors,
        }),
      ]);
    }
    const validateAuthoring = authoringValidator();
    if (!validateAuthoring(parsed.value)) {
      const pointer = firstSchemaPointer(validateAuthoring.errors);
      return invalidResult([
        diagnostic({
          code: "catalog.authoring.schema-invalid",
          phase: "schema",
          message: "railguard.yaml does not satisfy the closed marketplace schema.",
          path: relativePosixPath("railguard.yaml"),
          ...(pointer === undefined ? {} : { pointer }),
          evidence: schemaEvidence(validateAuthoring.errors),
        }),
      ]);
    }

    const diagnostics: Diagnostic[] = [];
    const loaded: LoadedComponent[] = [];
    for (const [id, definition] of Object.entries(parsed.value.catalog.skills).sort(
      ([left], [right]) => compareUtf8(left, right),
    )) {
      const result = await loadSkill(id, definition, this.#authoringRoot);
      diagnostics.push(...result.diagnostics);
      if (result.loaded !== null) {
        loaded.push(result.loaded);
      }
    }
    for (const [id, definition] of Object.entries(parsed.value.catalog.mcps).sort(
      ([left], [right]) => compareUtf8(left, right),
    )) {
      loaded.push(loadMcp(id, definition));
    }
    for (const [id, definition] of Object.entries(
      parsed.value.catalog["verification-profiles"],
    ).sort(([left], [right]) => compareUtf8(left, right))) {
      loaded.push(loadVerificationProfile(id, definition));
    }
    for (const [id, definition] of Object.entries(parsed.value.catalog["git-gates"]).sort(
      ([left], [right]) => compareUtf8(left, right),
    )) {
      loaded.push(loadGitGate(id, definition));
    }
    for (const [id, definition] of Object.entries(parsed.value.catalog["agent-hooks"] ?? {}).sort(
      ([left], [right]) => compareUtf8(left, right),
    )) {
      loaded.push(loadAgentHook(id, definition));
    }
    for (const [id, definition] of Object.entries(
      parsed.value.catalog["instruction-fragments"],
    ).sort(([left], [right]) => compareUtf8(left, right))) {
      loaded.push(loadInstructionFragment(id, definition));
    }
    for (const [id, definition] of Object.entries(parsed.value.catalog.packs).sort(
      ([left], [right]) => compareUtf8(left, right),
    )) {
      loaded.push(loadPack(id, definition));
    }
    for (const [id, definition] of Object.entries(parsed.value.catalog.agents).sort(
      ([left], [right]) => compareUtf8(left, right),
    )) {
      loaded.push(loadAgent(id, definition));
    }

    diagnostics.push(...validateCatalog(loaded, this.#supportedLanguages));
    diagnostics.sort(compareDiagnostics);
    if (diagnostics.length > 0) {
      return invalidResult(diagnostics);
    }

    const components = loaded
      .map((entry) => entry.component)
      .sort((left, right) => compareUtf8(left.ref, right.ref));
    const snapshotRecords = components.map(
      (component) =>
        `${component.ref}\0${component.version}\0${component.integrity.component}\n`,
    );
    const catalog: CatalogSnapshot = Object.freeze({
      revision: semVer(parsed.value.version),
      digest: sha256(`${parsed.value.schema}\0${parsed.value.version}\n${snapshotRecords.join("")}`),
      components: Object.freeze(components),
    });

    return Object.freeze({
      kind: "ready",
      catalog,
      diagnostics: Object.freeze([]),
    });
  }
}

async function readRegularSourceFile(
  absolutePath: string,
  path: RelativePosixPath,
): Promise<SourceFile> {
  const pathStat = await lstat(absolutePath);
  if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
    throw new Error(`Authoring source must be a regular file: ${path}`);
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
      throw new Error(`Authoring source changed during read: ${path}`);
    }
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  return Object.freeze({
    path,
    mode: portableMode,
    bytes: new ReadonlyBytes(bytes),
  });
}

function schemaEvidence(errors: readonly ErrorObject[] | null | undefined): readonly string[] {
  return Object.freeze(
    (errors ?? [])
      .map((error) => `${error.instancePath || "/"}:${error.keyword}:${error.message ?? "invalid"}`)
      .sort(compareUtf8),
  );
}

function firstSchemaPointer(errors: readonly ErrorObject[] | null | undefined): string | undefined {
  return [...(errors ?? [])]
    .sort((left, right) => compareUtf8(left.instancePath, right.instancePath))[0]?.instancePath;
}

function invalidResult(diagnostics: readonly Diagnostic[]): CatalogLoadResult {
  const sorted = [...diagnostics].sort(compareDiagnostics);
  const first = sorted[0];
  if (first === undefined) {
    throw new Error("An invalid catalog result requires at least one diagnostic");
  }
  return Object.freeze({
    kind: "invalid",
    diagnostics: Object.freeze([first, ...sorted.slice(1)]) as readonly [
      Diagnostic,
      ...Diagnostic[],
    ],
  });
}

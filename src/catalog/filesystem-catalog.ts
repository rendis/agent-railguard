import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { dirname, posix, relative, resolve, sep } from "node:path";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import authoringSchema from "../../schemas/railguard.v1.schema.json" with {
  type: "json",
};
import type {
  Catalog,
  CatalogComponent,
  CatalogFile,
  CatalogLoadResult,
  CatalogRelation,
  CatalogRelationKind,
  CatalogSnapshot,
} from "../domain/catalog/model.js";
import {
  ReadonlyBytes,
  capabilityId,
  compareDiagnostics,
  compareUtf8,
  componentRef,
  languageId,
  relativePosixPath,
  semVer,
  sha256,
  type ComponentRef,
  type Diagnostic,
  type LanguageId,
  type RelativePosixPath,
  type SemVer,
  type Sha256Digest,
} from "../domain/shared/types.js";
import { parseSafeYaml } from "../shared/safe-yaml.js";

const maximumSkillDescriptionLength = 320;

interface RelationDefinition {
  readonly kind: Exclude<CatalogRelationKind, "includes">;
  readonly target: string;
  readonly reason: string;
}

interface IncludeRelationDefinition {
  readonly kind: "includes";
  readonly target: string;
  readonly reason: string;
}

interface AppliesDefinition {
  readonly languages: readonly string[];
}

interface SkillDefinition {
  readonly version: string;
  readonly details: string;
  readonly source: string;
  readonly applies?: AppliesDefinition;
  readonly relations?: readonly RelationDefinition[];
}

interface McpDefinition {
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

interface InstructionFragmentDefinition {
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

interface PackDefinition {
  readonly version: string;
  readonly description: string;
  readonly details: string;
  readonly applies?: AppliesDefinition;
  readonly relations: readonly IncludeRelationDefinition[];
}

interface AgentDefinition {
  readonly version: string;
  readonly description: string;
  readonly details: string;
  readonly prompt: string;
  readonly applies?: AppliesDefinition;
  readonly relations?: readonly RelationDefinition[];
}

interface VerificationProfileDefinition {
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

interface GitGateDefinition {
  readonly version: string;
  readonly description: string;
  readonly details: string;
  readonly event: "pre-commit" | "pre-push";
  readonly operation: "check" | "verify";
  readonly relations: readonly RelationDefinition[];
}

interface AgentHookDefinition {
  readonly version: string;
  readonly description: string;
  readonly details: string;
  readonly event: "stop";
  readonly operation: "check" | "verify";
  readonly relations?: readonly RelationDefinition[];
}

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

interface SourceFile {
  readonly path: RelativePosixPath;
  readonly mode: "100644" | "100755";
  readonly bytes: ReadonlyBytes;
}

interface LoadedComponent {
  readonly component: CatalogComponent;
  readonly sourceDirectory: RelativePosixPath;
  readonly authoringPointer: string;
}

export interface FilesystemCatalogOptions {
  readonly catalogFile: string;
  readonly supportedLanguages: readonly LanguageId[];
}

const relationOrder: Readonly<Record<CatalogRelationKind, number>> = Object.freeze({
  includes: 0,
  requires: 1,
  recommends: 2,
  composes: 3,
  conflicts: 4,
});

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateAuthoring = ajv.compile<RailguardAuthoring>(authoringSchema);

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
      const result = await this.#loadSkill(id, definition);
      diagnostics.push(...result.diagnostics);
      if (result.loaded !== null) {
        loaded.push(result.loaded);
      }
    }
    for (const [id, definition] of Object.entries(parsed.value.catalog.mcps).sort(
      ([left], [right]) => compareUtf8(left, right),
    )) {
      loaded.push(this.#loadMcp(id, definition));
    }
    for (const [id, definition] of Object.entries(
      parsed.value.catalog["verification-profiles"],
    ).sort(([left], [right]) => compareUtf8(left, right))) {
      loaded.push(this.#loadVerificationProfile(id, definition));
    }
    for (const [id, definition] of Object.entries(parsed.value.catalog["git-gates"]).sort(
      ([left], [right]) => compareUtf8(left, right),
    )) {
      loaded.push(this.#loadGitGate(id, definition));
    }
    for (const [id, definition] of Object.entries(parsed.value.catalog["agent-hooks"] ?? {}).sort(
      ([left], [right]) => compareUtf8(left, right),
    )) {
      loaded.push(this.#loadAgentHook(id, definition));
    }
    for (const [id, definition] of Object.entries(
      parsed.value.catalog["instruction-fragments"],
    ).sort(([left], [right]) => compareUtf8(left, right))) {
      loaded.push(this.#loadInstructionFragment(id, definition));
    }
    for (const [id, definition] of Object.entries(parsed.value.catalog.packs).sort(
      ([left], [right]) => compareUtf8(left, right),
    )) {
      loaded.push(this.#loadPack(id, definition));
    }
    for (const [id, definition] of Object.entries(parsed.value.catalog.agents).sort(
      ([left], [right]) => compareUtf8(left, right),
    )) {
      loaded.push(this.#loadAgent(id, definition));
    }

    diagnostics.push(...this.#validateCatalog(loaded));
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

  async #loadSkill(id: string, definition: SkillDefinition): Promise<{
    readonly loaded: LoadedComponent | null;
    readonly diagnostics: readonly Diagnostic[];
  }> {
    const authoringPointer = `/catalog/skills/${id}`;
    const sourceDirectory = relativePosixPath(definition.source);
    const absoluteRoot = resolve(this.#authoringRoot, ...definition.source.split("/"));
    const diagnostics: Diagnostic[] = [];
    const relativeSource = relative(this.#authoringRoot, absoluteRoot);
    if (
      relativeSource === "" ||
      relativeSource === ".." ||
      relativeSource.startsWith(`..${sep}`) ||
      resolve(this.#authoringRoot, relativeSource) !== absoluteRoot
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

  #loadMcp(id: string, definition: McpDefinition): LoadedComponent {
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

  #loadInstructionFragment(
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

  #loadPack(id: string, definition: PackDefinition): LoadedComponent {
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

  #loadAgent(id: string, definition: AgentDefinition): LoadedComponent {
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

  #loadVerificationProfile(
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

  #loadGitGate(id: string, definition: GitGateDefinition): LoadedComponent {
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

  #loadAgentHook(id: string, definition: AgentHookDefinition): LoadedComponent {
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

  #validateCatalog(loaded: readonly LoadedComponent[]): readonly Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const byRef = new Map<ComponentRef, LoadedComponent[]>();
    for (const entry of loaded) {
      const values = byRef.get(entry.component.ref) ?? [];
      values.push(entry);
      byRef.set(entry.component.ref, values);
    }
    for (const [ref, entries] of byRef) {
      if (entries.length > 1) {
        diagnostics.push(
          diagnostic({
            code: "catalog.identity.duplicate",
            phase: "catalog",
            message: "Two source directories normalize to the same component identity.",
            path: entries[0]!.sourceDirectory,
            subjects: [ref],
            evidence: entries.map((entry) => entry.sourceDirectory),
          }),
        );
      }
    }

    const uniqueComponents = new Map(
      [...byRef.entries()]
        .filter(([, entries]) => entries.length === 1)
        .map(([ref, entries]) => [ref, entries[0] as LoadedComponent]),
    );
    const sectionOwners = new Map<string, LoadedComponent>();
    const groupOwners = new Map<string, LoadedComponent>();
    for (const entry of loaded) {
      if (entry.component.kind !== "instruction-fragment") continue;
      const canonicalSection = `${entry.component.content.group}.mapping`;
      if (entry.component.section !== canonicalSection) {
        diagnostics.push(
          diagnostic({
            code: "catalog.instruction-fragment.section-noncanonical",
            phase: "catalog",
            message: "A grouped instruction mapping must use its canonical managed section ID.",
            path: relativePosixPath("railguard.yaml"),
            pointer: `${entry.authoringPointer}/section`,
            subjects: [entry.component.ref],
            evidence: [entry.component.section, canonicalSection],
          }),
        );
      }
      const previousGroupOwner = groupOwners.get(entry.component.content.group);
      if (previousGroupOwner !== undefined) {
        diagnostics.push(
          diagnostic({
            code: "catalog.instruction-fragment.group-duplicate",
            phase: "catalog",
            message: "Only one managed instruction mapping may own a component group.",
            path: relativePosixPath("railguard.yaml"),
            pointer: `${entry.authoringPointer}/content/group`,
            subjects: [previousGroupOwner.component.ref, entry.component.ref],
            evidence: [entry.component.content.group],
          }),
        );
      } else {
        groupOwners.set(entry.component.content.group, entry);
      }
      const previousOwner = sectionOwners.get(entry.component.section);
      if (previousOwner !== undefined) {
        diagnostics.push(
          diagnostic({
            code: "catalog.instruction-fragment.section-duplicate",
            phase: "catalog",
            message: "Two instruction fragments cannot own the same managed section.",
            path: relativePosixPath("railguard.yaml"),
            pointer: `${entry.authoringPointer}/section`,
            subjects: [previousOwner.component.ref, entry.component.ref],
            evidence: [entry.component.section],
          }),
        );
      } else {
        sectionOwners.set(entry.component.section, entry);
      }
    }
    for (const entry of loaded) {
      const component = entry.component;
      for (const language of component.applies?.languages ?? []) {
        if (!this.#supportedLanguages.has(language)) {
          diagnostics.push(
            diagnostic({
              code: "catalog.language.unknown",
              phase: "catalog",
              message: "The catalog declares a language with no registered stack adapter.",
              path: relativePosixPath("railguard.yaml"),
              pointer: `${entry.authoringPointer}/applies/languages`,
              subjects: [component.ref],
              evidence: [language],
            }),
          );
        }
      }

      if (component.kind === "verification-profile") {
        for (const input of component.inputs) {
          let pattern: RegExp;
          try {
            pattern = new RegExp(input.itemPattern, "u");
          } catch (error) {
            diagnostics.push(
              diagnostic({
                code: "catalog.input.pattern-invalid",
                phase: "catalog",
                message: "A verification input declares an invalid item pattern.",
                path: relativePosixPath("railguard.yaml"),
                pointer: `${entry.authoringPointer}/inputs/${input.id}/item_pattern`,
                subjects: [component.ref],
                evidence: [errorMessage(error)],
              }),
            );
            continue;
          }
          const rejectedDefaults = input.default.filter((value) => !pattern.test(value));
          if (rejectedDefaults.length > 0) {
            diagnostics.push(
              diagnostic({
                code: "catalog.input.default-invalid",
                phase: "catalog",
                message: "A verification input default is rejected by its item pattern.",
                path: relativePosixPath("railguard.yaml"),
                pointer: `${entry.authoringPointer}/inputs/${input.id}/default`,
                subjects: [component.ref],
                evidence: rejectedDefaults,
              }),
            );
          }
        }
        const checkIds = component.checks.map((check) => check.id);
        const duplicateChecks = checkIds.filter((id, index) => checkIds.indexOf(id) !== index);
        if (duplicateChecks.length > 0) {
          diagnostics.push(
            diagnostic({
              code: "catalog.verification-profile.check-duplicate",
              phase: "catalog",
              message: "Every check of a verification profile needs a unique id.",
              path: relativePosixPath("railguard.yaml"),
              pointer: `${entry.authoringPointer}/checks`,
              subjects: [component.ref],
              evidence: [...new Set(duplicateChecks)].sort(compareUtf8),
            }),
          );
        }
      }

      const targets = new Set<ComponentRef>();
      for (const relation of component.relations) {
        if (relation.target === component.ref || targets.has(relation.target)) {
          diagnostics.push(
            diagnostic({
              code: "catalog.relation.invalid",
              phase: "catalog",
              message: "A relation cannot be a self-reference or duplicate a target.",
              path: relativePosixPath("railguard.yaml"),
              pointer: `${entry.authoringPointer}/relations`,
              subjects: [component.ref],
              evidence: [relation.target],
            }),
          );
        }
        targets.add(relation.target);
        if (!uniqueComponents.has(relation.target)) {
          diagnostics.push(
            diagnostic({
              code: "catalog.relation.target-missing",
              phase: "catalog",
              message: "A relation target does not exist in the same catalog snapshot.",
              path: relativePosixPath("railguard.yaml"),
              pointer: `${entry.authoringPointer}/relations`,
              subjects: [component.ref],
              evidence: [relation.target],
            }),
          );
        }
      }

      if (component.kind === "git-gate") {
        const requiredProfiles = component.relations
          .filter((relation) => relation.kind === "requires")
          .map((relation) => uniqueComponents.get(relation.target)?.component)
          .filter(
            (target): target is Extract<CatalogComponent, { readonly kind: "verification-profile" }> =>
              target?.kind === "verification-profile",
          );
        if (requiredProfiles.length !== 1) {
          diagnostics.push(
            diagnostic({
              code: "catalog.git-gate.profile-invalid",
              phase: "catalog",
              message: "A Git gate must require exactly one verification profile.",
              path: relativePosixPath("railguard.yaml"),
              pointer: `${entry.authoringPointer}/relations`,
              subjects: [component.ref],
              evidence: component.relations
                .filter((relation) => relation.kind === "requires")
                .map((relation) => relation.target),
            }),
          );
        }
      }
    }

    const cycle = findHardCycle([...uniqueComponents.values()].map((entry) => entry.component));
    if (cycle !== null) {
      diagnostics.push(
        diagnostic({
          code: "catalog.graph.cycle",
          phase: "catalog",
          message: "The hard dependency graph contains a cycle.",
          path: null,
          subjects: cycle,
          evidence: cycle,
        }),
      );
    }
    return diagnostics;
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

function normalizeSourceMode(
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

function compareRelations(left: CatalogRelation, right: CatalogRelation): number {
  const kindDifference = relationOrder[left.kind] - relationOrder[right.kind];
  if (kindDifference !== 0) {
    return kindDifference;
  }
  return compareUtf8(`${left.target}\0${left.reason}`, `${right.target}\0${right.reason}`);
}

function normalizeRelations(
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

function normalizeApplies(applies: {
  readonly languages: readonly string[];
}): { readonly languages: readonly LanguageId[] } {
  return Object.freeze({
    languages: Object.freeze(
      [...applies.languages].map((value) => languageId(value)).sort(compareUtf8),
    ),
  });
}

function normalizeTextBody(body: string): string {
  const normalized = body.replaceAll("\r\n", "\n");
  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

function inlineIntegrity(
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

function findHardCycle(components: readonly CatalogComponent[]): readonly ComponentRef[] | null {
  const graph = new Map<ComponentRef, readonly ComponentRef[]>(
    components.map((component) => [
      component.ref,
      Object.freeze(
        component.relations
          .filter((relation) => relation.kind === "requires" || relation.kind === "includes")
          .map((relation) => relation.target)
          .sort(compareUtf8),
      ),
    ]),
  );
  const visited = new Set<ComponentRef>();
  const active = new Set<ComponentRef>();
  const stack: ComponentRef[] = [];

  const visitNode = (node: ComponentRef): readonly ComponentRef[] | null => {
    if (active.has(node)) {
      const start = stack.indexOf(node);
      return Object.freeze([...stack.slice(start), node]);
    }
    if (visited.has(node)) {
      return null;
    }
    active.add(node);
    stack.push(node);
    for (const target of graph.get(node) ?? []) {
      if (!graph.has(target)) {
        continue;
      }
      const cycle = visitNode(target);
      if (cycle !== null) {
        return cycle;
      }
    }
    stack.pop();
    active.delete(node);
    visited.add(node);
    return null;
  };

  for (const node of [...graph.keys()].sort(compareUtf8)) {
    const cycle = visitNode(node);
    if (cycle !== null) {
      return cycle;
    }
  }
  return null;
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

function diagnostic(input: {
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

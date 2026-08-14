import { chmod, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FilesystemCatalog } from "../../src/catalog/filesystem-catalog.js";
import { componentRef, languageId } from "../../src/domain/shared/types.js";
import { createTempRepository } from "../helpers/temp-repository.js";

const supportedLanguages = [
  languageId("go"),
  languageId("python"),
  languageId("typescript"),
  languageId("java"),
];

describe("FilesystemCatalog", () => {
  it("loads the seven real skills as one immutable canonical snapshot", async () => {
    const catalog = new FilesystemCatalog({
      catalogFile: resolve("ai-harness.yaml"),
      supportedLanguages,
    });

    const first = await catalog.load();
    const second = await catalog.load();

    expect(first.kind).toBe("ready");
    expect(second.kind).toBe("ready");
    if (first.kind !== "ready" || second.kind !== "ready") {
      throw new Error("Expected the authoring catalog to be valid");
    }

    expect(first.catalog.digest).toBe(second.catalog.digest);
    expect(
      first.catalog.components
        .filter((component) => component.kind === "skill")
        .map((component) => component.ref),
    ).toEqual([
      "skill:build-e2e-test-suite",
      "skill:configure-go-quality",
      "skill:design-tests",
      "skill:develop-go-hexagonal-service",
      "skill:review-go-quality",
      "skill:tdd",
      "skill:test-go-service",
    ]);
    expect(
      first.catalog.components.filter((component) => component.kind === "skill").flatMap((component) =>
        component.payload.files.filter((file) => file.path.endsWith("ai-harness.yaml")),
      ),
    ).toEqual([]);
    expect(
      first.catalog.components.filter((component) => component.kind === "skill").every((component) =>
        component.payload.files.some((file) => file.path === "SKILL.md"),
      ),
    ).toBe(true);

    const firstFile = first.catalog.components.find((component) => component.kind === "skill")?.payload.files[0];
    expect(firstFile).toBeDefined();
    if (firstFile !== undefined) {
      const copy = firstFile.bytes.copy();
      copy[0] = copy[0] === 0 ? 1 : 0;
      expect(firstFile.bytes.digest()).toBe(firstFile.digest);
    }
  });

  it("loads the Go verification profile and optional Git gates as typed components", async () => {
    const result = await new FilesystemCatalog({
      catalogFile: resolve("ai-harness.yaml"),
      supportedLanguages,
    }).load();

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") {
      throw new Error("Expected centralized quality authoring to be valid");
    }
    expect(
      result.catalog.components
        .filter((component) => component.ref.startsWith("verification-profile:"))
        .map((component) => component.ref),
    ).toEqual([
      "verification-profile:go-assurance",
      "verification-profile:go-e2e",
      "verification-profile:go-fuzz",
      "verification-profile:go-mutation",
      "verification-profile:go-quality",
    ]);
    expect(
      result.catalog.components
        .filter((component) => component.ref.startsWith("git-gate:"))
        .map((component) => component.ref),
    ).toEqual([
      "git-gate:pre-commit-check",
      "git-gate:pre-commit-verify",
      "git-gate:pre-push-check",
      "git-gate:pre-push-verify",
    ]);
    expect(
      result.catalog.components
        .find((component) => component.ref === "skill:configure-go-quality")
        ?.relations.map((relation) => [relation.kind, relation.target]),
    ).toContainEqual(["requires", "verification-profile:go-quality"]);
    const profile = result.catalog.components.find(
      (component) => component.ref === "verification-profile:go-quality",
    );
    expect(profile?.kind === "verification-profile" ? profile.inputs : []).toEqual([
      {
        id: "module_roots",
        type: "string-list",
        default: ["."],
        itemPattern: "^(?:\\.|[A-Za-z0-9_][A-Za-z0-9_-]*(?:/[A-Za-z0-9_][A-Za-z0-9_-]*)*)$",
        makeVariable: "AI_HARNESS_GO_MODULE_ROOTS",
        source: "project-units",
      },
      {
        id: "test_packages",
        type: "string-list",
        default: ["./..."],
        itemPattern: "^(?:\\./|[A-Za-z0-9_])[A-Za-z0-9_./-]*(?:\\.\\.\\.)?$",
        makeVariable: "AI_HARNESS_GO_TEST_PACKAGES",
        source: "literal",
      },
    ]);
  });

  it("loads every v0.1 component family from the single central catalog", async () => {
    const result = await new FilesystemCatalog({
      catalogFile: resolve("ai-harness.yaml"),
      supportedLanguages,
    }).load();

    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") {
      throw new Error("Expected the complete centralized catalog to be valid");
    }

    const byRef = new Map(result.catalog.components.map((component) => [component.ref, component]));
    expect(new Set(result.catalog.components.map((component) => component.kind))).toEqual(
      new Set([
        "skill",
        "mcp-integration",
        "verification-profile",
        "git-gate",
        "instruction-fragment",
        "pack",
        "agent",
      ]),
    );
    expect(
      result.catalog.components.every(
        (component) => component.description.length > 0 && component.details.length >= 40,
      ),
    ).toBe(true);

    expect(byRef.get(componentRef("mcp:context7"))).toMatchObject({
      kind: "mcp-integration",
      connection: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@upstash/context7-mcp@4.0.0"],
      },
      auth: { type: "none" },
      network: "runtime-required",
      tools: ["query-docs", "resolve-library-id"],
    });
    expect(byRef.get(componentRef("mcp:atlassian-rovo"))).toMatchObject({
      kind: "mcp-integration",
      connection: {
        type: "remote-http",
        url: "https://mcp.atlassian.com/v1/mcp/authv2",
      },
      auth: { type: "oauth", activation: "harness-native" },
      tools: expect.arrayContaining([
        "getJiraIssue",
        "searchJiraIssuesUsingJql",
        "createJiraIssue",
        "editJiraIssue",
      ]),
    });
    expect(
      result.catalog.components
        .filter((component) => component.kind === "instruction-fragment")
        .map((component) => component.section),
    ).toEqual([
      "agents.mapping",
      "automation.mapping",
      "mcps.mapping",
      "quality.mapping",
      "skills.mapping",
    ]);
    expect(byRef.get(componentRef("agent:go-reviewer"))).toMatchObject({
      kind: "agent",
      applies: { languages: ["go"] },
    });
    expect(byRef.get(componentRef("pack:testing-foundation"))?.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "includes", target: "skill:tdd" }),
      ]),
    );
    expect(byRef.get(componentRef("pack:go-service-foundation"))?.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "includes",
          target: "skill:develop-go-hexagonal-service",
        }),
        expect.objectContaining({ kind: "includes", target: "mcp:context7" }),
        expect.objectContaining({ kind: "includes", target: "agent:go-reviewer" }),
      ]),
    );
  });

  it("loads a remote HTTPS MCP with harness-native OAuth", async () => {
    const root = await createTempRepository({
      "ai-harness.yaml": authoring([], remoteOauthMcpAuthoring()),
    });
    try {
      const result = await new FilesystemCatalog({
        catalogFile: join(root.root, "ai-harness.yaml"),
        supportedLanguages,
      }).load();

      expect(result.kind, JSON.stringify(result)).toBe("ready");
      if (result.kind === "ready") {
        expect(result.catalog.components).toContainEqual(
          expect.objectContaining({
            kind: "mcp-integration",
            ref: "mcp:remote-docs",
            connection: {
              type: "remote-http",
              url: "https://mcp.example.test/v1/mcp",
            },
            auth: { type: "oauth", activation: "harness-native" },
          }),
        );
      }
    } finally {
      await root.cleanup();
    }
  });

  it.each([
    ["non-HTTPS remote URL", "        url: http://mcp.example.test/v1/mcp"],
    ["stdio fields on remote", "        command: npx"],
    ["unsupported remote auth", "        type: none"],
  ])("rejects %s", async (_name, replacement) => {
    const source = authoring([], remoteOauthMcpAuthoring()).replace(
      _name === "non-HTTPS remote URL"
        ? "        url: https://mcp.example.test/v1/mcp"
        : _name === "stdio fields on remote"
          ? "        url: https://mcp.example.test/v1/mcp"
          : "        type: oauth",
      replacement,
    );
    const root = await createTempRepository({ "ai-harness.yaml": source });
    try {
      const result = await new FilesystemCatalog({
        catalogFile: join(root.root, "ai-harness.yaml"),
        supportedLanguages,
      }).load();
      expect(result.kind).toBe("invalid");
    } finally {
      await root.cleanup();
    }
  });

  it("requires detailed guidance for every catalog component", async () => {
    const definition = skillDefinition("undocumented").filter(
      (line) => !line.trimStart().startsWith("details:"),
    );
    const root = await createTempRepository({
      "ai-harness.yaml": authoring(definition),
      "skills/undocumented/SKILL.md": skill("undocumented"),
    });
    try {
      const result = await new FilesystemCatalog({
        catalogFile: join(root.root, "ai-harness.yaml"),
        supportedLanguages,
      }).load();

      expect(result.kind).toBe("invalid");
      if (result.kind === "invalid") {
        expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
          "catalog.authoring.schema-invalid",
        );
      }
    } finally {
      await root.cleanup();
    }
  });

  it("rejects a verification input pattern that cannot be compiled", async () => {
    const source = qualityAuthoring(
      ["check", "verify"],
      "check",
      "check:\n  @true\n\nverify:\n  @true",
    ).replace('          item_pattern: "^\\\\./.*$"', '          item_pattern: "["');
    const root = await createTempRepository({ "ai-harness.yaml": source });
    try {
      const result = await new FilesystemCatalog({
        catalogFile: join(root.root, "ai-harness.yaml"),
        supportedLanguages,
      }).load();

      expect(result.kind).toBe("invalid");
      if (result.kind === "invalid") {
        expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
          "catalog.input.pattern-invalid",
        );
      }
    } finally {
      await root.cleanup();
    }
  });

  it("rejects two instruction mappings that claim the same component group", async () => {
    const root = await createTempRepository({
      "ai-harness.yaml": instructionGroupAuthoring([
        ["first", "first.instructions", "mcps"],
        ["second", "second.instructions", "mcps"],
      ]),
    });
    try {
      const result = await new FilesystemCatalog({
        catalogFile: join(root.root, "ai-harness.yaml"),
        supportedLanguages,
      }).load();

      expect(result.kind).toBe("invalid");
      if (result.kind === "invalid") {
        expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
          "catalog.instruction-fragment.group-duplicate",
        );
      }
    } finally {
      await root.cleanup();
    }
  });

  it("rejects a managed instruction section that does not match its group", async () => {
    const root = await createTempRepository({
      "ai-harness.yaml": instructionGroupAuthoring([
        ["context7-usage", "mcp.context7.usage", "mcps"],
      ]),
    });
    try {
      const result = await new FilesystemCatalog({
        catalogFile: join(root.root, "ai-harness.yaml"),
        supportedLanguages,
      }).load();

      expect(result.kind).toBe("invalid");
      if (result.kind === "invalid") {
        expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
          "catalog.instruction-fragment.section-noncanonical",
        );
      }
    } finally {
      await root.cleanup();
    }
  });

  it("rejects static instruction fragments outside the grouped mapping contract", async () => {
    const source = instructionGroupAuthoring([
      ["mcps-mapping", "mcps.mapping", "mcps"],
    ]).replace(
      "        kind: catalog-index\n        group: mcps",
      "        kind: text\n        body: Per-provider instructions.",
    );
    const root = await createTempRepository({ "ai-harness.yaml": source });
    try {
      const result = await new FilesystemCatalog({
        catalogFile: join(root.root, "ai-harness.yaml"),
        supportedLanguages,
      }).load();

      expect(result.kind).toBe("invalid");
    } finally {
      await root.cleanup();
    }
  });

  it.each([
    {
      name: "a public operation mapped to an undeclared private target",
      source: qualityAuthoring(
        ["check", "verify"],
        "check",
        "check:\n  @true\n\nverify:\n  @true",
      ).replace("          check: check", "          check: undeclared"),
      code: "catalog.verification-profile.operation-target-missing",
    },
    {
      name: "a declared Make target without an implementation",
      source: qualityAuthoring(["check", "verify"], "check", "check:\n  @true"),
      code: "catalog.verification-profile.target-missing",
    },
    {
      name: "a Git gate operation absent from its required profile",
      source: qualityAuthoring(
        ["check", "verify"],
        "other",
        "check:\n  @true\n\nverify:\n  @true",
      ),
      code: "catalog.git-gate.operation-missing",
    },
  ])("rejects $name", async ({ source, code }) => {
    const root = await createTempRepository({ "ai-harness.yaml": source });
    try {
      const result = await new FilesystemCatalog({
        catalogFile: join(root.root, "ai-harness.yaml"),
        supportedLanguages,
      }).load();

      expect(result.kind).toBe("invalid");
      if (result.kind === "invalid") {
        expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(code);
      }
    } finally {
      await root.cleanup();
    }
  });

  it("includes the centralized catalog version in the snapshot identity", async () => {
    const firstRoot = await createTempRepository({
      "ai-harness.yaml": authoring(skillDefinition("stable"), [], "0.1.0"),
      "skills/stable/SKILL.md": skill("stable"),
    });
    const secondRoot = await createTempRepository({
      "ai-harness.yaml": authoring(skillDefinition("stable"), [], "0.2.0"),
      "skills/stable/SKILL.md": skill("stable"),
    });
    try {
      const first = await new FilesystemCatalog({
        catalogFile: join(firstRoot.root, "ai-harness.yaml"),
        supportedLanguages,
      }).load();
      const second = await new FilesystemCatalog({
        catalogFile: join(secondRoot.root, "ai-harness.yaml"),
        supportedLanguages,
      }).load();

      expect(first.kind).toBe("ready");
      expect(second.kind).toBe("ready");
      if (first.kind === "ready" && second.kind === "ready") {
        expect(first.catalog.digest).not.toBe(second.catalog.digest);
      }
    } finally {
      await Promise.all([firstRoot.cleanup(), secondRoot.cleanup()]);
    }
  });

  it("rejects invalid centralized authoring through Catalog.load", async () => {
    const invalidAuthoring = [
      authoring(["    bad:", "      version: 0.1.0"]),
      authoring([
        "    bad:",
        "      version: 0.1.0",
        "      source: skills/bad",
        "      unknown: true",
      ]),
      authoring([
        "    bad:",
        "      version: ^1.0.0",
        "      source: skills/bad",
      ]),
      authoring([
        "    bad:",
        "      version: 0.1.0",
        "      source: skills/bad",
        "      relations:",
        "        - kind: includes",
        "          target: skill:other",
        "          reason: Packs own includes.",
      ]),
      authoring([], ["  mcps:", "    context7: {}"]),
    ];

    for (const [index, source] of invalidAuthoring.entries()) {
      const root = await createTempRepository({
        "ai-harness.yaml": source,
        "skills/bad/SKILL.md": skill("bad"),
      });
      try {
        const result = await new FilesystemCatalog({
          catalogFile: join(root.root, "ai-harness.yaml"),
          supportedLanguages,
        }).load();
        expect(result.kind, `case:${index}`).toBe("invalid");
        if (result.kind === "invalid") {
          expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
            "catalog.authoring.schema-invalid",
          );
        }
      } finally {
        await root.cleanup();
      }
    }
  });

  it.each([
    {
      name: "missing relation target",
      files: {
        "ai-harness.yaml": authoring([
          ...skillDefinition("source", [
            "      relations:",
            "        - kind: requires",
            "          target: skill:missing",
            "          reason: Missing target must fail closed.",
          ]),
        ]),
        "skills/source/SKILL.md": skill("source"),
      },
      code: "catalog.relation.target-missing",
    },
    {
      name: "hard dependency cycle",
      files: {
        "ai-harness.yaml": authoring([
          ...skillDefinition("a", [
            "      relations:",
            "        - kind: requires",
            "          target: skill:b",
            "          reason: A requires B.",
          ]),
          ...skillDefinition("b", [
            "      relations:",
            "        - kind: requires",
            "          target: skill:a",
            "          reason: B requires A.",
          ]),
        ]),
        "skills/a/SKILL.md": skill("a"),
        "skills/b/SKILL.md": skill("b"),
      },
      code: "catalog.graph.cycle",
    },
    {
      name: "unknown language",
      files: {
        "ai-harness.yaml": authoring([
          ...skillDefinition("unknown", [
            "      applies:",
            "        languages: [rust]",
          ]),
        ]),
        "skills/unknown/SKILL.md": skill("unknown"),
      },
      code: "catalog.language.unknown",
    },
    {
      name: "identity mismatch",
      files: {
        "ai-harness.yaml": authoring(skillDefinition("directory")),
        "skills/directory/SKILL.md": skill("different"),
      },
      code: "catalog.skill.standard-invalid",
    },
    {
      name: "broken local markdown link",
      files: {
        "ai-harness.yaml": authoring(skillDefinition("linked")),
        "skills/linked/SKILL.md": `${skill("linked")}\n[missing](references/missing.md)\n`,
      },
      code: "catalog.payload.invalid",
    },
    {
      name: "oversized skill description",
      files: {
        "ai-harness.yaml": authoring(skillDefinition("verbose")),
        "skills/verbose/SKILL.md": skill("verbose", "x".repeat(321)),
      },
      code: "catalog.skill.standard-invalid",
    },
    {
      name: "unreferenced skill reference",
      files: {
        "ai-harness.yaml": authoring(skillDefinition("orphaned")),
        "skills/orphaned/SKILL.md": skill("orphaned"),
        "skills/orphaned/references/orphan.md": "# Orphan\n",
      },
      code: "catalog.skill.reference-unreachable",
    },
  ])("fails closed for $name", async ({ files, code }) => {
    const root = await createTempRepository(files);
    try {
      const result = await new FilesystemCatalog({
        catalogFile: join(root.root, "ai-harness.yaml"),
        supportedLanguages,
      }).load();
      expect(result.kind).toBe("invalid");
      if (result.kind === "invalid") {
        expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(code);
      }
    } finally {
      await root.cleanup();
    }
  });

  it("rejects a payload symlink without reading its target", async () => {
    const root = await createTempRepository({
      "ai-harness.yaml": authoring(skillDefinition("linked")),
      "skills/linked/SKILL.md": skill("linked"),
    });
    const outside = await createTempRepository({ "outside.md": "secret\n" });
    try {
      await symlink(
        join(outside.root, "outside.md"),
        join(root.root, "skills", "linked", "outside.md"),
      );
      const result = await new FilesystemCatalog({
        catalogFile: join(root.root, "ai-harness.yaml"),
        supportedLanguages,
      }).load();
      expect(result.kind).toBe("invalid");
      if (result.kind === "invalid") {
        expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
          "catalog.payload.invalid",
        );
      }
    } finally {
      await Promise.all([root.cleanup(), outside.cleanup()]);
    }
  });

  it("preserves executable payload mode in its digest and projection bytes", async () => {
    const root = await createTempRepository({
      "ai-harness.yaml": authoring(skillDefinition("executable")),
      "skills/executable/SKILL.md": skill("executable"),
      "skills/executable/scripts/run.sh": "#!/bin/sh\nexit 0\n",
    });
    try {
      await chmod(join(root.root, "skills", "executable", "scripts", "run.sh"), 0o755);
      const result = await new FilesystemCatalog({
        catalogFile: join(root.root, "ai-harness.yaml"),
        supportedLanguages,
      }).load();
      expect(result.kind).toBe("ready");
      if (result.kind === "ready") {
        const executable = result.catalog.components.find(
          (component) => component.kind === "skill",
        )?.payload.files.find(
          (file) => file.path === "scripts/run.sh",
        );
        expect(executable?.mode).toBe("100755");
      }
    } finally {
      await root.cleanup();
    }
  });
});

function authoring(
  skillLines: readonly string[],
  familyOverride: readonly string[] = [],
  version = "0.1.0",
): string {
  const overriddenFamily = familyOverride[0]?.trim().replace(/:$/, "");
  return [
    "schema: ai-harness/v1",
    `version: ${version}`,
    "catalog:",
    ...(skillLines.length === 0 ? ["  skills: {}"] : ["  skills:", ...skillLines]),
    ...(familyOverride.length > 0 ? familyOverride : ["  mcps: {}"]),
    ...(overriddenFamily === "verification-profiles" ? [] : ["  verification-profiles: {}"]),
    ...(overriddenFamily === "git-gates" ? [] : ["  git-gates: {}"]),
    ...(overriddenFamily === "instruction-fragments" ? [] : ["  instruction-fragments: {}"]),
    ...(overriddenFamily === "packs" ? [] : ["  packs: {}"]),
    ...(overriddenFamily === "agents" ? [] : ["  agents: {}"]),
    "",
  ].join("\n");
}

function skillDefinition(id: string, extra: readonly string[] = []): readonly string[] {
  return [
    `    ${id}:`,
    "      version: 0.1.0",
    `      details: Detailed guidance for ${id}, including when to use it and the outcome it provides.`,
    `      source: skills/${id}`,
    ...extra,
  ];
}

function skill(name: string, description = `Use ${name} when its workflow is required.`): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "---",
    "",
    `# ${name}`,
    "",
  ].join("\n");
}

function remoteOauthMcpAuthoring(): readonly string[] {
  return [
    "  mcps:",
    "    remote-docs:",
    "      version: 0.1.0",
    "      description: Remote documentation MCP.",
    "      details: Detailed remote documentation integration guidance for project agents.",
    "      trust: third-party-network",
    "      connection:",
    "        type: remote-http",
    "        url: https://mcp.example.test/v1/mcp",
    "      tools: [search]",
    "      network: runtime-required",
    "      auth:",
    "        type: oauth",
    "        activation: harness-native",
  ];
}

function qualityAuthoring(
  targets: readonly string[],
  gateOperation: string,
  makeBody: string,
): string {
  return [
    "schema: ai-harness/v1",
    "version: 0.1.0",
    "catalog:",
    "  skills: {}",
    "  mcps: {}",
    "  verification-profiles:",
    "    go-quality:",
    "      version: 0.1.0",
    "      description: Test profile.",
    "      details: Detailed test profile guidance and its complete project verification purpose.",
    "      applies:",
    "        languages: [go]",
    "      executables: [find, go, gofmt, make]",
    "      inputs:",
    "        test_packages:",
    "          type: string-list",
    "          default: [\"./...\"]",
    "          item_pattern: \"^\\\\./.*$\"",
    "          make_variable: GO_TEST_PACKAGES",
      "      make:",
      `        targets: [${targets.join(", ")}]`,
      "        operations:",
      "          check: check",
      "          verify: verify",
    "        body: |",
    ...makeBody.split("\n").map((line) => `          ${line}`),
    "  git-gates:",
    "    pre-commit:",
    "      version: 0.1.0",
    "      description: Test gate.",
    "      details: Detailed test gate guidance and the exact lifecycle point it protects.",
    "      event: pre-commit",
    `      operation: ${gateOperation}`,
    "      inputs:",
    "        scopes:",
    "          type: string-list",
    "          default: [\"*\"]",
    "          item_pattern: \"^(?:\\\\*|\\\\.)$\"",
    "      relations:",
    "        - kind: requires",
    "          target: verification-profile:go-quality",
    "          reason: Test gate requires its profile.",
    "  instruction-fragments: {}",
    "  packs: {}",
    "  agents: {}",
    "",
  ].join("\n");
}

function instructionGroupAuthoring(
  fragments: readonly (readonly [id: string, section: string, group: string])[],
): string {
  return [
    "schema: ai-harness/v1",
    "version: 0.1.0",
    "catalog:",
    "  skills: {}",
    "  mcps: {}",
    "  verification-profiles: {}",
    "  git-gates: {}",
    "  instruction-fragments:",
    ...fragments.flatMap(([id, section, group]) => [
      `    ${id}:`,
      "      version: 0.1.0",
      `      description: ${id} instructions.`,
      `      details: Detailed guidance for the ${id} managed instruction section.`,
      `      section: ${section}`,
      "      content:",
      "        kind: catalog-index",
      `        group: ${group}`,
    ]),
    "  packs: {}",
    "  agents: {}",
    "",
  ].join("\n");
}

import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../../src/adapters/harness/claude-code/claude-code-adapter.js";
import { CodexAdapter } from "../../src/adapters/harness/codex/codex-adapter.js";
import { CursorAdapter } from "../../src/adapters/harness/cursor/cursor-adapter.js";
import { OpenCodeAdapter } from "../../src/adapters/harness/opencode/opencode-adapter.js";
import { VsCodeAdapter } from "../../src/adapters/harness/vscode/vscode-adapter.js";
import { NodeRepositoryInventory } from "../../src/adapters/platform/repository-inventory/node-repository-inventory.js";
import { FilesystemCatalog } from "../../src/catalog/filesystem-catalog.js";
import type { CatalogSnapshot } from "../../src/domain/catalog/model.js";
import type { ExecutableProbe, HarnessAdapter } from "../../src/domain/harness/model.js";
import { DefaultResolver } from "../../src/domain/resolution/resolver.js";
import {
  capabilityId,
  componentRef,
  harnessTargetId,
  languageId,
  projectUnitId,
  relativePosixPath,
} from "../../src/domain/shared/types.js";
import { createTempRepository } from "../helpers/temp-repository.js";

const absentProbe: ExecutableProbe = {
  async probe() {
    return { detected: false, path: null, version: null, diagnostics: [] };
  },
};

const cases = [
  {
    id: "codex",
    adapter: () => new CodexAdapter(absentProbe),
    agentPath: ".codex/agents/go-reviewer.toml",
    mcpPath: ".codex/config.toml",
    mcpKind: "managed-section",
    agentNeedle: "developer_instructions",
    mcpNeedle: "[mcp_servers.context7]",
    remoteNeedle: '[mcp_servers.atlassian-rovo]\nurl = "https://mcp.atlassian.com/v1/mcp/authv2"',
  },
  {
    id: "claude-code",
    adapter: () => new ClaudeCodeAdapter(absentProbe),
    agentPath: ".claude/agents/go-reviewer.md",
    mcpPath: ".mcp.json",
    mcpKind: "file",
    agentNeedle: "name: go-reviewer",
    mcpNeedle: '"mcpServers"',
    remoteNeedle: '"type": "http"',
  },
  {
    id: "cursor",
    adapter: () => new CursorAdapter(absentProbe),
    agentPath: ".cursor/agents/go-reviewer.md",
    mcpPath: ".cursor/mcp.json",
    mcpKind: "file",
    agentNeedle: "model: inherit",
    mcpNeedle: '"mcpServers"',
    remoteNeedle: '"atlassian-rovo"',
  },
  {
    id: "vscode",
    adapter: () => new VsCodeAdapter(absentProbe),
    agentPath: ".github/agents/go-reviewer.agent.md",
    mcpPath: ".vscode/mcp.json",
    mcpKind: "file",
    agentNeedle: "name: go-reviewer",
    mcpNeedle: '"servers"',
    remoteNeedle: '"type": "http"',
  },
  {
    id: "opencode",
    adapter: () => new OpenCodeAdapter(absentProbe),
    agentPath: ".opencode/agents/go-reviewer.md",
    mcpPath: "opencode.json",
    mcpKind: "file",
    agentNeedle: "mode: subagent",
    mcpNeedle: '"type": "local"',
    remoteNeedle: '"type": "remote"',
  },
] as const;

describe("Harness adapter contract", () => {
  it.each(cases)("$id remains configurable when its executable is absent", async ({ id, adapter }) => {
    const repository = await createTempRepository({});
    try {
      const inventory = new NodeRepositoryInventory();
      const before = await inventory.snapshot(repository.root);
      const inspection = await adapter().inspect(before);
      const after = await inventory.snapshot(repository.root);

      expect(inspection.target).toBe(id);
      expect(inspection.detected).toBe(false);
      expect(inspection.capabilities).toEqual(expectedCapabilities(id));
      const roles = new Set(inspection.surfaces.map((surface) => surface.role));
      roles.delete("hooks");
      expect(roles).toEqual(new Set(["agents", "instructions", "mcp", "skills"]));
      expect(inspection.diagnostics).toEqual([]);
      expect(after.fingerprint).toBe(before.fingerprint);
    } finally {
      await repository.cleanup();
    }
  });

  it.each(cases)("$id renders its exact native MCP and agent surfaces", async (definition) => {
    const catalog = await loadCatalog();
    const resolution = resolveNative(catalog, definition.id);
    const projection = definition.adapter().project(resolution, catalog);
    const artifacts = projection.units.flatMap((unit) =>
      unit.kind === "artifact" ? [{ ...unit, intent: unit.intent }] : [],
    );

    expect(projection.identity).toEqual({
      target: definition.id,
      adapter: { id: definition.id, version: "0.1.0" },
      capabilities: expectedCapabilities(definition.id),
    });
    expect(new Set(artifacts.map((unit) => unit.intent.path))).toEqual(
      new Set([definition.agentPath, definition.mcpPath]),
    );
    expect(artifacts.every((unit) => unit.sources.length > 0)).toBe(true);
    expect(new Set(artifacts.map((unit) => unit.ownershipId)).size).toBe(artifacts.length);

    const agent = artifacts.find((unit) => unit.intent.path === definition.agentPath)?.intent;
    const mcpArtifacts = artifacts.filter((unit) => unit.intent.path === definition.mcpPath);
    expect(agent?.kind).toBe("file");
    expect(mcpArtifacts.every((unit) => unit.intent.kind === definition.mcpKind)).toBe(true);
    expect(intentText(agent)).toContain(definition.agentNeedle);
    expect(intentText(agent)).toContain("Review the current Go change without editing it.");
    const mcpText = mcpArtifacts
      .map((unit) => intentText(unit.intent))
      .join("\n");
    expect(mcpText).toContain(definition.mcpNeedle);
    expect(mcpText).toContain("@upstash/context7-mcp@4.0.0");
    expect(mcpText).toContain(definition.remoteNeedle);
    expect(mcpText).toContain("https://mcp.atlassian.com/v1/mcp/authv2");
    expect(projection.units.some((unit) =>
      unit.kind === "artifact" &&
      unit.intent.kind === "file" &&
      (unit.intent.path.startsWith(".agents/skills/") || unit.intent.path.startsWith(".claude/skills/")),
    )).toBe(false);
  });

  it.each(cases)("$id installs the agent stop hook or blocks it explicitly", async ({ id, adapter }) => {
    const catalog = await loadCatalog();
    const repository = await createTempRepository({});
    try {
      const inspection = await adapter().inspect(await new NodeRepositoryInventory().snapshot(repository.root));
      const result = new DefaultResolver().resolve({
        catalog,
        directSelections: [componentRef("agent-hook:stop-check")],
        projectUnits: [],
        targets: [{ target: inspection.target, capabilities: inspection.capabilities }],
      });

      if (id === "vscode" || id === "opencode") {
        expect(result.kind).toBe("blocked");
        expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("resolution.capability.unsupported");
      } else {
        expect(result.kind).toBe("ready");
        if (result.kind !== "ready") return;
        const projection = adapter().project(result, catalog);
        expect(projection.units.some((unit) => unit.sources.includes(componentRef("agent-hook:stop-check")))).toBe(true);
      }
    } finally {
      await repository.cleanup();
    }
  });
});

function resolveNative(catalog: CatalogSnapshot, target: string) {
  const result = new DefaultResolver().resolve({
    catalog,
    directSelections: [
      componentRef("agent:go-reviewer"),
      componentRef("mcp:atlassian-rovo"),
      componentRef("mcp:context7"),
    ],
    projectUnits: [
      {
        id: projectUnitId("unit:."),
        root: relativePosixPath(".", { allowRoot: true }),
        languages: [languageId("go")],
      },
    ],
    targets: [
      {
        target: harnessTargetId(target),
        capabilities: [
          capabilityId("project.agents"),
          capabilityId("project.instructions"),
          capabilityId("project.mcp"),
          capabilityId("project.skills"),
        ],
      },
    ],
  });
  if (result.kind !== "ready") throw new Error(`Expected ${target} resolution to be ready`);
  return result;
}

/** Only the harnesses whose adapter installs the agent stop hook declare that capability. */
function expectedCapabilities(target: string): readonly string[] {
  const common = ["project.agents", "project.instructions", "project.mcp", "project.skills"];
  return target === "vscode" || target === "opencode" ? common : ["project.agent-hooks", ...common];
}

function intentText(intent: ReturnType<HarnessAdapter["project"]>["units"][number]["intent"] | undefined): string {
  if (intent === undefined) return "";
  if (intent.kind === "managed-section") return intent.body;
  if (intent.kind === "file") return new TextDecoder().decode(intent.bytes.copy());
  if (intent.kind === "symlink") return intent.target;
  if (intent.kind === "json-member") return JSON.stringify(intent.value);
  return `${intent.key}=${intent.value}`;
}

async function loadCatalog(): Promise<CatalogSnapshot> {
  const result = await new FilesystemCatalog({
    catalogFile: resolve("railguard.yaml"),
    supportedLanguages: ["go", "python", "typescript", "java"].map(languageId),
  }).load();
  if (result.kind !== "ready") throw new Error("Expected catalog to be ready");
  return result.catalog;
}

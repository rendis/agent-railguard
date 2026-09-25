import { mkdir, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexAdapter } from "../../src/adapters/harness/codex/codex-adapter.js";
import { NodeRepositoryInventory } from "../../src/adapters/platform/repository-inventory/node-repository-inventory.js";
import { FilesystemCatalog } from "../../src/catalog/filesystem-catalog.js";
import type { CatalogSnapshot } from "../../src/domain/catalog/model.js";
import type { ExecutableProbe } from "../../src/domain/harness/model.js";
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

const detectedProbe: ExecutableProbe = {
  async probe() {
    return {
      detected: true,
      path: "/opt/internal/bin/codex",
      version: "codex-cli 0.142.5",
      diagnostics: [],
    };
  },
};

describe("CodexAdapter", () => {
  it("inspects project topology and executable capability without writing", async () => {
    const repository = await createTempRepository({
      "AGENTS.md": "# Existing instructions\n",
      ".agents/skills/.keep": "",
    });
    try {
      const inventory = new NodeRepositoryInventory();
      const before = await inventory.snapshot(repository.root);
      const inspection = await new CodexAdapter(detectedProbe).inspect(before);
      const after = await inventory.snapshot(repository.root);

      expect(inspection).toEqual({
        target: "codex",
        detected: true,
        executablePath: "/opt/internal/bin/codex",
        version: "codex-cli 0.142.5",
        capabilities: [
          "project.agents",
          "project.instructions",
          "project.mcp",
          "project.skills",
        ],
        surfaces: [
          { role: "agents", path: ".codex/agents", kind: "absent" },
          { role: "hooks", path: ".codex/hooks.json", kind: "absent" },
          { role: "instructions", path: "AGENTS.md", kind: "file" },
          { role: "mcp", path: ".codex/config.toml", kind: "absent" },
          { role: "skills", path: ".agents/skills", kind: "directory" },
        ],
        diagnostics: [],
      });
      expect(after.fingerprint).toBe(before.fingerprint);
    } finally {
      await repository.cleanup();
    }
  });

  it("leaves portable skill materialization to the shared project projector", async () => {
    const catalog = await loadCatalog();
    const resolution = new DefaultResolver().resolve({
      catalog,
      directSelections: [componentRef("skill:develop-go-hexagonal-service")],
      projectUnits: [
        {
          id: projectUnitId("unit:."),
          root: relativePosixPath(".", { allowRoot: true }),
          languages: [languageId("go")],
        },
      ],
      targets: [
        {
          target: harnessTargetId("codex"),
          capabilities: [
            capabilityId("project.instructions"),
            capabilityId("project.skills"),
          ],
        },
      ],
    });
    if (resolution.kind !== "ready") {
      throw new Error("Expected the real closure to resolve");
    }

    const projection = new CodexAdapter(detectedProbe).project(resolution, catalog);
    expect(projection.identity).toEqual({
      target: "codex",
      adapter: { id: "codex", version: "0.1.0" },
      capabilities: [
        "project.agents",
        "project.instructions",
        "project.mcp",
        "project.skills",
      ],
    });
    expect(projection.units).toEqual([]);
  });

  it("classifies a symlinked Codex skill root as unsafe", async () => {
    const repository = await createTempRepository({});
    const outside = await createTempRepository({ "outside.txt": "outside\n" });
    try {
      await mkdir(join(repository.root, ".agents"), { recursive: true });
      await symlink(outside.root, join(repository.root, ".agents", "skills"));
      const snapshot = await new NodeRepositoryInventory().snapshot(repository.root);

      const inspection = await new CodexAdapter(detectedProbe).inspect(snapshot);

      expect(
        inspection.surfaces.find((surface) => surface.role === "skills"),
      ).toEqual({ role: "skills", path: ".agents/skills", kind: "symlink" });
      expect(inspection.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
        "harness.codex.topology-unsafe",
      ]);
    } finally {
      await Promise.all([repository.cleanup(), outside.cleanup()]);
    }
  });
});

async function loadCatalog(): Promise<CatalogSnapshot> {
  const result = await new FilesystemCatalog({
    catalogFile: resolve("railguard.yaml"),
    supportedLanguages: [
      languageId("go"),
      languageId("python"),
      languageId("typescript"),
      languageId("java"),
    ],
  }).load();
  if (result.kind !== "ready") {
    throw new Error("Expected the authoring catalog to be valid");
  }
  return result.catalog;
}

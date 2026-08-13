import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeRepositoryInventory } from "../../src/adapters/platform/repository-inventory/node-repository-inventory.js";
import { SharedSkillProjector } from "../../src/adapters/project/skills/shared-skill-projector.js";
import { FilesystemCatalog } from "../../src/catalog/filesystem-catalog.js";
import type { CatalogSnapshot } from "../../src/domain/catalog/model.js";
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
import { repositoryAssessment } from "../helpers/repository-assessment.js";

describe("SharedSkillProjector", () => {
  it("materializes one shared skill tree for compatible targets", async () => {
    const repository = await createTempRepository({});
    try {
      const catalog = await loadCatalog();
      const resolution = resolveSkill(catalog, ["codex", "cursor", "vscode", "opencode"]);
      const snapshot = await new NodeRepositoryInventory().snapshot(repository.root);

      const projection = await new SharedSkillProjector().project(
        resolution,
        catalog,
        snapshot,
        repositoryAssessment(snapshot),
        ["vscode", "codex", "cursor", "opencode"].map(harnessTargetId),
        new Map(),
      );

      const paths = projection.units.map((unit) =>
        unit.kind === "artifact" && unit.intent.kind === "file" ? unit.intent.path : null,
      );
      expect(paths.every((path) => path?.startsWith(".agents/skills/") === true)).toBe(true);
      expect(new Set(paths).size).toBe(paths.length);
      expect(projection.identity.capabilities).toEqual(["project.skills"]);
      expect(projection.units.every((unit) => unit.sources.length === 1)).toBe(true);
    } finally {
      await repository.cleanup();
    }
  });

  it("links Claude skills to the shared tree on POSIX when another compatible target is selected", async () => {
    const repository = await createTempRepository({});
    try {
      const catalog = await loadCatalog();
      const resolution = resolveSkill(catalog, ["codex", "claude-code"]);
      const snapshot = await new NodeRepositoryInventory().snapshot(repository.root);

      const projection = await new SharedSkillProjector("posix").project(
        resolution,
        catalog,
        snapshot,
        repositoryAssessment(snapshot),
        [harnessTargetId("claude-code"), harnessTargetId("codex")],
        new Map(),
      );
      const filePaths = projection.units.flatMap((unit) =>
        unit.kind === "artifact" && unit.intent.kind === "file" ? [unit.intent.path] : [],
      );
      const links = projection.units.flatMap((unit) => {
        if (unit.kind !== "artifact" || unit.intent.kind !== "symlink") return [];
        return [{ path: unit.intent.path, target: unit.intent.target }];
      });

      expect(filePaths.some((path) => path.startsWith(".agents/skills/"))).toBe(true);
      expect(filePaths.some((path) => path.startsWith(".claude/skills/"))).toBe(false);
      expect(links).toContainEqual({
        path: ".claude/skills/tdd",
        target: "../../.agents/skills/tdd",
      });
      expect(links.every(({ path, target }) =>
        target === `../../.agents/skills/${path.slice(".claude/skills/".length)}`,
      )).toBe(true);
    } finally {
      await repository.cleanup();
    }
  });

  it("copies Claude skills on Windows where symlink creation is not guaranteed", async () => {
    const repository = await createTempRepository({});
    try {
      const catalog = await loadCatalog();
      const resolution = resolveSkill(catalog, ["codex", "claude-code"]);
      const snapshot = await new NodeRepositoryInventory().snapshot(repository.root);

      const projection = await new SharedSkillProjector("windows").project(
        resolution,
        catalog,
        snapshot,
        repositoryAssessment(snapshot),
        [harnessTargetId("claude-code"), harnessTargetId("codex")],
        new Map(),
      );
      const artifacts = projection.units.flatMap((unit) =>
        unit.kind === "artifact" ? [unit.intent] : [],
      );

      expect(artifacts.some((intent) =>
        intent.kind === "file" && intent.path.startsWith(".agents/skills/"),
      )).toBe(true);
      expect(artifacts.some((intent) =>
        intent.kind === "file" && intent.path.startsWith(".claude/skills/"),
      )).toBe(true);
      expect(artifacts.some((intent) => intent.kind === "symlink")).toBe(false);
    } finally {
      await repository.cleanup();
    }
  });

  it("does not create an unused shared root for a Claude-only project", async () => {
    const repository = await createTempRepository({});
    try {
      const catalog = await loadCatalog();
      const resolution = resolveSkill(catalog, ["claude-code"]);
      const snapshot = await new NodeRepositoryInventory().snapshot(repository.root);

      const projection = await new SharedSkillProjector().project(
        resolution,
        catalog,
        snapshot,
        repositoryAssessment(snapshot),
        [harnessTargetId("claude-code")],
        new Map(),
      );
      const paths = projection.units.flatMap((unit) =>
        unit.kind === "artifact" && unit.intent.kind === "file" ? [unit.intent.path] : [],
      );

      expect(paths.every((path) => path.startsWith(".claude/skills/"))).toBe(true);
    } finally {
      await repository.cleanup();
    }
  });
});

function resolveSkill(catalog: CatalogSnapshot, targets: readonly string[]) {
  const result = new DefaultResolver().resolve({
    catalog,
    directSelections: [componentRef("skill:tdd")],
    projectUnits: [
      {
        id: projectUnitId("unit:."),
        root: relativePosixPath(".", { allowRoot: true }),
        languages: [languageId("go")],
      },
    ],
    targets: targets.map((target) => ({
      target: harnessTargetId(target),
      capabilities: [capabilityId("project.skills")],
    })),
  });
  if (result.kind !== "ready") throw new Error("Expected skill resolution to be ready");
  return result;
}

async function loadCatalog(): Promise<CatalogSnapshot> {
  const result = await new FilesystemCatalog({
    catalogFile: resolve("ai-harness.yaml"),
    supportedLanguages: ["go", "python", "typescript", "java"].map(languageId),
  }).load();
  if (result.kind !== "ready") throw new Error("Expected catalog to be ready");
  return result.catalog;
}

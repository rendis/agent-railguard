import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeRepositoryInventory } from "../../src/adapters/platform/repository-inventory/node-repository-inventory.js";
import { InstructionProjector } from "../../src/adapters/project/instructions/instruction-projector.js";
import { FilesystemCatalog } from "../../src/catalog/filesystem-catalog.js";
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

describe("InstructionProjector", () => {
  it("renders each canonical instruction section once from the resolved catalog", async () => {
    const repository = await createTempRepository({
      "AGENTS.md": "# Project-owned instructions\n",
      "go.mod": "module example.com/instructions\n\ngo 1.24\n",
    });
    try {
      const catalogResult = await new FilesystemCatalog({
        catalogFile: resolve("railguard.yaml"),
        supportedLanguages: [
          languageId("go"),
          languageId("python"),
          languageId("typescript"),
          languageId("java"),
        ],
      }).load();
      if (catalogResult.kind !== "ready") {
        throw new Error("Expected the central catalog to be valid");
      }
      const resolution = new DefaultResolver().resolve({
        catalog: catalogResult.catalog,
        directSelections: [
          componentRef("agent:go-reviewer"),
          componentRef("git-gate:pre-commit-check"),
          componentRef("mcp:atlassian-rovo"),
          componentRef("mcp:context7"),
          componentRef("skill:tdd"),
        ],
        projectUnits: [
          {
            id: projectUnitId("unit:go"),
            root: relativePosixPath("go"),
            languages: [languageId("go")],
          },
        ],
        targets: [
          {
            target: harnessTargetId("codex"),
            capabilities: [
              capabilityId("project.agents"),
              capabilityId("project.instructions"),
              capabilityId("project.mcp"),
              capabilityId("project.skills"),
            ],
          },
        ],
      });
      if (resolution.kind !== "ready") {
        throw new Error("Expected the instruction selection to resolve");
      }
      const snapshot = await new NodeRepositoryInventory().snapshot(repository.root);

      const projection = await new InstructionProjector().project(
        resolution,
        catalogResult.catalog,
        snapshot,
        repositoryAssessment(snapshot),
        [harnessTargetId("codex")],
        new Map(),
      );
      const sections = projection.units
        .filter((unit) => unit.kind === "artifact" && unit.intent.kind === "managed-section")
        .map((unit) => unit.kind === "artifact" && unit.intent.kind === "managed-section"
          ? { id: unit.intent.sectionId, path: unit.intent.path, body: unit.intent.body }
          : null)
        .filter((unit): unit is NonNullable<typeof unit> => unit !== null);

      expect(sections.map((section) => section.id)).toEqual([
        "agents.mapping",
        "automation.mapping",
        "mcps.mapping",
        "quality.mapping",
        "skills.mapping",
      ]);
      expect(new Set(sections.map((section) => section.path))).toEqual(new Set(["AGENTS.md"]));
      const skills = sections.find((section) => section.id === "skills.mapping")?.body;
      expect(skills).toContain("## Skill routing");
      expect(skills).toContain("Read `.agents/skills/tdd/SKILL.md` before following this workflow.");
      expect(skills).toContain("`tdd`: Use for features, bug fixes and behavior-preserving refactors.");
      expect(skills?.length).toBeLessThan(2_000);

      const agents = sections.find((section) => section.id === "agents.mapping")?.body;
      expect(agents).toContain("## Delegation");
      expect(agents).toContain("`go-reviewer`: Delegate when you need to review a Go change");
      expect(agents).toContain("Load `review-go-quality` before starting the review.");

      const mcps = sections.find((section) => section.id === "mcps.mapping")?.body;
      expect(mcps).toContain("## External tools");
      expect(mcps).toContain("`atlassian-rovo`");
      expect(mcps).toContain("Use only when Jira or Confluence context or actions are required");
      expect(mcps).toContain("Keep native approvals in force");
      expect(mcps).toContain("`context7`");
      expect(mcps).toContain("Use Context7 when current third-party library behavior cannot be established");

      const automation = sections.find((section) => section.id === "automation.mapping")?.body;
      expect(automation).toContain("## Git automation");
      expect(automation).toContain(
        "`pre-commit-check`: Before committing, `.railguard/bin/railguard check --changed` runs automatically; run it yourself to reproduce a failure.",
      );
      expect(automation).toContain("Treat hook failures as local feedback");

      const quality = sections.find((section) => section.id === "quality.mapping")?.body;
      expect(quality).toContain("## Verification");
      expect(quality).toContain("Run Railguard as `.railguard/bin/railguard`, which uses the version this repository pins");
      expect(quality).toContain(
        "`go-quality`: Run `railguard check --changed` while developing and `railguard verify --changed` before delivery for Go changes.",
      );

      for (const section of sections) {
        expect(section.body).not.toContain("installed by Railguard");
        expect(section.body).not.toMatch(/\b(?:Install|Configure|Create or update)\b/u);
      }
    } finally {
      await repository.cleanup();
    }
  });

  it("renders one canonical skill workflow pointer in the shared mapping", async () => {
    const repository = await createTempRepository({});
    try {
      const catalogResult = await new FilesystemCatalog({
        catalogFile: resolve("railguard.yaml"),
        supportedLanguages: ["go", "python", "typescript", "java"].map(languageId),
      }).load();
      if (catalogResult.kind !== "ready") throw new Error("Expected valid catalog");
      const targets = [harnessTargetId("codex"), harnessTargetId("claude-code")];
      const resolution = new DefaultResolver().resolve({
        catalog: catalogResult.catalog,
        directSelections: [componentRef("skill:tdd")],
        projectUnits: [],
        targets: targets.map((target) => ({
          target,
          capabilities: [capabilityId("project.instructions"), capabilityId("project.skills")],
        })),
      });
      if (resolution.kind !== "ready") throw new Error("Expected ready resolution");
      const snapshot = await new NodeRepositoryInventory().snapshot(repository.root);

      const projection = await new InstructionProjector().project(
        resolution,
        catalogResult.catalog,
        snapshot,
        repositoryAssessment(snapshot),
        targets,
        new Map(),
      );
      const mapping = projection.units.find(
        (unit) => unit.kind === "artifact" &&
          unit.intent.kind === "managed-section" &&
          unit.intent.sectionId === "skills.mapping",
      );
      if (mapping?.kind !== "artifact" || mapping.intent.kind !== "managed-section") {
        throw new Error("Expected skills mapping");
      }
      expect(mapping.intent.body).toContain(
        "Read `.agents/skills/tdd/SKILL.md` before following this workflow.",
      );
      expect(mapping.intent.body).not.toContain(".claude/skills/tdd/SKILL.md");
    } finally {
      await repository.cleanup();
    }
  });
});

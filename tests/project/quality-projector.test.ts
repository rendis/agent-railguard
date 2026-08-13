import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeRepositoryInventory } from "../../src/adapters/platform/repository-inventory/node-repository-inventory.js";
import { QualityProjector } from "../../src/adapters/project/quality/quality-projector.js";
import { GoStackAdapter } from "../../src/adapters/stack/go/go-stack-adapter.js";
import { FilesystemCatalog } from "../../src/catalog/filesystem-catalog.js";
import type { ExecutableProbe } from "../../src/domain/harness/model.js";
import type { GitHookInventory } from "../../src/domain/project/model.js";
import { DefaultRepositoryAssessment } from "../../src/domain/repository/assessment.js";
import { DefaultResolver } from "../../src/domain/resolution/resolver.js";
import {
  capabilityId,
  componentRef,
  harnessTargetId,
  languageId,
} from "../../src/domain/shared/types.js";
import { createTempRepository } from "../helpers/temp-repository.js";
import { repositoryAssessment } from "../helpers/repository-assessment.js";

const available: ExecutableProbe = {
  async probe(command) {
    return { detected: true, path: `/test/${command}`, version: "test", diagnostics: [] };
  },
};

const noHooks: GitHookInventory = {
  async executableDefaultHooks() {
    return [];
  },
};

describe("QualityProjector", () => {
  it("renders approved verification inputs and catalog defaults into the managed Make block", async () => {
    const repository = await createTempRepository({});
    try {
      const catalogResult = await new FilesystemCatalog({
        catalogFile: resolve("ai-harness.yaml"),
        supportedLanguages: [languageId("go")],
      }).load();
      if (catalogResult.kind !== "ready") throw new Error("Expected ready catalog");
      const profile = componentRef("verification-profile:go-quality");
      const resolution = new DefaultResolver().resolve({
        catalog: catalogResult.catalog,
        directSelections: [profile],
        projectUnits: [],
        targets: [
          {
            target: harnessTargetId("codex"),
            capabilities: [capabilityId("project.instructions")],
          },
        ],
      });
      if (resolution.kind !== "ready") throw new Error("Expected ready resolution");
      const snapshot = await new NodeRepositoryInventory().snapshot(repository.root);
      const projector = new QualityProjector(available, noHooks);

      const configured = await projector.project(
        resolution,
        catalogResult.catalog,
        snapshot,
        repositoryAssessment(snapshot),
        [harnessTargetId("codex")],
        new Map([[profile, { test_packages: ["./core/...", "./internal/..."] }]]),
      );
      const defaults = await projector.project(
        resolution,
        catalogResult.catalog,
        snapshot,
        repositoryAssessment(snapshot),
        [harnessTargetId("codex")],
        new Map(),
      );
      const configuredBody = managedMakeBody(configured);
      const defaultBody = managedMakeBody(defaults);

      expect(configuredBody).toContain("GO_TEST_PACKAGES := ./core/... ./internal/...");
      expect(defaultBody).toContain("GO_TEST_PACKAGES := ./...");
      expect(configuredBody).not.toContain("GO_TEST_PACKAGES ?=");
    } finally {
      await repository.cleanup();
    }
  });

  it("derives every Go module root for the repository-wide Make facade", async () => {
    const repository = await createTempRepository({
      "go.mod": "module example.com/root\n\ngo 1.24\n",
      "services/orders/go.mod": "module example.com/orders\n\ngo 1.24\n",
    });
    try {
      const catalogResult = await new FilesystemCatalog({
        catalogFile: resolve("ai-harness.yaml"),
        supportedLanguages: [languageId("go")],
      }).load();
      if (catalogResult.kind !== "ready") throw new Error("Expected ready catalog");
      const snapshot = await new NodeRepositoryInventory().snapshot(repository.root);
      const assessment = await new DefaultRepositoryAssessment([new GoStackAdapter()]).assess(
        snapshot,
      );
      const profile = componentRef("verification-profile:go-quality");
      const resolution = new DefaultResolver().resolve({
        catalog: catalogResult.catalog,
        directSelections: [profile],
        projectUnits: assessment.projectUnits,
        targets: [{
          target: harnessTargetId("codex"),
          capabilities: [capabilityId("project.instructions")],
        }],
      });
      if (resolution.kind !== "ready") throw new Error("Expected ready resolution");

      const projection = await new QualityProjector(available, noHooks).project(
        resolution,
        catalogResult.catalog,
        snapshot,
        assessment,
        [harnessTargetId("codex")],
        new Map(),
      );

      expect(managedMakeBody(projection)).toContain(
        "GO_MODULE_ROOTS := . services/orders",
      );
      const entrypoints = projection.units.find(
        (unit) => unit.kind === "artifact" &&
          unit.intent.kind === "managed-section" &&
          unit.intent.sectionId === "verification.entrypoints",
      );
      expect(entrypoints?.kind === "artifact" && entrypoints.intent.kind === "managed-section"
        ? entrypoints.intent.body
        : "").toContain("check: ai-harness-go-check");
    } finally {
      await repository.cleanup();
    }
  });
});

function managedMakeBody(projection: Awaited<ReturnType<QualityProjector["project"]>>): string {
  const unit = projection.units.find(
    (candidate) =>
      candidate.kind === "artifact" &&
      candidate.intent.kind === "managed-section" &&
      candidate.intent.sectionId === "verification.go-quality",
  );
  if (unit?.kind !== "artifact" || unit.intent.kind !== "managed-section") {
    throw new Error("Expected a managed Make section");
  }
  return unit.intent.body;
}

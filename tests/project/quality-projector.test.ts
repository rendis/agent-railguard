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
  it("composes selected Go assurance behind only check and verify", async () => {
    const repository = await createTempRepository({});
    try {
      const catalogResult = await new FilesystemCatalog({
        catalogFile: resolve("ai-harness.yaml"),
        supportedLanguages: [languageId("go")],
      }).load();
      if (catalogResult.kind !== "ready") {
        throw new Error(JSON.stringify(catalogResult.diagnostics, null, 2));
      }
      const profiles = [
        componentRef("verification-profile:go-quality"),
        componentRef("verification-profile:go-assurance"),
        componentRef("verification-profile:go-fuzz"),
        componentRef("verification-profile:go-mutation"),
        componentRef("verification-profile:go-e2e"),
      ];
      const resolution = new DefaultResolver().resolve({
        catalog: catalogResult.catalog,
        directSelections: profiles,
        projectUnits: [],
        targets: [{
          target: harnessTargetId("codex"),
          capabilities: [capabilityId("project.instructions")],
        }],
      });
      if (resolution.kind !== "ready") throw new Error("Expected ready resolution");
      const snapshot = await new NodeRepositoryInventory().snapshot(repository.root);
      const projection = await new QualityProjector(available, noHooks).project(
        resolution,
        catalogResult.catalog,
        snapshot,
        repositoryAssessment(snapshot),
        [harnessTargetId("codex")],
        new Map([
          [componentRef("verification-profile:go-assurance"), {
            core_cover_packages: ["./internal/core/..."],
            core_packages: ["./internal/core/..."],
            overall_cover_packages: ["./cmd/...", "./internal/..."],
            test_packages: ["./..."],
          }],
          [componentRef("verification-profile:go-fuzz"), {
            cases: ["./internal/infra/config:FuzzConfig:5s"],
          }],
          [componentRef("verification-profile:go-mutation"), {
            packages: ["./internal/core/domain", "./internal/core/service"],
          }],
          [componentRef("verification-profile:go-e2e"), {
            packages: ["./tests/e2e/..."],
          }],
        ]),
      );

      const entrypoints = managedSectionBody(projection, "verification.entrypoints");
      expect(entrypoints).toBe([
        ".PHONY: check verify",
        "",
        "check: ai-harness-go-assurance-check ai-harness-go-check ai-harness-go-e2e-check ai-harness-go-fuzz-check ai-harness-go-mutation-check",
        "",
        "verify: ai-harness-go-assurance-verify ai-harness-go-e2e-verify ai-harness-go-fuzz-verify ai-harness-go-mutation-verify ai-harness-go-verify",
      ].join("\n"));
      const generated = projection.units.flatMap((unit) =>
        unit.kind === "artifact" && unit.intent.kind === "managed-section"
          ? [unit.intent.body]
          : []
      ).join("\n");
      expect(generated).not.toMatch(/^(?:quality-check|verify-hardening|verify-all):/m);
    } finally {
      await repository.cleanup();
    }
  });

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

      expect(configuredBody).toContain(
        "AI_HARNESS_GO_TEST_PACKAGES := ./core/... ./internal/...",
      );
      expect(defaultBody).toContain("AI_HARNESS_GO_TEST_PACKAGES := ./...");
      expect(configuredBody).not.toContain("AI_HARNESS_GO_TEST_PACKAGES ?=");
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
        "AI_HARNESS_GO_MODULE_ROOTS := . services/orders",
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
  return managedSectionBody(projection, "verification.go-quality");
}

function managedSectionBody(
  projection: Awaited<ReturnType<QualityProjector["project"]>>,
  sectionId: string,
): string {
  const unit = projection.units.find(
    (candidate) =>
      candidate.kind === "artifact" &&
      candidate.intent.kind === "managed-section" &&
      candidate.intent.sectionId === sectionId,
  );
  if (unit?.kind !== "artifact" || unit.intent.kind !== "managed-section") {
    throw new Error("Expected a managed Make section");
  }
  return unit.intent.body;
}

import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeRepositoryInventory } from "../../src/adapters/platform/repository-inventory/node-repository-inventory.js";
import { QualityProjector } from "../../src/adapters/project/quality/quality-projector.js";
import { FilesystemCatalog } from "../../src/catalog/filesystem-catalog.js";
import type { ExecutableProbe } from "../../src/domain/harness/model.js";
import type { GitHookInventory } from "../../src/domain/project/model.js";
import { DefaultResolver } from "../../src/domain/resolution/resolver.js";
import {
  capabilityId,
  componentRef,
  harnessTargetId,
  languageId,
} from "../../src/domain/shared/types.js";
import { createTempRepository } from "../helpers/temp-repository.js";

const available: ExecutableProbe = {
  async probe(command) {
    return { detected: true, path: `/test/${command}`, version: "test", diagnostics: [] };
  },
};

const availableWithoutVersionCommands: ExecutableProbe = {
  async probe(command, args) {
    if (args.length === 0) {
      return { detected: true, path: `/test/${command}`, version: null, diagnostics: [] };
    }
    return {
      detected: true,
      path: `/test/${command}`,
      version: null,
      diagnostics: [{
        code: "harness.executable.version-unavailable",
        severity: "warning",
        phase: "harness",
        subjects: [],
        location: null,
        message: "The executable does not expose a version command.",
        evidence: [args.join(" ")],
        impact: "A present prerequisite is reported with a misleading warning.",
        action: null,
      }],
    };
  },
};

const noHooks: GitHookInventory = {
  async executableDefaultHooks() {
    return [];
  },
};

describe("QualityProjector", () => {
  it("requires prerequisite presence without requiring version commands", async () => {
    const repository = await createTempRepository({});
    try {
      const catalogResult = await new FilesystemCatalog({
        catalogFile: resolve("railguard.yaml"),
        supportedLanguages: [languageId("go")],
      }).load();
      if (catalogResult.kind !== "ready") throw new Error("Expected ready catalog");
      const profile = componentRef("verification-profile:go-quality");
      const resolution = new DefaultResolver().resolve({
        catalog: catalogResult.catalog,
        directSelections: [profile],
        projectUnits: [],
        targets: [{
          target: harnessTargetId("codex"),
          capabilities: [capabilityId("project.instructions")],
        }],
      });
      if (resolution.kind !== "ready") throw new Error("Expected ready resolution");
      const snapshot = await new NodeRepositoryInventory().snapshot(repository.root);

      const projection = await new QualityProjector(
        availableWithoutVersionCommands,
        noHooks,
      ).project(resolution, catalogResult.catalog, snapshot);

      expect(projection.diagnostics).not.toContainEqual(
        expect.objectContaining({ code: "harness.executable.version-unavailable" }),
      );
    } finally {
      await repository.cleanup();
    }
  });

  it("reports a missing prerequisite as quality.executable.missing", async () => {
    const repository = await createTempRepository({});
    try {
      const catalogResult = await new FilesystemCatalog({
        catalogFile: resolve("railguard.yaml"),
        supportedLanguages: [languageId("go")],
      }).load();
      if (catalogResult.kind !== "ready") throw new Error("Expected ready catalog");
      const profile = componentRef("verification-profile:go-quality");
      const resolution = new DefaultResolver().resolve({
        catalog: catalogResult.catalog,
        directSelections: [profile],
        projectUnits: [],
        targets: [{
          target: harnessTargetId("codex"),
          capabilities: [capabilityId("project.instructions")],
        }],
      });
      if (resolution.kind !== "ready") throw new Error("Expected ready resolution");
      const snapshot = await new NodeRepositoryInventory().snapshot(repository.root);
      const missing: ExecutableProbe = {
        async probe() {
          return { detected: false, path: null, version: null, diagnostics: [] };
        },
      };

      const projection = await new QualityProjector(missing, noHooks).project(
        resolution,
        catalogResult.catalog,
        snapshot,
      );

      expect(projection.diagnostics).toContainEqual(
        expect.objectContaining({ code: "quality.executable.missing" }),
      );
      expect(projection.diagnostics).not.toContainEqual(
        expect.objectContaining({ code: "quality.make.missing" }),
      );
    } finally {
      await repository.cleanup();
    }
  });

  it("selecting a verification profile alone projects no files", async () => {
    const repository = await createTempRepository({});
    try {
      const catalogResult = await new FilesystemCatalog({
        catalogFile: resolve("railguard.yaml"),
        supportedLanguages: [languageId("go")],
      }).load();
      if (catalogResult.kind !== "ready") throw new Error("Expected ready catalog");
      const profiles = [
        componentRef("verification-profile:go-quality"),
        componentRef("verification-profile:go-assurance"),
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
      );

      expect(projection.units).toEqual([]);
    } finally {
      await repository.cleanup();
    }
  });

  it("writes a managed hook that runs railguard --changed for the gate's operation", async () => {
    const repository = await createTempRepository({});
    try {
      const catalogResult = await new FilesystemCatalog({
        catalogFile: resolve("railguard.yaml"),
        supportedLanguages: [languageId("go")],
      }).load();
      if (catalogResult.kind !== "ready") throw new Error("Expected ready catalog");
      const selections = [
        componentRef("verification-profile:go-quality"),
        componentRef("git-gate:pre-commit-verify"),
      ];
      const resolution = new DefaultResolver().resolve({
        catalog: catalogResult.catalog,
        directSelections: selections,
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
      );

      const hook = projection.units.find(
        (unit) =>
          unit.kind === "artifact" &&
          unit.intent.kind === "file" &&
          unit.intent.path === ".railguard/hooks/pre-commit",
      );
      expect(hook?.kind === "artifact" && hook.intent.kind === "file"
        ? Buffer.from(hook.intent.bytes.copy()).toString("utf8")
        : "").toContain("railguard verify --changed");
      expect(
        projection.units.some((unit) => unit.kind === "artifact" && unit.intent.kind === "managed-section"),
      ).toBe(false);
    } finally {
      await repository.cleanup();
    }
  });
});

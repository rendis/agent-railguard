import { execFile } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { NodeRepositoryInventory } from "../../src/adapters/platform/repository-inventory/node-repository-inventory.js";
import { NodeProcessRunner } from "../../src/adapters/platform/process/node-process-runner.js";
import { QualityProjector } from "../../src/adapters/project/quality/quality-projector.js";
import { registeredCheckProviders } from "../../src/adapters/stack/registry.js";
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

const engine = { version: "1.2.3", repository: "example/railguard" };

/** A repository without project units, targets or selected inputs. */
const noUnits = [{ projectUnits: [] } as never, [], new Map()] as const;

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

      const projection = await new QualityProjector(availableWithoutVersionCommands,
        noHooks,
        engine, []).project(resolution, catalogResult.catalog, snapshot, ...noUnits);

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

      const projection = await new QualityProjector(missing, noHooks, engine, []).project(
        resolution,
        catalogResult.catalog,
        snapshot,
        ...noUnits,
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

  it("a verification profile alone projects only the launcher that pins the engine", async () => {
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

      const projection = await new QualityProjector(available, noHooks, engine, []).project(
        resolution,
        catalogResult.catalog,
        snapshot,
        ...noUnits,
      );

      expect(projection.units.map((unit) => unit.ownershipId)).toEqual(["project.launcher"]);
      const launcher = projection.units[0];
      const text = launcher?.kind === "artifact" && launcher.intent.kind === "file"
        ? Buffer.from(launcher.intent.bytes.copy()).toString("utf8")
        : "";
      expect(launcher).toMatchObject({ intent: { path: ".railguard/bin/railguard", mode: 0o755 } });
      expect(text).toContain("version=1.2.3\nrepository=example/railguard\n");
      expect(launcher?.sources).toEqual([...profiles].sort());
    } finally {
      await repository.cleanup();
    }
  });

  it("writes the verify script from the selected profiles, units and inputs", async () => {
    const repository = await createTempRepository({});
    try {
      const catalogResult = await new FilesystemCatalog({
        catalogFile: resolve("railguard.yaml"),
        supportedLanguages: [languageId("go")],
      }).load();
      if (catalogResult.kind !== "ready") throw new Error("Expected ready catalog");
      const profiles = [
        componentRef("verification-profile:go-quality"),
        componentRef("verification-profile:change-guard"),
      ];
      const resolution = new DefaultResolver().resolve({
        catalog: catalogResult.catalog,
        directSelections: profiles,
        projectUnits: [],
        targets: [{ target: harnessTargetId("codex"), capabilities: [capabilityId("project.instructions")] }],
      });
      if (resolution.kind !== "ready") throw new Error("Expected ready resolution");
      const snapshot = await new NodeRepositoryInventory().snapshot(repository.root);

      const projection = await new QualityProjector(available, noHooks, engine, [
        ...registeredCheckProviders(new NodeProcessRunner()),
        {
          kinds: ["change-integrity", "change-size"],
          async run() { throw new Error("not called"); },
          full() { return { kind: "skipped", reason: "Judges a change" }; },
        },
      ]).project(
        resolution,
        catalogResult.catalog,
        snapshot,
        { projectUnits: [{ root: "svc", languages: [languageId("go")] }] } as never,
        [],
        new Map([[profiles[0]!, { test_packages: ["./internal/..."] }]]),
      );

      const script = projection.units.find((unit) => unit.ownershipId === "project.verify-script");
      const text = script?.kind === "artifact" && script.intent.kind === "file"
        ? Buffer.from(script.intent.bytes.copy()).toString("utf8")
        : "";
      expect(script).toMatchObject({ sources: [profiles[0]], intent: { path: ".railguard/verify.sh", mode: 0o755 } });
      expect(text).toContain("    go-quality/race@svc) (\n      cd svc || exit 4\n      go test -count=1 -race -shuffle=on ./internal/... || exit 1\n");
      expect(text).toContain("  check)\n    run go-quality/format@svc\n    run go-quality/vet@svc\n    run go-quality/test@svc\n    ;;");
      expect(text).not.toContain("change-guard");
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

      const projection = await new QualityProjector(available, noHooks, engine, []).project(
        resolution,
        catalogResult.catalog,
        snapshot,
        ...noUnits,
      );

      const hook = projection.units.find(
        (unit) =>
          unit.kind === "artifact" &&
          unit.intent.kind === "file" &&
          unit.intent.path === ".railguard/hooks/pre-commit",
      );
      expect(hook?.kind === "artifact" && hook.intent.kind === "file"
        ? Buffer.from(hook.intent.bytes.copy()).toString("utf8")
        : "").toContain(".railguard/bin/railguard verify --changed");
      expect(
        projection.units.some((unit) => unit.kind === "artifact" && unit.intent.kind === "managed-section"),
      ).toBe(false);
    } finally {
      await repository.cleanup();
    }
  });
  it("writes the pre-action guard with the protected paths the repository selected", async () => {
    const repository = await createTempRepository({});
    try {
      const catalogResult = await new FilesystemCatalog({
        catalogFile: resolve("railguard.yaml"),
        supportedLanguages: [languageId("go")],
      }).load();
      if (catalogResult.kind !== "ready") throw new Error("Expected ready catalog");
      const changeGuard = componentRef("verification-profile:change-guard");
      const resolution = new DefaultResolver().resolve({
        catalog: catalogResult.catalog,
        directSelections: [componentRef("agent-hook:action-guard"), changeGuard],
        projectUnits: [],
        targets: [{
          target: harnessTargetId("cursor"),
          capabilities: [capabilityId("project.instructions"), capabilityId("project.agent-hooks")],
        }],
      });
      if (resolution.kind !== "ready") throw new Error("Expected ready resolution");
      const snapshot = await new NodeRepositoryInventory().snapshot(repository.root);

      const projection = await new QualityProjector(available, noHooks, engine, []).project(
        resolution,
        catalogResult.catalog,
        snapshot,
        { projectUnits: [] } as never,
        [],
        new Map([[changeGuard, { protected_paths: [".golangci.*", "it's config/**"] }]]),
      );

      const unit = projection.units.find((candidate) => candidate.ownershipId === "project.agent-hook.guard");
      expect(unit?.sources).toEqual([componentRef("agent-hook:action-guard"), changeGuard]);
      expect(projection.units.some((candidate) => candidate.ownershipId === "project.agent-hook.stop")).toBe(false);
      const script = unit?.kind === "artifact" && unit.intent.kind === "file" ? Buffer.from(unit.intent.bytes.copy()).toString("utf8") : "";

      // Run the generated script against a launcher that records its arguments.
      const run = promisify(execFile);
      await run("git", ["init", "-q"], { cwd: repository.root });
      await mkdir(join(repository.root, ".railguard/bin"), { recursive: true });
      await writeFile(join(repository.root, ".railguard/guard"), script, { mode: 0o755 });
      const launcher = join(repository.root, ".railguard/bin/railguard");
      await writeFile(launcher, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
      await chmod(launcher, 0o755);
      expect((await run(join(repository.root, ".railguard/guard"), ["cursor"], { cwd: repository.root })).stdout.split("\n")).toEqual([
        "hook", "guard", "--harness", "cursor", "--protect", ".golangci.*", "it's config/**", "",
      ]);
      await writeFile(launcher, "#!/bin/sh\nexit 127\n");
      expect((await run(join(repository.root, ".railguard/guard"), ["cursor"], { cwd: repository.root })).stdout).toBe('{"permission":"allow"}\n');
      expect((await run(join(repository.root, ".railguard/guard"), ["codex"], { cwd: repository.root })).stdout).toBe("");
    } finally {
      await repository.cleanup();
    }
  });
});

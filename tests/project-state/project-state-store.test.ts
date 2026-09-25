import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeProjectStateStore } from "../../src/adapters/platform/state/project-state-store.js";
import { FilesystemCatalog } from "../../src/catalog/filesystem-catalog.js";
import type { ReadyResolution } from "../../src/domain/resolution/model.js";
import { componentRef, languageId, sha256 } from "../../src/domain/shared/types.js";
import { LockStateModule } from "../../src/project-state/lock-state.js";
import { DesiredStateModule } from "../../src/project-state/desired-state.js";
import { createTempRepository } from "../helpers/temp-repository.js";

describe("NodeProjectStateStore", () => {
  it("loads generated desired state from the project-owned path", async () => {
    const loaded = await new FilesystemCatalog({
      catalogFile: resolve("railguard.yaml"),
      supportedLanguages: [languageId("go")],
    }).load();
    if (loaded.kind !== "ready") throw new Error("Expected catalog to load");
    const built = new DesiredStateModule().evaluate(
      {
        kind: "draft",
        targets: ["codex"],
        selections: [{ ref: "skill:tdd" }],
      },
      loaded.catalog,
    );
    if (built.kind !== "ready") throw new Error("Expected desired state to build");
    const repository = await createTempRepository({
      ".railguard/project.yaml": built.bytes.copy(),
    });
    try {
      const observed = await new NodeProjectStateStore().loadDesired(
        repository.root,
        loaded.catalog,
      );

      expect(observed).toEqual(built);
    } finally {
      await repository.cleanup();
    }
  });

  it("loads a generated portable lock in a new store instance", async () => {
    const loaded = await new FilesystemCatalog({
      catalogFile: resolve("railguard.yaml"),
      supportedLanguages: [languageId("go")],
    }).load();
    if (loaded.kind !== "ready") throw new Error("Expected catalog to load");
    const desiredDigest = sha256("desired");
    const module = new LockStateModule();
    const built = module.build({
      desiredDigest,
      catalog: loaded.catalog,
      resolution: minimalResolution(loaded.catalog),
      targets: [],
      artifacts: [],
      localEffects: [],
    });
    if (built.kind !== "ready") throw new Error("Expected lock to build");
    const repository = await createTempRepository({
      ".railguard/lock.json": built.bytes.copy(),
    });
    try {
      const observed = await new NodeProjectStateStore().loadLock(repository.root, {
        desiredDigest,
        catalog: loaded.catalog,
      });

      expect(observed).toEqual(built);
    } finally {
      await repository.cleanup();
    }
  });

  it("reports an unsafe lock symlink without following it", async () => {
    const loaded = await new FilesystemCatalog({
      catalogFile: resolve("railguard.yaml"),
      supportedLanguages: [languageId("go")],
    }).load();
    if (loaded.kind !== "ready") throw new Error("Expected catalog to load");
    const repository = await createTempRepository({});
    const outside = join(repository.root, "outside.json");
    try {
      await mkdir(join(repository.root, ".railguard"));
      await writeFile(outside, "{}\n");
      await symlink(outside, join(repository.root, ".railguard", "lock.json"));

      const result = await new NodeProjectStateStore().loadLock(repository.root, {
        desiredDigest: sha256("desired"),
        catalog: loaded.catalog,
      });

      expect(result.kind).toBe("invalid");
      if (result.kind === "invalid") {
        expect(result.diagnostics[0].code).toBe("project-state.lock-path-unsafe");
      }
    } finally {
      await repository.cleanup();
    }
  });
});

function minimalResolution(
  catalog: Extract<Awaited<ReturnType<FilesystemCatalog["load"]>>, { readonly kind: "ready" }>["catalog"],
): ReadyResolution {
  const ref = componentRef("skill:tdd");
  const component = catalog.components.find((candidate) => candidate.ref === ref);
  if (component === undefined) throw new Error("Expected skill:tdd");
  return Object.freeze({
    kind: "ready",
    catalogDigest: catalog.digest,
    components: Object.freeze([
      Object.freeze({
        ref,
        version: component.version,
        componentDigest: component.integrity.component,
        direct: true,
        includedBy: Object.freeze([]),
        applicability: Object.freeze({ kind: "portable" as const }),
      }),
    ]),
    recommendations: Object.freeze([]),
    associations: Object.freeze([]),
    blockers: Object.freeze([]) as readonly [],
    diagnostics: Object.freeze([]),
    readyBrand: Symbol("ready-resolution"),
  });
}

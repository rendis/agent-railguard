import { describe, expect, it } from "vitest";
import { NodeRepositoryInventory } from "../../src/adapters/platform/repository-inventory/node-repository-inventory.js";
import { registeredStackAdapters } from "../../src/adapters/stack/registry.js";
import { DefaultRepositoryAssessment } from "../../src/domain/repository/assessment.js";
import { languageId, relativePosixPath } from "../../src/domain/shared/types.js";
import { createTempRepository } from "../helpers/temp-repository.js";

const cases = [
  {
    language: "go",
    files: { "service/go.mod": "module example.com/service\n" },
    manifest: "service/go.mod",
  },
  {
    language: "python",
    files: { "service/pyproject.toml": "[project]\nname = \"service\"\n" },
    manifest: "service/pyproject.toml",
  },
  {
    language: "typescript",
    files: {
      "service/package.json": '{"name":"service","private":true}\n',
      "service/tsconfig.json": "{}\n",
    },
    manifest: "service/package.json",
  },
  {
    language: "java",
    files: { "service/build.gradle": "plugins { id 'java' }\n" },
    manifest: "service/build.gradle",
  },
] as const;

describe("Stack adapter contract", () => {
  it.each(cases)("detects one $language root without executing the project", async (fixture) => {
    const repository = await createTempRepository(fixture.files);
    try {
      const snapshot = await new NodeRepositoryInventory().snapshot(repository.root);
      const adapter = registeredStackAdapters().find(
        (candidate) => candidate.id === fixture.language,
      );
      if (adapter === undefined) throw new Error(`Missing ${fixture.language} adapter`);

      const result = await adapter.assess(snapshot);

      expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "blocked")).toEqual([]);
      expect(result.contributions).toHaveLength(1);
      expect(result.contributions[0]).toMatchObject({
        root: relativePosixPath("service"),
        language: languageId(fixture.language),
      });
      expect(result.contributions[0]?.manifests).toContain(
        relativePosixPath(fixture.manifest),
      );
    } finally {
      await repository.cleanup();
    }
  });

  it("keeps an empty repository valid for every registered adapter", async () => {
    const repository = await createTempRepository({});
    try {
      const snapshot = await new NodeRepositoryInventory().snapshot(repository.root);
      for (const adapter of registeredStackAdapters()) {
        expect(await adapter.assess(snapshot)).toEqual({ contributions: [], diagnostics: [] });
      }
    } finally {
      await repository.cleanup();
    }
  });

  it("combines a mixed monorepo and reports lockfile ambiguity as non-blocking evidence", async () => {
    const repository = await createTempRepository({
      "services/api/go.mod": "module example.com/api\n",
      "services/api/pyproject.toml": "[project]\nname = \"api-tools\"\n",
      "web/package.json": '{"name":"web","devDependencies":{"typescript":"5.9.0"}}\n',
      "web/tsconfig.json": "{}\n",
      "web/bun.lockb": "lock\n",
      "web/package-lock.json": "{}\n",
      "web/pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "backend/build.gradle.kts": "plugins { java }\n",
      "backend/gradlew": "#!/bin/sh\n",
    });
    try {
      const snapshot = await new NodeRepositoryInventory().snapshot(repository.root);
      const result = await new DefaultRepositoryAssessment(registeredStackAdapters()).assess(
        snapshot,
      );

      expect(result.projectUnits.map((unit) => ({ root: unit.root, languages: unit.languages }))).toEqual([
        { root: "backend", languages: ["java"] },
        { root: "services/api", languages: ["go", "python"] },
        { root: "web", languages: ["typescript"] },
      ]);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "stack.typescript.lockfiles-ambiguous",
          severity: "warning",
        }),
      );
    } finally {
      await repository.cleanup();
    }
  });
});

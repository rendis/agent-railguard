import { describe, expect, it } from "vitest";
import { GoStackAdapter } from "../../src/adapters/stack/go/go-stack-adapter.js";
import { DefaultRepositoryAssessment } from "../../src/domain/repository/assessment.js";
import type { StackAdapter } from "../../src/domain/repository/model.js";
import {
  languageId,
  projectUnitId,
  relativePosixPath,
} from "../../src/domain/shared/types.js";
import { NodeRepositoryInventory } from "../../src/adapters/platform/repository-inventory/node-repository-inventory.js";
import { createTempRepository } from "../helpers/temp-repository.js";

describe("GoStackAdapter", () => {
  it("identifies one Go project unit from a valid root go.mod", async () => {
    const repository = await createTempRepository({
      "go.mod": "module example.com/service\n\ngo 1.24\n",
      "main.go": "package main\n",
    });
    try {
      const snapshot = await new NodeRepositoryInventory().snapshot(repository.root);
      const result = await new GoStackAdapter().assess(snapshot);

      expect(result.diagnostics).toEqual([]);
      expect(result.contributions).toEqual([
        {
          root: relativePosixPath(".", { allowRoot: true }),
          language: languageId("go"),
          manifests: [relativePosixPath("go.mod")],
          evidence: [
            {
              kind: "manifest",
              path: relativePosixPath("go.mod"),
              detail: "module example.com/service",
            },
          ],
          nativeTasks: [],
        },
      ]);
    } finally {
      await repository.cleanup();
    }
  });

  it("returns no unit for an empty repository", async () => {
    const repository = await createTempRepository({});
    try {
      const snapshot = await new NodeRepositoryInventory().snapshot(repository.root);
      const result = await new GoStackAdapter().assess(snapshot);
      expect(result).toEqual({ contributions: [], diagnostics: [] });
    } finally {
      await repository.cleanup();
    }
  });

  it.each([
    {
      name: "invalid marker",
      files: { "go.mod": "go 1.24\n" },
      code: "stack.go.module-invalid",
    },
  ])("reports $name without blocking other roots or manual selection", async ({ files, code }) => {
    const repository = await createTempRepository(files);
    try {
      const snapshot = await new NodeRepositoryInventory().snapshot(repository.root);
      const result = await new GoStackAdapter().assess(snapshot);
      expect(result.contributions).toEqual([]);
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([code]);
      expect(result.diagnostics[0]?.severity).toBe("warning");
    } finally {
      await repository.cleanup();
    }
  });

  it("reports every valid Go module as an independent monorepo contribution", async () => {
    const repository = await createTempRepository({
      "go.mod": "module example.com/root\n",
      "nested/go.mod": "module example.com/nested\n",
    });
    try {
      const snapshot = await new NodeRepositoryInventory().snapshot(repository.root);
      const result = await new GoStackAdapter().assess(snapshot);

      expect(result.diagnostics).toEqual([]);
      expect(result.contributions.map((contribution) => contribution.root)).toEqual([
        relativePosixPath(".", { allowRoot: true }),
        relativePosixPath("nested"),
      ]);
    } finally {
      await repository.cleanup();
    }
  });
});

describe("DefaultRepositoryAssessment", () => {
  it("combines independent adapter contributions at the same root", async () => {
    const repository = await createTempRepository({ "go.mod": "module example.com/service\n" });
    try {
      const snapshot = await new NodeRepositoryInventory().snapshot(repository.root);
      const pythonAdapter: StackAdapter = {
        id: languageId("python"),
        async assess() {
          return {
            diagnostics: [],
            contributions: [
              {
                root: relativePosixPath(".", { allowRoot: true }),
                language: languageId("python"),
                manifests: [relativePosixPath("pyproject.toml")],
                evidence: [
                  {
                    kind: "manifest",
                    path: relativePosixPath("pyproject.toml"),
                    detail: "project metadata",
                  },
                ],
                nativeTasks: [],
              },
            ],
          };
        },
      };

      const assessment = new DefaultRepositoryAssessment([
        pythonAdapter,
        new GoStackAdapter(),
      ]);
      const result = await assessment.assess(snapshot);

      expect(result.projectUnits).toHaveLength(1);
      expect(result.projectUnits[0]).toMatchObject({
        id: projectUnitId("unit:."),
        root: relativePosixPath(".", { allowRoot: true }),
        languages: [languageId("go"), languageId("python")],
        manifests: [relativePosixPath("go.mod"), relativePosixPath("pyproject.toml")],
      });
    } finally {
      await repository.cleanup();
    }
  });
});

import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FilesystemCatalog } from "../../src/catalog/filesystem-catalog.js";
import type { CatalogSnapshot } from "../../src/domain/catalog/model.js";
import { recommend } from "../../src/domain/recommendation/recommend.js";
import {
  componentRef,
  languageId,
  projectUnitId,
  relativePosixPath,
} from "../../src/domain/shared/types.js";

describe("recommend", () => {
  it("recommends each applicable Go skill once and retains matching units", async () => {
    const catalog = await loadCatalog();
    const result = recommend({
      catalog,
      activeComponents: [],
      projectUnits: [
        {
          id: projectUnitId("unit:service"),
          root: relativePosixPath("service"),
          languages: [languageId("go")],
        },
      ],
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.candidates.map((candidate) => candidate.ref)).toEqual([
      "skill:configure-go-quality",
      "skill:develop-go-hexagonal-service",
      "skill:review-go-quality",
      "skill:test-go-service",
    ]);
    expect(
      result.candidates.find(
        (candidate) => candidate.ref === "skill:develop-go-hexagonal-service",
      )?.reasons,
    ).toEqual([
      {
        kind: "language-match",
        language: "go",
        matchingUnits: ["unit:service"],
      },
    ]);
  });

  it("does not turn portable components into automatic recommendations", async () => {
    const result = recommend({
      catalog: await loadCatalog(),
      activeComponents: [],
      projectUnits: [],
    });

    expect(result.candidates).toEqual([]);
  });

  it("combines declarative and language reasons independent of input order", async () => {
    const original = await loadCatalog();
    const sourceRef = componentRef("skill:design-tests");
    const targetRef = componentRef("skill:test-go-service");
    const catalog: CatalogSnapshot = Object.freeze({
      ...original,
      components: Object.freeze(
        original.components.map((component) =>
          component.ref === sourceRef
            ? Object.freeze({
                ...component,
                relations: Object.freeze([
                  {
                    kind: "recommends" as const,
                    target: targetRef,
                    reason: "The active design workflow benefits from Go-specific proof.",
                  },
                ]),
              })
            : component,
        ),
      ),
    });
    const units = [
      {
        id: projectUnitId("unit:z"),
        root: relativePosixPath("z"),
        languages: [languageId("go")],
      },
      {
        id: projectUnitId("unit:a"),
        root: relativePosixPath("a"),
        languages: [languageId("go")],
      },
    ];

    const first = recommend({
      catalog,
      activeComponents: [sourceRef],
      projectUnits: units,
    });
    const second = recommend({
      catalog,
      activeComponents: [sourceRef, sourceRef],
      projectUnits: [...units].reverse(),
    });

    expect(second).toEqual(first);
    expect(first.candidates.find((candidate) => candidate.ref === targetRef)?.reasons).toEqual([
      {
        kind: "language-match",
        language: "go",
        matchingUnits: ["unit:a", "unit:z"],
      },
      {
        kind: "catalog-recommends",
        from: sourceRef,
        reason: "The active design workflow benefits from Go-specific proof.",
      },
    ]);
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

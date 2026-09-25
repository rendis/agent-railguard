import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
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

const direct = componentRef("skill:develop-go-hexagonal-service");
const codex = harnessTargetId("codex");
const projectInstructions = capabilityId("project.instructions");
const projectSkills = capabilityId("project.skills");
const codexCapabilities = [projectInstructions, projectSkills] as const;

describe("DefaultResolver", () => {
  it("resolves the real skill and verification closure with every immediate cause", async () => {
    const result = new DefaultResolver().resolve({
      catalog: await loadCatalog(),
      directSelections: [direct],
      projectUnits: [goUnit()],
      targets: [{ target: codex, capabilities: codexCapabilities }],
    });

    expect(result.kind).toBe("ready");
    expect(result.components.map((component) => component.ref)).toEqual([
      "skill:design-tests",
      "skill:build-e2e-test-suite",
      "skill:tdd",
      "skill:test-go-service",
      "verification-profile:go-quality",
      "skill:configure-go-quality",
      "skill:review-go-quality",
      "skill:develop-go-hexagonal-service",
    ]);
    expect(result.components.filter((component) => component.direct).map((entry) => entry.ref)).toEqual([
      direct,
    ]);
    expect(
      result.components.find((component) => component.ref === "skill:configure-go-quality")
        ?.includedBy.map((cause) => cause.from),
    ).toEqual(["skill:develop-go-hexagonal-service", "skill:review-go-quality"]);
    expect(
      result.components.find((component) => component.ref === "verification-profile:go-quality")
        ?.includedBy.map((cause) => cause.from),
    ).toEqual(["skill:configure-go-quality"]);
    expect(
      result.components.find((component) => component.ref === "skill:design-tests")?.includedBy
        .map((cause) => cause.from)
        .sort(),
    ).toEqual([
      "skill:build-e2e-test-suite",
      "skill:develop-go-hexagonal-service",
      "skill:tdd",
      "skill:test-go-service",
    ]);
    expect(result.blockers).toEqual([]);
  });

  it("keeps a direct selection valid when no language was detected", async () => {
    const result = new DefaultResolver().resolve({
      catalog: await loadCatalog(),
      directSelections: [direct],
      projectUnits: [],
      targets: [{ target: codex, capabilities: codexCapabilities }],
    });

    expect(result.kind).toBe("ready");
    expect(result.components.find((component) => component.ref === direct)?.applicability).toEqual({
      kind: "unverified",
      declaredLanguages: ["go"],
      observedLanguages: [],
    });
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "resolution.selection.applicability-unverified",
    );
  });

  it("returns a canonical blocked preview for unknown selections and missing capabilities", async () => {
    const catalog = await loadCatalog();
    const unknown = componentRef("skill:not-in-catalog");
    const result = new DefaultResolver().resolve({
      catalog,
      directSelections: [unknown, direct, unknown],
      projectUnits: [goUnit()],
      targets: [{ target: codex, capabilities: [] }],
    });

    expect(result.kind).toBe("blocked");
    expect(result.blockers.filter((blocker) => blocker.kind === "unknown-selection")).toEqual([
      { kind: "unknown-selection", component: unknown },
    ]);
    expect(
      result.blockers.filter((blocker) => blocker.kind === "unsupported-capability"),
    ).toHaveLength(7);
    expect(result.components).toHaveLength(8);
  });

  it("accepts an empty desired state", async () => {
    const result = new DefaultResolver().resolve({
      catalog: await loadCatalog(),
      directSelections: [],
      projectUnits: [],
      targets: [{ target: codex, capabilities: [] }],
    });

    expect(result.kind).toBe("ready");
    expect(result.components).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it("rejects an internal instruction mapping as a direct selection", async () => {
    const mapping = componentRef("instruction-fragment:skills-mapping");
    const result = new DefaultResolver().resolve({
      catalog: await loadCatalog(),
      directSelections: [mapping],
      projectUnits: [],
      targets: [{ target: codex, capabilities: [projectInstructions] }],
    });

    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") {
      expect(result.blockers).toContainEqual({
        kind: "non-selectable-component",
        component: mapping,
      });
      expect(result.components).toEqual([]);
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        "resolution.selection.non-selectable",
      );
    }
  });

  it("resolves a pack through the same graph as its explicit direct selections", async () => {
    const catalog = await loadCatalog();
    const resolver = new DefaultResolver();
    const targetFacts = [{ target: codex, capabilities: [projectSkills] }] as const;
    const fromPack = resolver.resolve({
      catalog,
      directSelections: [componentRef("pack:testing-foundation")],
      projectUnits: [],
      targets: targetFacts,
    });
    const explicit = resolver.resolve({
      catalog,
      directSelections: [
        componentRef("skill:build-e2e-test-suite"),
        componentRef("skill:tdd"),
      ],
      projectUnits: [],
      targets: targetFacts,
    });

    expect(fromPack.kind).toBe("ready");
    expect(explicit.kind).toBe("ready");
    expect(
      fromPack.components
        .filter((component) => component.ref !== "pack:testing-foundation")
        .map((component) => component.ref),
    ).toEqual(explicit.components.map((component) => component.ref));
    expect(
      fromPack.components.find(
        (component) => component.ref === "skill:build-e2e-test-suite",
      )?.includedBy,
    ).toContainEqual(
      expect.objectContaining({
        kind: "includes",
        from: "pack:testing-foundation",
      }),
    );
  });

  it("is invariant to duplicate and permuted normalized inputs", async () => {
    const catalog = await loadCatalog();
    const resolver = new DefaultResolver();
    const first = resolver.resolve({
      catalog,
      directSelections: [direct],
      projectUnits: [goUnit(), pythonUnit()],
      targets: [{ target: codex, capabilities: codexCapabilities }],
    });
    const second = resolver.resolve({
      catalog,
      directSelections: [direct, direct],
      projectUnits: [pythonUnit(), goUnit()],
      targets: [
        { target: codex, capabilities: [] },
        { target: codex, capabilities: [projectInstructions, projectSkills, projectSkills] },
      ],
    });

    expect(second).toEqual(first);
  });

  it("projects recommends without expanding closure and blocks a selected conflict", async () => {
    const original = await loadCatalog();
    const configure = componentRef("skill:configure-go-quality");
    const tdd = componentRef("skill:tdd");
    const catalog: CatalogSnapshot = Object.freeze({
      ...original,
      components: Object.freeze(
        original.components.map((component) =>
          component.ref === configure
            ? Object.freeze({
                ...component,
                relations: Object.freeze([
                  {
                    kind: "recommends" as const,
                    target: tdd,
                    reason: "Quality setup benefits from a test-first workflow.",
                  },
                  {
                    kind: "conflicts" as const,
                    target: tdd,
                    reason: "Synthetic conflict for the resolver contract.",
                  },
                ]),
              })
            : component,
        ),
      ),
    });
    const resolver = new DefaultResolver();

    const recommended = resolver.resolve({
      catalog,
      directSelections: [configure],
      projectUnits: [goUnit()],
      targets: [{ target: codex, capabilities: codexCapabilities }],
    });
    expect(recommended.kind).toBe("ready");
    expect(recommended.components.map((component) => component.ref)).toEqual([configure]);
    expect(recommended.recommendations.map((component) => component.ref)).toEqual([tdd]);

    const conflicted = resolver.resolve({
      catalog,
      directSelections: [configure, tdd],
      projectUnits: [goUnit()],
      targets: [{ target: codex, capabilities: codexCapabilities }],
    });
    expect(conflicted.kind).toBe("blocked");
    expect(conflicted.blockers.some((blocker) => blocker.kind === "conflict")).toBe(true);
  });
});

function goUnit() {
  return {
    id: projectUnitId("unit:go"),
    root: relativePosixPath("go"),
    languages: [languageId("go")],
  } as const;
}

function pythonUnit() {
  return {
    id: projectUnitId("unit:python"),
    root: relativePosixPath("python"),
    languages: [languageId("python")],
  } as const;
}

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

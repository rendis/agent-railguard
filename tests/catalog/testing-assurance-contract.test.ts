import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FilesystemCatalog } from "../../src/catalog/filesystem-catalog.js";
import { componentRef, languageId } from "../../src/domain/shared/types.js";

describe("testing assurance contract", () => {
  it("carries a complete behavior inventory from design through TDD reconciliation", async () => {
    const [designSkill, behavioralProof, tddSkill] = await Promise.all([
      readFile("skills/design-tests/SKILL.md", "utf8"),
      readFile("skills/design-tests/references/behavioral-proof.md", "utf8"),
      readFile("skills/tdd/SKILL.md", "utf8"),
    ]);

    for (const field of [
      "behavior/risk",
      "authority",
      "plausible defect",
      "proof/seam",
      "evidence state",
    ]) {
      expect(behavioralProof).toContain(`\`${field}\``);
    }
    expect(designSkill).toContain("`planned` is a valid design handoff");
    const contractIndex = tddSkill.indexOf("task-local behavior inventory");
    const redIndex = tddSkill.indexOf("**RED.**");
    expect(contractIndex).toBeGreaterThan(-1);
    expect(contractIndex).toBeLessThan(redIndex);
    expect(tddSkill).toContain("**Reconcile.**");
    expect(tddSkill).toContain("implementation-created decisions");
    expect(tddSkill).toContain("A coverage percentage cannot close the slice");
  });

  it("keeps Go coverage facts separate from contextual gap closure", async () => {
    const [testSkill, gapAnalysis, criticalAssurance, parser] = await Promise.all([
      readFile("skills/test-go-service/SKILL.md", "utf8"),
      readFile("skills/test-go-service/references/coverage-gap-analysis.md", "utf8"),
      readFile("skills/test-go-service/references/critical-code-assurance.md", "utf8"),
      readFile("skills/test-go-service/scripts/coverage-gaps/main.go", "utf8"),
    ]);

    expect(testSkill).toContain(
      "[coverage-gap-analysis.md](references/coverage-gap-analysis.md)",
    );
    expect(gapAnalysis).toContain(
      "go run <skill-root>/scripts/coverage-gaps/main.go -profile <fresh-coverprofile>",
    );
    expect(gapAnalysis).toContain("repository-owned producer");
    expect(gapAnalysis).toContain("task-local standard Go fallback");
    expect(gapAnalysis).toContain("authorized changed or audited production scope");
    expect(gapAnalysis).toContain("mechanical regression floor");
    expect(criticalAssurance).toContain("three coverage tiers");
    expect(parser).toContain("ai-harness/go-coverage-gaps/v1");
    expect(parser).not.toMatch(/85|threshold/i);
  });

  it("keeps thresholds mechanical and challenges changed-scope gaps before delivery", async () => {
    const [deterministicGate, qualityProfiles, reviewSkill, qualityModel, reviewWorkflow, delivery, e2e] =
      await Promise.all([
        readFile("skills/configure-go-quality/references/deterministic-gate.md", "utf8"),
        readFile("skills/configure-go-quality/references/quality-profiles.md", "utf8"),
        readFile("skills/review-go-quality/SKILL.md", "utf8"),
        readFile("skills/review-go-quality/references/go-quality-model.md", "utf8"),
        readFile("skills/review-go-quality/references/review-workflow.md", "utf8"),
        readFile("skills/develop-go-hexagonal-service/references/verification.md", "utf8"),
        readFile("skills/build-e2e-test-suite/SKILL.md", "utf8"),
      ]);

    expect(deterministicGate).toContain("mechanical regression floor");
    expect(deterministicGate).toContain("does not classify uncovered behavior");
    expect(qualityProfiles).toContain("semantic test completeness");
    expect(reviewSkill).toContain("load `test-go-service`");
    expect(reviewSkill).toContain("candidate changes Go production");
    expect(reviewWorkflow).toContain("passing percentage");
    expect(qualityModel).toContain("unclassified in-scope block");
    expect(delivery).toContain("zero unclassified gaps");
    expect(delivery).toContain("`planned`, `blocked`, or `unavailable`");
    expect(delivery).toContain("cannot be reclassified as `out_of_scope`");
    expect(e2e).toContain("do not create scenarios for internal branches");
  });

  it("installs the Go gap-analysis contract without selecting optional assurance profiles", async () => {
    const result = await new FilesystemCatalog({
      catalogFile: resolve("ai-harness.yaml"),
      supportedLanguages: [
        languageId("go"),
        languageId("python"),
        languageId("typescript"),
        languageId("java"),
      ],
    }).load();
    if (result.kind !== "ready") throw new Error("Expected the real catalog to be ready");

    const review = result.catalog.components.find(
      (component) => component.ref === componentRef("skill:review-go-quality"),
    );
    expect(review?.relations.map((relation) => [relation.kind, relation.target])).toContainEqual([
      "requires",
      componentRef("skill:test-go-service"),
    ]);

    const configure = result.catalog.components.find(
      (component) => component.ref === componentRef("skill:configure-go-quality"),
    );
    expect(configure?.relations
      .filter((relation) => relation.target.startsWith("verification-profile:"))
      .map((relation) => relation.target)).toEqual([
      componentRef("verification-profile:go-quality"),
    ]);
    const baseline = result.catalog.components.find(
      (component) => component.ref === componentRef("verification-profile:go-quality"),
    );
    expect(baseline?.kind === "verification-profile" ? baseline.make : null).toMatchObject({
      targets: ["ai-harness-go-check", "ai-harness-go-verify"],
      operations: { check: "ai-harness-go-check", verify: "ai-harness-go-verify" },
    });
  });
});

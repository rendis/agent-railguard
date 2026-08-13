import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FilesystemCatalog } from "../../src/catalog/filesystem-catalog.js";
import { componentRef, languageId } from "../../src/domain/shared/types.js";

describe("skill routing contract", () => {
  it("keeps frontmatter descriptions focused on capability and trigger branches", async () => {
    const skills = await realSkills();

    for (const skill of skills) {
      expect(skill.description.length).toBeLessThanOrEqual(320);
      expect(skill.description).not.toMatch(/outer owner|remains the .*owner|owns remediation/i);
      expect(skill.description).not.toContain("develop-go-hexagonal-service");
    }
  });

  it("routes complete Go delivery separately from bounded specialist work", async () => {
    const byRef = new Map((await realSkills()).map((skill) => [skill.ref, skill]));

    expect(byRef.get(componentRef("skill:develop-go-hexagonal-service"))?.details).toContain(
      "production behavior or architectural/runtime boundaries",
    );
    expect(byRef.get(componentRef("skill:develop-go-hexagonal-service"))?.details).toContain(
      "Standalone test-only, E2E-only, configuration-only, and read-only review work",
    );
    expect(byRef.get(componentRef("skill:test-go-service"))?.details).toContain(
      "does not require the full service delivery workflow",
    );
    expect(byRef.get(componentRef("skill:configure-go-quality"))?.details).toContain(
      "configuration or commands are missing or invalid",
    );
    expect(byRef.get(componentRef("skill:review-go-quality"))?.details).toContain("without editing");
  });
});

async function realSkills() {
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
  return result.catalog.components.filter((component) => component.kind === "skill");
}

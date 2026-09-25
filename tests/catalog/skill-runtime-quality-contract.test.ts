import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FilesystemCatalog } from "../../src/catalog/filesystem-catalog.js";
import { languageId } from "../../src/domain/shared/types.js";

const skillsRoot = resolve("skills");

describe("skill runtime quality contract", () => {
  it("requires Complete when on every numbered step", async () => {
    for (const skillId of await skillIds()) {
      const markdown = await readFile(join(skillsRoot, skillId, "SKILL.md"), "utf8");
      const steps = numberedSteps(markdown);
      expect(steps.length, skillId).toBeGreaterThan(0);
      for (const step of steps) {
        expect(step.body, `${skillId} step ${step.index} ${step.name}`).toContain("Complete when");
      }
    }
  });

  it("opens Composition contract with a Situation / Load or owner table", async () => {
    for (const skillId of await skillIds()) {
      const markdown = await readFile(join(skillsRoot, skillId, "SKILL.md"), "utf8");
      const section = compositionSection(markdown);
      expect(section, skillId).toBeDefined();
      const firstTable = section!.trimStart();
      expect(firstTable, skillId).toMatch(/^\| Situation \| Load or owner \|/i);
    }
  });

  it("installs no Codex-only agents/openai.yaml payload files", async () => {
    for (const skillId of await skillIds()) {
      expect(existsSync(join(skillsRoot, skillId, "agents", "openai.yaml")), skillId).toBe(false);
    }
  });

  it("keeps tdd inventory, proof, and conventions as separate steps before RED", async () => {
    const markdown = await readFile(join(skillsRoot, "tdd", "SKILL.md"), "utf8");
    const names = numberedSteps(markdown).map((step) => step.name);
    expect(names.slice(0, 4)).toEqual(["Inventory.", "Proof.", "Conventions.", "RED."]);
  });

  it("loads go-design-practices by change class instead of before every Go edit", async () => {
    const markdown = await readFile(join(skillsRoot, "develop-go-hexagonal-service", "SKILL.md"), "utf8");
    const contract = numberedSteps(markdown).find((step) => step.name === "Contract.");
    expect(contract).toBeDefined();
    expect(contract!.body).toMatch(/\| Change class \| Reference \|/i);
    expect(contract!.body).toContain("[go-design-practices.md](references/go-design-practices.md)");
    expect(contract!.body).not.toContain("before Go changes");
  });

  it("loads configure-go-quality profile policy references only when selecting beyond the baseline", async () => {
    const skill = await readFile(join(skillsRoot, "configure-go-quality", "SKILL.md"), "utf8");
    expect(skill).toMatch(/\[quality-profiles\.md\]\(references\/quality-profiles\.md\) only when /);
  });

  it("routes Go/Godog executable specification from E2E to the stack testing skill by id", async () => {
    const e2e = await readFile(join(skillsRoot, "build-e2e-test-suite", "SKILL.md"), "utf8");
    expect(e2e).toMatch(/Godog|Gherkin|go-e2e-gherkin/);
    expect(e2e).toContain("`test-go-service`");
    expect(e2e).not.toMatch(/\]\([^)]*test-go-service/);
  });

  it("names review-go-quality as a read-only caller of test-go-service", async () => {
    const skill = await readFile(join(skillsRoot, "test-go-service", "SKILL.md"), "utf8");
    expect(skill).toContain("`review-go-quality`");
  });

  it("hands accepted review findings to test-go-service by skill id", async () => {
    const skill = await readFile(join(skillsRoot, "review-go-quality", "SKILL.md"), "utf8");
    expect(skill.match(/\| Accepted findings \|[^\n]*/)?.[0]).toContain("`test-go-service`");
  });

  it("loads every applicable develop-go contract reference row", async () => {
    const markdown = await readFile(join(skillsRoot, "develop-go-hexagonal-service", "SKILL.md"), "utf8");
    const contract = numberedSteps(markdown).find((step) => step.name === "Contract.");
    expect(contract?.body).toMatch(/matching rows/);
  });

  it("names configure-go-quality when develop-go assesses readiness", async () => {
    const markdown = await readFile(join(skillsRoot, "develop-go-hexagonal-service", "SKILL.md"), "utf8");
    const route = numberedSteps(markdown).find((step) => step.name === "Route.");
    expect(route?.body).toContain("`configure-go-quality`");
  });

  it("keeps test-go-service description free of delivery-ownership composition", async () => {
    const markdown = await readFile(join(skillsRoot, "test-go-service", "SKILL.md"), "utf8");
    const description = markdown.match(/^description:\s*(.+)$/m)?.[1] ?? "";
    expect(description).not.toMatch(/full service delivery/);
  });

  it("keeps frontmatter descriptions as exclusive capability-and-trigger pointers", async () => {
    const skills = await loadSkills();
    const byId = new Map(skills.map((skill) => [skill.id, skill.description]));

    for (const skill of skills) {
      expect(skill.description.length, skill.id).toBeLessThanOrEqual(280);
      expect(skill.description, skill.id).not.toMatch(/\n/);
      expect(skill.description, skill.id).toMatch(/Use for |Use when /);
      expect(skill.description, skill.id).not.toMatch(
        /outer owner|remains the .*owner|owns remediation|belongs to|focused skills/i,
      );
      expect(skill.description, skill.id).not.toContain("develop-go-hexagonal-service");
    }

    expect(byId.get("tdd")).toMatch(/FAIL.?PASS|red-green|test-first/i);
    expect(byId.get("tdd")).not.toMatch(/coverage-gap|mutation|public journey/i);
    expect(byId.get("design-tests")).toMatch(/seam|oracle|proof/i);
    expect(byId.get("design-tests")).not.toMatch(/FAIL.?PASS|red-green/i);
    expect(byId.get("test-go-service")).toMatch(/Go-specific|coverage-gap|hardening/i);
    expect(byId.get("develop-go-hexagonal-service")).toMatch(/^Deliver /);
    expect(byId.get("configure-go-quality")).toMatch(/pins?|configs?|CI/i);
    expect(byId.get("configure-go-quality")).not.toMatch(/remediation|belongs to/i);
    expect(byId.get("build-e2e-test-suite")).toMatch(/journey|end-to-end|acceptance/i);
    expect(byId.get("review-go-quality")).toMatch(/without editing|fixed snapshot|read-only/i);
    expect(
      ["tdd", "develop-go-hexagonal-service"].filter((id) =>
        /Use for features/.test(byId.get(id) ?? ""),
      ).length,
    ).toBe(1);
  });
});

async function skillIds(): Promise<string[]> {
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function loadSkills() {
  const result = await new FilesystemCatalog({
    catalogFile: resolve("railguard.yaml"),
    supportedLanguages: [
      languageId("go"),
      languageId("python"),
      languageId("typescript"),
      languageId("java"),
    ],
  }).load();
  if (result.kind !== "ready") throw new Error("Expected the real catalog to be ready");
  return result.catalog.components
    .filter((component) => component.kind === "skill")
    .map((component) => ({
      id: component.ref.slice("skill:".length),
      description: component.description,
    }));
}

function numberedSteps(markdown: string): Array<{ index: number; name: string; body: string }> {
  const body = markdown.replace(/^---\n[\s\S]*?\n---\n/, "");
  const matches = [...body.matchAll(/^(\d+)\.\s+\*\*([^*]+)\*\*\s*/gm)];
  return matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < matches.length ? (matches[index + 1]?.index ?? body.length) : body.length;
    let stepBody = body.slice(start, end);
    const nextHeading = stepBody.search(/^## /m);
    if (nextHeading >= 0) stepBody = stepBody.slice(0, nextHeading);
    return {
      index: Number(match[1]),
      name: match[2]?.trim() ?? "",
      body: stepBody.trim(),
    };
  });
}

function compositionSection(markdown: string): string | undefined {
  const body = markdown.replace(/^---\n[\s\S]*?\n---\n/, "");
  const marker = "## Composition contract";
  const offset = body.indexOf(marker);
  if (offset < 0) return undefined;
  return body.slice(offset + marker.length);
}

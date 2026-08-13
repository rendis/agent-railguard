import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const skillRoot = "skills/develop-go-hexagonal-service";

describe("develop-go-hexagonal-service contract", () => {
  it("gates a new inbound or outbound REST stack on implementation and version decisions", async () => {
    const skill = await readFile(`${skillRoot}/SKILL.md`, "utf8");
    const selection = await readFile(`${skillRoot}/references/rest-stack-selection.md`, "utf8");

    expect(skill).toContain("[REST stack selection](references/rest-stack-selection.md)");
    expect(selection).toContain("A stack is adopted only when repository evidence shows");
    expect(selection).toContain("When no adopted stack exists");
    expect(selection).toContain("a library previously recommended by this skill is not adopted");
    expect(selection).toContain("explicitly asks to select or reconsider one");
    expect(selection).toContain("## Gate 1: choose the implementation");
    expect(selection).toContain("## Gate 2: choose the version");

    for (const server of ["Vanilla `net/http`", "Chi", "Gin", "Echo", "Fiber"]) {
      expect(selection).toContain(`| ${server} |`);
    }
    for (const client of [
      "Vanilla `net/http`",
      "Resty",
      "Req",
      "`go-retryablehttp`",
      "`fasthttp`",
    ]) {
      expect(selection).toContain(`| ${client} |`);
    }

    expect(selection).toContain("Ask which option the user wants");
    expect(selection).toContain("latest compatible stable version or a particular version");
    expect(selection).toContain("may select one of the five or name another maintained library");
  });

  it("owns typed runtime configuration with deterministic precedence and startup validation", async () => {
    const skill = await readFile(`${skillRoot}/SKILL.md`, "utf8");
    const configuration = await readFile(
      `${skillRoot}/references/runtime-configuration.md`,
      "utf8",
    );

    expect(skill).toContain("[runtime configuration](references/runtime-configuration.md)");
    expect(configuration).toContain("internal/infra/config/application.yaml");
    expect(configuration).toContain("variables already injected into the process environment");
    expect(configuration).toContain("`application.yaml`");
    expect(configuration).toContain("typed defaults declared by the configuration owner");
    expect(configuration).toContain("`gopkg.in/yaml.v3`");
    expect(configuration).toContain("`github.com/spf13/viper`");
    expect(configuration).toContain("`github.com/joho/godotenv`");
    expect(configuration).toContain("Fail before readiness");
  });
});

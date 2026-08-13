import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const skillRoot = "skills/configure-go-quality";
const classifier = resolve(`${skillRoot}/scripts/classify-readiness.mjs`);

describe("configure-go-quality contract", () => {
  it.each([
    ["missing inputs", ["--inputs", "missing"], "MISSING", "missing"],
    ["broken inputs", ["--inputs", "broken"], "BROKEN", "broken"],
    [
      "blocked execution before product findings",
      [
        "--inputs",
        "ready",
        "--product-finding",
        "coverage",
        "--blocked-prerequisite",
        "vulnerability-db",
      ],
      "BLOCKED_SETUP",
      "blocked_setup",
    ],
    [
      "ready configuration with product findings",
      ["--inputs", "ready", "--product-finding", "tests"],
      "READY_WITH_FINDINGS",
      "ready_with_findings",
    ],
    ["ready configuration", ["--inputs", "ready"], "READY", "ready"],
  ])("classifies %s", (_name, args, state, status) => {
    const result = spawnSync(process.execPath, [classifier, ...args], { encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ state, status });
  });

  it.each([
    ["missing --inputs", []],
    ["invalid --inputs", ["--inputs", "unknown"]],
    ["duplicate --inputs", ["--inputs", "ready", "--inputs", "broken"]],
    ["missing finding label", ["--inputs", "ready", "--product-finding"]],
    ["empty finding label", ["--inputs", "ready", "--product-finding", ""]],
    ["blank prerequisite label", ["--inputs", "ready", "--blocked-prerequisite", "   "]],
    ["unknown option", ["--inputs", "ready", "--other", "value"]],
  ])("rejects %s", (_name, args) => {
    const result = spawnSync(process.execPath, [classifier, ...args], { encoding: "utf8" });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Usage:");
  });

  it("uses the managed v1 profile as the generic default without promising undeclared targets", async () => {
    const [skill, profile] = await Promise.all([
      readFile(`${skillRoot}/SKILL.md`, "utf8"),
      readFile(`${skillRoot}/references/default-go-service-profile.md`, "utf8"),
    ]);

    expect(skill).toContain("node scripts/classify-readiness.mjs");
    expect(skill).toContain("[default-go-service-profile.md](references/default-go-service-profile.md)");
    expect(profile).toContain("## Managed AI Harness v1 baseline");
    expect(profile).toContain("`verification-profile:go-quality`");
    expect(profile).toContain("`make check`");
    expect(profile).toContain("`make verify`");
    expect(profile).toContain("requires an explicit provider");
    expect(skill).not.toContain("submit semantic scopes and required targets");
    expect(skill).not.toContain("silently absent race, fuzz, vulnerability, mutation, or E2E is incomplete");
  });
});

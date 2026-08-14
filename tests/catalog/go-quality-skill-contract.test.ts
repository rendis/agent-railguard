import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

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
    expect(profile).toContain("selected profile with its default `disabled` sentinel");
    expect(skill).not.toContain("submit semantic scopes and required targets");
    expect(skill).not.toContain("silently absent race, fuzz, vulnerability, mutation, or E2E is incomplete");
  });

  it("defines strict AI-code assurance as managed profiles behind check and verify", async () => {
    const [skill, profile, profiles, gate, policy, rawLint, catalog] = await Promise.all([
      readFile(`${skillRoot}/SKILL.md`, "utf8"),
      readFile(`${skillRoot}/references/default-go-service-profile.md`, "utf8"),
      readFile(`${skillRoot}/references/quality-profiles.md`, "utf8"),
      readFile(`${skillRoot}/references/deterministic-gate.md`, "utf8"),
      readFile(`${skillRoot}/references/tool-policy.md`, "utf8"),
      readFile(`${skillRoot}/assets/golangci.yml`, "utf8"),
      readFile("ai-harness.yaml", "utf8"),
    ]);
    const authoring = parse(catalog) as {
      catalog: {
        "verification-profiles": Record<string, {
          make: { operations: Record<string, string>; targets: string[] };
        }>;
      };
    };
    const lint = parse(rawLint) as {
      linters: {
        enable: string[];
        settings: {
          gocognit: { "min-complexity": number };
          goconst: { "ignore-tests": boolean; "min-len": number; "min-occurrences": number };
          dupl: { threshold: number };
          godox: { keywords: string[] };
          revive: { rules: Array<{ name: string }> };
          nolintlint: {
            "allow-unused": boolean;
            "require-explanation": boolean;
            "require-specific": boolean;
          };
        };
      };
    };

    expect(skill).toContain("strict AI-generated or AI-modified Go assurance");
    expect(skill).toContain("`verification-profile:go-assurance`");
    expect(skill).toContain("`verification-profile:go-fuzz`");
    expect(skill).toContain("`verification-profile:go-mutation`");
    expect(skill).toContain("`verification-profile:go-e2e`");
    expect(profile).toContain("one public `make check` and `make verify` interface");
    expect(profiles).toContain("actual SonarQube Quality Gate");
    expect(gate).toContain("`sonar.qualitygate.wait=true`");
    expect(policy).toContain("maximum of 10");
    expect(policy).toContain("Do not add a whole-repository aggregate");
    expect([skill, profile, profiles, gate, policy].join("\n")).not.toMatch(
      /(?:quality-check|verify-hardening|verify-all)/,
    );
    await expect(access(`${skillRoot}/assets/Makefile.quality`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(Object.keys(authoring.catalog["verification-profiles"]).sort()).toEqual([
      "go-assurance",
      "go-e2e",
      "go-fuzz",
      "go-mutation",
      "go-quality",
    ]);
    for (const id of ["go-assurance", "go-e2e", "go-fuzz", "go-mutation", "go-quality"]) {
      expect(authoring.catalog["verification-profiles"][id]?.make.operations).toEqual({
        check: expect.stringMatching(/^ai-harness-/),
        verify: expect.stringMatching(/^ai-harness-/),
      });
    }

    expect(lint.linters.enable).toEqual(expect.arrayContaining([
      "dupl",
      "gocognit",
      "goconst",
      "godox",
      "nolintlint",
      "revive",
    ]));
    expect(lint.linters.settings.gocognit["min-complexity"]).toBe(10);
    expect(lint.linters.settings.goconst).toEqual({
      "ignore-tests": true,
      "min-len": 3,
      "min-occurrences": 3,
    });
    expect(lint.linters.settings.dupl.threshold).toBe(100);
    expect(lint.linters.settings.godox.keywords).toEqual(expect.arrayContaining(["FIXME", "TODO"]));
    expect(lint.linters.settings.revive.rules.map((rule) => rule.name)).toEqual(
      expect.arrayContaining(["bare-return", "early-return", "empty-block", "superfluous-else"]),
    );
    expect(lint.linters.settings.nolintlint).toEqual({
      "allow-unused": false,
      "require-explanation": true,
      "require-specific": true,
    });
  });
});

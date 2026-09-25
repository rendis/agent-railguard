import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
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
    expect(profile).toContain("## Baseline");
    expect(profile).toContain("`verification-profile:go-quality`");
    expect(profile).toContain("`railguard check`");
    expect(profile).toContain("`railguard verify`");
    expect(profile).not.toContain("make check");
    expect(profile).toContain("profile whose inputs keep the default `disabled` sentinel");
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
      readFile("railguard.yaml", "utf8"),
    ]);
    const authoring = parse(catalog) as {
      catalog: {
        "verification-profiles": Record<string, {
          checks: Array<{ id: string; kind: string; stage: "check" | "verify" }>;
        }>;
      };
    };
    const lint = parse(rawLint) as {
      run: {
        tests: boolean;
        "modules-download-mode": string;
        "build-tags"?: string[];
      };
      linters: {
        enable: string[];
        settings: {
          cyclop: { "max-complexity": number; "package-average": number };
          funlen: { lines: number; statements: number; "ignore-comments": boolean };
          gocognit: { "min-complexity": number };
          goconst: {
            "ignore-tests": boolean;
            "ignore-calls": boolean;
            "min-len": number;
            "min-occurrences": number;
          };
          dupl: { threshold: number };
          godox: { keywords: string[] };
          maintidx: { under: number };
          nestif: { "min-complexity": number };
          revive: { rules: Array<{ name: string; arguments?: number[] }> };
          nolintlint: {
            "allow-unused": boolean;
            "require-explanation": boolean;
            "require-specific": boolean;
          };
        };
        exclusions: {
          rules: Array<{ path: string; linters: string[] }>;
        };
      };
    };

    expect(skill).toContain("strict AI-generated or AI-modified Go assurance");
    expect(skill).toContain("`verification-profile:go-assurance`");
    expect(skill).toContain("`verification-profile:go-fuzz`");
    expect(skill).toContain("`verification-profile:go-mutation`");
    expect(skill).toContain("`verification-profile:go-e2e`");
    expect(profile).toContain("`railguard verify --changed`");
    expect(profiles).toContain("actual SonarQube Quality Gate");
    expect(gate).toContain("`sonar.qualitygate.wait=true`");
    expect(policy).toContain("cyclomatic complexity `5`");
    expect(policy).toContain("cognitive complexity `6`");
    expect(policy).toContain("Do not add a whole-repository aggregate");
    expect(Object.keys(authoring.catalog["verification-profiles"]).sort()).toEqual([
      "change-guard",
      "go-architecture",
      "go-assurance",
      "go-e2e",
      "go-fuzz",
      "go-mutation",
      "go-quality",
      "handoff-review",
    ]);
    for (const id of ["go-architecture", "go-assurance", "go-e2e", "go-fuzz", "go-mutation", "go-quality"]) {
      const checks = authoring.catalog["verification-profiles"][id]?.checks ?? [];
      expect(checks.length).toBeGreaterThan(0);
      expect(checks.every((check) => check.stage === "check" || check.stage === "verify")).toBe(true);
    }

    expect(lint.run).toEqual({
      timeout: "5m",
      tests: true,
      "modules-download-mode": "readonly",
    });
    expect(lint.linters.enable).toEqual([
      "bodyclose",
      "contextcheck",
      "cyclop",
      "dupl",
      "durationcheck",
      "errcheck",
      "errorlint",
      "fatcontext",
      "funlen",
      "gocognit",
      "goconst",
      "gocritic",
      "godoclint",
      "godox",
      "gosec",
      "govet",
      "ineffassign",
      "loggercheck",
      "maintidx",
      "musttag",
      "nestif",
      "nilerr",
      "nilnil",
      "noctx",
      "nolintlint",
      "revive",
      "sloglint",
      "staticcheck",
      "testifylint",
      "thelper",
      "unused",
      "usetesting",
      "wastedassign",
    ]);
    expect(lint.linters.settings.cyclop).toEqual({
      "max-complexity": 5,
      "package-average": 0,
    });
    expect(lint.linters.settings.funlen).toEqual({
      lines: 80,
      statements: 40,
      "ignore-comments": true,
    });
    expect(lint.linters.settings.gocognit["min-complexity"]).toBe(6);
    expect(lint.linters.settings.goconst).toEqual({
      "ignore-tests": true,
      "ignore-calls": false,
      "min-len": 3,
      "min-occurrences": 3,
    });
    expect(lint.linters.settings.dupl.threshold).toBe(100);
    expect(lint.linters.settings.godox.keywords).toEqual(expect.arrayContaining(["FIXME", "TODO"]));
    expect(lint.linters.settings.maintidx.under).toBe(20);
    expect(lint.linters.settings.nestif["min-complexity"]).toBe(4);
    expect(lint.linters.settings.revive.rules.map((rule) => rule.name)).toEqual(
      expect.arrayContaining([
        "argument-limit",
        "bare-return",
        "early-return",
        "empty-block",
        "superfluous-else",
      ]),
    );
    expect(lint.linters.settings.revive.rules.find((rule) => rule.name === "argument-limit"))
      .toEqual({ name: "argument-limit", arguments: [7] });
    expect(lint.linters.exclusions.rules).toContainEqual({
      path: "_test\\.go",
      linters: ["cyclop", "funlen", "gocognit", "godoclint", "maintidx", "nestif", "nilnil"],
    });
    expect(lint.linters.settings.nolintlint).toEqual({
      "allow-unused": false,
      "require-explanation": true,
      "require-specific": true,
    });
  });
});

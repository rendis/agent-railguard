import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { draftContext, draftFindings, renderDraftFindings } from "../../src/cli/issue-draft-check.js";
import { issueKinds, issueReport } from "../../src/cli/issue-report.js";

const repository = "example/railguard";
const context = {
  terms: ["Acme-Payments/ledger-api", "Acme-Payments", "ledger-api", "Payments", "Jane Roe", "Jane", "Roe", "main", "example"],
  isCommit: (candidate: string) => candidate === "3f9c2ab" || candidate === "4105278",
};

describe("issue draft check", () => {
  it("finds project names, identity, paths, hosts, secrets and commits", () => {
    const draft = [
      "In ledger-api the check fails for Jane (jane.roe@acme.io).",
      "Path: /Users/jroe/work/app. And C:\\Users\\jroe\\app, see http://ci.corp/job/1 or 10.2.3.4.",
      "token=abcdef123456 ghp_0123456789abcdefghijklmnopqrstuvwxyz commit 3f9c2ab or 4105278",
    ].join("\n");

    const findings = draftFindings(draft, context, repository);

    expect(findings.map((finding) => [finding.line, finding.kind, finding.excerpt])).toEqual([
      [1, "project-or-person", "ledger-api"],
      [1, "project-or-person", "Jane"],
      [1, "project-or-person", "jane"],
      [1, "email", "jane.roe@acme.io"],
      [1, "project-or-person", "roe"],
      [2, "absolute-path", "/Users/jroe/work/app"],
      [2, "absolute-path", "C:\\Users\\jroe\\app"],
      [2, "internal-url", "http://ci.corp/job/1"],
      [2, "ip-address", "10.2.3.4"],
      [3, "secret", "toke…(18 caracteres)"],
      [3, "secret", "ghp_…(40 caracteres)"],
      [3, "commit", "3f9c2ab"],
      [3, "commit", "4105278"],
    ]);
    expect(renderDraftFindings("issue.md", findings)).toContain("issue.md:1:4 nombre del repositorio, su organización o la persona: ledger-api");
  });

  it("accepts markers, public links, generic words and the Railguard repository itself", () => {
    const draft = [
      "`check --changed` en <repo>/<modulo> con ~/<ruta>, main, uat y 127.0.0.1.",
      "Ver https://github.com/example/railguard/issues y docs/cli.md; release 0.1.2, commit abc1234.",
    ].join("\n");

    expect(draftFindings(draft, context, repository)).toEqual([]);
  });

  it.each(issueKinds)("does not flag its own %s guide and template", (kind) => {
    const report = issueReport(kind, { engineVersion: "1.2.3", pinnedVersion: "1.0.0", platform: "linux-x64" }, repository);
    expect(draftFindings(report, { terms: [], isCommit: () => false }, repository)).toEqual([]);
    expect(renderDraftFindings("draft.md", [])).toContain("Sin hallazgos");
  });

  it("collects the repository, remote, branch and person names from Git", async () => {
    const root = await mkdtemp(join(tmpdir(), "railguard-draft-"));
    try {
      const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
      git("init", "--quiet", "--initial-branch", "feature/secret-launch");
      git("config", "user.name", "Jane Roe");
      git("config", "user.email", "jane@acme-corp.example");
      git("remote", "add", "origin", "git@git.acme-corp.example:Acme-Payments/ledger-api.git");
      git("commit", "--quiet", "--allow-empty", "-m", "start");
      const commit = git("rev-parse", "--short", "HEAD");

      const collected = draftContext(root);

      expect(collected.terms).toEqual(expect.arrayContaining([
        "Jane Roe", "Jane", "jane@acme-corp.example", "acme-corp", "Acme-Payments/ledger-api", "ledger-api",
        "Payments", "feature/secret-launch",
      ]));
      expect(collected.isCommit(commit)).toBe(true);
      expect(collected.isCommit("abc1234")).toBe(false);
      expect(draftContext(join(root, "missing")).isCommit(commit)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

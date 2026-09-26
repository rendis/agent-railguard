import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { issueKinds, issueReport, issueTemplate } from "../../src/cli/issue-report.js";

const environment = { engineVersion: "1.2.3", pinnedVersion: null, platform: "darwin-arm64" };

describe("issue report", () => {
  it.each([["bug", "bug"], ["improvement", "enhancement"]] as const)(
    "prints the guide, the GitHub %s template and how to publish it",
    (kind, label) => {
      const report = issueReport(kind, environment, "example/railguard");
      const template = issueTemplate(readFileSync(`.github/ISSUE_TEMPLATE/${kind}.md`, "utf8"));

      expect(template.label).toBe(label);
      expect(report).toContain("## 2. Protect privacy");
      expect(report).toContain(template.body.trimEnd());
      expect(report).not.toContain("labels:");
      expect(report).toContain("- Railguard: 1.2.3\n- Plataforma: darwin-arm64");
      expect(report).toContain(`gh issue create --repo example/railguard --label ${label} `);
    },
  );

  it("names the version the repository pins when it differs from this engine", () => {
    expect(issueReport("bug", { ...environment, pinnedVersion: "1.2.3" }, "example/railguard"))
      .toContain("- Railguard: 1.2.3\n");
    expect(issueReport("bug", { ...environment, pinnedVersion: "1.0.0" }, "example/railguard"))
      .toContain("- Railguard: 1.2.3 (este repositorio fija 1.0.0)\n");
  });

  it("has a template for every kind and rejects one without a single label", () => {
    expect(issueKinds).toEqual(["bug", "improvement"]);
    expect(() => issueTemplate("## Sin front matter\n")).toThrow("front matter");
    expect(() => issueTemplate("---\nlabels: [bug, docs]\n---\n\nbody\n")).toThrow("one label");
  });
});

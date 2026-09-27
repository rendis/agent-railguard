import { describe, expect, it } from "vitest";
import type { InteractionSnapshot } from "../../src/interaction/model.js";
import { scanSummary } from "../../src/tui/render.js";

const harness = (id: string, detected: boolean) => ({ id, detected, version: null, ready: detected });

function snapshot(repository: Record<string, unknown>, recommendations: readonly string[] = []): InteractionSnapshot {
  return {
    repository: {
      root: "/home/dev/work/service",
      fingerprint: "",
      languages: ["go"],
      integrity: "clean",
      readiness: "ready",
      updates: "none",
      installedComponents: [],
      installedDirectSelections: [],
      installedTargets: [],
      harnesses: [harness("claude-code", true), harness("codex", true), harness("opencode", false), harness("vscode", true)],
      ...repository,
    },
    recommendations: recommendations.map((ref) => ({ ref, version: "1.0.0", reasons: [] })),
    diagnostics: [],
  } as unknown as InteractionSnapshot;
}

describe("scanSummary", () => {
  it("groups harnesses by state and installed components by family", () => {
    const summary = scanSummary(snapshot({
      management: "managed",
      installedTargets: ["claude-code", "codex"],
      installedDirectSelections: ["git-gate:pre-commit-verify", "pack:go-service-foundation", "verification-profile:go-fuzz"],
    }), "/home/dev");

    expect(summary).toBe([
      "Path         ~/work/service",
      "Stack        go",
      "Status       configured by Railguard; managed files unchanged",
      "Harnesses    claude-code, codex (configured)",
      "             vscode (detected, not configured)",
      "             opencode (not detected)",
      "",
      "Installed (3)",
      "  📦 Packs       go-service-foundation",
      "  🧪 Quality     go-fuzz",
      "  🌿 Git hooks   pre-commit-verify",
    ].join("\n"));
  });

  it("shows detected harnesses and grouped recommendations before configuration", () => {
    const summary = scanSummary(snapshot({ management: "uninitialized", integrity: "unknown" }, ["skill:configure-go-quality"]), "/elsewhere");

    expect(summary).toContain("Path         /home/dev/work/service");
    expect(summary).toContain("Status       not configured by Railguard yet");
    expect(summary).toContain("Harnesses    claude-code, codex, vscode (detected)");
    expect(summary).toContain("Recommended (1)\n  🧠 Skills      configure-go-quality");
    expect(summary).not.toContain("Installed");
  });
});

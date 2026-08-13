import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { createInteractionRuntime } from "../../src/interaction/interaction-session.js";
import { AiHarnessTui } from "../../src/tui/app.js";
import type { UpdateResult, UpdateService } from "../../src/update/update-service.js";
import { createTempRepository } from "../helpers/temp-repository.js";

const execute = promisify(execFile);

describe("TUI CLI update flow", () => {
  it("checks in the background, reviews explicitly, applies and asks for restart", async () => {
    const repository = await createTempRepository({
      "go.mod": "module example.com/tui-update\n\ngo 1.24\n",
    });
    await execute("git", ["init", "--quiet", repository.root]);
    const interaction = await createInteractionRuntime({ catalogFile: resolve("ai-harness.yaml") });
    const available = updateResult("available");
    const applied = updateResult("applied");
    const updateService = {
      check: vi.fn(async () => available),
      apply: vi.fn(async () => applied),
    } satisfies Pick<UpdateService, "check" | "apply">;
    const tui = render(
      <AiHarnessTui
        session={interaction.session}
        root={repository.root}
        currentVersion="0.1.0"
        updateService={updateService}
      />,
    );
    try {
      await waitForFrame(tui, "Review available CLI update");
      expect(tui.lastFrame()).toContain("Review available CLI update");
      expect(tui.lastFrame()).toContain("[u] Review CLI update");
      expect(updateService.check).toHaveBeenCalledOnce();

      tui.stdin.write("u");
      await waitForFrame(tui, "REVIEW CLI UPDATE");
      expect(tui.lastFrame()).toContain("[Enter] Apply verified CLI update");
      expect(tui.lastFrame()).toContain("0.2.0");

      tui.stdin.write("\r");
      await waitForFrame(tui, "CLI UPDATE APPLIED");
      expect(updateService.apply).toHaveBeenCalledOnce();
      expect(tui.lastFrame()).toContain("Restart AI Harness");
      expect(tui.lastFrame()).toContain("[q] Quit and restart");

      tui.stdin.write("o");
      await waitForFrame(tui, "SCAN COMPLETE");
      expect(tui.lastFrame()).toContain("Repository discovery is ready");
    } finally {
      tui.unmount();
      await Promise.all([interaction.dispose(), repository.cleanup()]);
    }
  }, 30_000);
});

function updateResult(status: "available" | "applied"): UpdateResult {
  const digest = `sha256:${"a".repeat(64)}` as const;
  const manifest = Object.freeze({
    schema: "ai-harness/release-manifest/v1" as const,
    channel: "stable",
    source: Object.freeze({ commit: "abc123", tree: "def456", input_digest: digest }),
    release: Object.freeze({
      name: "@example/ai-harness" as const,
      version: "0.2.0",
      runtime: Object.freeze({
        node: ">=24.19.0 <25.0.0" as const,
        pnpm: ">=11.21.0 <12.0.0" as const,
      }),
      artifact: Object.freeze({ path: "ai-harness-0.2.0.tgz", sha256: digest, size: 12345 }),
      sbom: Object.freeze({ path: "ai-harness-0.2.0.sbom.json", sha256: digest, size: 120 }),
      notices: Object.freeze({ path: "THIRD_PARTY_NOTICES.txt", sha256: digest, size: 80 }),
      notes: Object.freeze(["Verified TUI update flow"]),
    }),
    authentication: Object.freeze({
      kind: "external-https-channel" as const,
      manifest_authentication: "Corporate HTTPS channel",
    }),
    content: Object.freeze({ manifest: Object.freeze({ path: "content-manifest.json" }) }),
  });
  const release = Object.freeze({
    manifestUrl: new URL("https://releases.example.test/stable/release-manifest.json"),
    artifactUrl: new URL("https://releases.example.test/stable/ai-harness-0.2.0.tgz"),
    contentManifestUrl: new URL("https://releases.example.test/stable/content-manifest.json"),
    manifest,
  });
  return Object.freeze({
    status,
    currentVersion: "0.1.0",
    latestVersion: "0.2.0",
    release,
    diagnostics: Object.freeze([]),
  });
}

async function waitForFrame(
  instance: ReturnType<typeof render>,
  expected: string,
): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (instance.lastFrame()?.includes(expected) === true) return;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(
    `Timed out waiting for TUI frame containing: ${expected}\n${instance.lastFrame() ?? "<no frame>"}`,
  );
}

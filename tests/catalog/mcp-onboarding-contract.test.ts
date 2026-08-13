import { execFile } from "node:child_process";
import { cp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { createDefaultApplication } from "../../src/application/composition-root.js";
import type { ExecutableProbe } from "../../src/domain/harness/model.js";
import {
  componentRef,
  harnessTargetId,
} from "../../src/domain/shared/types.js";
import { createTempRepository } from "../helpers/temp-repository.js";

const execute = promisify(execFile);
const targets = ["claude-code", "codex", "cursor", "opencode", "vscode"].map(
  harnessTargetId,
);
const fixtureRef = componentRef("mcp:authoring-only-fixture");
const fixtureUrl = "https://mcp.example.test/v1/mcp";

const probe: ExecutableProbe = {
  async probe(command) {
    return {
      detected: true,
      path: `/test/bin/${command}`,
      version: `${command} onboarding contract`,
      diagnostics: [],
    };
  },
};

describe("MCP authoring-only onboarding contract", () => {
  it("loads, resolves, projects, reviews, repairs and removes a supported MCP added only to the manifest", async () => {
    const source = await createTempRepository({});
    const repository = await createTempRepository({});
    await Promise.all([
      cp(resolve("skills"), resolve(source.root, "skills"), { recursive: true }),
      cp(resolve("ai-harness.yaml"), resolve(source.root, "ai-harness.yaml")),
    ]);
    await injectFixtureMcp(resolve(source.root, "ai-harness.yaml"));
    await execute("git", ["init", "--quiet", repository.root]);

    const runtime = await createDefaultApplication({
      sourcePath: source.root,
      executableProbe: probe,
    });
    try {
      const baseline = await runtime.application.scan(repository.root);
      expect(baseline.kind).toBe("ready");
      if (baseline.kind !== "ready") throw new Error("Expected ready baseline scan");
      expect(baseline.catalog.components.find(({ ref }) => ref === fixtureRef)).toMatchObject({
        kind: "mcp-integration",
        connection: { type: "remote-http", url: fixtureUrl },
        auth: { type: "oauth", activation: "harness-native" },
      });

      const install = await runtime.application.prepareInstall(baseline, [fixtureRef], targets);
      expect(install.resolution.kind).toBe("ready");
      expect(install.resolution.components.map(({ ref }) => ref)).toEqual([fixtureRef]);
      expect(install.plan?.kind).toBe("ready");
      if (install.plan?.kind !== "ready") throw new Error("Expected ready install plan");
      expect(install.plan.operations.map(({ path }) => path).sort()).toEqual([
        ".ai-harness",
        ".ai-harness/lock.json",
        ".ai-harness/project.yaml",
        ".codex",
        ".codex/config.toml",
        ".cursor",
        ".cursor/mcp.json",
        ".mcp.json",
        ".vscode",
        ".vscode/mcp.json",
        "AGENTS.md",
        "CLAUDE.md",
        "opencode.json",
      ]);
      expect((await runtime.application.apply(install.plan)).kind).toBe("applied");

      await expect(readFile(resolve(repository.root, ".codex/config.toml"), "utf8"))
        .resolves.toContain(`url = "${fixtureUrl}"`);
      await expect(readFile(resolve(repository.root, ".mcp.json"), "utf8"))
        .resolves.toContain(`"url": "${fixtureUrl}"`);
      await expect(readFile(resolve(repository.root, ".cursor/mcp.json"), "utf8"))
        .resolves.toContain(`"url": "${fixtureUrl}"`);
      await expect(readFile(resolve(repository.root, ".vscode/mcp.json"), "utf8"))
        .resolves.toContain(`"url": "${fixtureUrl}"`);
      await expect(readFile(resolve(repository.root, "opencode.json"), "utf8"))
        .resolves.toContain(`"url": "${fixtureUrl}"`);
      const agentInstructions = await readFile(resolve(repository.root, "AGENTS.md"), "utf8");
      expect(agentInstructions).toContain('id="mcps.mapping"');
      expect(agentInstructions).toContain("`authoring-only-fixture`");
      await expect(readFile(resolve(repository.root, "CLAUDE.md"), "utf8"))
        .resolves.toContain("@AGENTS.md");

      const installed = await runtime.application.scan(repository.root);
      if (installed.kind !== "ready") throw new Error("Expected installed scan");
      const noOp = await runtime.application.prepareInstall(installed, [fixtureRef], targets);
      expect(noOp.plan?.kind).toBe("ready");
      if (noOp.plan?.kind !== "ready") throw new Error("Expected ready no-op plan");
      expect(noOp.plan.operations).toEqual([]);

      await writeFile(
        resolve(repository.root, ".mcp.json"),
        '{"mcpServers":{"authoring-only-fixture":{"url":"https://tampered.invalid"}}}\n',
      );
      const drifted = await runtime.application.scan(repository.root);
      if (drifted.kind !== "ready") throw new Error("Expected drifted scan");
      expect(drifted.reconciliation.integrity).toBe("drifted");
      const repair = await runtime.application.prepareInstall(drifted, [fixtureRef], targets);
      expect(repair.plan?.kind).toBe("ready");
      if (repair.plan?.kind !== "ready") throw new Error("Expected ready repair plan");
      expect(repair.plan.operations.map(({ path }) => path)).toContain(".mcp.json");
      expect((await runtime.application.apply(repair.plan)).kind).toBe("applied");

      const repaired = await runtime.application.scan(repository.root);
      if (repaired.kind !== "ready") throw new Error("Expected repaired scan");
      const removal = await runtime.application.prepareRemove(repaired, { all: true });
      expect(removal.plan?.kind).toBe("ready");
      if (removal.plan?.kind !== "ready") throw new Error("Expected ready removal plan");
      expect((await runtime.application.apply(removal.plan)).kind).toBe("applied");
      const restored = await runtime.application.scan(repository.root);
      expect(restored.snapshot.fingerprint).toBe(baseline.snapshot.fingerprint);
    } finally {
      await Promise.all([runtime.dispose(), source.cleanup(), repository.cleanup()]);
    }
  }, 90_000);
});

async function injectFixtureMcp(catalogFile: string): Promise<void> {
  const document = parse(await readFile(catalogFile, "utf8")) as {
    catalog: { mcps: Record<string, unknown> };
  };
  document.catalog.mcps["authoring-only-fixture"] = {
    version: "0.1.0",
    description: "Connect a fixture remote MCP through harness-native OAuth.",
    details: "Configure a fictitious HTTPS MCP endpoint to prove that an already-supported connection and authentication variant is authoring-only across every harness.",
    trust: "third-party-network",
    connection: { type: "remote-http", url: fixtureUrl },
    tools: ["readFixture", "writeFixture"],
    network: "runtime-required",
    auth: { type: "oauth", activation: "harness-native" },
  };
  await writeFile(catalogFile, stringify(document));
}

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createDefaultApplication } from "../../src/application/composition-root.js";
import type { ExecutableProbe } from "../../src/domain/harness/model.js";
import type { CommandRequest, CommandRunner } from "../../src/domain/process/command-runner.js";
import { componentRef, harnessTargetId } from "../../src/domain/shared/types.js";
import { createTempRepository } from "../helpers/temp-repository.js";

const execute = promisify(execFile);
const codex = harnessTargetId("codex");
const allTargets = ["claude-code", "codex", "cursor", "opencode", "vscode"].map(
  harnessTargetId,
);
const atlassian = componentRef("mcp:atlassian-rovo");
const context7 = componentRef("mcp:context7");
const probe: ExecutableProbe = {
  async probe(command) {
    return { detected: true, path: `/test/bin/${command}`, version: "test", diagnostics: [] };
  },
};

describe("MCP session and materialization lifecycle", () => {
  it.each([
    ["failed", 1],
    ["cancelled", 130],
  ] as const)("keeps %s OAuth and uninstall independent from project state and preserves shared MCP files", async (_case, exitCode) => {
    const repository = await createTempRepository({});
    await execute("git", ["init", "--quiet", repository.root]);
    const runner = new FailingRunner(exitCode);
    const runtime = await createDefaultApplication({
      executableProbe: probe,
      mcpCommandRunner: runner,
    });
    try {
      const baseline = await runtime.application.scan(repository.root);
      if (baseline.kind !== "ready") throw new Error("Expected ready baseline");
      const install = await runtime.application.prepareInstall(
        baseline,
        [atlassian, context7],
        allTargets,
      );
      if (install.plan?.kind !== "ready") throw new Error("Expected ready MCP install");
      const installResult = await runtime.application.apply(install.plan);
      expect(installResult.kind).toBe("applied");
      if (installResult.receiptPath === null) throw new Error("Expected durable install receipt");
      const installedInstructions = await readFile(resolve(repository.root, "AGENTS.md"), "utf8");
      expect(installedInstructions.match(/id="mcps\.mapping"/gu)).toHaveLength(2);
      expect(installedInstructions).toContain("`atlassian-rovo`");
      expect(installedInstructions).toContain("`context7`");

      const managed = await runtime.application.scan(repository.root);
      if (managed.kind !== "ready") throw new Error("Expected ready managed scan");
      const before = await managedBytes(repository.root);
      const receiptBefore = await readFile(installResult.receiptPath, "utf8");
      const session = await runtime.application.mcpSession(
        repository.root,
        atlassian,
        [codex],
        "login",
      );
      expect(session.results).toEqual([
        expect.objectContaining({
          target: codex,
          state: "authentication-unknown",
          action: null,
        }),
      ]);
      expect(runner.requests).toHaveLength(1);
      expect(runner.requests[0]).toMatchObject({
        command: "codex",
        args: ["mcp", "login", "atlassian-rovo"],
        cwd: managed.snapshot.realRoot,
      });
      expect(await managedBytes(repository.root)).toEqual(before);
      expect(await readFile(installResult.receiptPath, "utf8")).toBe(receiptBefore);

      const afterFailure = await runtime.application.scan(repository.root);
      if (afterFailure.kind !== "ready") throw new Error("Expected ready scan after failed login");
      const removeAtlassian = await runtime.application.prepareRemove(afterFailure, {
        components: [atlassian],
      });
      if (removeAtlassian.plan?.kind !== "ready") throw new Error("Expected partial MCP removal");
      expect((await runtime.application.apply(removeAtlassian.plan)).kind).toBe("applied");
      expect(runner.requests).toHaveLength(1);

      for (const path of [
        ".codex/config.toml",
        ".mcp.json",
        ".cursor/mcp.json",
        ".vscode/mcp.json",
        "opencode.json",
      ]) {
        const configuration = await readFile(resolve(repository.root, path), "utf8");
        expect(configuration, path).toContain("context7");
        expect(configuration, path).not.toContain("atlassian-rovo");
      }
      const retainedInstructions = await readFile(resolve(repository.root, "AGENTS.md"), "utf8");
      expect(retainedInstructions.match(/id="mcps\.mapping"/gu)).toHaveLength(2);
      expect(retainedInstructions).toContain("`context7`");
      expect(retainedInstructions).not.toContain("`atlassian-rovo`");
      const retained = await runtime.application.scan(repository.root);
      if (retained.kind !== "ready") throw new Error("Expected retained Context7 scan");
      expect(retained.desired?.state.selections.map(({ ref }) => ref)).toEqual([context7]);
      expect(retained.reconciliation.integrity).toBe("clean");
    } finally {
      await Promise.all([runtime.dispose(), repository.cleanup()]);
    }
  }, 60_000);
});

class FailingRunner implements CommandRunner {
  readonly requests: CommandRequest[] = [];

  public constructor(private readonly exitCode: number) {}

  public async run(request: CommandRequest) {
    this.requests.push(request);
    return {
      exitCode: this.exitCode,
      stdout: "Authorization: [REDACTED]",
      stderr: "Synthetic native OAuth cancellation",
    };
  }
}

async function managedBytes(root: string): Promise<readonly string[]> {
  return await Promise.all([
    readFile(resolve(root, ".ai-harness/project.yaml"), "utf8"),
    readFile(resolve(root, ".ai-harness/lock.json"), "utf8"),
    readFile(resolve(root, ".codex/config.toml"), "utf8"),
  ]);
}

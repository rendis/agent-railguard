import { execFile } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createDefaultApplication } from "../../src/application/composition-root.js";
import type { ExecutableProbe } from "../../src/domain/harness/model.js";
import { componentRef, harnessTargetId } from "../../src/domain/shared/types.js";
import { createTempRepository } from "../helpers/temp-repository.js";

const execute = promisify(execFile);
const probe: ExecutableProbe = {
  async probe(command) {
    return { detected: true, path: `/test/bin/${command}`, version: "test", diagnostics: [] };
  },
};
const stopHook = componentRef("agent-hook:stop-check");
const targets = [harnessTargetId("claude-code"), harnessTargetId("codex"), harnessTargetId("cursor")];
const userSettings = `${JSON.stringify({ permissions: { allow: ["Bash(go test:*)"] } }, null, 2)}\n`;

describe("agent stop hook", () => {
  it("owns only hooks.Stop in the user's Claude settings and restores them on removal", async () => {
    const repository = await gitRepository({ ".claude/settings.json": userSettings });
    const runtime = await createDefaultApplication({ executableProbe: probe });
    try {
      const scan = await runtime.application.scan(repository.root);
      const install = await runtime.application.prepareInstall(scan, [stopHook], targets);
      if (install.plan?.kind !== "ready") throw new Error(`Expected ready plan: ${install.diagnostics[0]?.code}`);
      expect((await runtime.application.apply(install.plan)).kind).toBe("applied");

      const settings = JSON.parse(await readFile(join(repository.root, ".claude/settings.json"), "utf8"));
      expect(settings.permissions).toEqual({ allow: ["Bash(go test:*)"] });
      expect(settings.hooks.Stop[0].hooks[0].command).toBe('"$CLAUDE_PROJECT_DIR"/.railguard/agent-hooks/stop claude-code');
      expect(JSON.parse(await readFile(join(repository.root, ".codex/hooks.json"), "utf8")).hooks.Stop).toHaveLength(1);
      expect(JSON.parse(await readFile(join(repository.root, ".cursor/hooks.json"), "utf8")).hooks.stop[0].command)
        .toBe(".railguard/agent-hooks/stop cursor");
      const script = join(repository.root, ".railguard/agent-hooks/stop");
      expect(await readFile(script, "utf8")).toContain('exec railguard hook stop --harness "$1" --operation check');
      expect((await stat(script)).mode & 0o111).not.toBe(0);

      const managed = await runtime.application.scan(repository.root);
      if (managed.kind !== "ready") throw new Error("Expected ready scan");
      expect(managed.reconciliation.integrity).toBe("clean");

      await writeFile(
        join(repository.root, ".claude/settings.json"),
        `${JSON.stringify({ ...settings, hooks: { Stop: [] }, model: "opus" }, null, 2)}\n`,
      );
      const drifted = await runtime.application.scan(repository.root);
      if (drifted.kind !== "ready") throw new Error("Expected ready scan");
      expect(drifted.reconciliation.integrity).toBe("drifted");

      const repair = await runtime.application.prepareRepair(drifted);
      if (repair.plan?.kind !== "ready") throw new Error("Expected ready repair");
      expect((await runtime.application.apply(repair.plan)).kind).toBe("applied");
      const repaired = JSON.parse(await readFile(join(repository.root, ".claude/settings.json"), "utf8"));
      expect(repaired.model).toBe("opus");
      expect(repaired.hooks.Stop).toHaveLength(1);

      const managedAgain = await runtime.application.scan(repository.root);
      const removal = await runtime.application.prepareRemove(managedAgain, { all: true });
      if (removal.plan?.kind !== "ready") throw new Error("Expected ready removal");
      expect((await runtime.application.apply(removal.plan)).kind).toBe("applied");
      expect(JSON.parse(await readFile(join(repository.root, ".claude/settings.json"), "utf8"))).toEqual({
        permissions: { allow: ["Bash(go test:*)"] },
        model: "opus",
      });
    } finally {
      await Promise.all([runtime.dispose(), repository.cleanup()]);
    }
  });

  it("never adopts a Stop hook the repository already declares", async () => {
    const foreign = `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "./mine" }] }] } }, null, 2)}\n`;
    const repository = await gitRepository({ ".claude/settings.json": foreign });
    const runtime = await createDefaultApplication({ executableProbe: probe });
    try {
      const scan = await runtime.application.scan(repository.root);
      const install = await runtime.application.prepareInstall(scan, [stopHook], [harnessTargetId("claude-code")]);

      expect(install.plan?.kind).toBe("blocked");
      expect(install.diagnostics.map((diagnostic) => diagnostic.code)).toContain("planning.json-member.foreign");
      expect(await readFile(join(repository.root, ".claude/settings.json"), "utf8")).toBe(foreign);
    } finally {
      await Promise.all([runtime.dispose(), repository.cleanup()]);
    }
  });

  it("creates and later deletes Claude settings when the repository had none", async () => {
    const repository = await gitRepository({ "go.mod": "module example.com/hooks\n\ngo 1.24\n" });
    const runtime = await createDefaultApplication({ executableProbe: probe });
    try {
      const scan = await runtime.application.scan(repository.root);
      const install = await runtime.application.prepareInstall(scan, [stopHook], [harnessTargetId("claude-code")]);
      if (install.plan?.kind !== "ready") throw new Error("Expected ready plan");
      await runtime.application.apply(install.plan);
      expect(Object.keys(JSON.parse(await readFile(join(repository.root, ".claude/settings.json"), "utf8")))).toEqual(["hooks"]);

      const removal = await runtime.application.prepareRemove(await runtime.application.scan(repository.root), { all: true });
      if (removal.plan?.kind !== "ready") throw new Error("Expected ready removal");
      await runtime.application.apply(removal.plan);
      await expect(stat(join(repository.root, ".claude/settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await Promise.all([runtime.dispose(), repository.cleanup()]);
    }
  });
});

async function gitRepository(files: Readonly<Record<string, string>>) {
  const repository = await createTempRepository(files);
  await execute("git", ["init", "--quiet", repository.root]);
  return repository;
}

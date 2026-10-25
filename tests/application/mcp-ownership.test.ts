import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createDefaultApplication } from "../../src/application/composition-root.js";
import type { ExecutableProbe } from "../../src/domain/harness/model.js";
import { componentRef, harnessTargetId, relativePosixPath, sha256 } from "../../src/domain/shared/types.js";
import type { LockState, LockedArtifact } from "../../src/project-state/lock-state.js";
import { createTempRepository } from "../helpers/temp-repository.js";

const execute = promisify(execFile);
const context7 = componentRef("mcp:context7");
const atlassian = componentRef("mcp:atlassian-rovo");
const surfaces = [
  { target: "claude-code", path: ".mcp.json", group: "mcpServers" },
  { target: "cursor", path: ".cursor/mcp.json", group: "mcpServers" },
  { target: "vscode", path: ".vscode/mcp.json", group: "servers" },
  { target: "opencode", path: "opencode.json", group: "mcp" },
] as const;
const targets = surfaces.map(({ target }) => harnessTargetId(target));
const meshy = { command: "meshy-server", args: ["--foreign"], env: { MODE: "preserve" } };
const probe: ExecutableProbe = {
  async probe(command) {
    return { detected: true, path: `/test/bin/${command}`, version: "test", diagnostics: [] };
  },
};

describe("shared MCP ownership", () => {
  it("adds and removes its servers beside foreign servers in every shared JSON surface", async () => {
    const repository = await createTempRepository(Object.fromEntries(surfaces.map(({ path, group }) => [
      path, JSON.stringify({ [group]: { meshy } }),
    ])));
    await execute("git", ["init", "--quiet", repository.root]);
    const runtime = await createDefaultApplication({ executableProbe: probe });
    try {
      const install = await runtime.application.prepareInstall(
        await runtime.application.scan(repository.root), [context7, atlassian], targets,
      );
      if (install.plan?.kind !== "ready") throw new Error(`Expected install: ${install.diagnostics[0]?.code}`);
      expect((await runtime.application.apply(install.plan)).kind).toBe("applied");
      await expectServers(repository.root, ["atlassian-rovo", "context7", "meshy"]);

      const partial = await runtime.application.prepareRemove(await runtime.application.scan(repository.root), {
        components: [atlassian],
      });
      if (partial.plan?.kind !== "ready") throw new Error("Expected partial removal");
      expect((await runtime.application.apply(partial.plan)).kind).toBe("applied");
      await expectServers(repository.root, ["context7", "meshy"]);

      const removal = await runtime.application.prepareRemove(await runtime.application.scan(repository.root), { all: true });
      if (removal.plan?.kind !== "ready") throw new Error("Expected full removal");
      expect((await runtime.application.apply(removal.plan)).kind).toBe("applied");
      await expectServers(repository.root, ["meshy"]);
    } finally {
      await Promise.all([runtime.dispose(), repository.cleanup()]);
    }
  });

  it.each(["sync", "remove"] as const)("migrates legacy whole-file ownership before %s without claiming foreign servers", async (action) => {
    const repository = await createTempRepository({});
    await execute("git", ["init", "--quiet", repository.root]);
    const runtime = await createDefaultApplication({ executableProbe: probe });
    try {
      const install = await runtime.application.prepareInstall(
        await runtime.application.scan(repository.root), [context7, atlassian], targets,
      );
      if (install.plan?.kind !== "ready") throw new Error("Expected initial install");
      expect((await runtime.application.apply(install.plan)).kind).toBe("applied");
      await useLegacyFileOwnership(repository.root);
      for (const { path, group } of surfaces) {
        const configuration = JSON.parse(await readFile(join(repository.root, path), "utf8"));
        configuration[group].meshy = meshy;
        configuration[group].context7 = { command: "outdated" };
        if (path === "opencode.json") configuration.model = "example/preserved-model";
        await writeFile(join(repository.root, path), JSON.stringify(configuration));
      }
      const scan = await runtime.application.scan(repository.root);
      if (scan.kind !== "ready") throw new Error(`Invalid legacy fixture: ${JSON.stringify(scan.diagnostics)}`);
      const preparation = action === "sync"
        ? await runtime.application.prepareSync(scan)
        : await runtime.application.prepareRemove(scan, { all: true });
      if (preparation.plan?.kind !== "ready") throw new Error(`Expected migration: ${preparation.diagnostics[0]?.code}`);
      expect((await runtime.application.apply(preparation.plan)).kind).toBe("applied");
      await expectServers(repository.root, action === "sync" ? ["atlassian-rovo", "context7", "meshy"] : ["meshy"]);
      expect(JSON.parse(await readFile(join(repository.root, "opencode.json"), "utf8")).model).toBe("example/preserved-model");

      if (action === "sync") {
        const managed = await runtime.application.scan(repository.root);
        if (managed.kind !== "ready") throw new Error("Expected migrated state");
        expect(managed.reconciliation.integrity).toBe("clean");
        for (const { path, group } of surfaces) {
          const configuration = JSON.parse(await readFile(join(repository.root, path), "utf8"));
          expect(JSON.stringify(configuration[group].context7), path).toContain("@upstash/context7-mcp@4.0.0");
          const ownership = managed.lock?.state.artifacts.filter((artifact) => artifact.path === path);
          expect(ownership, path).toHaveLength(2);
          expect(ownership?.every((artifact) => artifact.kind === "json-member" && artifact.pointer.length === 2)).toBe(true);
        }
        const repeated = await runtime.application.prepareSync(managed);
        if (repeated.plan?.kind !== "ready") throw new Error("Expected repeated sync");
        expect(repeated.plan.operations).toEqual([]);
        const removal = await runtime.application.prepareRemove(managed, { all: true });
        if (removal.plan?.kind !== "ready") throw new Error("Expected removal after migration");
        expect((await runtime.application.apply(removal.plan)).kind).toBe("applied");
        await expectServers(repository.root, ["meshy"]);
      }
    } finally {
      await Promise.all([runtime.dispose(), repository.cleanup()]);
    }
  });

  it("blocks a same-name foreign server instead of adopting or changing it", async () => {
    const foreign = Object.fromEntries(surfaces.map(({ path, group }) => [path, JSON.stringify({ [group]: { context7: meshy } })]));
    const repository = await createTempRepository(foreign);
    await execute("git", ["init", "--quiet", repository.root]);
    const runtime = await createDefaultApplication({ executableProbe: probe });
    try {
      const install = await runtime.application.prepareInstall(
        await runtime.application.scan(repository.root), [context7], targets,
      );
      expect(install.plan?.kind).toBe("blocked");
      expect(install.diagnostics.map(({ code }) => code)).toContain("planning.json-member.foreign");
      for (const { path } of surfaces) expect(await readFile(join(repository.root, path), "utf8")).toBe(foreign[path]);
    } finally {
      await Promise.all([runtime.dispose(), repository.cleanup()]);
    }
  });

  it("rejects an unrelated whole-file ownership identity at a shared MCP path", async () => {
    const repository = await createTempRepository({});
    await execute("git", ["init", "--quiet", repository.root]);
    const runtime = await createDefaultApplication({ executableProbe: probe });
    try {
      const install = await runtime.application.prepareInstall(
        await runtime.application.scan(repository.root), [context7, atlassian], targets,
      );
      if (install.plan?.kind !== "ready") throw new Error("Expected initial install");
      await runtime.application.apply(install.plan);
      await useLegacyFileOwnership(repository.root);
      const lockPath = join(repository.root, ".railguard/lock.json");
      const lock: LockState = JSON.parse(await readFile(lockPath, "utf8"));
      await writeFile(lockPath, `${JSON.stringify({
        ...lock,
        artifacts: lock.artifacts.map((artifact) => artifact.path === ".mcp.json"
          ? { ...artifact, ownership_id: "unrelated.file.owner" } : artifact),
      }, null, 2)}\n`);
      const before = await readFile(join(repository.root, ".mcp.json"), "utf8");
      const sync = await runtime.application.prepareSync(await runtime.application.scan(repository.root));
      expect(sync.plan?.kind).toBe("blocked");
      expect(sync.diagnostics.map(({ code }) => code)).toContain("planning.path.ownership-conflict");
      expect(await readFile(join(repository.root, ".mcp.json"), "utf8")).toBe(before);
    } finally {
      await Promise.all([runtime.dispose(), repository.cleanup()]);
    }
  });
});

async function expectServers(root: string, names: readonly string[]) {
  for (const { path, group } of surfaces) {
    const configuration = JSON.parse(await readFile(join(root, path), "utf8"));
    expect(Object.keys(configuration[group]).sort(), path).toEqual(names);
    expect(configuration[group].meshy, path).toEqual(meshy);
  }
}

/** Recreates the persisted MCP file ownership emitted through Railguard 0.1.22. */
async function useLegacyFileOwnership(root: string) {
  const path = join(root, ".railguard/lock.json");
  const lock: LockState = JSON.parse(await readFile(path, "utf8"));
  const legacy: LockedArtifact[] = [];
  for (const { target, path } of surfaces) {
    legacy.push({
      kind: "file",
      ownership_id: `${target}.mcp.file.${sha256(path).slice(7, 19)}`,
      target: harnessTargetId(target),
      adapter: harnessTargetId(target),
      path: relativePosixPath(path),
      sources: [atlassian, context7],
      content_digest: sha256(await readFile(join(root, path), "utf8")),
      portable_mode: "regular",
    });
  }
  await writeFile(path, `${JSON.stringify({
    ...lock,
    artifacts: [...lock.artifacts.filter((artifact) => !surfaces.some(({ path }) => path === artifact.path)), ...legacy],
  }, null, 2)}\n`);
}

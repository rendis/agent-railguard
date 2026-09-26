import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { NodeRepositoryInventory } from "../../src/adapters/platform/repository-inventory/node-repository-inventory.js";
import { QualityProjector } from "../../src/adapters/project/quality/quality-projector.js";
import { FilesystemCatalog } from "../../src/catalog/filesystem-catalog.js";
import { DefaultResolver } from "../../src/domain/resolution/resolver.js";
import { capabilityId, componentRef, harnessTargetId, languageId } from "../../src/domain/shared/types.js";

const execute = promisify(execFile);
const asset = `railguard-${process.platform}-${process.arch}`;
const cleanups: (() => Promise<void>)[] = [];
let files: ReadonlyMap<string, string>;

/** Stands in for the engine: reports its version and echoes what it was asked to run. */
function fakeEngine(version: string): string {
  return `#!/bin/sh\nif [ "$1" = --version ]; then echo ${version}; exit 0; fi\necho "ran $* with $(cat)"\n`;
}

beforeAll(async () => {
  const catalogResult = await new FilesystemCatalog({
    catalogFile: resolve("railguard.yaml"),
    supportedLanguages: [languageId("go")],
  }).load();
  if (catalogResult.kind !== "ready") throw new Error("Expected ready catalog");
  const resolution = new DefaultResolver().resolve({
    catalog: catalogResult.catalog,
    directSelections: [componentRef("git-gate:pre-commit-check"), componentRef("agent-hook:stop-check")],
    projectUnits: [],
    targets: [{
      target: harnessTargetId("codex"),
      capabilities: [capabilityId("project.instructions"), capabilityId("project.agent-hooks")],
    }],
  });
  if (resolution.kind !== "ready") throw new Error("Expected ready resolution");
  const empty = await mkdtemp(join(tmpdir(), "railguard-launcher-scan-"));
  cleanups.push(() => rm(empty, { recursive: true, force: true }));
  const projection = await new QualityProjector(
    { async probe() { return { detected: true, path: "/test/go", version: "test", diagnostics: [] }; } },
    { async executableDefaultHooks() { return []; } },
    { version: "1.2.3", repository: "example/railguard" },
    [],
  ).project(resolution, catalogResult.catalog, await new NodeRepositoryInventory().snapshot(empty), { projectUnits: [] } as never, [], new Map());
  files = new Map(projection.units.flatMap((unit) =>
    unit.kind === "artifact" && unit.intent.kind === "file"
      ? [[unit.intent.path, Buffer.from(unit.intent.bytes.copy()).toString("utf8")] as const]
      : []));
});

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("repository launcher", () => {
  it("runs the cached engine of the pinned version without looking anywhere else", async () => {
    const sandbox = await launcherSandbox();
    await executable(join(sandbox.cache, "railguard", "1.2.3", "railguard"), fakeEngine("1.2.3"));
    await executable(join(sandbox.bin, "railguard"), fakeEngine("9.9.9"));

    const result = await sandbox.run(["check", "--changed"], "stdin");

    expect(result).toMatchObject({ code: 0, stdout: "ran check --changed with stdin\n" });
  });

  it("uses a railguard on PATH only when it is exactly the pinned version", async () => {
    const sandbox = await launcherSandbox();
    await executable(join(sandbox.bin, "railguard"), fakeEngine("1.2.3"));
    expect(await sandbox.run(["status"])).toMatchObject({ code: 0, stdout: "ran status with \n" });

    await executable(join(sandbox.bin, "railguard"), fakeEngine("1.2.4"));
    const other = await sandbox.run(["status"], "", { RAILGUARD_DOWNLOAD_URL: `file://${sandbox.root}/missing` });
    expect(other.code).toBe(127);
    expect(other.stderr).toContain("railguard 1.2.3 is not available");
  });

  it("downloads the release once, verifies it and runs it from the cache", async () => {
    const sandbox = await launcherSandbox();
    const release = join(sandbox.root, "release");
    await mkdir(release);
    const engine = fakeEngine("1.2.3");
    await writeFile(join(release, asset), engine);
    await writeFile(join(release, "SHA256SUMS"), `${createHash("sha256").update(engine).digest("hex")}  ${asset}\n`);
    const environment = { RAILGUARD_DOWNLOAD_URL: `file://${release}` };

    const first = await sandbox.run(["verify"], "", environment);
    await rm(release, { recursive: true });
    const second = await sandbox.run(["verify"], "", environment);

    expect(first).toMatchObject({ code: 0, stdout: "ran verify with \n" });
    expect(first.stderr).toContain(`downloading 1.2.3 ${asset}`);
    expect(second).toMatchObject({ code: 0, stdout: "ran verify with \n", stderr: "" });
  });

  it("refuses a download whose checksum does not match and caches nothing", async () => {
    const sandbox = await launcherSandbox();
    const release = join(sandbox.root, "release");
    await mkdir(release);
    await writeFile(join(release, asset), fakeEngine("1.2.3"));
    await writeFile(join(release, "SHA256SUMS"), `${"0".repeat(64)}  ${asset}\n`);

    const result = await sandbox.run(["check"], "", { RAILGUARD_DOWNLOAD_URL: `file://${release}` });

    expect(result.code).toBe(127);
    expect(result.stderr).toContain(`checksum mismatch for ${asset}`);
    expect(await readdir(join(sandbox.cache, "railguard", "1.2.3")).catch(() => [])).toEqual([]);
  });

  it("lets hooks continue with a warning when the engine is unavailable", async () => {
    const sandbox = await launcherSandbox();
    const environment = { RAILGUARD_DOWNLOAD_URL: `file://${sandbox.root}/missing` };

    const commit = await sandbox.hook(".railguard/hooks/pre-commit", [], environment);
    const stop = await sandbox.hook(".railguard/agent-hooks/stop", ["codex"], environment);

    expect(commit).toMatchObject({ code: 0, stdout: "" });
    expect(commit.stderr).toContain("Railguard is unavailable; skipping the pre-commit check.");
    expect(stop).toMatchObject({ code: 0, stdout: "" });
    expect(stop.stderr).toContain("Railguard is unavailable; this change was not verified.");
  });

  it("passes the engine's exit status through a git hook", async () => {
    const sandbox = await launcherSandbox();
    await executable(join(sandbox.cache, "railguard", "1.2.3", "railguard"), "#!/bin/sh\nexit 8\n");

    expect((await sandbox.hook(".railguard/hooks/pre-commit", [])).code).toBe(8);
  });
});

/** A Git repository with the projected files, an isolated cache and a PATH without railguard. */
async function launcherSandbox() {
  const root = await mkdtemp(join(tmpdir(), "railguard-launcher-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "repository");
  const cache = join(root, "cache");
  const bin = join(root, "bin");
  const tools = join(root, "tools");
  await mkdir(bin, { recursive: true });
  await mkdir(tools, { recursive: true });
  // Only the tools the launcher and hooks use, so a gh or railguard on the host never leaks in.
  for (const tool of ["awk", "cat", "chmod", "curl", "git", "mkdir", "mktemp", "mv", "rm", "sha256sum", "shasum", "sysctl", "tr", "uname"]) {
    const found = await execute("sh", ["-c", `command -v ${tool} || true`]).then(({ stdout }) => stdout.trim());
    if (found.startsWith("/")) await symlink(found, join(tools, tool));
  }
  for (const [path, text] of files) await executable(join(repository, path), text);
  await execute("git", ["init", "--quiet", repository]);
  const environment = (extra: Readonly<Record<string, string>>) => ({
    HOME: root,
    XDG_CACHE_HOME: cache,
    PATH: `${bin}:${tools}`,
    ...extra,
  });
  const run = (file: string, args: readonly string[], stdin: string, extra: Readonly<Record<string, string>>) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolveRun) => {
      const child = execFile(file, [...args], { cwd: repository, env: environment(extra) }, (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolveRun({ code, stdout, stderr });
      });
      child.stdin?.end(stdin);
    });
  return {
    root,
    cache,
    bin,
    run: (args: readonly string[], stdin = "", extra: Readonly<Record<string, string>> = {}) =>
      run(join(repository, ".railguard/bin/railguard"), args, stdin, extra),
    hook: (path: string, args: readonly string[], extra: Readonly<Record<string, string>> = {}) =>
      run(join(repository, path), args, "", extra),
  };
}

async function executable(path: string, text: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
  await chmod(path, 0o755);
}

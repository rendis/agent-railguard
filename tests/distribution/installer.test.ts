import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const cleanups: string[] = [];
let releaseRoot: string;

beforeAll(async () => {
  releaseRoot = await mkdtemp(join(tmpdir(), "ai-harness-install-release-"));
  cleanups.push(releaseRoot);
  await execute(process.execPath, ["scripts/release/build-release.mjs", "--out", releaseRoot], {
    cwd: resolve("."),
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}, 70_000);

afterEach(async () => {
  const disposable = cleanups.splice(1);
  await Promise.all(disposable.map((path) => rm(path, { recursive: true, force: true })));
});

afterAll(async () => {
  const disposable = cleanups.splice(0);
  await Promise.all(disposable.map((path) => rm(path, { recursive: true, force: true })));
});

describe.sequential("corporate bootstrap installer", () => {
  it("installs from the authoring checkout and uses it from another repository without overrides", async () => {
    const environment = await isolatedEnvironment();
    const consumer = join(environment.root, "consumer");
    await mkdir(consumer);
    await execute("git", ["init", "--quiet", consumer], { env: environment.env });
    await writeFile(join(consumer, "go.mod"), "module example.com/local-install\n\ngo 1.24\n", "utf8");

    const result = await runLocalInstaller(environment).catch((error: unknown) => {
      const failure = error as { stdout?: string; stderr?: string };
      throw new Error(`Local installer failed\nstdout:\n${failure.stdout ?? ""}\nstderr:\n${failure.stderr ?? ""}`);
    });

    expect(result.stdout).toContain("AI Harness 0.1.0 installed successfully.");
    expect(result.stdout).toContain("Local project content source configured");
    const executable = join(environment.pnpmHome, "bin", "ai-harness");
    const invocationEnvironment = {
      ...environment.env,
      AI_HARNESS_ALLOW_FILE_CONTENT: "0",
    };
    expect((await execute(executable, ["--version"], { env: invocationEnvironment })).stdout.trim()).toBe("0.1.0");
    const scan = JSON.parse((await execute(executable, [
      "scan",
      "--cwd",
      consumer,
      "--format",
      "json",
    ], { env: invocationEnvironment })).stdout);
    expect(scan).toMatchObject({ verdict: "READY", repository: { languages: ["go"] } });
    const catalog = JSON.parse((await execute(executable, [
      "catalog",
      "show",
      "mcp:context7",
      "--cwd",
      consumer,
      "--format",
      "json",
    ], { env: invocationEnvironment })).stdout);
    expect(catalog).toMatchObject({ verdict: "READY" });
    expect(JSON.parse(await readFile(
      join(environment.env.XDG_CONFIG_HOME!, "ai-harness", "engine.json"),
      "utf8",
    ))).toEqual({
      schema: "ai-harness/engine-config/v1",
      content_source_path: await realpath(resolve(".")),
    });
  }, 90_000);

  it("installs the verified tarball globally without a registry", async () => {
    const environment = await isolatedEnvironment();
    const result = await runInstaller(environment).catch((error: unknown) => {
      const failure = error as { stdout?: string; stderr?: string };
      throw new Error(`Installer failed\nstdout:\n${failure.stdout ?? ""}\nstderr:\n${failure.stderr ?? ""}`);
    });

    expect(result.stdout).toContain("AI Harness 0.1.0 installed successfully.");
    expect(result.stdout).toContain("Project content channel configured");
    const executable = join(environment.pnpmHome, "bin", "ai-harness");
    expect((await execute(executable, ["--version"], { env: environment.env })).stdout.trim()).toBe("0.1.0");
    expect((await execute(executable, ["--help"], { env: environment.env })).stdout).toContain("Configure an AI-assisted");
    const catalog = await execute(executable, ["catalog", "show", "mcp:context7", "--format", "json"], {
      env: environment.env,
    }).catch(async (error: unknown) => {
      const failure = error as { stdout?: string; stderr?: string };
      const configPath = join(environment.env.XDG_CONFIG_HOME!, "ai-harness", "engine.json");
      const config = await readFile(configPath, "utf8").catch((readError: unknown) => `unreadable: ${String(readError)}`);
      throw new Error(`Installed content smoke failed\n${failure.stdout ?? ""}\n${failure.stderr ?? ""}\nengine_config=${config}`);
    });
    expect(JSON.parse(catalog.stdout)).toMatchObject({ verdict: "READY" });
    const engineConfigPath = join(environment.env.XDG_CONFIG_HOME!, "ai-harness", "engine.json");
    expect(JSON.parse(await readFile(engineConfigPath, "utf8"))).toEqual({
      schema: "ai-harness/engine-config/v1",
      content_manifest_url: new URL(`file://${join(releaseRoot, "content-manifest.json")}`).href,
    });
    expect((await stat(engineConfigPath)).mode & 0o777).toBe(0o600);
    const globalRoot = (await execute("pnpm", ["root", "--global"], { env: environment.env })).stdout.trim();
    const packageLink = (await execute("find", [globalRoot, "-path", "*/node_modules/@example/ai-harness", "-print"])).stdout.trim().split("\n")[0]!;
    const packageRoot = await realpath(packageLink);
    await expect(stat(join(packageRoot, "ai-harness.yaml"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(packageRoot, "skills"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 45_000);

  it("rejects an altered digest before global installation", async () => {
    const environment = await isolatedEnvironment();
    const fixture = join(environment.root, "altered-release");
    await mkdir(fixture, { recursive: true });
    const manifest = JSON.parse(await readFile(join(releaseRoot, "release-manifest.json"), "utf8"));
    manifest.release.artifact.sha256 = `sha256:${"0".repeat(64)}`;
    await writeFile(join(fixture, "release-manifest.json"), `${JSON.stringify(manifest)}\n`, "utf8");
    await copyFile(join(releaseRoot, manifest.release.artifact.path), join(fixture, manifest.release.artifact.path));

    const failure = await runInstaller(environment, join(fixture, "release-manifest.json"))
      .then(() => null, (error: unknown) => error as { stdout?: string; stderr?: string });
    expect(`${failure?.stdout ?? ""}\n${failure?.stderr ?? ""}`).toContain("Artifact digest mismatch");
    await expect(execute(join(environment.pnpmHome, "bin", "ai-harness"), ["--version"]))
      .rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("rejects an unsupported Node line before downloading a release", async () => {
    const environment = await isolatedEnvironment();
    const fakeBin = join(environment.root, "fake-bin");
    await mkdir(fakeBin);
    const fakeNode = join(fakeBin, "node");
    await writeFile(fakeNode, "#!/bin/sh\nprintf 'v22.23.0\\n'\n", { mode: 0o755 });
    await chmod(fakeNode, 0o755);

    await expect(runInstaller({
      ...environment,
      env: { ...environment.env, PATH: `${fakeBin}${delimiter}${environment.env.PATH}` },
    })).rejects.toMatchObject({
      stderr: expect.stringContaining("Install Node.js >=24.19.0 <25.0.0"),
    });
  });

  it("reports a missing pnpm prerequisite before downloading", async () => {
    const environment = await isolatedEnvironment();

    await expect(runInstaller({
      ...environment,
      env: {
        ...environment.env,
        AI_HARNESS_PNPM_COMMAND: "ai-harness-missing-pnpm",
      },
    })).rejects.toMatchObject({
      stderr: expect.stringContaining("ai-harness-missing-pnpm is required"),
    });
  });

  it("rejects a pnpm major outside the certified range", async () => {
    const environment = await isolatedEnvironment();
    const fakePnpm = join(environment.root, "pnpm-12");
    await writeFile(fakePnpm, "#!/bin/sh\nprintf '12.0.0\\n'\n", { mode: 0o755 });
    await chmod(fakePnpm, 0o755);

    await expect(runInstaller({
      ...environment,
      env: { ...environment.env, AI_HARNESS_PNPM_COMMAND: fakePnpm },
    })).rejects.toMatchObject({
      stderr: expect.stringContaining("pnpm 12.0.0 is unsupported"),
    });
  });

  it("rejects an unsafe engine configuration target before downloading or installing", async () => {
    const environment = await isolatedEnvironment();
    const configDirectory = join(environment.env.XDG_CONFIG_HOME!, "ai-harness");
    const foreign = join(environment.root, "foreign-engine.json");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(foreign, "foreign\n", "utf8");
    await symlink(foreign, join(configDirectory, "engine.json"));

    await expect(runInstaller(environment)).rejects.toMatchObject({
      stderr: expect.stringContaining("Engine configuration target must not be a symlink"),
    });
    expect(await readFile(foreign, "utf8")).toBe("foreign\n");
    await expect(execute(join(environment.pnpmHome, "bin", "ai-harness"), ["--version"]))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});

interface IsolatedEnvironment {
  readonly root: string;
  readonly pnpmHome: string;
  readonly env: NodeJS.ProcessEnv;
}

async function isolatedEnvironment(): Promise<IsolatedEnvironment> {
  const root = await mkdtemp(join(tmpdir(), "ai-harness-install-test-"));
  cleanups.push(root);
  const pnpmHome = join(root, "pnpm-home");
  const home = join(root, "home");
  const store = join(root, "store");
  await Promise.all([mkdir(join(pnpmHome, "bin"), { recursive: true }), mkdir(home), mkdir(store)]);
  return {
    root,
    pnpmHome,
    env: {
      ...process.env,
      HOME: home,
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      PNPM_HOME: pnpmHome,
      COREPACK_HOME:
        process.env.COREPACK_HOME ?? join(process.env.HOME ?? home, ".cache", "node", "corepack"),
      pnpm_config_store_dir: store,
      PATH: `${join(pnpmHome, "bin")}${delimiter}${process.env.PATH ?? ""}`,
      AI_HARNESS_ALLOW_FILE_RELEASES: "1",
      AI_HARNESS_ALLOW_FILE_CONTENT: "1",
    },
  };
}

async function runInstaller(environment: IsolatedEnvironment, manifest = join(releaseRoot, "release-manifest.json")) {
  return await execute("bash", [resolve("install.sh")], {
    cwd: environment.root,
    env: {
      ...environment.env,
      AI_HARNESS_RELEASE_MANIFEST_URL: new URL(`file://${manifest}`).href,
    },
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function runLocalInstaller(environment: IsolatedEnvironment) {
  return await execute("bash", [resolve("install.sh"), "--local"], {
    cwd: environment.root,
    env: environment.env,
    timeout: 80_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

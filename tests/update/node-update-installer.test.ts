import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256 } from "../../src/domain/shared/types.js";
import type { ResolvedRelease } from "../../src/update/release-client.js";
import {
  NodeUpdateInstaller,
  type UpdateCommand,
  type UpdateCommandRunner,
} from "../../src/update/node-update-installer.js";

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("transactional pnpm update installer", () => {
  it("stages, smokes and applies an offline dependency-free candidate", async () => {
    const fixture = await installedFixture();
    const runner = fakeRunner(fixture);
    const installer = new NodeUpdateInstaller({ runner, temporaryRoot: fixture.temporaryRoot });

    const result = await installer.install(
      { currentVersion: "0.1.0", release: release("0.2.0") },
      new Uint8Array([1, 2, 3]),
    );

    expect(result).toEqual({
      status: "applied",
      previousVersion: "0.1.0",
      installedVersion: "0.2.0",
    });
    const installs = runner.commands.filter((entry) => entry.args[0] === "add");
    expect(installs).toHaveLength(2);
    expect(installs.every((entry) => entry.args.includes("--offline"))).toBe(true);
    expect(installs.every((entry) => entry.args.includes("--ignore-scripts"))).toBe(true);
    expect(runner.commands.some((entry) => entry.args[0] === "pack")).toBe(true);
  });

  it("restores and verifies the previous package if the global candidate smoke fails", async () => {
    const fixture = await installedFixture();
    const runner = fakeRunner(fixture, { failCandidateGlobalSmoke: true });
    const installer = new NodeUpdateInstaller({ runner, temporaryRoot: fixture.temporaryRoot });

    await expect(installer.install(
      { currentVersion: "0.1.0", release: release("0.2.0") },
      new Uint8Array([1, 2, 3]),
    )).resolves.toEqual({
      status: "rolled-back",
      previousVersion: "0.1.0",
      installedVersion: null,
    });

    const installs = runner.commands.filter((entry) => entry.args[0] === "add");
    expect(installs).toHaveLength(3);
    expect(installs.at(-1)?.args.at(-1)).toContain("previous.tgz");
  });
});

interface Fixture {
  readonly root: string;
  readonly globalRoot: string;
  readonly globalBin: string;
  readonly temporaryRoot: string;
}

async function installedFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "ai-harness-update-test-"));
  cleanups.push(root);
  const globalRoot = join(root, "global", "node_modules");
  const globalBin = join(root, "global", "bin");
  const temporaryRoot = join(root, "temporary");
  const installed = join(globalRoot, "@example", "ai-harness");
  await mkdir(installed, { recursive: true });
  await mkdir(globalBin, { recursive: true });
  await mkdir(temporaryRoot, { recursive: true });
  await writeFile(join(installed, "package.json"), JSON.stringify({
    name: "@example/ai-harness",
    version: "0.1.0",
  }), "utf8");
  return { root, globalRoot, globalBin, temporaryRoot };
}

function fakeRunner(
  fixture: Fixture,
  options: { readonly failCandidateGlobalSmoke?: boolean } = {},
): UpdateCommandRunner & { readonly commands: UpdateCommand[] } {
  const commands: UpdateCommand[] = [];
  let globalSmokeAttempts = 0;
  return {
    commands,
    async run(command) {
      commands.push(command);
      if (command.executable === "pnpm" && command.args.join(" ") === "--version") {
        return { stdout: "11.21.0\n", stderr: "" };
      }
      if (command.args.join(" ") === "list --global --depth 0 --json") {
        return {
          stdout: `${JSON.stringify([{
            path: fixture.globalRoot,
            dependencies: {
              "@example/ai-harness": {
                version: "0.1.0",
                path: join(fixture.globalRoot, "@example", "ai-harness"),
              },
            },
          }])}\n`,
          stderr: "",
        };
      }
      if (command.args.join(" ") === "bin --global") return { stdout: `${fixture.globalBin}\n`, stderr: "" };
      if (command.args[0] === "pack") {
        const out = command.args[command.args.indexOf("--out") + 1];
        if (out === undefined) throw new Error("Missing pack output");
        await writeFile(out, "backup", { mode: 0o600 });
        return { stdout: `${out}\n`, stderr: "" };
      }
      if (command.args[0] === "add") return { stdout: "installed\n", stderr: "" };
      if (command.executable === join(fixture.globalBin, "ai-harness")) {
        globalSmokeAttempts += 1;
        if (options.failCandidateGlobalSmoke === true && globalSmokeAttempts === 1) {
          throw new Error("candidate smoke failed");
        }
        return { stdout: globalSmokeAttempts === 1 ? "0.2.0\n" : "0.1.0\n", stderr: "" };
      }
      if (command.executable.endsWith("/bin/ai-harness")) {
        return { stdout: "0.2.0\n", stderr: "" };
      }
      throw new Error(`Unexpected command: ${command.executable} ${command.args.join(" ")}`);
    },
  };
}

function release(version: string): ResolvedRelease {
  return {
    manifestUrl: new URL("https://releases.example/stable/release-manifest.json"),
    artifactUrl: new URL("https://releases.example/stable/ai-harness.tgz"),
    contentManifestUrl: new URL("https://releases.example/stable/content-manifest.json"),
    manifest: {
      schema: "ai-harness/release-manifest/v1",
      channel: "stable",
      source: { commit: "abc", tree: "def", input_digest: `sha256:${"1".repeat(64)}` },
      release: {
        name: "@example/ai-harness",
        version,
        runtime: { node: ">=24.19.0 <25.0.0", pnpm: ">=11.21.0 <12.0.0" },
        artifact: { path: "candidate.tgz", sha256: sha256(new Uint8Array([1, 2, 3])), size: 3 },
        sbom: { path: "sbom.json", sha256: `sha256:${"3".repeat(64)}`, size: 3 },
        notices: { path: "notices.md", sha256: `sha256:${"4".repeat(64)}`, size: 3 },
        notes: [],
      },
      authentication: { kind: "external-https-channel", manifest_authentication: "test" },
      content: { manifest: { path: "content-manifest.json" } },
    },
  };
}

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ReleaseClient } from "../../src/update/release-client.js";
import { ContentManifestClient } from "../../src/catalog/source/content-manifest-client.js";

const execute = promisify(execFile);
const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("reproducible corporate release", () => {
  it("builds byte-identical dependency-free tarballs and a verified sidecar", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-harness-release-test-"));
    cleanups.push(root);
    const first = join(root, "first");
    const second = join(root, "second");

    const firstBuild = await buildRelease(first);
    const secondBuild = await buildRelease(second);

    const firstManifestPath = join(first, "release-manifest.json");
    const firstManifest = JSON.parse(await readFile(firstManifestPath, "utf8"));
    const secondManifest = JSON.parse(await readFile(join(second, "release-manifest.json"), "utf8"));
    expect(firstManifest).toEqual(secondManifest);
    const artifactName = firstManifest.release.artifact.path as string;
    const firstTarball = await readFile(join(first, artifactName));
    const secondTarball = await readFile(join(second, artifactName));
    expect(digest(firstTarball)).toBe(digest(secondTarball));
    expect(firstTarball.equals(secondTarball)).toBe(true);

    const client = new ReleaseClient({
      manifestUrl: new URL(`file://${firstManifestPath}`),
      allowFileUrl: true,
    });
    const release = await client.fetchManifest();
    await expect(client.fetchArtifact(release)).resolves.toEqual(new Uint8Array(firstTarball));

    expect(firstManifest.content).toEqual({ manifest: { path: "content-manifest.json" } });
    const contentManifestPath = join(first, firstManifest.content.manifest.path);
    const contentClient = new ContentManifestClient({
      manifestUrl: new URL(`file://${contentManifestPath}`),
      allowFileUrl: true,
    });
    const content = await contentClient.fetchManifest();
    expect(content.manifest.revision).toBe("0.1.0");
    expect(content.files[0]?.path).toBe("ai-harness.yaml");
    expect(content.files.some((entry) => entry.path === "skills/tdd/SKILL.md")).toBe(true);
    for (const file of content.files) {
      await expect(contentClient.fetchFile(file)).resolves.toEqual(
        new Uint8Array(await readFile(join(first, "content", ...file.path.split("/")))),
      );
    }
    expect(await readFile(join(first, "content-manifest.json"), "utf8")).toBe(
      await readFile(join(second, "content-manifest.json"), "utf8"),
    );
    expect(firstBuild.content).toEqual(secondBuild.content);
    expect(firstBuild.content).toEqual({
      revision: "0.1.0",
      manifest: {
        path: "content-manifest.json",
        sha256: digestWithPrefix(await readFile(join(first, "content-manifest.json"))),
        size: (await readFile(join(first, "content-manifest.json"))).byteLength,
      },
    });

    const packedManifest = JSON.parse((await execute("tar", [
      "-xOf",
      join(first, artifactName),
      "package/package.json",
    ])).stdout);
    expect(packedManifest).toMatchObject({
      name: "@example/ai-harness",
      version: "0.1.0",
      type: "module",
      bin: { "ai-harness": "dist/cli.js" },
      engines: { node: ">=24.19.0 <25.0.0" },
    });
    for (const forbidden of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
      "scripts",
    ]) {
      expect(packedManifest).not.toHaveProperty(forbidden);
    }
    const entries = (await execute("tar", ["-tzf", join(first, artifactName)])).stdout;
    expect(entries).toContain("package/dist/cli.js");
    expect(entries).toContain("package/build-info.json");
    expect(entries).toContain("package/sbom.cdx.json");
    expect(entries).not.toContain("package/ai-harness.yaml");
    expect(entries).not.toContain("package/skills/");
    expect(entries).not.toContain("package/schemas/");
    expect(entries).not.toContain("prototype-interaction");
    expect(entries).not.toContain("node_modules");
  }, 90_000);
});

interface ReleaseBuildResult {
  readonly artifact: string;
  readonly sha256: string;
  readonly content: {
    readonly revision: string;
    readonly manifest: {
      readonly path: string;
      readonly sha256: string;
      readonly size: number;
    };
  };
}

async function buildRelease(output: string): Promise<ReleaseBuildResult> {
  const execution = await execute(process.execPath, ["scripts/release/build-release.mjs", "--out", output], {
    cwd: resolve("."),
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(execution.stdout) as ReleaseBuildResult;
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function digestWithPrefix(value: Uint8Array): string {
  return `sha256:${digest(value)}`;
}

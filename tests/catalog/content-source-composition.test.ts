import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultContentSource } from "../../src/catalog/source/content-source-composition.js";
import { sha256 } from "../../src/domain/shared/types.js";

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("default content source selection", () => {
  it("gives an explicit local source priority over every configured remote source", async () => {
    const root = await localSource("0.1.0");
    const source = createDefaultContentSource({
      sourcePath: root,
      developmentCatalogFile: "/missing/development/ai-harness.yaml",
      environment: {
        AI_HARNESS_CONTENT_MANIFEST_URL: "not-a-valid-url",
        AI_HARNESS_ENGINE_CONFIG: "/missing/engine.json",
      },
    });

    await expect(source.resolve()).resolves.toMatchObject({
      kind: "local",
      root: await realpath(root),
    });
  });

  it("uses an explicit remote environment override before development authoring", async () => {
    const fixture = await remoteFixture("0.2.0");
    const development = await localSource("0.1.0");
    const cache = await temporaryRoot("ai-harness-composition-cache-");
    const source = createDefaultContentSource({
      developmentCatalogFile: join(development, "ai-harness.yaml"),
      cacheRoot: cache,
      environment: {
        AI_HARNESS_CONTENT_MANIFEST_URL: fixture.manifestUrl,
        AI_HARNESS_ALLOW_FILE_CONTENT: "1",
      },
    });

    const resolved = await source.resolve();
    expect(resolved).toMatchObject({ kind: "remote", revision: "0.2.0" });
    expect(await readFile(resolved.catalogFile, "utf8")).toContain("version: 0.2.0");
  });

  it("uses local authoring during development without reading machine configuration", async () => {
    const development = await localSource("0.3.0");
    const source = createDefaultContentSource({
      developmentCatalogFile: join(development, "ai-harness.yaml"),
      environment: { AI_HARNESS_ENGINE_CONFIG: "/missing/engine.json" },
    });

    await expect(source.resolve()).resolves.toMatchObject({ kind: "local" });
  });

  it("uses the installer-written engine configuration when no development source exists", async () => {
    const fixture = await remoteFixture("0.4.0");
    const root = await temporaryRoot("ai-harness-engine-config-");
    const config = join(root, "engine.json");
    const cache = join(root, "cache");
    await writeFile(config, `${JSON.stringify({
      schema: "ai-harness/engine-config/v1",
      content_manifest_url: fixture.manifestUrl,
    })}\n`, "utf8");
    const source = createDefaultContentSource({
      developmentCatalogFile: join(root, "missing", "ai-harness.yaml"),
      cacheRoot: cache,
      environment: {
        AI_HARNESS_ENGINE_CONFIG: config,
        AI_HARNESS_ALLOW_FILE_CONTENT: "1",
      },
    });

    await expect(source.resolve()).resolves.toMatchObject({
      kind: "remote",
      revision: "0.4.0",
    });
  });

  it("fails closed on a malformed installed engine configuration", async () => {
    const root = await temporaryRoot("ai-harness-bad-engine-config-");
    const config = join(root, "engine.json");
    await writeFile(config, '{"content_manifest_url":"https://example.test/content.json"}\n');
    const source = createDefaultContentSource({
      developmentCatalogFile: join(root, "missing", "ai-harness.yaml"),
      environment: { AI_HARNESS_ENGINE_CONFIG: config },
    });

    await expect(source.resolve()).rejects.toThrow("Installed engine configuration is invalid");
  });
});

async function remoteFixture(revision: string) {
  const root = await temporaryRoot("ai-harness-remote-fixture-");
  const contentRoot = join(root, "content");
  await mkdir(contentRoot);
  const catalog = minimalCatalog(revision);
  await writeFile(join(contentRoot, "ai-harness.yaml"), catalog, "utf8");
  const manifest = {
    schema: "ai-harness/content-manifest/v1",
    revision,
    source: {
      commit: "0123456789abcdef0123456789abcdef01234567",
      tree: "89abcdef0123456789abcdef0123456789abcdef",
      input_digest: sha256(`content:${revision}`),
    },
    files: [{
      path: "ai-harness.yaml",
      mode: "100644",
      size: Buffer.byteLength(catalog),
      sha256: sha256(catalog),
    }],
    authentication: {
      kind: "external-https-channel",
      manifest_authentication: "Fixture file channel.",
    },
  };
  const manifestPath = join(root, "content-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { manifestUrl: new URL(`file://${manifestPath}`).href };
}

async function localSource(revision: string): Promise<string> {
  const root = await temporaryRoot("ai-harness-local-composition-");
  await writeFile(join(root, "ai-harness.yaml"), minimalCatalog(revision), "utf8");
  return root;
}

function minimalCatalog(revision: string): string {
  return [
    "schema: ai-harness/v1",
    `version: ${revision}`,
    "catalog:",
    "  skills: {}",
    "  mcps: {}",
    "  verification-profiles: {}",
    "  git-gates: {}",
    "  instruction-fragments: {}",
    "  packs: {}",
    "  agents: {}",
    "",
  ].join("\n");
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(root);
  return root;
}

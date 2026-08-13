import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContentManifestClient, type ContentTransport } from "../../src/catalog/source/content-manifest-client.js";
import { LocalContentSource } from "../../src/catalog/source/local-content-source.js";
import { RemoteContentSource } from "../../src/catalog/source/remote-content-source.js";
import { SourcedCatalog } from "../../src/catalog/source/sourced-catalog.js";
import { languageId, sha256 } from "../../src/domain/shared/types.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class MutableTransport implements ContentTransport {
  readonly requests: string[] = [];
  readonly responses = new Map<string, Uint8Array>();

  public async get(url: URL): Promise<Uint8Array> {
    this.requests.push(url.href);
    const response = this.responses.get(url.href);
    if (response === undefined) throw new Error(`Unavailable: ${url.href}`);
    return new Uint8Array(response);
  }
}

describe("content sources", () => {
  it("loads a local checkout without copying it and reports its origin", async () => {
    const root = await temporaryRoot("ai-harness-local-source-");
    await writeFile(join(root, "ai-harness.yaml"), minimalCatalog("0.1.0"), "utf8");
    const progress: string[] = [];
    const source = new LocalContentSource({
      root,
      progress: (event) => progress.push(`${event.phase}:${event.status}`),
    });
    const resolved = await source.resolve();
    const realRoot = await realpath(root);
    const catalog = new SourcedCatalog({
      source,
      supportedLanguages: [languageId("go")],
    });

    expect(resolved).toMatchObject({ kind: "local", root: realRoot, revision: null });
    expect(resolved.catalogFile).toBe(join(realRoot, "ai-harness.yaml"));
    const loaded = await catalog.load();
    expect(loaded.kind).toBe("ready");
    if (loaded.kind === "ready") {
      expect(loaded.catalog.revision).toBe("0.1.0");
      expect(loaded.diagnostics.some((entry) => entry.code === "catalog.source.local")).toBe(true);
    }
    expect(progress).toEqual([
      "local:started",
      "local:completed",
      "local:started",
      "local:completed",
    ]);
  });

  it("fetches the manifest once per catalog instance and reuses only verified cache files", async () => {
    const cacheRoot = await temporaryRoot("ai-harness-content-cache-");
    const transport = new MutableTransport();
    publish(transport, "0.1.0");

    const first = remoteCatalog(transport, cacheRoot);
    const firstLoad = await first.catalog.load();
    expect(firstLoad.kind).toBe("ready");
    await first.catalog.load();
    expect(transport.requests).toEqual([
      manifestUrl,
      `${channelUrl}content/ai-harness.yaml`,
    ]);

    transport.requests.length = 0;
    const second = remoteCatalog(transport, cacheRoot);
    const secondLoad = await second.catalog.load();
    expect(secondLoad.kind).toBe("ready");
    expect(transport.requests).toEqual([manifestUrl]);

    const resolved = await second.source.resolve();
    await writeFile(resolved.catalogFile, "tampered", "utf8");
    transport.requests.length = 0;
    const repaired = remoteCatalog(transport, cacheRoot);
    const repairedLoad = await repaired.catalog.load();
    expect(repairedLoad.kind).toBe("ready");
    expect(transport.requests).toEqual([
      manifestUrl,
      `${channelUrl}content/ai-harness.yaml`,
    ]);
    expect(await readFile(resolved.catalogFile, "utf8")).toBe(minimalCatalog("0.1.0"));
  });

  it("does not claim cached content is current when the next manifest request fails", async () => {
    const cacheRoot = await temporaryRoot("ai-harness-content-offline-");
    const transport = new MutableTransport();
    publish(transport, "0.1.0");
    const first = remoteCatalog(transport, cacheRoot);
    expect((await first.catalog.load()).kind).toBe("ready");

    transport.responses.delete(manifestUrl);
    transport.requests.length = 0;
    const offline = remoteCatalog(transport, cacheRoot);
    const result = await offline.catalog.load();

    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.diagnostics[0]).toMatchObject({
        code: "catalog.source.unavailable",
        severity: "blocked",
      });
    }
    expect(transport.requests).toEqual([manifestUrl]);
  });

  it("closes visible source progress as failed when manifest resolution fails", async () => {
    const cacheRoot = await temporaryRoot("ai-harness-content-progress-");
    const transport = new MutableTransport();
    const progress: string[] = [];
    const source = new RemoteContentSource({
      client: new ContentManifestClient({ manifestUrl, transport }),
      cacheRoot,
      progress: (event) => progress.push(`${event.phase}:${event.status}`),
    });
    const catalog = new SourcedCatalog({
      source,
      supportedLanguages: [languageId("go")],
    });

    expect((await catalog.load()).kind).toBe("invalid");
    expect(progress).toEqual(["manifest:started", "manifest:failed"]);
  });

  it("replaces a remote snapshot when the current manifest revision changes", async () => {
    const cacheRoot = await temporaryRoot("ai-harness-content-update-");
    const transport = new MutableTransport();
    publish(transport, "0.1.0");
    const first = remoteCatalog(transport, cacheRoot);
    const initial = await first.catalog.load();
    expect(initial.kind === "ready" ? initial.catalog.revision : null).toBe("0.1.0");

    publish(transport, "0.2.0");
    transport.requests.length = 0;
    const next = remoteCatalog(transport, cacheRoot);
    const updated = await next.catalog.load();

    expect(updated.kind === "ready" ? updated.catalog.revision : null).toBe("0.2.0");
    expect(transport.requests).toEqual([
      manifestUrl,
      `${channelUrl}content/ai-harness.yaml`,
    ]);
  });

  it("rejects a local source whose catalog is absent or not a regular file", async () => {
    const root = await temporaryRoot("ai-harness-invalid-local-");
    const absent = new SourcedCatalog({
      source: new LocalContentSource({ root }),
      supportedLanguages: [languageId("go")],
    });
    const absentResult = await absent.load();
    expect(absentResult.kind).toBe("invalid");

    await mkdir(join(root, "ai-harness.yaml"));
    const directory = new SourcedCatalog({
      source: new LocalContentSource({ root }),
      supportedLanguages: [languageId("go")],
    });
    const directoryResult = await directory.load();
    expect(directoryResult.kind).toBe("invalid");
  });

  it("preserves executable modes declared by the remote manifest", async () => {
    const cacheRoot = await temporaryRoot("ai-harness-content-mode-");
    const transport = new MutableTransport();
    const catalogBytes = bytes(minimalCatalog("0.1.0"));
    const executableBytes = bytes("#!/usr/bin/env bash\nexit 0\n");
    const manifest = manifestFor("0.1.0", [
      contentFile("ai-harness.yaml", catalogBytes, "100644"),
      contentFile("skills/tool/run.sh", executableBytes, "100755"),
    ]);
    transport.responses.set(manifestUrl, jsonBytes(manifest));
    transport.responses.set(`${channelUrl}content/ai-harness.yaml`, catalogBytes);
    transport.responses.set(`${channelUrl}content/skills/tool/run.sh`, executableBytes);
    const source = new RemoteContentSource({
      client: new ContentManifestClient({ manifestUrl, transport }),
      cacheRoot,
    });

    const resolved = await source.resolve();
    const executable = join(resolved.root, "skills", "tool", "run.sh");
    expect((await lstat(executable)).mode & 0o777).toBe(0o755);
    await chmod(executable, 0o644);
    const repaired = await source.resolve();
    expect((await lstat(join(repaired.root, "skills", "tool", "run.sh"))).mode & 0o777).toBe(0o755);
  });
});

const channelUrl = "https://content.example.test/stable/";
const manifestUrl = `${channelUrl}content-manifest.json`;

function remoteCatalog(transport: MutableTransport, cacheRoot: string) {
  const source = new RemoteContentSource({
    client: new ContentManifestClient({ manifestUrl, transport }),
    cacheRoot,
  });
  return {
    source,
    catalog: new SourcedCatalog({
      source,
      supportedLanguages: [languageId("go")],
    }),
  };
}

function publish(transport: MutableTransport, revision: string): void {
  const catalog = bytes(minimalCatalog(revision));
  transport.responses.set(manifestUrl, jsonBytes(manifestFor(revision, [
    contentFile("ai-harness.yaml", catalog, "100644"),
  ])));
  transport.responses.set(`${channelUrl}content/ai-harness.yaml`, catalog);
}

function manifestFor(
  revision: string,
  files: readonly ReturnType<typeof contentFile>[],
) {
  return {
    schema: "ai-harness/content-manifest/v1",
    revision,
    source: {
      commit: "0123456789abcdef0123456789abcdef01234567",
      tree: "89abcdef0123456789abcdef0123456789abcdef",
      input_digest: sha256(`content:${revision}`),
    },
    files,
    authentication: {
      kind: "external-https-channel",
      manifest_authentication: "Corporate HTTPS channel.",
    },
  };
}

function contentFile(path: string, content: Uint8Array, mode: "100644" | "100755") {
  return { path, mode, size: content.byteLength, sha256: sha256(content) };
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
  temporaryRoots.push(root);
  return root;
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function jsonBytes(value: unknown): Uint8Array {
  return bytes(`${JSON.stringify(value, null, 2)}\n`);
}

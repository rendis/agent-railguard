import { describe, expect, it } from "vitest";
import {
  ContentArtifactIntegrityError,
  ContentManifestClient,
  ContentManifestValidationError,
  type ContentTransport,
} from "../../src/catalog/source/content-manifest-client.js";
import { sha256 } from "../../src/domain/shared/types.js";

class MemoryTransport implements ContentTransport {
  readonly requests: string[] = [];

  public constructor(readonly responses: ReadonlyMap<string, Uint8Array>) {}

  public async get(url: URL): Promise<Uint8Array> {
    this.requests.push(url.href);
    const response = this.responses.get(url.href);
    if (response === undefined) throw new Error(`No response for ${url.href}`);
    return new Uint8Array(response);
  }
}

describe("content manifest client", () => {
  it("loads a closed HTTPS manifest and verifies every referenced file", async () => {
    const manifestUrl = "https://content.example.test/stable/content-manifest.json";
    const catalog = bytes("schema: ai-harness/v1\nversion: 0.1.0\ncatalog: {}\n");
    const skill = bytes("---\nname: tdd\ndescription: Test first\n---\n");
    const manifest = validManifest([
      file("ai-harness.yaml", catalog),
      file("skills/tdd/SKILL.md", skill),
    ]);
    const transport = new MemoryTransport(new Map([
      [manifestUrl, jsonBytes(manifest)],
      ["https://content.example.test/stable/content/ai-harness.yaml", catalog],
      ["https://content.example.test/stable/content/skills/tdd/SKILL.md", skill],
    ]));
    const client = new ContentManifestClient({ manifestUrl, transport });

    const resolved = await client.fetchManifest();
    expect(resolved.manifest.schema).toBe("ai-harness/content-manifest/v1");
    expect(resolved.manifest.revision).toBe("0.1.0");
    expect(resolved.digest).toBe(sha256(jsonBytes(manifest)));
    expect(resolved.files.map((entry) => entry.url.href)).toEqual([
      "https://content.example.test/stable/content/ai-harness.yaml",
      "https://content.example.test/stable/content/skills/tdd/SKILL.md",
    ]);
    await expect(client.fetchFile(resolved.files[0]!)).resolves.toEqual(catalog);
    await expect(client.fetchFile(resolved.files[1]!)).resolves.toEqual(skill);
    expect(transport.requests).toEqual([
      manifestUrl,
      "https://content.example.test/stable/content/ai-harness.yaml",
      "https://content.example.test/stable/content/skills/tdd/SKILL.md",
    ]);
  });

  it("requires HTTPS unless a test-only transport protocol is explicitly enabled", () => {
    expect(() => new ContentManifestClient({
      manifestUrl: "http://content.example.test/content-manifest.json",
    })).toThrow("Content channel must use HTTPS");
    expect(() => new ContentManifestClient({
      manifestUrl: "file:///tmp/content-manifest.json",
      allowFileUrl: true,
    })).not.toThrow();
    expect(() => new ContentManifestClient({
      manifestUrl: "http://127.0.0.1:8080/content-manifest.json",
      allowInsecureLoopback: true,
    })).not.toThrow();
  });

  it.each([
    ["path traversal", [file("../AGENTS.md", bytes("bad"))], "relative portable POSIX"],
    ["absolute path", [file("/tmp/AGENTS.md", bytes("bad"))], "relative portable POSIX"],
    ["backslash", [file("skills\\tdd\\SKILL.md", bytes("bad"))], "relative portable POSIX"],
    ["missing catalog", [file("skills/tdd/SKILL.md", bytes("bad"))], "exactly one ai-harness.yaml"],
    [
      "duplicate path",
      [file("ai-harness.yaml", bytes("one")), file("ai-harness.yaml", bytes("two"))],
      "duplicate file path",
    ],
  ])("rejects %s before resolving content URLs", async (_name, files, message) => {
    const manifestUrl = "https://content.example.test/stable/content-manifest.json";
    const transport = new MemoryTransport(new Map([
      [manifestUrl, jsonBytes(validManifest(files))],
    ]));
    const client = new ContentManifestClient({ manifestUrl, transport });

    await expect(client.fetchManifest()).rejects.toThrow(message);
    expect(transport.requests).toEqual([manifestUrl]);
  });

  it("rejects manifests that exceed the total content budget", async () => {
    const manifestUrl = "https://content.example.test/stable/content-manifest.json";
    const manifest = validManifest([
      {
        path: "ai-harness.yaml",
        mode: "100644",
        size: 16 * 1024 * 1024 + 1,
        sha256: sha256("oversized"),
      },
    ]);
    const transport = new MemoryTransport(new Map([[manifestUrl, jsonBytes(manifest)]]));

    await expect(
      new ContentManifestClient({ manifestUrl, transport }).fetchManifest(),
    ).rejects.toBeInstanceOf(ContentManifestValidationError);
  });

  it("rejects content bytes whose size or digest differs from the manifest", async () => {
    const manifestUrl = "https://content.example.test/stable/content-manifest.json";
    const expected = bytes("expected");
    const manifest = validManifest([file("ai-harness.yaml", expected)]);
    const transport = new MemoryTransport(new Map([
      [manifestUrl, jsonBytes(manifest)],
      ["https://content.example.test/stable/content/ai-harness.yaml", bytes("tampered")],
    ]));
    const client = new ContentManifestClient({ manifestUrl, transport });
    const resolved = await client.fetchManifest();

    await expect(client.fetchFile(resolved.files[0]!)).rejects.toBeInstanceOf(
      ContentArtifactIntegrityError,
    );
  });

  it("rejects credentials in manifest channel URLs", () => {
    expect(() => new ContentManifestClient({
      manifestUrl: "https://token@content.example.test/content-manifest.json",
    })).toThrow("must not contain credentials");
  });
});

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function jsonBytes(value: unknown): Uint8Array {
  return bytes(`${JSON.stringify(value, null, 2)}\n`);
}

function file(path: string, content: Uint8Array) {
  return {
    path,
    mode: "100644" as const,
    size: content.byteLength,
    sha256: sha256(content),
  };
}

function validManifest(files: readonly ReturnType<typeof file>[]) {
  return {
    schema: "ai-harness/content-manifest/v1",
    revision: "0.1.0",
    source: {
      commit: "0123456789abcdef0123456789abcdef01234567",
      tree: "89abcdef0123456789abcdef0123456789abcdef",
      input_digest: sha256("content-input"),
    },
    files,
    authentication: {
      kind: "external-https-channel",
      manifest_authentication: "Authenticate through the corporate HTTPS channel.",
    },
  };
}

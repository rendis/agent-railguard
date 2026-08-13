import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ArtifactIntegrityError,
  ReleaseClient,
  ReleaseManifestValidationError,
  type ReleaseTransport,
} from "../../src/update/release-client.js";

const manifestUrl = "https://releases.example/ai-harness/stable/release-manifest.json";
const artifactUrl = "https://releases.example/ai-harness/stable/ai-harness-0.2.0.tgz";

describe("verified release client", () => {
  it("loads a closed manifest and resolves an artifact within the same channel", async () => {
    const artifact = Buffer.from("candidate tarball", "utf8");
    const transport = mappedTransport(new Map([
      [manifestUrl, bytes(manifest(artifact))],
      [artifactUrl, artifact],
    ]));
    const client = new ReleaseClient({ manifestUrl, transport, timeoutMs: 100 });

    const release = await client.fetchManifest();
    expect(release.manifest.release.version).toBe("0.2.0");
    expect(release.artifactUrl.href).toBe(artifactUrl);
    expect(release.contentManifestUrl.href).toBe(
      "https://releases.example/ai-harness/stable/content-manifest.json",
    );
    await expect(client.fetchArtifact(release)).resolves.toEqual(new Uint8Array(artifact));
  });

  it("rejects schema extensions and channel path escapes", async () => {
    const artifact = Buffer.from("candidate", "utf8");
    const extended = { ...manifest(artifact), unexpected: true };
    const invalidSchema = new ReleaseClient({
      manifestUrl,
      transport: mappedTransport(new Map([[manifestUrl, bytes(extended)]])),
    });
    await expect(invalidSchema.fetchManifest()).rejects.toBeInstanceOf(
      ReleaseManifestValidationError,
    );

    const escaped = manifest(artifact);
    escaped.release.artifact.path = "../candidate.tgz";
    const invalidPath = new ReleaseClient({
      manifestUrl,
      transport: mappedTransport(new Map([[manifestUrl, bytes(escaped)]])),
    });
    await expect(invalidPath.fetchManifest()).rejects.toBeInstanceOf(
      ReleaseManifestValidationError,
    );
  });

  it("rejects altered artifact bytes before installation", async () => {
    const expected = Buffer.from("expected", "utf8");
    const transport = mappedTransport(new Map([
      [manifestUrl, bytes(manifest(expected))],
      [artifactUrl, Buffer.from("altered", "utf8")],
    ]));
    const client = new ReleaseClient({ manifestUrl, transport });

    const release = await client.fetchManifest();
    await expect(client.fetchArtifact(release)).rejects.toBeInstanceOf(
      ArtifactIntegrityError,
    );
  });
});

function manifest(artifact: Uint8Array) {
  return {
    schema: "ai-harness/release-manifest/v1" as const,
    channel: "stable",
    source: {
      commit: "abc123",
      tree: "def456",
      input_digest: digest(Buffer.from("source", "utf8")),
    },
    release: {
      name: "@example/ai-harness" as const,
      version: "0.2.0",
      runtime: { node: ">=24.19.0 <25.0.0" as const, pnpm: ">=11.21.0 <12.0.0" as const },
      artifact: { path: "ai-harness-0.2.0.tgz", sha256: digest(artifact), size: artifact.byteLength },
      sbom: { path: "sbom.cdx.json", sha256: digest(Buffer.from("sbom")), size: 4 },
      notices: { path: "THIRD_PARTY_NOTICES.md", sha256: digest(Buffer.from("notice")), size: 6 },
      notes: ["Verified test release"],
    },
    authentication: {
      kind: "external-https-channel" as const,
      manifest_authentication: "Corporate HTTPS channel policy",
    },
    content: { manifest: { path: "content-manifest.json" } },
  };
}

function digest(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function bytes(value: unknown): Uint8Array {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function mappedTransport(values: ReadonlyMap<string, Uint8Array>): ReleaseTransport {
  return {
    async get(url) {
      const value = values.get(url.href);
      if (value === undefined) throw new Error(`Unexpected URL: ${url.href}`);
      return new Uint8Array(value);
    },
  };
}

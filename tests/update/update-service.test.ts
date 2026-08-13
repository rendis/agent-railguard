import { describe, expect, it, vi } from "vitest";
import type { ResolvedRelease } from "../../src/update/release-client.js";
import {
  UpdateService,
  type UpdateInstaller,
  type VerifiedReleaseSource,
} from "../../src/update/update-service.js";

describe("CLI update service", () => {
  it("keeps an unconfigured or unavailable channel non-blocking during check", async () => {
    const unconfigured = new UpdateService(null, installer());
    await expect(unconfigured.check("0.1.0")).resolves.toMatchObject({
      status: "unknown",
      latestVersion: null,
      diagnostics: [{ code: "update.channel-unconfigured", severity: "warning" }],
    });

    const unavailable = new UpdateService(
      source(async () => {
        throw new DOMException("timed out", "TimeoutError");
      }),
      installer(),
    );
    await expect(unavailable.check("0.1.0")).resolves.toMatchObject({
      status: "unknown",
      diagnostics: [{ code: "update.channel-unavailable", severity: "warning" }],
    });
  });

  it("distinguishes current and available stable releases", async () => {
    await expect(new UpdateService(sourceRelease("0.1.0"), installer()).check("0.1.0"))
      .resolves.toMatchObject({ status: "current", latestVersion: "0.1.0" });
    await expect(new UpdateService(sourceRelease("0.2.0"), installer()).check("0.1.0"))
      .resolves.toMatchObject({ status: "available", latestVersion: "0.2.0" });
  });

  it("downloads and installs only an available verified artifact", async () => {
    const install = vi.fn<UpdateInstaller["install"]>().mockResolvedValue({
      status: "applied",
      previousVersion: "0.1.0",
      installedVersion: "0.2.0",
    });
    const source = sourceRelease("0.2.0", new Uint8Array([1, 2, 3]));

    const result = await new UpdateService(source, { install }).apply("0.1.0");

    expect(result).toMatchObject({ status: "applied", latestVersion: "0.2.0" });
    expect(install).toHaveBeenCalledWith(
      expect.objectContaining({ currentVersion: "0.1.0", release: expect.any(Object) }),
      new Uint8Array([1, 2, 3]),
      undefined,
    );
  });

  it("reports an installer rollback without claiming success", async () => {
    const rolledBack = installer({
      status: "rolled-back",
      previousVersion: "0.1.0",
      installedVersion: null,
    });
    const result = await new UpdateService(sourceRelease("0.2.0"), rolledBack).apply("0.1.0");

    expect(result).toMatchObject({
      status: "rolled-back",
      diagnostics: [{ code: "update.install-rolled-back", severity: "blocked" }],
    });
  });
});

function sourceRelease(
  version: string,
  artifact = new Uint8Array([4, 5, 6]),
): VerifiedReleaseSource {
  const release = resolvedRelease(version);
  return {
    async fetchManifest() {
      return release;
    },
    async fetchArtifact(candidate) {
      expect(candidate).toBe(release);
      return artifact;
    },
  };
}

function source(load: () => Promise<ResolvedRelease>): VerifiedReleaseSource {
  return {
    fetchManifest: load,
    async fetchArtifact() {
      throw new Error("Artifact should not be fetched");
    },
  };
}

function installer(
  result: Awaited<ReturnType<UpdateInstaller["install"]>> = {
    status: "applied",
    previousVersion: "0.1.0",
    installedVersion: "0.2.0",
  },
): UpdateInstaller {
  return { async install() { return result; } };
}

function resolvedRelease(version: string): ResolvedRelease {
  return {
    manifestUrl: new URL("https://releases.example/stable/release-manifest.json"),
    artifactUrl: new URL("https://releases.example/stable/ai-harness.tgz"),
    contentManifestUrl: new URL("https://releases.example/stable/content-manifest.json"),
    manifest: {
      schema: "ai-harness/release-manifest/v1",
      channel: "stable",
      source: {
        commit: "abc",
        tree: "def",
        input_digest: `sha256:${"1".repeat(64)}`,
      },
      release: {
        name: "@example/ai-harness",
        version,
        runtime: { node: ">=24.19.0 <25.0.0", pnpm: ">=11.21.0 <12.0.0" },
        artifact: { path: "ai-harness.tgz", sha256: `sha256:${"2".repeat(64)}`, size: 3 },
        sbom: { path: "sbom.cdx.json", sha256: `sha256:${"3".repeat(64)}`, size: 3 },
        notices: { path: "THIRD_PARTY_NOTICES.md", sha256: `sha256:${"4".repeat(64)}`, size: 3 },
        notes: [],
      },
      authentication: {
        kind: "external-https-channel",
        manifest_authentication: "test",
      },
      content: { manifest: { path: "content-manifest.json" } },
    },
  };
}

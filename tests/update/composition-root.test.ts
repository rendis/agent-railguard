import { describe, expect, it } from "vitest";
import { createUpdateServiceFromEnvironment } from "../../src/update/composition-root.js";

describe("update composition root", () => {
  it("creates an offline-safe unconfigured service", async () => {
    const service = createUpdateServiceFromEnvironment({});
    expect(service.source).toBeNull();
    await expect(service.check("0.1.0")).resolves.toMatchObject({
      status: "unknown",
      diagnostics: [{ code: "update.channel-unconfigured" }],
    });
  });

  it("accepts explicit HTTPS, file and loopback channel policies", () => {
    expect(createUpdateServiceFromEnvironment({
      AI_HARNESS_RELEASE_MANIFEST_URL: "https://releases.example.test/stable/release-manifest.json",
      AI_HARNESS_RELEASE_TIMEOUT_MS: "1500",
      AI_HARNESS_PNPM_COMMAND: "/test/pnpm",
    }).source).not.toBeNull();
    expect(createUpdateServiceFromEnvironment({
      AI_HARNESS_RELEASE_MANIFEST_URL: "file:///tmp/release-manifest.json",
      AI_HARNESS_ALLOW_FILE_RELEASES: "1",
    }).source).not.toBeNull();
    expect(createUpdateServiceFromEnvironment({
      AI_HARNESS_RELEASE_MANIFEST_URL: "http://127.0.0.1:4000/release-manifest.json",
      AI_HARNESS_ALLOW_LOOPBACK_RELEASES: "1",
    }).source).not.toBeNull();
  });

  it.each(["0", "-1", "1.5", "abc", "60001", "9007199254740992"])(
    "rejects invalid timeout %s",
    (timeout) => {
      expect(() => createUpdateServiceFromEnvironment({
        AI_HARNESS_RELEASE_MANIFEST_URL: "https://releases.example.test/release-manifest.json",
        AI_HARNESS_RELEASE_TIMEOUT_MS: timeout,
      })).toThrow(/positive integer|must not exceed/);
    },
  );

  it("uses the default timeout when the variable is empty", () => {
    expect(createUpdateServiceFromEnvironment({
      AI_HARNESS_RELEASE_MANIFEST_URL: "https://releases.example.test/release-manifest.json",
      AI_HARNESS_RELEASE_TIMEOUT_MS: "",
    }).source).not.toBeNull();
  });
});

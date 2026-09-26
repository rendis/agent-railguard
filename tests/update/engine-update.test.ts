import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitHubLatestRelease } from "../../src/adapters/platform/release/github-latest-release.js";
import {
  compareVersions,
  refreshLatest,
  updateCheckIntervalMs,
  updateNotice,
} from "../../src/application/engine-update.js";
import type { ProcessRunner } from "../../src/domain/verification/checks.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function cacheFile(content?: object): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "railguard-update-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "railguard", "latest.json");
  if (content !== undefined) {
    await mkdir(join(directory, "railguard"));
    await writeFile(file, JSON.stringify(content));
  }
  return file;
}

describe("update notice", () => {
  it("orders versions numerically", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3", "2.0.0")).toBeLessThan(0);
  });

  it("reports a newer cached release without refreshing a fresh cache", async () => {
    const now = 1_000_000_000_000;
    const file = await cacheFile({ checked_at: now - 1000, latest: "0.2.0" });
    let refreshed = 0;

    const notice = await updateNotice("0.1.0", { cacheFile: file, now, refresh: () => { refreshed += 1; } });

    expect(notice).toContain("Railguard 0.2.0 is available; this repository runs 0.1.0.");
    expect(notice).toContain("never update without asking");
    expect(refreshed).toBe(0);
  });

  it("stays silent for the current or an older release", async () => {
    const now = 1_000_000_000_000;
    const file = await cacheFile({ checked_at: now, latest: "0.1.0" });

    expect(await updateNotice("0.1.0", { cacheFile: file, now, refresh: () => undefined })).toBeNull();
    expect(await updateNotice("0.2.0", { cacheFile: file, now, refresh: () => undefined })).toBeNull();
  });

  it("claims a stale or missing cache before refreshing it, so only one refresh starts", async () => {
    const now = 1_000_000_000_000;
    const stale = await cacheFile({ checked_at: now - updateCheckIntervalMs, latest: "0.2.0" });
    const missing = await cacheFile();
    let refreshed = 0;
    const refresh = () => { refreshed += 1; };

    expect(await updateNotice("0.1.0", { cacheFile: stale, now, refresh })).toContain("0.2.0 is available");
    expect(await updateNotice("0.1.0", { cacheFile: stale, now, refresh })).toContain("0.2.0 is available");
    expect(await updateNotice("0.1.0", { cacheFile: missing, now, refresh })).toBeNull();

    expect(refreshed).toBe(2);
    expect(JSON.parse(await readFile(stale, "utf8"))).toEqual({ checked_at: now, latest: "0.2.0" });
    expect(JSON.parse(await readFile(missing, "utf8"))).toEqual({ checked_at: now, latest: null });
  });

  it("records the refreshed answer, including an unknown one", async () => {
    const file = await cacheFile();

    expect(await refreshLatest({ async latest() { return "0.3.0"; } }, file, () => 42)).toBe("0.3.0");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ checked_at: 42, latest: "0.3.0" });
    expect(await refreshLatest({ async latest() { return null; } }, file, () => 43)).toBeNull();
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ checked_at: 43, latest: null });
  });
});

describe("GitHubLatestRelease", () => {
  it("reads the latest tag through gh, which also reaches private repositories", async () => {
    const calls: string[][] = [];
    const runner: ProcessRunner = {
      async run(command, args) {
        calls.push([command, ...args]);
        return { exitCode: 0, stdout: "v0.4.1\n", stderr: "", timedOut: false };
      },
    };

    expect(await new GitHubLatestRelease(runner, "example/railguard").latest()).toBe("0.4.1");
    expect(calls).toEqual([["gh", "api", "repos/example/railguard/releases/latest", "--jq", ".tag_name"]]);
  });

  it("rejects a tag that is not a release version", async () => {
    const runner: ProcessRunner = {
      async run() {
        return { exitCode: 0, stdout: "nightly\n", stderr: "", timedOut: false };
      },
    };

    expect(await new GitHubLatestRelease(runner, "example/railguard").latest()).toBeNull();
  });
});

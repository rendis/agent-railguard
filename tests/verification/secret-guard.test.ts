import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { NodeChangeSetReader } from "../../src/adapters/platform/git/node-change-set-reader.js";
import { NodeProcessRunner } from "../../src/adapters/platform/process/node-process-runner.js";
import { PinnedToolInstaller, type PinnedTool, type ToolLocator } from "../../src/adapters/platform/tools/pinned-tool.js";
import { betterleaks, SecretCheckProvider } from "../../src/adapters/verification/secret-check-provider.js";
import type { CheckRequest } from "../../src/domain/verification/checks.js";

const execute = promisify(execFile);
const runner = new NodeProcessRunner();
const changeSets = new NodeChangeSetReader(runner);
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

describe("pinned tool installer", () => {
  async function release() {
    const directory = await temporaryDirectory("railguard-tool-release-");
    const executable = "#!/bin/sh\necho fake\n";
    await writeFile(join(directory, "fake"), executable, { mode: 0o755 });
    await execute("tar", ["-czf", "fake.tar.gz", "fake"], { cwd: directory });
    const archive = await readFile(join(directory, "fake.tar.gz"));
    const asset = { archive: "fake.tar.gz", archiveSha256: sha256(archive), executableSha256: sha256(executable) };
    const tool: PinnedTool = {
      name: "fake",
      version: "1.0.0",
      releaseUrl: "https://example.test/v1.0.0",
      assets: {
        "darwin-arm64": asset,
        "darwin-x64": asset,
        "linux-arm64": asset,
        "linux-x64": asset,
        "windows-arm64": asset,
        "windows-x64": asset,
      },
    };
    const downloads: string[] = [];
    const download = async (url: string) => {
      downloads.push(url);
      return archive;
    };
    return { tool, downloads, download };
  }

  it("downloads once, verifies both digests and reuses the cached executable", async () => {
    const cacheRoot = await temporaryDirectory("railguard-tool-cache-");
    const { tool, downloads, download } = await release();
    const installer = new PinnedToolInstaller({ cacheRoot, process: runner, download, platform: "linux-x64" });

    const first = await installer.locate(tool);
    const second = await installer.locate(tool);

    expect(first).toEqual({ path: join(cacheRoot, "fake", "1.0.0", "linux-x64", "fake") });
    expect(second).toEqual(first);
    expect(downloads).toEqual(["https://example.test/v1.0.0/fake.tar.gz"]);
    const { stdout } = await execute((first as { path: string }).path);
    expect(stdout).toBe("fake\n");
  });

  it("replaces a tampered cached executable instead of trusting it", async () => {
    const cacheRoot = await temporaryDirectory("railguard-tool-cache-");
    const { tool, downloads, download } = await release();
    const installer = new PinnedToolInstaller({ cacheRoot, process: runner, download, platform: "linux-x64" });
    const installed = (await installer.locate(tool)) as { path: string };
    await writeFile(installed.path, "#!/bin/sh\necho null\n");

    expect(await installer.locate(tool)).toEqual(installed);
    expect(downloads).toHaveLength(2);
    expect(await readFile(installed.path, "utf8")).toBe("#!/bin/sh\necho fake\n");
  });

  it("reports a failed download, a mismatched archive or an unsupported platform as unavailable", async () => {
    const cacheRoot = await temporaryDirectory("railguard-tool-cache-");
    const { tool } = await release();
    const offline = new PinnedToolInstaller({
      cacheRoot, process: runner, platform: "linux-x64", download: async () => { throw new Error("offline"); },
    });
    const tampered = new PinnedToolInstaller({
      cacheRoot, process: runner, platform: "linux-x64", download: async () => new Uint8Array([1, 2, 3]),
    });
    const unsupported = new PinnedToolInstaller({ cacheRoot, process: runner, platform: null });

    expect(await offline.locate(tool)).toEqual({
      unavailable: "fake 1.0.0 could not be downloaded from https://example.test/v1.0.0/fake.tar.gz: offline",
    });
    expect(await tampered.locate(tool)).toEqual({ unavailable: "fake 1.0.0: fake.tar.gz does not match its pinned SHA-256" });
    expect(await unsupported.locate(tool)).toMatchObject({ unavailable: expect.stringContaining("fake 1.0.0 has no release for") });
  });

  it("pins every platform Railguard ships", () => {
    expect(Object.keys(betterleaks.assets).sort()).toEqual([
      "darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "windows-arm64", "windows-x64",
    ]);
    for (const asset of Object.values(betterleaks.assets)) {
      expect(asset.archive).toMatch(/^betterleaks_1\.8\.1_[a-z]+_(?:arm64|x64)\.(?:tar\.gz|zip)$/u);
      expect(asset.archiveSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(asset.executableSha256).toMatch(/^[0-9a-f]{64}$/u);
    }
  });
});

describe("secret-exposure", () => {
  /**
   * A stand-in for Betterleaks: it records its arguments and the exceptions it was given, then
   * prints the report stored for its subcommand (`git.json` or `dir.json`).
   */
  async function scanner() {
    const directory = await temporaryDirectory("railguard-fake-betterleaks-");
    const path = join(directory, "betterleaks");
    await writeFile(path, [
      "#!/bin/sh",
      `out=${directory}`,
      'sub=$1',
      '# Commit history is scanned as reconstructed files under a directory named history.',
      'if [ "$(basename "$PWD")" = history ]; then sub=history; for f in $(find . -type f | sort); do printf "%s\\n" "${f#./}" >> "$out/history-files.txt"; cat "$f" >> "$out/history-files.txt"; done; fi',
      'printf "%s\\n" "$@" >> "$out/args-$sub.txt"',
      'prev=',
      'for arg in "$@"; do',
      '  if [ "$prev" = --config ]; then cp "$arg" "$out/config-$sub.toml"; fi',
      '  if [ "$prev" = --gitleaks-ignore-path ]; then for f in "$arg"/.* "$arg"/*; do [ -f "$f" ] && { basename "$f"; cat "$f"; } >> "$out/ignore-$sub.txt"; done; fi',
      '  prev=$arg',
      'done',
      '# Files scanned in the working tree (or a staged copy) are recorded with their content.',
      'if [ "$sub" = dir ]; then seen=; for arg in "$@"; do if [ -n "$seen" ]; then printf "%s\\n" "$arg" >> "$out/dir-files.txt"; cat "$arg" >> "$out/dir-files.txt"; fi; [ "$arg" = -- ] && seen=1; done; fi',
      'if [ -f "$out/fail" ]; then echo "config error" >&2; exit 1; fi',
      'if [ -f "$out/$sub.json" ]; then cat "$out/$sub.json"; else echo null; fi',
      "",
    ].join("\n"));
    await chmod(path, 0o755);
    const locator: ToolLocator = { locate: async () => ({ path }) };
    const read = async (name: string) => {
      try {
        return await readFile(join(directory, name), "utf8");
      } catch {
        return null;
      }
    };
    const report = async (sub: "history" | "dir", findings: readonly object[]) =>
      await writeFile(join(directory, `${sub}.json`), JSON.stringify(findings));
    return { directory, locator, read, report };
  }

  async function repository(files: Readonly<Record<string, string>> = {}) {
    const root = await temporaryDirectory("railguard-secrets-repo-");
    const git = async (...args: string[]) => (await execute("git", args, { cwd: root })).stdout.trim();
    await git("init", "-q", "-b", "main");
    await git("config", "user.email", "dev@example.test");
    await git("config", "user.name", "Dev");
    await git("config", "commit.gpgsign", "false");
    await writeFile(join(root, "README.md"), "base\n");
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), content);
    }
    await git("add", ".");
    await git("commit", "-qm", "base");
    const base = await git("rev-parse", "HEAD");
    await git("checkout", "-qb", "feature");
    const commit = async (message: string, changes: Readonly<Record<string, string>>) => {
      for (const [path, content] of Object.entries(changes)) await writeFile(join(root, path), content);
      await git("add", ".");
      await git("commit", "-qm", message);
      return await git("rev-parse", "HEAD");
    };
    return { root, base, git, commit };
  }

  async function check(root: string, locator: ToolLocator, staged = false) {
    const request: CheckRequest = {
      repositoryRoot: root, unitRoot: ".", params: {}, inputs: {}, changes: await changeSets.read(root, undefined, { staged }),
    };
    return await new SecretCheckProvider(runner, changeSets, locator).run("secret-exposure", request);
  }

  const finding = (file: string, line: number, extra: Partial<Record<string, unknown>> = {}) => ({
    RuleID: "github-pat", File: file, StartLine: line, EndLine: line, Fingerprint: `${file}:github-pat:${line}`,
    Match: "REDACTED", Secret: "REDACTED", ...extra,
  });

  it("scans the branch's commits and its uncommitted files locally, hiding secret values", async () => {
    const fake = await scanner();
    const repo = await repository();
    await repo.commit("feature", { "app.go": "package app\n" });
    await writeFile(join(repo.root, "notes.txt"), "draft\n");

    const outcome = await check(repo.root, fake.locator);

    expect(outcome).toEqual({ status: "passed", summary: "No secret in the change", details: [] });
    const committed = (await fake.read("args-history.txt"))?.split("\n") ?? [];
    const uncommitted = (await fake.read("args-dir.txt"))?.split("\n") ?? [];
    const head = await repo.git("rev-parse", "HEAD");
    expect(committed[0]).toBe("dir");
    expect(committed.slice(committed.indexOf("--") + 1).filter(Boolean)).toEqual([`${head}/app.go`]);
    expect(await fake.read("history-files.txt")).toBe(`${head}/app.go\npackage app\n`);
    expect(uncommitted.slice(uncommitted.indexOf("--") + 1).filter(Boolean)).toEqual(["notes.txt"]);
    for (const args of [committed, uncommitted]) {
      expect(args).toEqual(expect.arrayContaining(["--redact", "--ignore-gitleaks-allow", "--exit-code", "0"]));
      expect(args[args.indexOf("--confidence") + 1]).toBe("medium");
      expect(args.some((arg) => arg.startsWith("--validation"))).toBe(false);
    }
  });

  it("fails on a secret in a commit even when the working tree no longer holds it", async () => {
    const fake = await scanner();
    const repo = await repository();
    const leaked = await repo.commit("leak", { "config.go": "package config\n" });
    await fake.report("history", [finding(`${leaked}/config.go`, 3)]);

    const outcome = await check(repo.root, fake.locator);

    expect(outcome.status).toBe("failed");
    expect(outcome.summary).toBe("1 secret(s) exposed by the change");
    expect(outcome.details[0]).toBe(
      `config.go:3: github-pat in commit ${leaked.slice(0, 12)} (fingerprint ${leaked}:config.go:github-pat:3)`,
    );
    expect(outcome.details.join("\n")).toContain("Never add a `Railguard-Allow` trailer yourself");
    expect(outcome.details.join("\n")).not.toContain("REDACTED");
  });

  it("reports an uncommitted secret only on lines the change touched", async () => {
    const fake = await scanner();
    const repo = await repository({ "settings.env": "A=1\nB=2\nC=3\n" });
    await writeFile(join(repo.root, "settings.env"), "A=1\nB=changed\nC=3\n");
    await fake.report("dir", [finding("settings.env", 1), finding("settings.env", 2)]);

    const outcome = await check(repo.root, fake.locator);

    expect(outcome.status).toBe("failed");
    expect(outcome.details[0]).toBe("settings.env:2: github-pat, not committed (fingerprint settings.env:github-pat:2)");
    expect(outcome.details).toHaveLength(3);
  });

  it("scans the staged content of a staged change, leaving unstaged and untracked files out", async () => {
    const fake = await scanner();
    const repo = await repository({ "settings.env": "A=1\nB=2\n" });
    await writeFile(join(repo.root, "settings.env"), "A=1\nB=staged\n");
    await repo.git("add", "settings.env");
    await writeFile(join(repo.root, "settings.env"), "A=1\nB=unstaged\n");
    await writeFile(join(repo.root, "notes.env"), "C=untracked\n");

    const outcome = await check(repo.root, fake.locator, true);

    expect(outcome.status).toBe("passed");
    expect(await fake.read("dir-files.txt")).toBe("settings.env\nA=1\nB=staged\n");
  });

  it("takes exceptions from the base, so a change cannot exempt itself", async () => {
    const fake = await scanner();
    const repo = await repository({ ".betterleaks.toml": "# base rules\n", ".betterleaksignore": "base-fingerprint\n" });
    await repo.commit("widen exceptions", { ".betterleaks.toml": "# allow everything\n", ".betterleaksignore": "new-fingerprint\n" });

    await check(repo.root, fake.locator);

    expect(await fake.read("config-history.toml")).toBe("# base rules\n");
    expect(await fake.read("ignore-history.txt")).toBe(".betterleaksignore\nbase-fingerprint\n");
  });

  it("places each commit's added lines at their line numbers and translates commit fingerprints", async () => {
    const fake = await scanner();
    const sha = "a".repeat(40);
    const repo = await repository({ "settings.env": "A=1\nB=2\nC=3\n", ".betterleaksignore": `${sha}:x.env:rule:1\nplain.env:rule:2\n` });
    const changed = await repo.commit("change", { "settings.env": "A=1\nB=2\nC=changed\nD=4\n" });

    await check(repo.root, fake.locator);

    expect(await fake.read("history-files.txt")).toBe(`${changed}/settings.env\n\n\nC=changed\nD=4\n`);
    expect(await fake.read("ignore-history.txt")).toBe(`.betterleaksignore\n${sha}:x.env:rule:1\nplain.env:rule:2\n${sha}/x.env:rule:1\n`);
  });

  it("extends the default rules when the base keeps no configuration", async () => {
    const fake = await scanner();
    const repo = await repository();
    await repo.commit("add config", { ".betterleaks.toml": "# allow everything\n" });

    await check(repo.root, fake.locator);

    expect(await fake.read("config-history.toml")).toBe("[extend]\nuseDefault = true\n");
    expect(await fake.read("ignore-history.txt")).toBeNull();
  });

  it("judges only what follows a commit where a person accepted the finding", async () => {
    const fake = await scanner();
    const repo = await repository();
    await repo.commit("leak", { "a.go": "package a\n" });
    await repo.git("commit", "--allow-empty", "-qm", "accept\n\nRailguard-Allow: secret-exposure: test fixture key");
    const accepted = await repo.git("rev-parse", "HEAD");
    const later = await repo.commit("later", { "b.go": "package b\n" });

    const outcome = await check(repo.root, fake.locator);

    expect(outcome.summary).toBe(`No secret in the change since ${accepted.slice(0, 12)} (accepted: test fixture key)`);
    const scanned = (await fake.read("args-history.txt"))?.split("\n") ?? [];
    expect(scanned.slice(scanned.indexOf("--") + 1).filter(Boolean)).toEqual([`${later}/b.go`]);
  });

  it("judges an agent's edit in the working tree only, without the commit history", async () => {
    const fake = await scanner();
    const repo = await repository();
    await repo.commit("leak", { "config.go": "package config\n" });
    await writeFile(join(repo.root, "edited.env"), "TOKEN=x\n");
    await writeFile(join(repo.root, "other.env"), "TOKEN=y\n");
    await fake.report("dir", [finding("edited.env", 1)]);
    const changes = await changeSets.read(repo.root);

    const outcome = await new SecretCheckProvider(runner, changeSets, fake.locator).run("secret-exposure", {
      repositoryRoot: repo.root, unitRoot: ".", params: {}, inputs: {}, paths: ["edited.env"],
      changes: { ...changes, files: new Map([...changes.files].filter(([path]) => path === "edited.env")) },
    });

    expect(outcome.details[0]).toBe("edited.env:1: github-pat, not committed (fingerprint edited.env:github-pat:1)");
    expect(await fake.read("args-history.txt")).toBeNull();
    const scanned = (await fake.read("args-dir.txt"))?.split("\n") ?? [];
    expect(scanned.slice(scanned.indexOf("--") + 1).filter(Boolean)).toEqual(["edited.env"]);
  });

  it("is unavailable, never passed, when Betterleaks cannot run", async () => {
    const fake = await scanner();
    const repo = await repository();
    await repo.commit("feature", { "a.go": "package a\n" });
    const missing: ToolLocator = { locate: async () => ({ unavailable: "betterleaks 1.8.1 could not be downloaded" }) };

    expect(await check(repo.root, missing)).toEqual({
      status: "unavailable",
      summary: "Betterleaks 1.8.1 is not available",
      details: ["betterleaks 1.8.1 could not be downloaded"],
    });
    await writeFile(join(fake.directory, "fail"), "");
    expect(await check(repo.root, fake.locator)).toEqual({
      status: "unavailable",
      summary: "Betterleaks could not scan the change",
      details: ["config error"],
    });
  });
});

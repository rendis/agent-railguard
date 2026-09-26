import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { createTempRepository } from "../helpers/temp-repository.js";
import { sha256 } from "../../src/domain/shared/types.js";

const execute = promisify(execFile);
const cliPath = resolve("dist/cli.js");
const engineVersion = (JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { version: string }).version;

beforeAll(async () => {
  await execute(process.execPath, ["esbuild.config.mjs"], { cwd: resolve(".") });
}, 30_000);

describe.sequential("production CLI contract", () => {
  it("exposes help/version and never opens a hidden prompt without a TTY", async () => {
    expect((await cli(["--version"])).stdout.trim()).toBe(engineVersion);
    expect((await cli(["--help"])).stdout).toContain("railguard [options] [command]");
    const noCommand = await cli([]);
    expect(noCommand.code).toBe(2);
    expect(noCommand.stderr).toContain("requires a subcommand");
  });

  it("documents the complete non-interactive contract for agents", async () => {
    const rootHelp = (await cli(["--help"])).stdout;
    expect(rootHelp).toContain("--source <path>");
    expect(rootHelp).toContain("Content source precedence:");
    expect(rootHelp).toContain("Project content update:");
    expect(rootHelp).toContain("Engine update:");
    expect(rootHelp).toContain("Machine-readable operation:");
    expect(rootHelp).toContain("Exit codes:");
    expect(rootHelp).toContain("railguard issue bug|improvement");
    expect((await cli(["issue", "question"])).code).toBe(2);
    expect((await cli(["issue"])).code).toBe(2);
    expect((await cli(["scan", "--unknown"])).code).toBe(2);
    expect(rootHelp).toContain("codex | claude-code | opencode | cursor | vscode");
    expect(rootHelp).toContain("skill:NAME");
    expect(rootHelp).not.toContain("instruction-fragment:NAME");

    const initHelp = (await cli(["init", "--help"])).stdout;
    expect(initHelp).toContain("--recommended");
    expect(initHelp).toContain("--add <components...>");
    expect(initHelp).toContain("--harness <harnesses...>");
    expect(initHelp).toContain("Examples:");
    expect(initHelp).toContain("No prompt is opened");

    const syncHelp = (await cli(["sync", "--help"])).stdout;
    expect(syncHelp).toContain("project content");
    expect(syncHelp).toContain("--check");
    expect(syncHelp).toContain("--plan-only");
    expect(syncHelp).toContain("--yes");

    expect(rootHelp).toContain("re-run the install script");
    expect(rootHelp).toContain("railguard update --check|--plan-only|--yes");
    expect(rootHelp).toMatch(/^\s+update \[options\]\s+Move this repository to the latest Railguard/m);

    const mcpHelp = (await cli(["mcp", "--help"])).stdout;
    expect(mcpHelp).toContain("never read or");
    expect(mcpHelp).toContain("persist OAuth credentials");
    expect(mcpHelp).toContain("mcp status mcp:atlassian-rovo");
    const mcpStatusHelp = (await cli(["mcp", "status", "--help"])).stdout;
    expect(mcpStatusHelp).toContain("authentication-unknown");
    const mcpLoginHelp = (await cli(["mcp", "login", "--help"])).stdout;
    expect(mcpLoginHelp).toContain("UI-owned flows remain action_required");
    const mcpLogoutHelp = (await cli(["mcp", "logout", "--help"])).stdout;
    expect(mcpLogoutHelp).toContain("does not uninstall the");
    expect(mcpLogoutHelp).toContain("MCP, edit project files");

    for (const help of [["check", "--help"], ["verify", "--help"], ["review", "--help"], ["review", "record", "--help"]]) {
      expect((await cli(help)).stdout, help.join(" ")).toContain("Examples:");
    }
    expect((await cli(["verify", "--help"])).stdout).toContain("8 a check failed");
  });

  it("uses one global local source override before or after a CLI subcommand", async () => {
    const source = await localCatalogSource("9.9.9");
    try {
      for (const args of [
        ["--source", source, "catalog", "show", "skill:tdd", "--format", "json"],
        ["catalog", "show", "skill:tdd", "--source", source, "--format", "json"],
      ]) {
        const result = await cli(args);
        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          verdict: "READY",
          data: { component: { ref: "skill:tdd", version: "9.9.9" } },
          diagnostics: [
            expect.objectContaining({ code: "catalog.source.local" }),
          ],
        });
      }
    } finally {
      await rm(source, { recursive: true, force: true });
    }
  });

  it("keeps managed instruction mappings out of the public catalog", async () => {
    const result = await cli(["catalog", "list", "--format", "json"]);
    expect(result.code).toBe(0);
    const components = JSON.parse(result.stdout).data.components as { ref: string }[];
    expect(components.some(({ ref }) => ref.startsWith("instruction-fragment:"))).toBe(false);

    const hooks = await cli(["catalog", "list", "--type", "agent-hook", "--format", "json"]);
    expect(JSON.parse(hooks.stdout).data.components.map(({ ref }: { ref: string }) => ref)).toEqual(["agent-hook:stop-check"]);
  });

  it("blocks catalog work instead of falling back when an explicit source is unavailable", async () => {
    const result = await cli([
      "--source", join(tmpdir(), "railguard-definitely-missing-source"),
      "catalog", "list", "--format", "json",
    ]);

    expect(result.code).toBe(5);
    expect(JSON.parse(result.stdout)).toMatchObject({
      verdict: "BLOCKED",
      diagnostics: [expect.objectContaining({ code: "catalog.source.unavailable" })],
    });
  });

  it("syncs project content from a newer source without changing the engine", async () => {
    const repository = await goRepository("content-update");
    const sourceA = await localCatalogSource("0.1.0");
    const sourceB = await localCatalogSource("0.2.0");
    try {
      const installed = await cli([
        "init",
        "--add", "skill:tdd",
        "--harness", "codex",
        "--yes",
        "--cwd", repository.root,
        "--format", "json",
        "--source", sourceA,
      ]);
      expect(installed.code).toBe(0);
      expect(JSON.parse(installed.stdout).verdict).toBe("SUCCEEDED");

      const available = await cli([
        "sync", "--check",
        "--cwd", repository.root, "--format", "json",
        "--source", sourceB,
      ]);
      expect(available.code).toBe(6);
      expect(JSON.parse(available.stdout)).toMatchObject({
        verdict: "CHANGES_AVAILABLE",
        command: "sync",
      });

      const updated = await cli([
        "sync", "--yes",
        "--cwd", repository.root, "--format", "json",
        "--source", sourceB,
      ]);
      expect(updated.code).toBe(0);
      expect(JSON.parse(updated.stdout).verdict).toBe("SUCCEEDED");

      const current = await cli([
        "sync", "--check",
        "--cwd", repository.root, "--format", "json",
        "--source", sourceB,
      ]);
      expect(current.code).toBe(0);
      expect(JSON.parse(current.stdout).verdict).toBe("NO_CHANGES");
      expect((await cli(["--version"])).stdout.trim()).toBe(engineVersion);
    } finally {
      await Promise.all([
        repository.cleanup(),
        rm(sourceA, { recursive: true, force: true }),
        rm(sourceB, { recursive: true, force: true }),
      ]);
    }
  }, 60_000);

  it("keeps JSON atomic and NDJSON ordered for a read-only scan", async () => {
    const repository = await goRepository("scan");
    try {
      const json = await cli(["scan", "--cwd", repository.root, "--format", "json"]);
      expect(json.code).toBe(0);
      expect(json.stdout.trimEnd().split("\n")).toHaveLength(1);
      expect(JSON.parse(json.stdout)).toMatchObject({
        schema: "railguard/command-result/v1",
        command: "scan",
        verdict: "READY",
        repository: { languages: ["go"], management: "uninitialized" },
      });

      const ndjson = await cli(["scan", "--cwd", repository.root, "--format", "ndjson"]);
      expect(ndjson.code).toBe(0);
      const entries = ndjson.stdout.trimEnd().split("\n").map((line) => JSON.parse(line));
      expect(entries.at(-1)).toMatchObject({ type: "result", command: "scan" });
      const events = entries.slice(0, -1);
      expect(events.length).toBeGreaterThan(0);
      expect(events.map((entry) => entry.sequence)).toEqual(
        events.map((_, index) => index + 1),
      );
    } finally {
      await repository.cleanup();
    }
  }, 30_000);

  it("runs plan export, fresh apply, status, idempotent sync and exact remove", async () => {
    const repository = await goRepository("lifecycle");
    const outputDirectory = await mkdtemp(join(tmpdir(), "railguard-cli-plan-"));
    const planPath = join(outputDirectory, "plan.json");
    try {
      const planned = await cli([
        "plan",
        "--add",
        "pack:testing-foundation",
        "--harness",
        "codex",
        "--out",
        planPath,
        "--cwd",
        repository.root,
        "--format",
        "json",
      ]);
      expect(planned.code).toBe(0);
      const plan = JSON.parse(await readFile(planPath, "utf8"));
      expect(plan).toMatchObject({ schema: "railguard/plan/v1", mode: "reconcile" });
      expect((await stat(planPath)).mode & 0o777).toBe(0o600);

      const applied = await cli([
        "apply",
        "--plan",
        planPath,
        "--yes",
        "--cwd",
        repository.root,
        "--format",
        "json",
      ]);
      expect(applied.code).toBe(0);
      expect(JSON.parse(applied.stdout)).toMatchObject({
        command: "apply",
        verdict: "SUCCEEDED",
        plan: { plan_id: plan.plan_id },
        receipt: { plan_id: plan.plan_id, materialization: "committed" },
      });

      const status = await cli(["status", "--cwd", repository.root, "--format", "json"]);
      expect(JSON.parse(status.stdout)).toMatchObject({
        verdict: "READY",
        repository: { management: "managed", integrity: "clean" },
      });
      const sync = await cli([
        "sync",
        "--check",
        "--cwd",
        repository.root,
        "--format",
        "json",
      ]);
      expect(JSON.parse(sync.stdout).verdict).toBe("NO_CHANGES");

      const removed = await cli([
        "remove",
        "--all",
        "--yes",
        "--cwd",
        repository.root,
        "--format",
        "json",
      ]);
      expect(removed.code).toBe(0);
      expect(JSON.parse(removed.stdout)).toMatchObject({
        verdict: "SUCCEEDED",
        plan: { mode: "remove", desired_after: null },
      });
      await expect(readFile(join(repository.root, "AGENTS.md"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await Promise.all([
        repository.cleanup(),
        rm(outputDirectory, { recursive: true, force: true }),
      ]);
    }
  }, 60_000);

  it("validates typed --set input and rejects ambiguous mutation flags", async () => {
    const repository = await goRepository("typed-input");
    try {
      const invalid = await cli([
        "init",
        "--add",
        "verification-profile:go-quality",
        "--harness",
        "codex",
        "--yes",
        "--plan-only",
        "--cwd",
        repository.root,
        "--format",
        "json",
      ]);
      expect(invalid.code).toBe(2);
      expect(JSON.parse(invalid.stdout)).toMatchObject({ verdict: "INVALID_INPUT" });

      const installed = await cli([
        "init",
        "--add",
        "verification-profile:go-quality",
        "--set",
        'verification-profile:go-quality.test_packages=["./cmd/...","./internal/..."]',
        "--harness",
        "codex",
        "--yes",
        "--cwd",
        repository.root,
        "--format",
        "json",
      ]);
      expect(installed.code).toBe(0);
      expect(await readFile(join(repository.root, ".railguard/project.yaml"), "utf8")).toContain(
        "./cmd/...",
      );

      const already = await cli([
        "init",
        "--recommended",
        "--harness",
        "codex",
        "--plan-only",
        "--cwd",
        repository.root,
        "--format",
        "json",
      ]);
      expect(JSON.parse(already.stdout).verdict).toBe("ALREADY_INITIALIZED");
    } finally {
      await repository.cleanup();
    }
  }, 45_000);

  it("exits 2 on invalid input for commands that write their own report", async () => {
    const repository = await goRepository("direct-input");
    try {
      for (const args of [
        ["verify", "--format", "ndjson"],
        ["check", "--changed", "--base", ""],
        ["review", "--base", ""],
        ["hook", "stop", "--harness", "vscode"],
      ]) {
        const result = await cli([...args, "--cwd", repository.root]);
        expect(result.code, `${args.join(" ")}: ${result.stderr}`).toBe(2);
        expect(result.stderr).toContain("--help");
      }
      const unreviewable = await cli(["review", "record", join(repository.root, "missing.json"), "--cwd", repository.root]);
      expect(unreviewable.code).toBe(5);
    } finally {
      await repository.cleanup();
    }
  }, 30_000);

  it("updates a repository to another release and runs every command with its pinned engine", async () => {
    const repository = await goRepository("engine-update");
    const workspace = await mkdtemp(join(tmpdir(), "railguard-cli-update-"));
    try {
      const init = await cli(["init", "--add", "verification-profile:go-quality", "--harness", "codex", "--yes", "--cwd", repository.root]);
      expect(init.code, init.stderr).toBe(0);
      const launcher = join(repository.root, ".railguard/bin/railguard");
      const pinned = await readFile(launcher, "utf8");
      expect(pinned).toContain(`version=${engineVersion}\n`);

      const release = join(workspace, "release");
      const asset = `railguard-${process.platform}-${process.arch}`;
      const engine = '#!/bin/sh\nif [ "$1" = --version ]; then echo 9.9.9; exit 0; fi\necho "engine 9.9.9 ran $*"\n';
      await mkdir(release);
      await writeFile(join(release, asset), engine);
      await writeFile(join(release, "SHA256SUMS"), `${sha256(engine).slice("sha256:".length)}  ${asset}\n`);
      const environment = { XDG_CACHE_HOME: join(workspace, "cache"), RAILGUARD_DOWNLOAD_URL: `file://${release}` };

      const check = await cli(["update", "--check", "--to", "9.9.9", "--cwd", repository.root], environment);
      expect(check).toMatchObject({ code: 6, stdout: `Railguard 9.9.9 is available; this repository runs ${engineVersion}.\n` });

      const update = await cli(["update", "--yes", "--to", "9.9.9", "--cwd", repository.root], environment);
      expect(update.code, update.stderr).toBe(0);
      expect(update.stdout).toBe(`engine 9.9.9 ran sync --yes --cwd ${repository.root} --format text\n`);

      await writeFile(launcher, pinned.replace(`version=${engineVersion}`, "version=9.9.9"));
      const delegated = await cli(["status", "--cwd", repository.root], environment);
      expect(delegated).toMatchObject({ code: 0, stdout: `engine 9.9.9 ran status --cwd ${repository.root}\n` });
      const unobtainable = await cli(["update", "--check", "--to", "9.9.10", "--cwd", repository.root], {
        ...environment,
        RAILGUARD_DOWNLOAD_URL: `file://${workspace}/missing`,
      });
      expect(unobtainable).toMatchObject({ code: 6, stdout: "Railguard 9.9.10 is available; this repository runs 9.9.9.\n" });
      const report = await cli(["issue", "bug", "--cwd", repository.root], environment);
      expect(report.code, report.stderr).toBe(0);
      expect(report.stdout).toContain(`- Railguard: ${engineVersion} (este repositorio fija 9.9.9)`);
      const draft = join(workspace, "issue.md");
      await writeFile(draft, "check --changed falla en <repo>.\n");
      expect(await cli(["issue", "--check", draft, "--cwd", repository.root], environment)).toMatchObject({ code: 0 });
      await writeFile(draft, `Falla en ${repository.root}.\n`);
      const leaked = await cli(["issue", "--check", draft, "--cwd", repository.root], environment);
      expect(leaked.code).toBe(8);
      expect(leaked.stdout).toContain(`${draft}:1:10 ruta absoluta: ${repository.root}`);
      expect((await cli(["issue", "bug", "--check", draft])).code).toBe(2);
      expect((await cli(["issue", "--check", join(workspace, "missing.md")])).code).toBe(2);
      await writeFile(launcher, pinned);

      await mkdir(join(workspace, "cache", "railguard"), { recursive: true });
      await writeFile(join(workspace, "cache", "railguard", "latest.json"), JSON.stringify({ checked_at: Date.now(), latest: "9.9.9" }));
      const notified = await cli(["status", "--cwd", repository.root, "--format", "json"], { ...environment, RAILGUARD_NO_UPDATE_CHECK: "", CI: "" });
      expect(notified.stderr).toContain(`railguard: Railguard 9.9.9 is available; this repository runs ${engineVersion}.`);
      expect(JSON.parse(notified.stdout)).toMatchObject({ command: "status" });
      const quietInCi = await cli(["status", "--cwd", repository.root], { ...environment, RAILGUARD_NO_UPDATE_CHECK: "", CI: "true" });
      expect(quietInCi.stderr).not.toContain("is available");
    } finally {
      await Promise.all([repository.cleanup(), rm(workspace, { recursive: true, force: true })]);
    }
  }, 60_000);

  it("activates the declared Git hooks in a clone that lacks them, but keeps a developer's own", async () => {
    const repository = await goRepository("gate-activation");
    try {
      const withoutProfile = await cli(["init", "--add", "git-gate:pre-commit-check", "--harness", "codex", "--yes", "--cwd", repository.root, "--format", "json"]);
      expect(withoutProfile.code).toBe(5);
      expect(JSON.parse(withoutProfile.stdout)).toMatchObject({
        verdict: "BLOCKED",
        diagnostics: expect.arrayContaining([expect.objectContaining({ code: "resolution.git-gate.profile-missing" })]),
      });
      expect((await cli(["init", "--add", "git-gate:pre-commit-check", "verification-profile:change-guard", "--harness", "codex", "--yes", "--cwd", repository.root])).code).toBe(0);
      const hooksPath = async () => (await execute("git", ["-C", repository.root, "config", "--get", "core.hooksPath"]).catch(() => ({ stdout: "" }))).stdout.trim();
      await execute("git", ["-C", repository.root, "config", "--unset", "core.hooksPath"]);

      const activated = await cli(["status", "--cwd", repository.root]);

      expect(activated.stderr).toContain("railguard: activated this repository's Git hooks (core.hooksPath=.railguard/hooks)");
      expect(activated.stdout).toContain("State: managed · clean");
      expect(await hooksPath()).toBe(".railguard/hooks");
      await execute("git", ["-C", repository.root, "config", "core.hooksPath", ".husky"]);
      expect((await cli(["status", "--cwd", repository.root])).stderr).not.toContain("activated");
      expect(await hooksPath()).toBe(".husky");
    } finally {
      await repository.cleanup();
    }
  });

  it("rejects an update outside a configured repository or to a malformed version", async () => {
    const repository = await goRepository("update-input");
    try {
      const unconfigured = await cli(["update", "--yes", "--to", "1.0.0", "--cwd", repository.root]);
      expect(unconfigured.code).toBe(2);
      expect(unconfigured.stderr).toContain("run install.sh again");
      expect((await cli(["update", "--yes", "--to", "latest", "--cwd", repository.root])).code).toBe(2);
      expect((await cli(["update", "--cwd", repository.root])).code).toBe(2);
    } finally {
      await repository.cleanup();
    }
  });

  it("supports catalog, doctor and repair queries", async () => {
    const repository = await goRepository("queries");
    try {
      const catalog = await cli(["catalog", "list", "--type", "mcp", "--format", "json"]);
      expect(JSON.parse(catalog.stdout)).toMatchObject({
        verdict: "READY",
        data: {
          kind: "catalog-list",
          components: [
            { ref: "mcp:atlassian-rovo", kind: "mcp-integration" },
            { ref: "mcp:context7", kind: "mcp-integration" },
          ],
        },
      });
      const shown = await cli([
        "catalog",
        "show",
        "mcp:context7",
        "--format",
        "json",
      ]);
      expect(JSON.parse(shown.stdout).data.component.ref).toBe("mcp:context7");

      const doctor = await cli(["doctor", "--cwd", repository.root, "--format", "json"]);
      expect(JSON.parse(doctor.stdout)).toMatchObject({
        data: { kind: "doctor" },
      });
      const repair = await cli([
        "repair",
        "--plan-only",
        "--cwd",
        repository.root,
        "--format",
        "json",
      ]);
      expect(repair.code).toBe(5);
      expect(JSON.parse(repair.stdout).verdict).toBe("BLOCKED");

    } finally {
      await repository.cleanup();
    }
  }, 45_000);

  it("configures Atlassian and exposes project-scoped native MCP authentication", async () => {
    const repository = await goRepository("atlassian-mcp");
    try {
      const installed = await cli([
        "init",
        "--add", "mcp:atlassian-rovo",
        "--harness", "claude-code",
        "--yes",
        "--cwd", repository.root,
        "--format", "json",
      ]);
      expect(installed.code).toBe(0);
      expect(JSON.parse(installed.stdout).verdict).toBe("SUCCEEDED");
      expect(await readFile(join(repository.root, ".mcp.json"), "utf8")).toContain(
        "https://mcp.atlassian.com/v1/mcp/authv2",
      );

      const status = await cli([
        "mcp", "status", "mcp:atlassian-rovo",
        "--harness", "claude-code",
        "--cwd", repository.root,
        "--format", "json",
      ]);
      expect(status.code).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({
        command: "mcp-status",
        verdict: "READY",
        data: {
          kind: "mcp-session",
          component: "mcp:atlassian-rovo",
          results: [{ target: "claude-code", state: "authentication-unknown" }],
        },
      });

      const login = await cli([
        "mcp", "login", "mcp:atlassian-rovo",
        "--harness", "claude-code",
        "--cwd", repository.root,
        "--format", "json",
      ]);
      expect(login.code).toBe(0);
      expect(JSON.parse(login.stdout)).toMatchObject({
        command: "mcp-login",
        verdict: "READY",
        data: {
          operation: "inspect",
          results: [{
            target: "claude-code",
            state: "authentication-unknown",
            action: { kind: "command", command: ["claude", "mcp", "list"] },
          }],
        },
      });
    } finally {
      await repository.cleanup();
    }
  }, 45_000);

  it("rejects a stale exported plan without mutating", async () => {
    const repository = await goRepository("stale");
    const outputDirectory = await mkdtemp(join(tmpdir(), "railguard-cli-stale-"));
    const planPath = join(outputDirectory, "plan.json");
    try {
      const planned = await cli([
        "plan",
        "--add",
        "skill:tdd",
        "--harness",
        "codex",
        "--out",
        planPath,
        "--cwd",
        repository.root,
        "--format",
        "json",
      ]);
      expect(planned.code).toBe(0);
      await writeFile(join(repository.root, "README.md"), "changed after review\n", "utf8");

      const applied = await cli([
        "apply",
        "--plan",
        planPath,
        "--yes",
        "--cwd",
        repository.root,
        "--format",
        "json",
      ]);
      expect(applied.code).toBe(5);
      expect(JSON.parse(applied.stdout)).toMatchObject({
        verdict: "BLOCKED",
        diagnostics: [
          expect.objectContaining({ code: "plan-import.repository-fingerprint-changed" }),
        ],
      });
      await expect(readFile(join(repository.root, ".railguard/project.yaml"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await Promise.all([
        repository.cleanup(),
        rm(outputDirectory, { recursive: true, force: true }),
      ]);
    }
  }, 45_000);

  it("rejects a plan output inside the target repository before writing it", async () => {
    const repository = await goRepository("inside-plan-output");
    const planPath = join(repository.root, "plan.json");
    try {
      const planned = await cli([
        "plan",
        "--add",
        "skill:tdd",
        "--harness",
        "codex",
        "--out",
        planPath,
        "--cwd",
        repository.root,
        "--format",
        "json",
      ]);
      expect(planned.code).toBe(2);
      expect(JSON.parse(planned.stdout)).toMatchObject({
        verdict: "INVALID_INPUT",
        diagnostics: [
          expect.objectContaining({
            message: expect.stringContaining("outside the target repository"),
          }),
        ],
      });
      await expect(readFile(planPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await repository.cleanup();
    }
  }, 30_000);
});

async function cli(
  args: readonly string[],
  environment: Readonly<NodeJS.ProcessEnv> = {},
) {
  try {
    const result = await execute(process.execPath, [cliPath, ...args], {
      cwd: resolve("."),
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: "1", RAILGUARD_NO_UPDATE_CHECK: "1", ...environment },
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === "number" ? failure.code : 70,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

async function goRepository(name: string) {
  const repository = await createTempRepository({
    "go.mod": `module example.com/${name}\n\ngo 1.24\n`,
    "README.md": `# ${name}\n`,
  });
  await execute("git", ["init", "--quiet", repository.root]);
  return repository;
}

async function localCatalogSource(version: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "railguard-cli-source-"));
  await mkdir(join(root, "skills"), { recursive: true });
  await cp(resolve("skills/tdd"), join(root, "skills/tdd"), { recursive: true });
  await writeFile(join(root, "railguard.yaml"), [
    "schema: railguard/v1",
    `version: ${version}`,
    "catalog:",
    "  skills:",
    "    tdd:",
    `      version: ${version}`,
    "      details: Apply a complete test-driven development workflow with explicit red, green and refactor evidence.",
    "      source: skills/tdd",
    "  mcps: {}",
    "  verification-profiles: {}",
    "  git-gates: {}",
    "  instruction-fragments: {}",
    "  packs: {}",
    "  agents: {}",
    "",
  ].join("\n"), "utf8");
  return root;
}

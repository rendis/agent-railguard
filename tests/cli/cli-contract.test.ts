import { execFile } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, opendir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { createTempRepository } from "../helpers/temp-repository.js";
import { sha256 } from "../../src/domain/shared/types.js";

const execute = promisify(execFile);
const cliPath = resolve("dist/cli.js");

beforeAll(async () => {
  await execute(process.execPath, ["esbuild.config.mjs"], { cwd: resolve(".") });
}, 30_000);

describe.sequential("production CLI contract", () => {
  it("exposes help/version and never opens a hidden prompt without a TTY", async () => {
    expect((await cli(["--version"])).stdout.trim()).toBe("0.1.0");
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

    expect(rootHelp).toContain("Re-run the install script");
    expect(rootHelp).not.toMatch(/^\s+update\b/m);

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
      expect((await cli(["--version"])).stdout.trim()).toBe("0.1.0");
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
      await expect(readFile(join(repository.root, "Makefile"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });

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
      env: { ...process.env, NO_COLOR: "1", ...environment },
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

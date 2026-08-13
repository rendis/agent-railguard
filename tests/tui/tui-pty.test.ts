import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { createTempRepository } from "../helpers/temp-repository.js";

const execute = promisify(execFile);
const cli = resolve("dist/cli.js");
const ptyRunner = resolve("scripts/verification/pty-runner.py");

describe("production TUI PTY", () => {
  beforeAll(async () => {
    await execute(process.execPath, ["esbuild.config.mjs"], {
      cwd: resolve("."),
      timeout: 30_000,
    });
    await execute("python3", ["--version"], { timeout: 5_000 });
  }, 35_000);

  it("responds to a live resize and restores terminal state on exit", async () => {
    const repository = await createTempRepository({
      "go.mod": "module example.com/tui-pty\n\ngo 1.24\n",
    });
    const control = await mkdtemp(join(tmpdir(), "ai-harness-pty-"));
    const resizeFile = join(control, "viewport");
    await execute("git", ["init", "--quiet", repository.root]);
    await writeFile(resizeFile, "160x40\n", "utf8");

    const child = spawn("python3", [
      ptyRunner,
      "--columns", "160",
      "--rows", "40",
      "--resize-file", resizeFile,
      "--",
      process.execPath,
      cli,
      "--cwd", repository.root,
    ], {
      cwd: resolve("."),
      env: {
        ...process.env,
        NO_COLOR: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      output += chunk;
    });

    try {
      await waitFor(
        () => output.includes("SCAN COMPLETE"),
        15_000,
        () => output,
      );
      const beforeResize = output.length;
      await writeFile(resizeFile, "120x30\n", "utf8");
      await waitFor(
        () => output.slice(beforeResize).includes("SCAN COMPLETE") && output.slice(beforeResize).includes("[d] Scan details"),
        20_000,
        () => output.slice(beforeResize),
      );

      child.stdin.write("q");
      const exit = await waitForExit(child, 20_000);

      expect(exit.signal).toBeNull();
      expect(exit.code, output.slice(-4_000)).toBe(0);
      expect(output).toContain("\u001B[?1049h\u001B[?25l");
      expect(output).toContain("\u001B[?25h\u001B[?1049l");
      expect(output).toContain(
        "AI Harness: session closed | management=uninitialized | integrity=unknown | no repository changes applied",
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await Promise.all([repository.cleanup(), rm(control, { recursive: true, force: true })]);
    }
  }, 100_000);

  it("uses the global local content source before the mandatory TUI scan", async () => {
    const repository = await createTempRepository({
      "go.mod": "module example.com/tui-local-source\n\ngo 1.24\n",
    });
    const source = await tuiContentSource();
    const resizeFile = join(source, ".tui-viewport");
    await execute("git", ["init", "--quiet", repository.root]);
    await writeFile(resizeFile, "140x36\n", "utf8");
    const child = spawn("python3", [
      ptyRunner,
      "--columns", "140",
      "--rows", "36",
      "--resize-file", resizeFile,
      "--",
      process.execPath,
      cli,
      "--source", source,
      "--cwd", repository.root,
    ], {
      cwd: resolve("."),
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.stderr.on("data", (chunk: string) => { output += chunk; });

    try {
      await waitFor(
        () => output.includes("SCAN COMPLETE"),
        20_000,
        () => output,
      );
      child.stdin.write("\r");
      await waitFor(() => output.includes("COMPONENTS"), 20_000, () => output);
      child.stdin.write("\u001B[C");
      await waitFor(() => output.includes("Local Only Go"), 20_000, () => output);
      child.stdin.write("q");
      const exit = await waitForExit(child, 20_000);
      expect(exit.code, output.slice(-4_000)).toBe(0);
      expect(exit.signal).toBeNull();
      expect(output).toContain("Local content source ready");
      expect(output).toContain("AI Harness: session closed");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await Promise.all([
        repository.cleanup(),
        rm(source, { recursive: true, force: true }),
      ]);
    }
  }, 70_000);
});

async function tuiContentSource(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ai-harness-tui-source-"));
  const skill = join(root, "skills", "local-only-go");
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, "SKILL.md"), [
    "---",
    "name: local-only-go",
    "description: Configure a local-only Go workflow for the TUI source contract.",
    "---",
    "",
    "# Local only Go",
    "",
    "Use the local content source selected for this invocation.",
    "",
  ].join("\n"), "utf8");
  await writeFile(join(root, "ai-harness.yaml"), [
    "schema: ai-harness/v1",
    "version: 9.9.9",
    "catalog:",
    "  skills:",
    "    local-only-go:",
    "      version: 9.9.9",
    "      details: Configure and use the complete local-only Go workflow from this explicit content source.",
    "      source: skills/local-only-go",
    "      applies:",
    "        languages: [go]",
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

async function waitFor(
  predicate: () => boolean,
  timeout: number,
  evidence: () => string,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`Timed out waiting for PTY output:\n${evidence().slice(-4_000)}`);
}

async function waitForExit(
  child: ReturnType<typeof spawn>,
  timeout: number,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await new Promise((resolveExit, reject) => {
    const timeoutId = setTimeout(() => reject(new Error("Timed out waiting for PTY exit")), timeout);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timeoutId);
      resolveExit({ code, signal });
    });
  });
}

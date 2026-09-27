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

describe("interactive wizard in a PTY", () => {
  beforeAll(async () => {
    await execute(process.execPath, ["esbuild.config.mjs"], {
      cwd: resolve("."),
      timeout: 30_000,
    });
    await execute("python3", ["--version"], { timeout: 5_000 });
  }, 35_000);

  it("quits from the main menu when q is pressed", async () => {
    const repository = await createTempRepository({});
    const control = await mkdtemp(join(tmpdir(), "railguard-pty-"));
    const session = startPty(control, ["--cwd", repository.root]);
    try {
      await session.answer("What do you want to do?", "q");
      const exit = await waitForExit(session.child, 20_000, session.output);

      expect(exit.code, session.output().slice(-4_000)).toBe(0);
      expect(session.output()).toContain("No repository changes applied.");
    } finally {
      session.stop();
      await Promise.all([repository.cleanup(), rm(control, { recursive: true, force: true })]);
    }
  }, 35_000);

  it("runs the interactive wizard in a real terminal and quits without changes", async () => {
    const repository = await createTempRepository({
      "go.mod": "module example.com/tui-pty\n\ngo 1.24\n",
    });
    const control = await mkdtemp(join(tmpdir(), "railguard-pty-"));
    await execute("git", ["init", "--quiet", repository.root]);
    const session = startPty(control, ["--cwd", repository.root]);
    try {
      await session.answer("What do you want to do?", "\u001B[A");
      expect(session.output()).toContain("Configure this repository");
      expect(session.output()).toContain("Stack        go");
      await session.answer("● Quit", "\r");
      const exit = await waitForExit(session.child, 20_000, session.output);

      expect(exit.signal).toBeNull();
      expect(exit.code, session.output().slice(-4_000)).toBe(0);
      expect(session.output()).toContain("No repository changes applied.");
    } finally {
      session.stop();
      await Promise.all([repository.cleanup(), rm(control, { recursive: true, force: true })]);
    }
  }, 60_000);

  it("uses the global local content source for the catalog it offers", async () => {
    const repository = await createTempRepository({
      "go.mod": "module example.com/tui-local-source\n\ngo 1.24\n",
    });
    const source = await tuiContentSource();
    await execute("git", ["init", "--quiet", repository.root]);
    const session = startPty(source, ["--source", source, "--cwd", repository.root]);
    try {
      await session.answer("What do you want to do?", "\r");
      await session.answer("local-only-go", "\u0003");
      await session.answer("What do you want to do?", "\u001B[A");
      await session.answer("● Quit", "\r");
      const exit = await waitForExit(session.child, 20_000, session.output);
      expect(exit.code, session.output().slice(-4_000)).toBe(0);
    } finally {
      session.stop();
      await Promise.all([repository.cleanup(), rm(source, { recursive: true, force: true })]);
    }
  }, 60_000);
});

function startPty(control: string, args: readonly string[]) {
  const resizeFile = join(control, ".tui-viewport");
  const child = spawn("python3", [
    ptyRunner, "--columns", "140", "--rows", "40", "--resize-file", resizeFile, "--",
    process.execPath, cli, ...args,
  ], { cwd: resolve("."), env: { ...process.env, NO_COLOR: "1", RAILGUARD_NO_UPDATE_CHECK: "1" }, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  let answered = 0;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { output += chunk; });
  child.stderr.on("data", (chunk: string) => { output += chunk; });
  const visible = () => output.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "");
  return {
    child,
    output: visible,
    /** Waits for `prompt` to render after the previous answer, then types `keys`. */
    answer: async (prompt: string, keys: string) => {
      await waitFor(() => visible().slice(answered).includes(prompt), 20_000, visible);
      answered = visible().length;
      child.stdin.write(keys);
    },
    stop: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    },
  };
}

async function tuiContentSource(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "railguard-tui-source-"));
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
  await writeFile(join(root, "railguard.yaml"), [
    "schema: railguard/v1",
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
  evidence: () => string = () => "",
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await new Promise((resolveExit, reject) => {
    const timeoutId = setTimeout(() => reject(new Error(`Timed out waiting for PTY exit:\n${evidence().slice(-4_000)}`)), timeout);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timeoutId);
      resolveExit({ code, signal });
    });
  });
}

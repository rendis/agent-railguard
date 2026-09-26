import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

let windowsShell: string | undefined;

/** A POSIX shell: `sh`, or on Windows the `sh.exe` that Git for Windows installs next to git. */
export function posixShell(platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return "sh";
  windowsShell ??= findWindowsShell();
  return windowsShell;
}

/**
 * The command and leading arguments that run an executable POSIX shell script. Windows does not
 * run a script by itself, so there it goes through the shell.
 */
export function posixScript(script: string, platform: NodeJS.Platform = process.platform): {
  readonly command: string;
  readonly args: readonly string[];
} {
  return platform === "win32" ? { command: posixShell(platform), args: [script] } : { command: script, args: [] };
}

function findWindowsShell(): string {
  const configured = process.env.RAILGUARD_SH;
  if (configured) return configured;
  try {
    // `git --exec-path` is <git root>/<mingw64|clangarm64>/libexec/git-core.
    const root = resolve(execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(), "..", "..", "..");
    for (const candidate of [join(root, "bin", "sh.exe"), join(root, "usr", "bin", "sh.exe")]) {
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // Fall through to sh on PATH.
  }
  return "sh";
}

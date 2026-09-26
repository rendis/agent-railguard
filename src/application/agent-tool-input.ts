import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { StopHookHarness } from "./agent-stop-hook.js";

/** A tool call a harness reported to a hook: a shell command, or the repository files it edits. */
export type ToolAction =
  | { readonly kind: "shell"; readonly command: string }
  /** Repository-relative POSIX paths; paths outside the repository are left out. */
  | { readonly kind: "files"; readonly paths: readonly string[] };

/**
 * Reads the tool call from a hook's stdin: `Bash` or `Shell` commands, Claude Code and Cursor file
 * tools (`file_path` and similar fields) and Codex `apply_patch` envelopes.
 */
export function parseToolAction(harness: StopHookHarness, source: string, root: string): ToolAction | null {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(source) as Record<string, unknown>;
  } catch {
    return null;
  }
  const tool = typeof value.tool_name === "string" ? value.tool_name : "";
  // Relative paths are relative to the session's working directory, not the repository root.
  const cwd = typeof value.cwd === "string" && value.cwd.length > 0 ? value.cwd : root;
  const input = isRecord(value.tool_input) ? value.tool_input : {};
  if (tool === "Bash" || tool === "Shell") {
    return typeof input.command === "string" ? { kind: "shell", command: input.command } : null;
  }
  const given = harness === "codex" && tool === "apply_patch"
    ? typeof input.command === "string" ? patchedPaths(input.command) : []
    : [input, ...(Array.isArray(input.edits) ? input.edits.filter(isRecord) : [])]
        .flatMap((entry) => [entry.file_path, entry.path, entry.target_file, entry.notebook_path])
        .filter((path): path is string => typeof path === "string" && path.length > 0);
  if (given.length === 0) return null;
  const paths = given
    .map((path) => repositoryRelative(root, resolve(cwd, path)))
    .filter((path): path is string => path !== null);
  return { kind: "files", paths: [...new Set(paths)] };
}

/** Files an apply_patch envelope adds, updates, deletes or moves to. */
function patchedPaths(patch: string): readonly string[] {
  const paths: string[] = [];
  for (const match of patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gmu)) {
    paths.push((match[1] as string).trim());
  }
  return paths;
}

/** The path relative to the repository root in POSIX form, or null when it lies outside it. */
function repositoryRelative(root: string, path: string): string | null {
  const posix = relative(root, realLocation(path)).split(sep).join("/");
  if (posix.length === 0 || posix === ".." || posix.startsWith("../") || isAbsolute(posix)) return null;
  return posix;
}

/**
 * Resolves symbolic links in the part of a path that exists, such as macOS's /var to /private/var,
 * so a path the harness spells differently still compares with the repository root.
 */
function realLocation(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(realLocation(parent), basename(path));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Cursor also runs the hooks in `.claude/settings.json`, passing its own input. When the repository
 * has Cursor's own Railguard hooks, those already handle the event, so the Claude Code copy invoked
 * by Cursor does nothing instead of deciding, blocking and recording twice. Without them, the
 * Claude Code copy is Cursor's only guardrail and runs.
 */
export function isDuplicateCursorInvocation(harness: StopHookHarness, source: string, root: string): boolean {
  if (harness !== "claude-code") return false;
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return false;
  }
  if (!isRecord(value) || typeof value.cursor_version !== "string") return false;
  try {
    return readFileSync(join(root, ".cursor", "hooks.json"), "utf8").includes(".railguard/agent-hooks/");
  } catch {
    return false;
  }
}

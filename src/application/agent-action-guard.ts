import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { matchesAnyGlob } from "../domain/verification/change-guard.js";
import type { StopHookHarness } from "./agent-stop-hook.js";

export interface ActionGuardRequest {
  readonly harness: StopHookHarness;
  /** Real path of the repository root. */
  readonly root: string;
  /** Raw JSON the harness wrote to the hook's stdin. */
  readonly input: string;
  /** Repository globs an agent must not edit, such as quality configuration. */
  readonly protectedPaths: readonly string[];
}

export interface ActionGuardResponse {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Paths an agent never edits with its file tools: the guardrails themselves and Git's internals.
 * Railguard changes them through `railguard sync`, and a person decides what they hold.
 */
const guardrailPaths = [".railguard/**", ".git/**", ".codex/hooks.json", ".cursor/hooks.json"];

const trailerReason =
  "Only a person may add a `Railguard-Allow` trailer: it accepts a guard finding on their authority. Fix the finding instead, or ask the user to accept it.";

/**
 * Refuses a command or file edit that would bypass the guardrails instead of satisfying them.
 * It is a guardrail, not a sandbox: the harness may run tools that skip hooks, and Git gates,
 * `change-guard` and review still judge the result.
 */
export function guardAction(request: ActionGuardRequest): ActionGuardResponse {
  const action = parseAction(request.harness, request.input);
  const reason = action === null ? null : refusal(action, request);
  return respond(request.harness, reason);
}

type Action =
  | { readonly kind: "shell"; readonly command: string }
  /** Paths as the tool gave them, relative ones against the session's working directory. */
  | { readonly kind: "files"; readonly cwd: string | null; readonly paths: readonly string[] };

function parseAction(harness: StopHookHarness, source: string): Action | null {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(source) as Record<string, unknown>;
  } catch {
    return null;
  }
  const tool = typeof value.tool_name === "string" ? value.tool_name : "";
  const cwd = typeof value.cwd === "string" && value.cwd.length > 0 ? value.cwd : null;
  const input = isRecord(value.tool_input) ? value.tool_input : {};
  if (tool === "Bash" || tool === "Shell") {
    return typeof input.command === "string" ? { kind: "shell", command: input.command } : null;
  }
  if (harness === "codex" && tool === "apply_patch") {
    return typeof input.command === "string" ? { kind: "files", cwd, paths: patchedPaths(input.command) } : null;
  }
  const paths = [input, ...(Array.isArray(input.edits) ? input.edits.filter(isRecord) : [])]
    .flatMap((entry) => [entry.file_path, entry.path, entry.target_file, entry.notebook_path])
    .filter((path): path is string => typeof path === "string" && path.length > 0);
  return paths.length === 0 ? null : { kind: "files", cwd, paths };
}

function refusal(action: Action, request: ActionGuardRequest): string | null {
  if (action.kind === "shell") return shellRefusal(action.command);
  for (const path of action.paths) {
    const repositoryPath = repositoryRelative(request.root, resolve(action.cwd ?? request.root, path));
    if (repositoryPath === null) continue;
    if (matchesAnyGlob(repositoryPath, guardrailPaths)) {
      return `${repositoryPath} belongs to the guardrails or to Git itself. Leave it to the user; Railguard changes it through \`railguard sync\`.`;
    }
    if (matchesAnyGlob(repositoryPath, request.protectedPaths)) {
      return `${repositoryPath} is a protected quality configuration. Fix the code instead of changing the rules; if the rule itself is wrong, ask the user to change it.`;
    }
  }
  return null;
}

function shellRefusal(command: string): string | null {
  if (/railguard-allow/iu.test(command)) return trailerReason;
  if (/(?:^|\s)--no-verify(?:\s|$)/u.test(command) || /\bgit\b.*\bcommit\b.*\s-n(?:\s|$)/u.test(command)) {
    return "Do not skip the Git hooks: they run the checks this repository requires. Fix what fails instead.";
  }
  if (/core\.hookspath/iu.test(command) && !/\bgit\s+config\s+(?:--get|--get-all|--list|-l)\b/u.test(command)) {
    return "Do not change core.hooksPath: it activates the Git hooks this repository requires.";
  }
  return null;
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

function respond(harness: StopHookHarness, reason: string | null): ActionGuardResponse {
  if (harness === "cursor") {
    // Cursor treats a permission hook without valid JSON as a refusal, so allowing is explicit.
    const payload = reason === null
      ? { permission: "allow" }
      : { permission: "deny", user_message: `Railguard refused this action: ${reason}`, agent_message: reason };
    return { stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
  }
  if (reason === null) return { stdout: "", stderr: "" };
  const payload = {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
  };
  return { stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

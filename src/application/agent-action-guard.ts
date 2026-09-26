import { matchesAnyGlob } from "../domain/verification/change-guard.js";
import type { StopHookHarness } from "./agent-stop-hook.js";
import { parseToolAction, type ToolAction } from "./agent-tool-input.js";

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
  const action = parseToolAction(request.harness, request.input, request.root);
  const reason = action === null ? null : refusal(action, request);
  return respond(request.harness, reason);
}

function refusal(action: ToolAction, request: ActionGuardRequest): string | null {
  if (action.kind === "shell") return shellRefusal(action.command);
  for (const repositoryPath of action.paths) {
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

import type { GuardRule } from "../domain/activity/model.js";
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
  /** The rule that refused the action, or null when it may proceed. */
  readonly refused: GuardRule | null;
}

/**
 * Paths an agent never edits with its file tools: the guardrails themselves and Git's internals.
 * Railguard changes them through `railguard sync`, and a person decides what they hold.
 */
const guardrailPaths = [".railguard/**", ".git/**", ".codex/hooks.json", ".cursor/hooks.json"];

const trailerReason =
  "Only a person may add a `Railguard-Allow` trailer: it accepts a guard finding on their authority. Fix the finding instead. When the check asks for a justification, write a `Railguard-Justify: <kind>: <reason>` trailer, which is yours to write. Otherwise, if the change is intended, ask for a person's acceptance with a `Railguard-Request: <check-kind>: <reason>` trailer in an empty commit made before the change, then open a pull request for them to approve.";

/**
 * Refuses a command or file edit that would bypass the guardrails instead of satisfying them.
 * It is a guardrail, not a sandbox: the harness may run tools that skip hooks, and Git gates,
 * `change-guard` and review still judge the result.
 */
export function guardAction(request: ActionGuardRequest): ActionGuardResponse {
  const action = parseToolAction(request.harness, request.input, request.root);
  const refused = action === null ? null : refusal(action, request);
  return { ...respond(request.harness, refused?.reason ?? null), refused: refused?.rule ?? null };
}

interface Refusal {
  readonly rule: GuardRule;
  readonly reason: string;
}

function refusal(action: ToolAction, request: ActionGuardRequest): Refusal | null {
  if (action.kind === "shell") return shellRefusal(action.command);
  for (const repositoryPath of action.paths) {
    if (matchesAnyGlob(repositoryPath, guardrailPaths)) {
      return {
        rule: "guardrail-path",
        reason: `${repositoryPath} belongs to the guardrails or to Git itself. Leave it to the user; Railguard changes it through \`railguard sync\`.`,
      };
    }
    if (matchesAnyGlob(repositoryPath, request.protectedPaths)) {
      return {
        rule: "protected-path",
        reason: `${repositoryPath} is a protected quality configuration. Fix the code instead of changing the rules; if the rule itself is wrong, ask the user to change it.`,
      };
    }
  }
  return null;
}

function shellRefusal(command: string): Refusal | null {
  if (/railguard-allow/iu.test(command)) return { rule: "allow-trailer", reason: trailerReason };
  if (/(?:^|\s)--no-verify(?:\s|$)/u.test(command) || /\bgit\b.*\bcommit\b.*\s-n(?:\s|$)/u.test(command)) {
    return {
      rule: "skip-hooks",
      reason: "Do not skip the Git hooks: they run the checks this repository requires. Fix what fails instead.",
    };
  }
  if (changesHooksPath(command)) {
    return { rule: "hooks-path", reason: "Do not change core.hooksPath: it activates the Git hooks this repository requires." };
  }
  return null;
}

/**
 * Whether a shell command changes or overrides core.hooksPath: `git config` writing or unsetting it,
 * `git -c` or GIT_CONFIG_* overriding it, or an edit of `.git/config` that names it. A text that
 * only names the key, such as a heredoc written to a file or a search, changes nothing.
 */
function changesHooksPath(command: string): boolean {
  return executedLines(command).some((line) => {
    if (!/hookspath/iu.test(line)) return false;
    if (/\.git\/config\b/u.test(line) || /\bGIT_CONFIG_(?:PARAMETERS|KEY_\d+)\b/u.test(line)) return true;
    if (/\bgit\b[^;&|\n]*\s-c\s*core\.hookspath\b/iu.test(line)) return true;
    const config = /\bgit\b[^;&|\n]*\sconfig\b([^;&|\n]*)/iu.exec(line);
    if (config === null || !/\bcore\.hookspath\b/iu.test(config[1] ?? "")) return false;
    return !/\s(?:--get|--get-all|--get-regexp|--list|-l|get|list)(?=\s|$)/u.test(config[1] ?? "");
  });
}

const shellInterpreters = /^(?:sudo\s+)?(?:\S*\/)?(?:sh|bash|zsh|dash|ksh|fish|eval)\b/u;

/** The command's lines without the bodies of heredocs fed to a program other than a shell. */
function executedLines(command: string): string[] {
  const lines = command.split("\n");
  const executed: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    executed.push(line);
    for (const heredoc of line.matchAll(/(?<!<)<<(?!<)(-?)\s*(['"]?)([\w.-]+)\2/gu)) {
      const segment = line.slice(0, heredoc.index).split(/[;&|]/u).at(-1)?.trim() ?? "";
      const runsBody = shellInterpreters.test(segment);
      const delimiter = heredoc[3] ?? "";
      while (index + 1 < lines.length) {
        index += 1;
        const body = lines[index] ?? "";
        if ((heredoc[1] === "-" ? body.replace(/^\t+/u, "") : body) === delimiter) break;
        if (runsBody) executed.push(body);
      }
    }
  }
  return executed;
}

function respond(harness: StopHookHarness, reason: string | null): Omit<ActionGuardResponse, "refused"> {
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

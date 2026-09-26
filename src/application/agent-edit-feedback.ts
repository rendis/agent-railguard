import type { StopHookHarness } from "./agent-stop-hook.js";
import { parseToolAction } from "./agent-tool-input.js";
import type { VerificationReport, VerificationService } from "./verification-service.js";

/**
 * Checks that judge a single file on their own and run in well under a second, so an agent learns
 * about a suppression, a weakened configuration or a secret in the edit that introduced it. Stack
 * checks such as formatting and tests stay with the stop hook.
 */
export const editFeedbackKinds = ["change-integrity", "secret-exposure"] as const;

const maxContextLength = 8_000;

/**
 * Runs the file-scoped checks on the files a tool just edited and returns their failures to the
 * agent as context, in each harness's PostToolUse format. A pass or an unrelated tool adds nothing.
 */
export async function runEditFeedbackHook(
  request: { readonly harness: StopHookHarness; readonly root: string; readonly input: string },
  verification: Pick<VerificationService, "run">,
  render: (report: VerificationReport) => string,
): Promise<string> {
  const quiet = request.harness === "cursor" ? "{}\n" : "";
  const action = parseToolAction(request.harness, request.input, request.root);
  if (action?.kind !== "files" || action.paths.length === 0) return quiet;
  const report = await verification.run({
    root: request.root,
    stage: "check",
    changed: true,
    paths: action.paths,
    kinds: editFeedbackKinds,
  });
  if (report.verdict !== "failed") return quiet;
  const text = [
    `Railguard found problems in ${action.paths.join(", ")} right after your edit. Fix the cause now instead of hiding it:`,
    "",
    render(report).trimEnd(),
  ].join("\n");
  const context = text.length <= maxContextLength ? text : `${text.slice(0, maxContextLength)}\n… truncated`;
  const payload = request.harness === "cursor"
    ? { additional_context: context }
    : { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context } };
  return `${JSON.stringify(payload)}\n`;
}

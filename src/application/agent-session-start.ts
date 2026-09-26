import { unverifiedNotice, type UnverifiedChanges } from "../domain/verification/unverified-change.js";
import type { StopHookHarness } from "./agent-stop-hook.js";

/**
 * Tells a new agent session that an earlier one left the change unverified, as context in each
 * harness's SessionStart format. Without such a change it adds nothing.
 */
export async function runSessionStartHook(
  harness: StopHookHarness,
  root: string,
  unverified: Pick<UnverifiedChanges, "read">,
): Promise<string> {
  const change = await unverified.read(root);
  if (change === null) return harness === "cursor" ? "{}\n" : "";
  const context = unverifiedNotice(change);
  const payload = harness === "cursor"
    ? { additional_context: context }
    : { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } };
  return `${JSON.stringify(payload)}\n`;
}

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ActivityLog, AgentHarness } from "../domain/activity/model.js";
import { sha256 } from "../domain/shared/types.js";
import type { CheckStage } from "../domain/verification/checks.js";
import type { UnverifiedChanges } from "../domain/verification/unverified-change.js";
import { failedChecks, type VerificationReport, type VerificationService } from "./verification-service.js";

export type StopHookHarness = AgentHarness;

export interface StopHookRequest {
  readonly harness: StopHookHarness;
  readonly root: string;
  readonly stage: CheckStage;
  /** Raw JSON the harness wrote to the hook's stdin. */
  readonly input: string;
  /** Directory for the per-session retry counters. */
  readonly stateDirectory: string;
  readonly maxRetries?: number;
}

export interface StopHookResponse {
  readonly stdout: string;
  readonly stderr: string;
}

const defaultMaxRetries = 3;
const maxReasonLength = 8_000;

/**
 * Decides whether a coding agent may finish its turn. A failed change sends the report back to the
 * agent as its next instruction, at most `maxRetries` times per session; after that the agent may
 * stop, the change is reported as unverified and the next session is told about it until a later
 * run passes. Readiness problems (a tool that is not installed, a repository without selection)
 * never trap the agent in a loop: they are reported and allowed.
 */
export async function runStopHook(
  request: StopHookRequest,
  verification: Pick<VerificationService, "run">,
  render: (report: VerificationReport) => string,
  unverified: Pick<UnverifiedChanges, "record" | "clear">,
  activity: Pick<ActivityLog, "append">,
): Promise<StopHookResponse> {
  const input = parseInput(request.input);
  if (request.harness === "cursor" && input.status !== undefined && input.status !== "completed") {
    return { stdout: "", stderr: "" };
  }
  const counter = join(
    request.stateDirectory,
    sha256(`${request.root}\0${input.session ?? "default"}`).slice("sha256:".length, "sha256:".length + 24),
  );
  const report = await verification.run({ root: request.root, stage: request.stage, changed: true });
  if (report.verdict !== "failed") {
    await rm(counter, { force: true });
    if (report.verdict === "passed") await unverified.clear(request.root);
    return {
      stdout: "",
      stderr: report.verdict === "passed"
        ? ""
        : `Railguard could not verify this change (${report.verdict}); run \`railguard ${request.stage} --changed\` for details.\n`,
    };
  }
  const attempts = (await readAttempts(counter)) + 1;
  const maxRetries = request.maxRetries ?? defaultMaxRetries;
  if (attempts > maxRetries) {
    await rm(counter, { force: true });
    await activity.append(request.root, { type: "stop-unverified", harness: request.harness, checks: failedChecks(report) });
    await unverified.record(request.root, {
      schema: "railguard/unverified/v1",
      stage: request.stage,
      attempts: maxRetries,
      recordedAt: new Date().toISOString(),
      failures: report.results
        .filter((result) => result.outcome.status === "failed")
        .map((result) => `${result.profile.slice(result.profile.indexOf(":") + 1)}/${result.check}: ${result.outcome.summary}`),
    });
    return {
      stdout: "",
      stderr: `Railguard: the change is still failing after ${maxRetries} attempts and is NOT verified. Run \`railguard ${request.stage} --changed\`.\n`,
    };
  }
  await mkdir(request.stateDirectory, { recursive: true, mode: 0o700 });
  await writeFile(counter, String(attempts));
  await activity.append(request.root, { type: "stop-blocked", harness: request.harness, checks: failedChecks(report) });
  const reason = truncate([
    `Railguard \`${request.stage} --changed\` failed for this change (attempt ${attempts} of ${maxRetries}).`,
    "Fix every failure below without weakening tests or checks, then finish again.",
    "",
    render(report).trimEnd(),
  ].join("\n"));
  const payload = request.harness === "cursor"
    ? { followup_message: reason }
    : { decision: "block", reason };
  return { stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
}

function parseInput(source: string): { readonly session?: string; readonly status?: string } {
  try {
    const value = JSON.parse(source) as Record<string, unknown>;
    const session = [value.session_id, value.conversation_id].find(
      (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
    );
    return {
      ...(session === undefined ? {} : { session }),
      ...(typeof value.status === "string" ? { status: value.status } : {}),
    };
  } catch {
    return {};
  }
}

async function readAttempts(path: string): Promise<number> {
  try {
    const value = Number((await readFile(path, "utf8")).trim());
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function truncate(text: string): string {
  return text.length <= maxReasonLength
    ? text
    : `${text.slice(0, maxReasonLength)}\n… truncated; run the command locally for the full report.`;
}

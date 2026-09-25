import type {
  CheckResult,
  VerificationReport,
  VerificationVerdict,
} from "../application/verification-service.js";

export const verificationExitCodes: Readonly<Record<VerificationVerdict, number>> = Object.freeze({
  passed: 0,
  unavailable: 4,
  blocked: 5,
  failed: 8,
});

export function renderVerificationReport(report: VerificationReport, plain: boolean): string {
  const lines = [`Railguard ${report.stage} · ${scopeLabel(report)}`];
  for (const result of report.results) {
    lines.push(`  ${mark(result, plain)} ${label(result)}  ${result.outcome.summary}`);
    for (const detail of result.outcome.status === "passed" && result.outcome.details.length === 0 ? [] : result.outcome.details) {
      lines.push(`      ${detail}`);
    }
  }
  for (const diagnostic of report.diagnostics) {
    lines.push(`  ${diagnostic.severity.toUpperCase()} ${diagnostic.code}: ${diagnostic.message}`);
    if (diagnostic.action !== null) lines.push(`      Next: ${diagnostic.action}`);
  }
  const counts = (["failed", "unavailable", "passed", "skipped"] as const)
    .map((status) => [status, report.results.filter((result) => result.outcome.status === status).length] as const)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${count} ${status}`);
  lines.push(`Result: ${report.verdict.toUpperCase()}${counts.length === 0 ? "" : ` — ${counts.join(", ")}`}`);
  if (report.verdict === "unavailable") {
    lines.push("A check could not run; fix the reported prerequisite. Unavailable never counts as a pass.");
  }
  return `${lines.join("\n")}\n`;
}

export function encodeVerificationReport(report: VerificationReport): string {
  return `${JSON.stringify({
    schema: "railguard/verification-report/v1",
    stage: report.stage,
    mode: report.mode,
    base: report.base,
    base_ref: report.baseRef,
    verdict: report.verdict,
    exit_code: verificationExitCodes[report.verdict],
    results: report.results.map((result) => ({
      profile: result.profile,
      check: result.check,
      kind: result.kind,
      unit: result.unit,
      status: result.outcome.status,
      summary: result.outcome.summary,
      details: result.outcome.details,
    })),
    diagnostics: report.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      severity: diagnostic.severity,
      message: diagnostic.message,
      action: diagnostic.action,
    })),
  })}\n`;
}

export function label(result: Pick<CheckResult, "profile" | "check" | "unit">): string {
  const profile = result.profile.slice("verification-profile:".length);
  return `${profile}/${result.check}${result.unit === "." ? "" : ` [${result.unit}]`}`;
}

function scopeLabel(report: VerificationReport): string {
  if (report.mode === "full") return "all project units";
  if (report.base === null) return "changed files (no base commit: every file counts as changed)";
  return `changes since ${report.baseRef ?? "base"} (${report.base.slice(0, 12)})`;
}

function mark(result: CheckResult, plain: boolean): string {
  const ascii = { passed: "ok  ", failed: "FAIL", skipped: "skip", unavailable: "N/A " } as const;
  const unicode = { passed: "✓", failed: "✗", skipped: "–", unavailable: "!" } as const;
  return (plain ? ascii : unicode)[result.outcome.status];
}

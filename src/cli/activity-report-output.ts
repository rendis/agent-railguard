import type { ActivityReport, Tally } from "../application/activity-report.js";

const recentAcceptances = 10;

export function renderActivityReport(report: ActivityReport): string {
  const lines = [`Railguard report · ${report.since === null ? "all history" : `since ${report.since}`}`, ""];
  lines.push(`Accepted findings (Railguard-Allow trailers from HEAD): ${report.acceptances.length}`);
  if (report.acceptances.length > 0) {
    lines.push(`  by check: ${inline(report.acceptancesByKind)}`);
    for (const acceptance of report.acceptances.slice(0, recentAcceptances)) {
      lines.push(`  ${acceptance.commit.slice(0, 12)} ${acceptance.date.slice(0, 10)} ${acceptance.author} · ${acceptance.kind}: ${acceptance.reason}`);
    }
    if (report.acceptances.length > recentAcceptances) {
      lines.push(`  … ${report.acceptances.length - recentAcceptances} older`);
    }
    lines.push("  Check that a person, not an agent, wrote each one.");
  }
  lines.push("");
  if (report.recordedSince === null) {
    lines.push("Agent hooks: no activity recorded on this clone yet.");
  } else {
    lines.push(`Agent hooks (recorded on this clone since ${report.recordedSince.slice(0, 10)}):`);
    lines.push(`  stop hook blocks: ${counted(report.stopBlocks.total, report.stopBlocks.checks)}`);
    lines.push(`  sessions left unverified: ${counted(report.unverifiedSessions.total, report.unverifiedSessions.checks)}`);
    lines.push(`  refused actions: ${counted(report.refusals.total, report.refusals.rules)}`);
    lines.push(`  flagged edits: ${counted(report.editFlags.total, report.editFlags.checks)}`);
    lines.push(`  by harness: ${inline(report.harnesses)}`);
  }
  lines.push("");
  const pending = report.pendingUnverified;
  lines.push(pending === null
    ? "Unverified change: none."
    : `Unverified change: an agent session left it failing \`railguard ${pending.stage} --changed\` on ${pending.recordedAt.slice(0, 10)}:`);
  for (const failure of pending?.failures ?? []) lines.push(`  ${failure}`);
  return `${lines.join("\n")}\n`;
}

export function encodeActivityReport(report: ActivityReport): string {
  return `${JSON.stringify({
    schema: "railguard/activity-report/v1",
    since: report.since,
    acceptances: report.acceptances,
    acceptances_by_check: report.acceptancesByKind,
    recorded_since: report.recordedSince,
    stop_blocks: report.stopBlocks,
    unverified_sessions: report.unverifiedSessions,
    refused_actions: report.refusals,
    flagged_edits: report.editFlags,
    harnesses: report.harnesses,
    unverified_change: report.pendingUnverified,
  })}\n`;
}

function counted(total: number, tally: Tally): string {
  return total === 0 ? "0" : `${total} (${inline(tally)})`;
}

function inline(tally: Tally): string {
  return tally.length === 0 ? "none" : tally.map((entry) => `${entry.name} ${entry.count}`).join(", ");
}

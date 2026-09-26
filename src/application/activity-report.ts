import type { Acceptance, AcceptanceHistory, ActivityLog, RecordedActivity } from "../domain/activity/model.js";
import type { UnverifiedChange, UnverifiedChanges } from "../domain/verification/unverified-change.js";

/** Counts by name, most frequent first. */
export type Tally = readonly { readonly name: string; readonly count: number }[];

/**
 * How the guardrails behave on this clone: which findings people accepted, how often agent hooks
 * blocked or flagged work and on which checks, and whether a change is left unverified. It answers
 * which rules earn their place, not whether the current change passes.
 */
export interface ActivityReport {
  readonly since: string | null;
  readonly acceptances: readonly Acceptance[];
  readonly acceptancesByKind: Tally;
  /** Time of the oldest agent hook event recorded on this clone, or null without events. */
  readonly recordedSince: string | null;
  readonly stopBlocks: { readonly total: number; readonly checks: Tally };
  readonly unverifiedSessions: { readonly total: number; readonly checks: Tally };
  readonly refusals: { readonly total: number; readonly rules: Tally };
  readonly editFlags: { readonly total: number; readonly checks: Tally };
  readonly harnesses: Tally;
  readonly pendingUnverified: UnverifiedChange | null;
}

export async function buildActivityReport(
  root: string,
  since: string | null,
  sources: {
    readonly history: AcceptanceHistory;
    readonly activity: Pick<ActivityLog, "read">;
    readonly unverified: Pick<UnverifiedChanges, "read">;
  },
): Promise<ActivityReport> {
  const acceptances = await sources.history.read(root, since);
  const events = (await sources.activity.read(root)).filter((event) => since === null || event.at >= since);
  const of = <T extends RecordedActivity["type"]>(type: T) =>
    events.filter((event): event is Extract<RecordedActivity, { type: T }> => event.type === type);
  const stops = of("stop-blocked");
  const unverified = of("stop-unverified");
  const refusals = of("action-refused");
  const edits = of("edit-flagged");
  return {
    since,
    acceptances,
    acceptancesByKind: tally(acceptances.map((acceptance) => acceptance.kind)),
    recordedSince: events.reduce<string | null>((oldest, event) => (oldest === null || event.at < oldest ? event.at : oldest), null),
    stopBlocks: { total: stops.length, checks: tally(stops.flatMap((event) => event.checks)) },
    unverifiedSessions: { total: unverified.length, checks: tally(unverified.flatMap((event) => event.checks)) },
    refusals: { total: refusals.length, rules: tally(refusals.map((event) => event.rule)) },
    editFlags: { total: edits.length, checks: tally(edits.flatMap((event) => event.checks)) },
    harnesses: tally(events.map((event) => event.harness)),
    pendingUnverified: await sources.unverified.read(root),
  };
}

function tally(names: readonly string[]): Tally {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

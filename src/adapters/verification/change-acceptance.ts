import { pendingSuffix } from "../../domain/verification/acceptance.js";
import { parseAllowances, parseRequests } from "../../domain/verification/change-guard.js";
import {
  changesAt,
  type ChangeSet,
  type ChangeSetReader,
  type CheckOutcome,
  type CheckRequest,
  type ProcessRunner,
} from "../../domain/verification/checks.js";

/**
 * How a finding of a check can be accepted:
 *
 * - A `Railguard-Allow: <check-kind>: <reason>` trailer, made by a person, accepts what the branch
 *   held at that commit, such as work that predates adopting Railguard. Later changes are judged
 *   from that commit on.
 * - A `Railguard-Request: <check-kind>: <reason>` trailer, which an agent may write, asks a person
 *   to accept what is still failing. It accepts nothing: the check ends `pending`, which does not
 *   block locally and which CI resolves with the pull request's approval.
 */
export class ChangeAcceptance {
  public constructor(
    private readonly process: ProcessRunner,
    private readonly changeSets: ChangeSetReader,
  ) {}

  public async judge(
    request: CheckRequest,
    kind: string,
    judge: (scope: ChangeSet) => Promise<CheckOutcome>,
  ): Promise<CheckOutcome> {
    const trailers = await this.#trailers(request.repositoryRoot, request.changes.base);
    const accepted = trailers.allowed.get(kind) ?? null;
    let outcome: CheckOutcome;
    if (accepted === null) {
      outcome = await judge(request.changes);
    } else {
      const since = await this.changeSets.read(request.repositoryRoot, accepted.commit, { staged: request.changes.staged });
      const judged = await judge(changesAt(since, request.paths));
      const label = `since ${accepted.commit.slice(0, 12)} (accepted: ${accepted.reason})`;
      outcome = { ...judged, summary: `${judged.summary} ${label}` };
    }
    if (outcome.status !== "failed") return outcome;
    const requested = trailers.requested.get(kind);
    if (requested === undefined) return { ...outcome, details: [...outcome.details, requestAdvice(kind)] };
    return {
      status: "pending",
      summary: `${outcome.summary}${pendingSuffix}`,
      details: outcome.details,
      requested,
    };
  }

  async #trailers(
    root: string,
    base: string | null,
  ): Promise<{
    readonly allowed: ReadonlyMap<string, { readonly commit: string; readonly reason: string }>;
    readonly requested: ReadonlyMap<string, string>;
  }> {
    const allowed = new Map<string, { readonly commit: string; readonly reason: string }>();
    const requested = new Map<string, string>();
    if (base === null) return { allowed, requested };
    const log = await this.process.run("git", ["log", "--format=%H%x1f%B%x1e", `${base}..HEAD`], { cwd: root, timeoutMs: 60_000 });
    if (log.exitCode !== 0) return { allowed, requested };
    // Newest first: the latest trailer of a kind decides.
    for (const entry of log.stdout.split("\x1e")) {
      const [commit, message] = entry.trim().split("\x1f");
      if (commit === undefined || message === undefined) continue;
      for (const [kind, reason] of parseAllowances(message)) if (!allowed.has(kind)) allowed.set(kind, { commit, reason });
      for (const [kind, reason] of parseRequests(message)) if (!requested.has(kind)) requested.set(kind, reason);
    }
    return { allowed, requested };
  }
}

/**
 * What an agent does with a finding it cannot or should not fix. The request goes into a commit of
 * its own, before the change it covers, because a commit is checked before its message exists.
 */
function requestAdvice(kind: string): string {
  return [
    `If the change is intended, ask a person to accept it instead: \`git commit --allow-empty -m "chore: request acceptance of ${kind}" -m "Railguard-Request: ${kind}: <why this is right>"\`, then commit the change and open a pull request.`,
    "The finding then stays pending, and CI passes it only when a configured approver approves the pull request.",
    "Never write a `Railguard-Allow` trailer yourself: only a person may accept what the branch holds so far.",
  ].join(" ");
}

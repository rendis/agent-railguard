import { parseAllowances } from "../../domain/verification/change-guard.js";
import {
  changesAt,
  type ChangeSet,
  type ChangeSetReader,
  type CheckOutcome,
  type CheckRequest,
  type ProcessRunner,
} from "../../domain/verification/checks.js";

/**
 * A `Railguard-Allow: <check-kind>: <reason>` trailer accepts what the branch held at that commit,
 * such as work that predates adopting Railguard. Later changes are judged from that commit on.
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
    const accepted = await this.#acceptedCommit(request.repositoryRoot, request.changes.base, kind);
    if (accepted === null) return await judge(request.changes);
    const outcome = await judge(changesAt(await this.changeSets.read(request.repositoryRoot, accepted.commit), request.paths));
    const since = `since ${accepted.commit.slice(0, 12)} (accepted: ${accepted.reason})`;
    return { ...outcome, summary: `${outcome.summary} ${since}` };
  }

  async #acceptedCommit(
    root: string,
    base: string | null,
    kind: string,
  ): Promise<{ readonly commit: string; readonly reason: string } | null> {
    if (base === null) return null;
    const log = await this.process.run("git", ["log", "--format=%H%x1f%B%x1e", `${base}..HEAD`], { cwd: root, timeoutMs: 60_000 });
    if (log.exitCode !== 0) return null;
    for (const entry of log.stdout.split("\x1e")) {
      const [commit, message] = entry.trim().split("\x1f");
      const reason = message === undefined ? undefined : parseAllowances(message).get(kind);
      if (commit !== undefined && reason !== undefined) return { commit, reason };
    }
    return null;
  }
}

import type { Acceptance, AcceptanceHistory } from "../../domain/activity/model.js";
import { parseAllowances } from "../../domain/verification/change-guard.js";
import type { ProcessRunner } from "../../domain/verification/checks.js";

/** `Railguard-Allow` trailers in the commits reachable from HEAD. */
export class GitAcceptanceHistory implements AcceptanceHistory {
  public constructor(private readonly process: ProcessRunner) {}

  public async read(root: string, since: string | null): Promise<readonly Acceptance[]> {
    const log = await this.process.run(
      "git",
      ["log", "--format=%H%x1f%aI%x1f%an%x1f%B%x1e", ...(since === null ? [] : [`--since=${since}`]), "HEAD", "--"],
      { cwd: root, timeoutMs: 120_000 },
    );
    if (log.exitCode !== 0) return [];
    return log.stdout.split("\x1e").flatMap((entry) => {
      const [commit, date, author, message] = entry.trim().split("\x1f");
      if (commit === undefined || date === undefined || author === undefined || message === undefined) return [];
      return [...parseAllowances(message)].map(([kind, reason]) => ({ commit, date, author, kind, reason }));
    });
  }
}

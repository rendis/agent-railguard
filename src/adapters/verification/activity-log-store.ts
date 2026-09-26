import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ActivityLog, AgentActivity, RecordedActivity } from "../../domain/activity/model.js";
import type { ProcessRunner } from "../../domain/verification/checks.js";

const maxLogBytes = 1024 * 1024;

/**
 * One JSON line per agent hook event in the repository's common Git directory, so every worktree
 * of a clone shares it and nothing is versioned. Recording is best effort: a hook never fails
 * because its activity could not be written. The oldest half is dropped past 1 MiB.
 */
export class ActivityLogStore implements ActivityLog {
  public constructor(
    private readonly process: ProcessRunner,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async append(root: string, activity: AgentActivity): Promise<void> {
    try {
      const path = await this.#path(root);
      if (path === null) return;
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify({ at: this.now().toISOString(), ...activity })}\n`);
      if ((await stat(path)).size > maxLogBytes) {
        const lines = (await readFile(path, "utf8")).split("\n").filter((line) => line.length > 0);
        await writeFile(path, `${lines.slice(Math.floor(lines.length / 2)).join("\n")}\n`);
      }
    } catch {
      // Activity is a report aid; the hook's decision must not depend on it.
    }
  }

  public async read(root: string): Promise<readonly RecordedActivity[]> {
    const path = await this.#path(root);
    if (path === null) return [];
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      return [];
    }
    return text.split("\n").flatMap((line) => {
      try {
        const value = JSON.parse(line) as RecordedActivity;
        return typeof value.at === "string" && typeof value.type === "string" ? [value] : [];
      } catch {
        return [];
      }
    });
  }

  async #path(root: string): Promise<string | null> {
    const result = await this.process.run("git", ["rev-parse", "--git-common-dir"], { cwd: root, timeoutMs: 30_000 });
    return result.exitCode === 0 ? join(resolve(root, result.stdout.trim()), "railguard", "activity.jsonl") : null;
  }
}

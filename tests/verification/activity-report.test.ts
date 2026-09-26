import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { NodeProcessRunner } from "../../src/adapters/platform/process/node-process-runner.js";
import { GitAcceptanceHistory } from "../../src/adapters/verification/acceptance-history.js";
import { ActivityLogStore } from "../../src/adapters/verification/activity-log-store.js";
import { buildActivityReport } from "../../src/application/activity-report.js";
import { encodeActivityReport, renderActivityReport } from "../../src/cli/activity-report-output.js";
import type { RecordedActivity } from "../../src/domain/activity/model.js";

const execute = promisify(execFile);
const runner = new NodeProcessRunner();
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function repository() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "railguard-report-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const git = async (args: readonly string[], date = "2026-09-01T10:00:00Z") =>
    (await execute("git", [...args], {
      cwd: root,
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    })).stdout.trim();
  await git(["init", "-q", "-b", "main"]);
  await git(["config", "user.email", "dev@example.test"]);
  await git(["config", "user.name", "Dev"]);
  await git(["config", "commit.gpgsign", "false"]);
  await git(["commit", "--allow-empty", "-qm", "init"]);
  return { root, git };
}

describe("activity log", () => {
  it("shares one log across the worktrees of a clone and skips unreadable lines", async () => {
    const { root, git } = await repository();
    const linked = `${root}-linked`;
    cleanups.push(() => rm(linked, { recursive: true, force: true }));
    await git(["worktree", "add", "-q", linked]);
    const log = new ActivityLogStore(runner, () => new Date("2026-09-26T12:00:00Z"));

    await log.append(root, { type: "action-refused", harness: "codex", rule: "skip-hooks" });
    await log.append(linked, { type: "edit-flagged", harness: "cursor", checks: ["change-guard/integrity"] });
    const path = join(root, ".git", "railguard", "activity.jsonl");
    await writeFile(path, `${await readFile(path, "utf8")}not json\n`);

    expect(await log.read(linked)).toEqual([
      { at: "2026-09-26T12:00:00.000Z", type: "action-refused", harness: "codex", rule: "skip-hooks" },
      { at: "2026-09-26T12:00:00.000Z", type: "edit-flagged", harness: "cursor", checks: ["change-guard/integrity"] },
    ]);
    expect(await new ActivityLogStore(runner).read(tmpdir())).toEqual([]);
  });

  it("drops the oldest half once the log passes 1 MiB", async () => {
    const { root } = await repository();
    const log = new ActivityLogStore(runner);
    await log.append(root, { type: "stop-blocked", harness: "claude-code", checks: ["go-quality/test"] });
    const path = join(root, ".git", "railguard", "activity.jsonl");
    const line = (await readFile(path, "utf8")).trim();
    await writeFile(path, `${`${line}\n`.repeat(Math.ceil((1024 * 1024) / line.length))}`);

    await log.append(root, { type: "stop-unverified", harness: "claude-code", checks: ["go-quality/test"] });

    expect((await stat(path)).size).toBeLessThan(600 * 1024);
    expect((await log.read(root)).at(-1)?.type).toBe("stop-unverified");
  });
});

describe("railguard report", () => {
  it("counts accepted findings from HEAD and agent hook activity from a date on", async () => {
    const { root, git } = await repository();
    await git(["commit", "--allow-empty", "-qm", "old\n\nRailguard-Allow: change-size: legacy import"], "2026-08-01T10:00:00Z");
    await git(["commit", "--allow-empty", "-qm", "fixture\n\nRailguard-Allow: secret-exposure: revoked test key"], "2026-09-20T10:00:00Z");
    await git(["commit", "--allow-empty", "-qm", "both\n\nRailguard-Allow: change-size: generated\nRailguard-Allow: change-integrity: vendored"], "2026-09-21T10:00:00Z");
    const events: RecordedActivity[] = [
      { at: "2026-08-02T00:00:00Z", type: "stop-blocked", harness: "codex", checks: ["go-quality/test"] },
      { at: "2026-09-22T00:00:00Z", type: "stop-blocked", harness: "claude-code", checks: ["go-quality/test", "secret-guard/secrets"] },
      { at: "2026-09-22T01:00:00Z", type: "stop-blocked", harness: "claude-code", checks: ["go-quality/test"] },
      { at: "2026-09-22T02:00:00Z", type: "stop-unverified", harness: "claude-code", checks: ["go-quality/test"] },
      { at: "2026-09-23T00:00:00Z", type: "action-refused", harness: "cursor", rule: "protected-path" },
      { at: "2026-09-23T00:00:00Z", type: "edit-flagged", harness: "cursor", checks: ["change-guard/integrity"] },
    ];
    const sources = {
      history: new GitAcceptanceHistory(runner),
      activity: { async read() { return events; } },
      unverified: { async read() { return null; } },
    };

    const report = await buildActivityReport(root, "2026-09-01", sources);

    expect(report.acceptances.map(({ kind, reason, date }) => ({ kind, reason, day: date.slice(0, 10) }))).toEqual([
      { kind: "change-size", reason: "generated", day: "2026-09-21" },
      { kind: "change-integrity", reason: "vendored", day: "2026-09-21" },
      { kind: "secret-exposure", reason: "revoked test key", day: "2026-09-20" },
    ]);
    expect(report).toMatchObject({
      acceptancesByKind: [{ name: "change-integrity", count: 1 }, { name: "change-size", count: 1 }, { name: "secret-exposure", count: 1 }],
      recordedSince: "2026-09-22T00:00:00Z",
      stopBlocks: { total: 2, checks: [{ name: "go-quality/test", count: 2 }, { name: "secret-guard/secrets", count: 1 }] },
      unverifiedSessions: { total: 1, checks: [{ name: "go-quality/test", count: 1 }] },
      refusals: { total: 1, rules: [{ name: "protected-path", count: 1 }] },
      editFlags: { total: 1, checks: [{ name: "change-guard/integrity", count: 1 }] },
      harnesses: [{ name: "claude-code", count: 3 }, { name: "cursor", count: 2 }],
    });
    expect((await buildActivityReport(root, null, sources)).acceptances).toHaveLength(4);

    const text = renderActivityReport(report);
    expect(text).toContain("Accepted findings (Railguard-Allow trailers from HEAD): 3");
    expect(text).toContain("stop hook blocks: 2 (go-quality/test 2, secret-guard/secrets 1)");
    expect(text).toContain("refused actions: 1 (protected-path 1)");
    expect(text).toContain("Unverified change: none.");
    expect(JSON.parse(encodeActivityReport(report))).toMatchObject({
      schema: "railguard/activity-report/v1",
      since: "2026-09-01",
      refused_actions: { total: 1 },
      unverified_change: null,
    });
  });

  it("reports an empty clone and a pending unverified change plainly", async () => {
    const { root } = await repository();

    const text = renderActivityReport(await buildActivityReport(root, null, {
      history: new GitAcceptanceHistory(runner),
      activity: new ActivityLogStore(runner),
      unverified: {
        async read() {
          return { schema: "railguard/unverified/v1", stage: "check", attempts: 3, recordedAt: "2026-09-26T20:00:00Z", failures: ["go-quality/test: 1 failed"] };
        },
      },
    }));

    expect(text).toContain("Accepted findings (Railguard-Allow trailers from HEAD): 0");
    expect(text).toContain("Agent hooks: no activity recorded on this clone yet.");
    expect(text).toContain("Unverified change: an agent session left it failing `railguard check --changed` on 2026-09-26:\n  go-quality/test: 1 failed");
  });
});

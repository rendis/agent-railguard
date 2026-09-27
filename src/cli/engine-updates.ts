import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { engineVersion, releaseRepository } from "../application/engine-release.js";
import {
  compareVersions,
  refreshLatest,
  updateNotice,
  type LatestRelease,
} from "../application/engine-update.js";
import { engineCacheRoot } from "../adapters/platform/engine-cache/engine-cache.js";
import { GitHubLatestRelease } from "../adapters/platform/release/github-latest-release.js";
import { NodeProcessRunner } from "../adapters/platform/process/node-process-runner.js";
import { posixScript } from "../adapters/platform/process/posix-shell.js";
import {
  engineUnavailable,
  launcherBody,
  launcherPath,
  pinnedVersion,
} from "../adapters/project/quality/launcher.js";
import { CommandInputError } from "./command-runner.js";

/** Set for every engine started by Railguard itself, so it never delegates again. */
const launchedVariable = "RAILGUARD_LAUNCHED";

function latestReleaseSource(): LatestRelease {
  return new GitHubLatestRelease(new NodeProcessRunner(), releaseRepository);
}

export function latestCacheFile(environment: NodeJS.ProcessEnv = process.env): string {
  return join(engineCacheRoot(environment), "latest.json");
}

/** The command that starts this same engine, whether it runs as a Bun binary or a Node bundle. */
function selfCommand(): { readonly command: string; readonly prefix: readonly string[] } {
  const bun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
  return { command: process.execPath, prefix: bun ? [] : [process.argv[1] ?? ""] };
}

/**
 * Runs the command with the engine version the repository pins when this engine is a different
 * one, as a global `railguard` must never rewrite a repository with another version. Returns the
 * exit status of the pinned engine, or null when this engine is the right one.
 */
export function delegateToPinnedEngine(root: string, args: readonly string[]): number | null {
  if (process.env[launchedVariable] === "1") return null;
  const launcherFile = repositoryLauncher(root);
  const pinned = repositoryPinnedVersion(root);
  if (launcherFile === null || pinned === null || pinned === engineVersion) return null;
  const launcher = posixScript(launcherFile);
  const result = spawnSync(launcher.command, [...launcher.args, ...args], {
    stdio: "inherit",
    env: { ...process.env, [launchedVariable]: "1" },
  });
  return result.status ?? 1;
}

/**
 * The engine version the launcher of the repository containing `root` pins, or null outside a
 * configured repository.
 */
export function repositoryPinnedVersion(root: string): string | null {
  const launcher = repositoryLauncher(root);
  return launcher === null ? null : pinnedVersion(readFileSync(launcher, "utf8"));
}

/** The launcher at `root` or, from a subdirectory, at the root of its Git worktree. */
function repositoryLauncher(root: string): string | null {
  const direct = join(root, launcherPath);
  if (existsSync(direct)) return direct;
  const topLevel = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" });
  if (topLevel.status !== 0) return null;
  const launcher = join(topLevel.stdout.trim(), launcherPath);
  return existsSync(launcher) ? launcher : null;
}

/** Prints the update notice on stderr; it never delays or fails the command that just ran. */
export async function printUpdateNotice(): Promise<void> {
  if (process.env.CI || process.env.RAILGUARD_NO_UPDATE_CHECK === "1") return;
  const notice = await updateNotice(engineVersion, {
    cacheFile: latestCacheFile(),
    now: Date.now(),
    refresh: () => {
      const { command, prefix } = selfCommand();
      spawn(command, [...prefix, "refresh-latest"], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, [launchedVariable]: "1" },
      }).unref();
    },
  });
  if (notice !== null) process.stderr.write(`railguard: ${notice}\n`);
}

export async function runRefreshLatest(): Promise<void> {
  await refreshLatest(latestReleaseSource(), latestCacheFile(), Date.now);
}

export interface UpdateRequest {
  readonly root: string;
  readonly action: "check" | "plan" | "apply";
  /** An exact version to pin instead of the latest release, which also allows going back. */
  readonly to: string | undefined;
  readonly format: "text" | "json";
}

/**
 * Moves the repository to another engine version as one reviewable change: the target engine runs
 * `sync`, which rewrites the launcher with its own version and the content it ships. The target is
 * obtained exactly as the launcher would obtain it, so it is downloaded and verified once.
 */
export async function runUpdate(request: UpdateRequest, source: LatestRelease = latestReleaseSource()): Promise<number> {
  if (!existsSync(join(request.root, ".railguard", "project.yaml"))) {
    throw new CommandInputError(
      "This repository is not configured by Railguard. To update the railguard command itself, run install.sh again.",
    );
  }
  const launcher = join(request.root, launcherPath);
  const current = existsSync(launcher) ? pinnedVersion(readFileSync(launcher, "utf8")) ?? engineVersion : engineVersion;
  const latest = request.to ?? await refreshLatest(source, latestCacheFile(), Date.now);
  if (latest === null) {
    process.stderr.write(
      `railguard: the latest release of ${releaseRepository} could not be determined; authenticate with gh auth login or pass --to <version>.\n`,
    );
    return 4;
  }
  const newer = compareVersions(latest, current) > 0;
  if (request.action === "check") {
    if (request.format === "json") {
      process.stdout.write(`${JSON.stringify({ schema: "railguard/update-check/v1", current, latest, update_available: newer })}\n`);
    } else {
      process.stdout.write(newer ? `Railguard ${latest} is available; this repository runs ${current}.\n` : `Railguard ${current} is current.\n`);
    }
    return newer ? 6 : 0;
  }
  if (request.to === undefined && !newer) {
    process.stdout.write(`Railguard ${current} is current; nothing to update.\n`);
    return 0;
  }
  const scratch = await mkdtemp(join(tmpdir(), "railguard-update-"));
  try {
    const target = join(scratch, "railguard");
    await writeFile(target, launcherBody({ version: latest, repository: releaseRepository }));
    await chmod(target, 0o755);
    const launcher = posixScript(target);
    const result = spawnSync(
      launcher.command,
      [...launcher.args, "sync", request.action === "apply" ? "--yes" : "--plan-only", "--cwd", request.root, "--format", request.format],
      { stdio: "inherit", env: { ...process.env, [launchedVariable]: "1" } },
    );
    if (result.status === engineUnavailable) return 4;
    return result.status ?? 1;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

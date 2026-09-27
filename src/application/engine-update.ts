import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface LatestRelease {
  /** The newest published engine version, or null when it cannot be determined. */
  latest(): Promise<string | null>;
}

interface LatestCache {
  readonly checked_at: number;
  readonly latest: string | null;
}

/** How long a known latest version is trusted before it is checked again. */
export const updateCheckIntervalMs = 24 * 60 * 60 * 1000;

/** Orders stable SemVer versions: negative when `left` is older than `right`. */
export function compareVersions(left: string, right: string): number {
  const parts = (version: string) => version.split(".").map(Number);
  const [a, b] = [parts(left), parts(right)];
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * A notice when the cached latest release is newer than `current`. It never touches the network:
 * when the cache is missing or older than a day it records the attempt and calls `refresh`, which
 * starts a detached process, so the command in progress never waits for or fails on GitHub.
 */
export async function updateNotice(
  current: string,
  options: { readonly cacheFile: string; readonly now: number; readonly refresh: () => void },
): Promise<string | null> {
  const cached = await readLatestCache(options.cacheFile);
  if (cached === null || options.now - cached.checked_at >= updateCheckIntervalMs) {
    await writeLatestCache(options.cacheFile, { checked_at: options.now, latest: cached?.latest ?? null });
    options.refresh();
  }
  const latest = cached?.latest ?? null;
  if (latest === null || compareVersions(latest, current) <= 0) return null;
  return [
    `Railguard ${latest} is available; this repository runs ${current}.`,
    "Update it with `railguard update --yes`, which pins the new version for the whole repository.",
    "Coding agents: tell the user and ask whether to update; never update without asking.",
  ].join(" ");
}

/** Asks for the latest release and records the answer, including "unknown", for a day. */
export async function refreshLatest(source: LatestRelease, cacheFile: string, now: () => number): Promise<string | null> {
  const latest = await source.latest();
  await writeLatestCache(cacheFile, { checked_at: now(), latest });
  return latest;
}

/** The latest release the daily check recorded, without touching the network. */
export async function cachedLatest(file: string): Promise<string | null> {
  return (await readLatestCache(file))?.latest ?? null;
}

async function readLatestCache(file: string): Promise<LatestCache | null> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as Partial<LatestCache>;
    if (typeof value.checked_at !== "number") return null;
    return {
      checked_at: value.checked_at,
      latest: typeof value.latest === "string" && /^\d+\.\d+\.\d+$/u.test(value.latest) ? value.latest : null,
    };
  } catch {
    return null;
  }
}

async function writeLatestCache(file: string, value: LatestCache): Promise<void> {
  try {
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(value)}\n`);
    await rename(temporary, file);
  } catch {
    // The notice is best effort: an unwritable cache only means checking again next time.
  }
}

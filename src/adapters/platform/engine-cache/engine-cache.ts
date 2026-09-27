import { readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CachedEngine } from "../../../interaction/engine-versions.js";

const versionPattern = /^\d+\.\d+\.\d+$/u;

/** Where launchers keep downloaded engines, one directory per version, and the latest-release cache. */
export function engineCacheRoot(environment: NodeJS.ProcessEnv = process.env): string {
  return join(environment.XDG_CACHE_HOME || join(homedir(), ".cache"), "railguard");
}

/** The engines launchers cached under `root`, newest first. */
export async function cachedEngines(root: string): Promise<CachedEngine[]> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const engines: CachedEngine[] = [];
  for (const version of entries.filter((entry) => versionPattern.test(entry))) {
    for (const name of ["railguard", "railguard.exe"]) {
      const info = await stat(join(root, version, name)).catch(() => null);
      if (info?.isFile() === true) {
        engines.push({ version, bytes: info.size });
        break;
      }
    }
  }
  return engines.sort((left, right) => right.version.localeCompare(left.version, "en", { numeric: true }));
}

/** Removes cached engine versions; a launcher that needs one again downloads it. */
export async function removeCachedEngines(root: string, versions: readonly string[]): Promise<void> {
  for (const version of versions) {
    if (!versionPattern.test(version)) throw new Error(`not an engine version: ${version}`);
    await rm(join(root, version), { recursive: true, force: true });
  }
}

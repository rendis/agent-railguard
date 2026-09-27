import { engineVersion } from "../application/engine-release.js";
import { cachedLatest } from "../application/engine-update.js";
import {
  cachedEngines,
  engineCacheRoot,
  removeCachedEngines,
} from "../adapters/platform/engine-cache/engine-cache.js";
import {
  engineRows,
  formatBytes,
  totalBytes,
  type EngineVersions,
  type EngineVersionsView,
} from "../interaction/engine-versions.js";
import { CommandInputError } from "./command-runner.js";
import { latestCacheFile, repositoryPinnedVersion } from "./engine-updates.js";

/** The engines cached on this machine, seen from the repository at `root`. */
export function engineVersions(root: string, environment: NodeJS.ProcessEnv = process.env): EngineVersions {
  const cacheRoot = engineCacheRoot(environment);
  return {
    view: async () => ({
      cacheRoot,
      engines: await cachedEngines(cacheRoot),
      running: engineVersion,
      pinned: repositoryPinnedVersion(root),
      latest: await cachedLatest(latestCacheFile(environment)),
    }),
    remove: (versions) => removeCachedEngines(cacheRoot, versions),
  };
}

export interface VersionsRequest {
  readonly remove: readonly string[];
  readonly yes: boolean;
}

/** Lists the cached engines, or removes the requested ones; returns the exit code. */
export async function runVersions(source: EngineVersions, request: VersionsRequest): Promise<number> {
  const view = await source.view();
  if (request.remove.length === 0) {
    process.stdout.write(renderEngineVersions(view));
    return 0;
  }
  const cached = new Set(view.engines.map((engine) => engine.version));
  const unknown = request.remove.filter((version) => !cached.has(version));
  if (unknown.length > 0) {
    throw new CommandInputError(
      `${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not cached; cached versions: ${[...cached].join(", ") || "none"}`,
    );
  }
  const versions = [...new Set(request.remove)];
  const size = formatBytes(totalBytes(view.engines, versions));
  if (!request.yes) {
    process.stdout.write(`Would remove ${versions.join(", ")} (${size}). Run again with --yes to remove them.\n`);
    return 6;
  }
  await source.remove(versions);
  const note = view.pinned !== null && versions.includes(view.pinned)
    ? `\nThis repository pins ${view.pinned}; its launcher downloads it again on the next command.`
    : "";
  process.stdout.write(`Removed ${versions.join(", ")} (${size}).${note}\n`);
  return 0;
}

export function renderEngineVersions(view: EngineVersionsView): string {
  if (view.engines.length === 0) return `No Railguard engines are cached in ${view.cacheRoot}.\n`;
  const total = formatBytes(totalBytes(view.engines, view.engines.map((engine) => engine.version)));
  return [
    `Railguard engines cached in ${view.cacheRoot}`,
    ...engineRows(view).map((row) => `  ${row}`),
    "",
    `${view.engines.length} version(s), ${total}. Remove some with railguard versions --remove VERSION... --yes`,
    "",
  ].join("\n");
}

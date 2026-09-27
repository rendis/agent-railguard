/** An engine release a launcher downloaded into the machine's cache. */
export interface CachedEngine {
  readonly version: string;
  readonly bytes: number;
}

export interface EngineVersionsView {
  readonly cacheRoot: string;
  readonly engines: readonly CachedEngine[];
  /** The version of the railguard command running now. */
  readonly running: string;
  /** The version the current repository pins, or null outside a configured repository. */
  readonly pinned: string | null;
  /** The latest release last seen by the daily check, or null when unknown. */
  readonly latest: string | null;
}

/** The cached engines on this machine, shared by the `versions` command and the wizard. */
export interface EngineVersions {
  view(): Promise<EngineVersionsView>;
  remove(versions: readonly string[]): Promise<void>;
}

/** What makes a cached version worth keeping, in the order a reader looks for it. */
export function engineMarks(version: string, view: EngineVersionsView): string[] {
  return [
    ...(version === view.pinned ? ["this repository"] : []),
    ...(version === view.running ? ["running"] : []),
    ...(version === view.latest ? ["latest"] : []),
  ];
}

/** One aligned row per cached engine: version, size and marks. */
export function engineRows(view: EngineVersionsView): string[] {
  const width = Math.max(0, ...view.engines.map((engine) => engine.version.length));
  return view.engines.map((engine) => {
    const marks = engineMarks(engine.version, view);
    const size = formatBytes(engine.bytes).padStart(8);
    return `${engine.version.padEnd(width)}  ${size}${marks.length === 0 ? "" : `  ${marks.join(" · ")}`}`;
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function totalBytes(engines: readonly CachedEngine[], versions: readonly string[]): number {
  return engines.filter((engine) => versions.includes(engine.version)).reduce((sum, engine) => sum + engine.bytes, 0);
}

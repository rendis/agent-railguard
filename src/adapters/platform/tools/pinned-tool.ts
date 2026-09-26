import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProcessRunner } from "../../../domain/verification/checks.js";

export type ToolPlatform =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-arm64"
  | "linux-x64"
  | "windows-arm64"
  | "windows-x64";

export interface PinnedToolAsset {
  /** Release archive holding the executable at its root. */
  readonly archive: string;
  readonly archiveSha256: string;
  readonly executableSha256: string;
}

/** A third-party executable pinned by version and digests, downloaded once from its release. */
export interface PinnedTool {
  readonly name: string;
  readonly version: string;
  /** URL of the release that publishes the archives. */
  readonly releaseUrl: string;
  readonly assets: Readonly<Record<ToolPlatform, PinnedToolAsset>>;
}

export type ToolResolution = { readonly path: string } | { readonly unavailable: string };

export interface ToolLocator {
  locate(tool: PinnedTool, signal?: AbortSignal): Promise<ToolResolution>;
}

export type Download = (url: string, signal?: AbortSignal) => Promise<Uint8Array>;

/**
 * Keeps each pinned tool in the user's cache. The executable is verified against its pinned digest
 * on every use, so a tampered or partial cache is replaced instead of trusted.
 */
export class PinnedToolInstaller implements ToolLocator {
  readonly #cacheRoot: string;
  readonly #process: ProcessRunner;
  readonly #download: Download;
  readonly #platform: ToolPlatform | null;

  public constructor(options: {
    readonly cacheRoot: string;
    readonly process: ProcessRunner;
    readonly download?: Download;
    readonly platform?: ToolPlatform | null;
  }) {
    this.#cacheRoot = options.cacheRoot;
    this.#process = options.process;
    this.#download = options.download ?? fetchBytes;
    this.#platform = options.platform === undefined ? currentPlatform() : options.platform;
  }

  public async locate(tool: PinnedTool, signal?: AbortSignal): Promise<ToolResolution> {
    const label = `${tool.name} ${tool.version}`;
    if (this.#platform === null) {
      return { unavailable: `${label} has no release for ${process.platform}-${process.arch}` };
    }
    const asset = tool.assets[this.#platform];
    const executable = this.#platform.startsWith("windows-") ? `${tool.name}.exe` : tool.name;
    const directory = join(this.#cacheRoot, tool.name, tool.version, this.#platform);
    const path = join(directory, executable);
    if ((await fileDigest(path)) === asset.executableSha256) return { path };

    const url = `${tool.releaseUrl}/${asset.archive}`;
    let archive: Uint8Array;
    try {
      archive = await this.#download(url, signal);
    } catch (error) {
      return { unavailable: `${label} could not be downloaded from ${url}: ${message(error)}` };
    }
    if (sha256(archive) !== asset.archiveSha256) {
      return { unavailable: `${label}: ${asset.archive} does not match its pinned SHA-256` };
    }
    await mkdir(directory, { recursive: true });
    const work = await mkdtemp(join(directory, ".download-"));
    try {
      await writeFile(join(work, asset.archive), archive);
      const extracted = await this.#process.run(tarExecutable(), ["-xf", asset.archive, executable], {
        cwd: work,
        timeoutMs: 120_000,
        ...(signal === undefined ? {} : { signal }),
      });
      const candidate = join(work, executable);
      if (extracted.exitCode !== 0) {
        return { unavailable: `${label}: ${asset.archive} could not be extracted: ${extracted.stderr.trim()}` };
      }
      if ((await fileDigest(candidate)) !== asset.executableSha256) {
        return { unavailable: `${label}: the executable in ${asset.archive} does not match its pinned SHA-256` };
      }
      await chmod(candidate, 0o755);
      try {
        await rm(path, { force: true });
        await rename(candidate, path);
      } catch (error) {
        // Another run may have installed the same executable first.
        if ((await fileDigest(path)) !== asset.executableSha256) throw error;
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }
    return { path };
  }
}

/** `$XDG_CACHE_HOME/railguard/tools`, by default `~/.cache/railguard/tools`. */
export function toolCacheRoot(environment: Readonly<NodeJS.ProcessEnv>): string {
  const base = environment.XDG_CACHE_HOME?.trim();
  const home = environment.HOME?.trim() || homedir();
  return join(base === undefined || base.length === 0 ? join(home, ".cache") : base, "railguard", "tools");
}

function currentPlatform(): ToolPlatform | null {
  const os = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform as string];
  const arch = { arm64: "arm64", x64: "x64" }[process.arch as string];
  return os === undefined || arch === undefined ? null : (`${os}-${arch}` as ToolPlatform);
}

/** Windows' own bsdtar reads zip archives; the GNU tar of Git for Windows does not. */
function tarExecutable(): string {
  if (process.platform !== "win32") return "tar";
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
}

async function fetchBytes(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  const timeout = AbortSignal.timeout(300_000);
  const response = await fetch(url, {
    redirect: "follow",
    signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function fileDigest(path: string): Promise<string | null> {
  try {
    return sha256(await readFile(path));
  } catch {
    return null;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

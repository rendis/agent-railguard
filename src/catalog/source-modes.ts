import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import type { RelativePosixPath } from "../domain/shared/types.js";
import { normalizeSourceMode, type SourceFile } from "./loaders/shared.js";

const execute = promisify(execFile);

/** Lists the executable files of materialized embedded content, one content-relative path per line. */
export const executableManifest = ".railguard-executables";

/** The portable mode of a content file, from its absolute path and observed permission bits. */
export type SourceModeOf = (absolutePath: string, mode: number, label: RelativePosixPath) => SourceFile["mode"];

/**
 * Where the file system carries permission bits they decide the mode, and unsafe ones are refused.
 * Windows has none, so the executable files come from the manifest that materialized embedded
 * content records, or from the Git index of a local checkout.
 */
export async function sourceModes(root: string, platform: NodeJS.Platform = process.platform): Promise<SourceModeOf> {
  if (platform !== "win32") return (_absolutePath, mode, label) => normalizeSourceMode(mode & 0o777, label);
  const executables = await windowsExecutables(root);
  return (absolutePath) =>
    executables.has(relative(root, absolutePath).split(sep).join("/")) ? "100755" : "100644";
}

async function windowsExecutables(root: string): Promise<ReadonlySet<string>> {
  try {
    const manifest = await readFile(join(root, executableManifest), "utf8");
    return new Set(manifest.split("\n").filter((line) => line.length > 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let listing: string;
  try {
    listing = (await execute("git", ["-C", root, "ls-files", "--stage", "-z"], { maxBuffer: 64 * 1024 * 1024 })).stdout;
  } catch {
    throw new Error(`On Windows a local content source must be a Git checkout, which records executable files: ${root}`);
  }
  return new Set(listing.split("\0")
    .filter((entry) => entry.startsWith("100755 "))
    .map((entry) => entry.slice(entry.indexOf("\t") + 1)));
}

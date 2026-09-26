import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Records in the Git index that files are executable; returns the paths whose index entry changed. */
export type ExecutableBitRecorder = (root: string, paths: readonly string[]) => Promise<readonly string[]>;

/**
 * Windows keeps no executable bit, so a file Railguard writes executable would be committed as
 * 100644 and would not run on macOS or Linux. A tracked file gets only its index mode changed; an
 * untracked one must be staged to carry the mode at all. Outside a Git work tree nothing changes.
 */
export const recordExecutableBits: ExecutableBitRecorder = async (root, paths) => {
  if (paths.length === 0) return [];
  const git = (...args: string[]) => execute("git", ["-C", root, ...args], { maxBuffer: 16 * 1024 * 1024 });
  try {
    await git("rev-parse", "--is-inside-work-tree");
  } catch {
    return [];
  }
  const listed = (await git("ls-files", "--stage", "-z", "--", ...paths)).stdout;
  const modes = new Map(listed.split("\0").filter(Boolean).map((entry) => [
    entry.slice(entry.indexOf("\t") + 1),
    entry.slice(0, entry.indexOf(" ")),
  ]));
  const tracked = paths.filter((path) => modes.get(path) === "100644");
  const untracked = paths.filter((path) => !modes.has(path));
  if (tracked.length > 0) await git("update-index", "--chmod=+x", "--", ...tracked);
  if (untracked.length > 0) await git("add", "--chmod=+x", "--", ...untracked);
  return [...tracked, ...untracked];
};

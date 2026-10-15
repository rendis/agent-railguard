import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { GitConfigPort, GitConfigValue } from "../../../domain/planning/model.js";

const execute = promisify(execFile);

/**
 * Repository-local Git config. Every worktree of a clone shares it, so a value is also described
 * from the worktree's point of view: an absolute path that points into one of the repository's
 * worktrees names the same directory a relative path would, and a linked worktree is told apart.
 */
export class NodeGitConfig implements GitConfigPort {
  public async get(
    rootRealPath: string,
    key: "core.hooksPath",
  ): Promise<GitConfigValue> {
    try {
      const result = await execute(
        "git",
        ["-C", rootRealPath, "config", "--local", "--get-all", key],
        { encoding: "utf8", maxBuffer: 64 * 1024 },
      );
      const values = result.stdout
        .split("\n")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      if (values.length !== 1) {
        throw new Error(`Expected one ${key} value, observed ${values.length}`);
      }
      const value = values[0]!;
      const worktreeRelative = isAbsolute(value) ? await relativeToWorktree(rootRealPath, value) : null;
      const linkedWorktree = await isLinkedWorktree(rootRealPath);
      return Object.freeze({
        kind: "value",
        value,
        ...(worktreeRelative === null ? {} : { worktreeRelative }),
        ...(linkedWorktree ? { linkedWorktree: true as const } : {}),
      });
    } catch (error) {
      if (isExitCode(error, 1)) {
        return Object.freeze({ kind: "absent" });
      }
      throw error;
    }
  }

  public async set(
    rootRealPath: string,
    key: "core.hooksPath",
    value: string | null,
  ): Promise<void> {
    const args =
      value === null
        ? ["-C", rootRealPath, "config", "--local", "--unset-all", key]
        : ["-C", rootRealPath, "config", "--local", "--replace-all", key, value];
    try {
      await execute("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 });
    } catch (error) {
      if (value === null && isExitCode(error, 5)) {
        return;
      }
      throw error;
    }
  }
}

/** The path relative to the worktree that contains it, among the worktrees of this repository. */
async function relativeToWorktree(rootRealPath: string, absolutePath: string): Promise<string | null> {
  let listing: string;
  try {
    listing = (await execute("git", ["-C", rootRealPath, "worktree", "list", "--porcelain"], { encoding: "utf8", maxBuffer: 1024 * 1024 })).stdout;
  } catch {
    return null;
  }
  const target = await canonical(absolutePath);
  for (const line of listing.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const difference = relative(await canonical(line.slice("worktree ".length).trim()), target);
    if (difference !== "" && difference !== ".." && !difference.startsWith(`..${sep}`) && !isAbsolute(difference)) {
      return difference.split(sep).join("/");
    }
  }
  return null;
}

/** Whether this checkout's own Git directory differs from the one the clone shares. */
async function isLinkedWorktree(rootRealPath: string): Promise<boolean> {
  try {
    const { stdout } = await execute(
      "git",
      ["-C", rootRealPath, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
      { encoding: "utf8", maxBuffer: 64 * 1024 },
    );
    const [gitDirectory, commonDirectory] = stdout.split("\n");
    if (gitDirectory === undefined || commonDirectory === undefined || commonDirectory === "") return false;
    return (await canonical(gitDirectory)) !== (await canonical(commonDirectory));
  } catch {
    return false;
  }
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

function isExitCode(error: unknown, code: number): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

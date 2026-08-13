import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, opendir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import type { GitHookInventory } from "../../../domain/project/model.js";
import { compareUtf8 } from "../../../domain/shared/types.js";

const execute = promisify(execFile);

export class NodeGitHookInventory implements GitHookInventory {
  public async executableDefaultHooks(
    rootRealPath: string,
  ): Promise<readonly string[]> {
    const commonDirectoryResult = await execute(
      "git",
      ["-C", rootRealPath, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8", maxBuffer: 64 * 1024 },
    );
    const commonDirectoryValue = commonDirectoryResult.stdout.trim();
    if (commonDirectoryValue.length === 0) {
      throw new Error("Git returned an empty common directory path");
    }
    const commonDirectory = isAbsolute(commonDirectoryValue)
      ? commonDirectoryValue
      : resolve(rootRealPath, commonDirectoryValue);
    const hooksDirectory = resolve(commonDirectory, "hooks");
    let names: string[];
    try {
      const directory = await opendir(hooksDirectory);
      names = [];
      for await (const entry of directory) {
        if (!entry.name.endsWith(".sample")) {
          names.push(entry.name);
        }
      }
      names.sort(compareUtf8);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return Object.freeze([]);
      }
      throw error;
    }
    const executable: string[] = [];
    for (const name of names) {
      const hookPath = resolve(hooksDirectory, name);
      try {
        await access(hookPath, constants.X_OK);
        const entry = await lstat(hookPath);
        if (entry.isFile() || entry.isSymbolicLink()) {
          executable.push(name);
        }
      } catch (error) {
        if (!isNodeError(error, "ENOENT") && !isNodeError(error, "EACCES")) {
          throw error;
        }
      }
    }
    return Object.freeze(executable);
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

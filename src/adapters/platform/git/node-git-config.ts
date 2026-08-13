import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitConfigPort, GitConfigValue } from "../../../domain/planning/model.js";

const execute = promisify(execFile);

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
      return Object.freeze({ kind: "value", value: values[0]! });
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

function isExitCode(error: unknown, code: number): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

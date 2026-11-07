import { spawn } from "node:child_process";
import type { ProcessResult, ProcessRunner } from "../../../domain/verification/checks.js";

const maximumOutputBytes = 8 * 1024 * 1024;

/**
 * Variables through which Git points a process at one repository, as `git rev-parse
 * --local-env-vars` lists them. Git sets some of them for its hooks.
 */
export const gitRepositoryVariables = Object.freeze([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
]);

/** The environment without Git's repository variables, so Git finds the repository from the working directory. */
export function withoutGitRepository(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...environment };
  for (const name of gitRepositoryVariables) delete clean[name];
  return clean;
}

/** Runs a command without a shell, capturing bounded output. */
export class NodeProcessRunner implements ProcessRunner {
  /** `environment` is read on every run; without it a command inherits this process's environment. */
  public constructor(private readonly environment?: () => NodeJS.ProcessEnv) {}

  public async run(
    command: string,
    args: readonly string[],
    options: { readonly cwd: string; readonly timeoutMs?: number; readonly signal?: AbortSignal },
  ): Promise<ProcessResult> {
    return await new Promise((resolve) => {
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let size = 0;
      let timedOut = false;
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        ...(this.environment === undefined ? {} : { env: this.environment() }),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const collect = (target: Buffer[]) => (chunk: Buffer) => {
        if (size >= maximumOutputBytes) return;
        size += chunk.byteLength;
        target.push(chunk);
      };
      child.stdout.on("data", collect(stdout));
      child.stderr.on("data", collect(stderr));
      const timer = options.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, options.timeoutMs);
      const finish = (exitCode: number | null, extra = "") => {
        if (timer !== null) clearTimeout(timer);
        resolve(Object.freeze({
          exitCode,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: `${Buffer.concat(stderr).toString("utf8")}${extra}`,
          timedOut,
        }));
      };
      child.on("error", (error) => finish(null, error.message));
      child.on("close", (code) => finish(timedOut ? null : code));
    });
  }
}

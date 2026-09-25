import { spawn } from "node:child_process";
import type { ProcessResult, ProcessRunner } from "../../../domain/verification/checks.js";

const maximumOutputBytes = 8 * 1024 * 1024;

/** Runs a command without a shell, capturing bounded output. */
export class NodeProcessRunner implements ProcessRunner {
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

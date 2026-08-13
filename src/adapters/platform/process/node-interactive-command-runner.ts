import { spawn } from "node:child_process";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from "../../../domain/process/command-runner.js";
import { redactSensitiveText } from "../../../domain/process/redact-sensitive-text.js";

export class NodeInteractiveCommandRunner implements CommandRunner {
  public run(request: CommandRequest): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(request.command, [...request.args], {
        cwd: request.cwd,
        env: process.env,
        shell: false,
        stdio: [process.stdin.isTTY ? "inherit" : "ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
      const abort = () => child.kill("SIGTERM");
      if (request.signal?.aborted === true) abort();
      else request.signal?.addEventListener("abort", abort, { once: true });
      child.once("error", reject);
      child.once("close", (code) => {
        request.signal?.removeEventListener("abort", abort);
        const cleanStdout = redactSensitiveText(Buffer.concat(stdout).toString("utf8"));
        const cleanStderr = redactSensitiveText(Buffer.concat(stderr).toString("utf8"));
        if (cleanStdout.length > 0) {
          request.onOutput?.(Object.freeze({ stream: "stdout", text: cleanStdout }));
        }
        if (cleanStderr.length > 0) {
          request.onOutput?.(Object.freeze({ stream: "stderr", text: cleanStderr }));
        }
        resolve(Object.freeze({
          exitCode: code ?? (request.signal?.aborted === true ? 130 : 1),
          stdout: cleanStdout,
          stderr: cleanStderr,
        }));
      });
    });
  }
}

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProcessResult, ProcessRunner } from "../../domain/verification/checks.js";
import { verifyScriptPath, type VerifyScript } from "../../domain/verification/verify-script.js";

/** Mutation campaigns and end-to-end suites can take long; one step never runs unbounded. */
const stepTimeoutMs = 2 * 60 * 60_000;

export class NodeVerifyScript implements VerifyScript {
  public constructor(private readonly process: ProcessRunner) {}

  public async read(root: string): Promise<string | null> {
    try {
      return await readFile(join(root, verifyScriptPath), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  public async step(root: string, id: string, signal?: AbortSignal): Promise<ProcessResult> {
    return await this.process.run("sh", [verifyScriptPath, "--step", id], {
      cwd: root,
      timeoutMs: stepTimeoutMs,
      ...(signal === undefined ? {} : { signal }),
    });
  }
}

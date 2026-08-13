import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import type {
  ExecutableProbe,
  ExecutableProbeResult,
} from "../../../domain/harness/model.js";

const execFileAsync = promisify(execFile);

export class NodeExecutableProbe implements ExecutableProbe {
  readonly #path: string;

  public constructor(path = process.env.PATH ?? "") {
    this.#path = path;
  }

  public async probe(
    command: string,
    args: readonly string[],
  ): Promise<ExecutableProbeResult> {
    const executablePath = await findExecutable(command, this.#path);
    if (executablePath === null) {
      return Object.freeze({
        detected: false,
        path: null,
        version: null,
        diagnostics: Object.freeze([]),
      });
    }
    try {
      const result = await execFileAsync(executablePath, [...args], {
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        timeout: 5_000,
        windowsHide: true,
      });
      const version = `${result.stdout}${result.stderr}`.trim();
      return Object.freeze({
        detected: true,
        path: executablePath,
        version: version.length === 0 ? null : version,
        diagnostics: Object.freeze([]),
      });
    } catch (error) {
      return Object.freeze({
        detected: true,
        path: executablePath,
        version: null,
        diagnostics: Object.freeze([
          Object.freeze({
            code: "harness.executable.version-unavailable",
            severity: "warning",
            phase: "harness",
            subjects: Object.freeze([]),
            location: null,
            message: "The harness executable was found but its version probe failed.",
            evidence: Object.freeze([error instanceof Error ? error.message : String(error)]),
            impact: "Detection is available, but version-specific certification is not observable.",
            action: "Run the executable version command manually if certification is required.",
          }),
        ]),
      });
    }
  }
}

async function findExecutable(command: string, pathValue: string): Promise<string | null> {
  const candidates = isAbsolute(command)
    ? [command]
    : pathValue
        .split(delimiter)
        .filter((entry) => entry.length > 0)
        .flatMap((entry) => executableNames(command).map((name) => join(entry, name)));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      const candidateStat = await stat(candidate);
      if (candidateStat.isFile()) {
        return await realpath(candidate);
      }
    } catch {
      // Continue through PATH without treating an absent entry as a diagnostic.
    }
  }
  return null;
}

function executableNames(command: string): readonly string[] {
  if (process.platform !== "win32") {
    return [command];
  }
  const extensions = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .filter((entry) => entry.length > 0);
  return [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`)];
}

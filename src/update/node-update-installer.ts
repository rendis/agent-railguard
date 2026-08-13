import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { sha256 } from "../domain/shared/types.js";
import type {
  UpdateInstallationRequest,
  UpdateInstallationResult,
  UpdateInstaller,
} from "./update-service.js";

const packageName = "@example/ai-harness";

export interface UpdateCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  readonly signal?: AbortSignal;
}

export interface UpdateCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface UpdateCommandRunner {
  run(command: UpdateCommand): Promise<UpdateCommandResult>;
}

export interface NodeUpdateInstallerOptions {
  readonly runner?: UpdateCommandRunner;
  readonly pnpmCommand?: string;
  readonly temporaryRoot?: string;
}

export class NodeUpdateCommandRunner implements UpdateCommandRunner {
  public async run(command: UpdateCommand): Promise<UpdateCommandResult> {
    return await new Promise((resolveCommand, reject) => {
      execFile(
        command.executable,
        [...command.args],
        {
          ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
          ...(command.env === undefined ? {} : { env: { ...command.env } }),
          ...(command.signal === undefined ? {} : { signal: command.signal }),
          encoding: "utf8",
          maxBuffer: 4 * 1024 * 1024,
          timeout: 120_000,
        },
        (error, stdout, stderr) => {
          if (error !== null) {
            reject(new Error(
              `${command.executable} ${command.args.join(" ")} failed: ${stderr.trim() || error.message}`,
              { cause: error },
            ));
            return;
          }
          resolveCommand({ stdout, stderr });
        },
      );
    });
  }
}

export class NodeUpdateInstaller implements UpdateInstaller {
  readonly #runner: UpdateCommandRunner;
  readonly #pnpm: string;
  readonly #temporaryRoot: string;

  public constructor(options: NodeUpdateInstallerOptions = {}) {
    this.#runner = options.runner ?? new NodeUpdateCommandRunner();
    this.#pnpm = options.pnpmCommand ?? process.env.AI_HARNESS_PNPM_COMMAND ?? "pnpm";
    this.#temporaryRoot = resolve(options.temporaryRoot ?? tmpdir());
  }

  public async install(
    request: UpdateInstallationRequest,
    artifact: Uint8Array,
    signal?: AbortSignal,
  ): Promise<UpdateInstallationResult> {
    signal?.throwIfAborted();
    assertNodeBaseline(process.versions.node);
    const pnpmVersion = (await this.#run(["--version"], signal)).stdout.trim();
    assertPnpmBaseline(pnpmVersion);

    const installedPackage = installedPackagePath(
      (await this.#run(["list", "--global", "--depth", "0", "--json"], signal)).stdout,
      request.currentVersion,
    );
    const installedManifest = await readInstalledManifest(installedPackage);
    if (installedManifest.name !== packageName || installedManifest.version !== request.currentVersion) {
      throw new Error(
        `Installed package identity ${installedManifest.name}@${installedManifest.version} does not match ${packageName}@${request.currentVersion}`,
      );
    }

    const operationRoot = await mkdtemp(join(this.#temporaryRoot, "ai-harness-update-"));
    const artifactPath = join(operationRoot, "candidate.tgz");
    const backupPath = join(operationRoot, "previous.tgz");
    const candidateHome = join(operationRoot, "candidate-pnpm-home");
    const candidateStore = join(operationRoot, "candidate-store");
    const candidateUserHome = join(operationRoot, "candidate-user-home");
    let globalMutationAttempted = false;
    try {
      await writeFile(artifactPath, artifact, { mode: 0o600, flag: "wx" });
      const expected = request.release.manifest.release.artifact;
      if (artifact.byteLength !== expected.size || sha256(artifact) !== expected.sha256) {
        throw new Error("Candidate bytes no longer match the verified release manifest");
      }
      await this.#run(
        ["pack", "--out", backupPath, "--skip-manifest-obfuscation"],
        signal,
        { cwd: installedPackage, env: { ...process.env, npm_config_ignore_scripts: "true" } },
      );
      const backupStat = await stat(backupPath);
      if (!backupStat.isFile() || backupStat.size === 0) {
        throw new Error("The previous installed package could not be backed up");
      }

      await Promise.all([
        mkdir(candidateHome, { recursive: true, mode: 0o700 }),
        mkdir(candidateStore, { recursive: true, mode: 0o700 }),
        mkdir(candidateUserHome, { recursive: true, mode: 0o700 }),
      ]);
      const candidateEnvironment: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: candidateUserHome,
        XDG_CACHE_HOME: join(candidateUserHome, ".cache"),
        XDG_CONFIG_HOME: join(candidateUserHome, ".config"),
        XDG_DATA_HOME: join(candidateUserHome, ".local", "share"),
        PNPM_HOME: candidateHome,
        PATH: `${join(candidateHome, "bin")}${delimiter}${process.env.PATH ?? ""}`,
      };
      await this.#run(
        installArguments(artifactPath, candidateStore),
        signal,
        { env: candidateEnvironment },
      );
      const candidateExecutable = join(candidateHome, "bin", "ai-harness");
      await access(candidateExecutable, constants.X_OK).catch(() => undefined);
      const stagedVersion = (
        await this.#runner.run({
          executable: candidateExecutable,
          args: ["--version"],
          env: candidateEnvironment,
          ...(signal === undefined ? {} : { signal }),
        })
      ).stdout.trim();
      if (stagedVersion !== request.release.manifest.release.version) {
        throw new Error(`Candidate smoke returned version ${stagedVersion || "unknown"}`);
      }

      globalMutationAttempted = true;
      await this.#run(installArguments(artifactPath), signal);
      const globalBin = resolveSingleLine(
        (await this.#run(["bin", "--global"], signal)).stdout,
        "pnpm global bin",
      );
      const installedVersion = (
        await this.#runner.run({
          executable: join(globalBin, "ai-harness"),
          args: ["--version"],
          ...(signal === undefined ? {} : { signal }),
        })
      ).stdout.trim();
      if (installedVersion !== request.release.manifest.release.version) {
        throw new Error(`Global smoke returned version ${installedVersion || "unknown"}`);
      }
      return Object.freeze({
        status: "applied",
        previousVersion: request.currentVersion,
        installedVersion,
      });
    } catch (error) {
      if (!globalMutationAttempted) throw error;
      try {
        await this.#run(installArguments(backupPath), undefined);
        const globalBin = resolveSingleLine(
          (await this.#run(["bin", "--global"], undefined)).stdout,
          "pnpm global bin",
        );
        const restored = (
          await this.#runner.run({
            executable: join(globalBin, "ai-harness"),
            args: ["--version"],
          })
        ).stdout.trim();
        if (restored !== request.currentVersion) {
          throw new Error(`Rollback smoke returned version ${restored || "unknown"}`);
        }
      } catch (rollbackError) {
        throw new Error(
          `Update failed and rollback could not be certified: ${errorMessage(rollbackError)}`,
          { cause: error },
        );
      }
      return Object.freeze({
        status: "rolled-back",
        previousVersion: request.currentVersion,
        installedVersion: null,
      });
    } finally {
      await rm(operationRoot, { recursive: true, force: true });
    }
  }

  async #run(
    args: readonly string[],
    signal: AbortSignal | undefined,
    options: { readonly cwd?: string; readonly env?: Readonly<NodeJS.ProcessEnv> } = {},
  ): Promise<UpdateCommandResult> {
    return await this.#runner.run({
      executable: this.#pnpm,
      args,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(signal === undefined ? {} : { signal }),
    });
  }
}

function installedPackagePath(source: string, expectedVersion: string): string {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`pnpm global list did not return JSON: ${errorMessage(error)}`);
  }
  const dependency = Array.isArray(value)
    ? (value[0] as { dependencies?: Record<string, { path?: unknown; version?: unknown }> } | undefined)
        ?.dependencies?.[packageName]
    : undefined;
  if (
    dependency === undefined ||
    typeof dependency.path !== "string" ||
    !isAbsolute(dependency.path) ||
    dependency.version !== expectedVersion
  ) {
    throw new Error(`pnpm global list does not contain ${packageName}@${expectedVersion}`);
  }
  return resolve(dependency.path);
}

function installArguments(artifact: string, store?: string): readonly string[] {
  return Object.freeze([
    "add",
    "--global",
    "--offline",
    "--ignore-scripts",
    ...(store === undefined ? [] : ["--store-dir", store]),
    artifact,
  ]);
}

async function readInstalledManifest(
  installedPackage: string,
): Promise<{ readonly name: string; readonly version: string }> {
  const value = JSON.parse(await readFile(join(installedPackage, "package.json"), "utf8")) as unknown;
  if (
    value === null ||
    typeof value !== "object" ||
    typeof (value as { name?: unknown }).name !== "string" ||
    typeof (value as { version?: unknown }).version !== "string"
  ) {
    throw new Error("Installed AI Harness package manifest is invalid");
  }
  return {
    name: (value as { name: string }).name,
    version: (value as { version: string }).version,
  };
}

function resolveSingleLine(source: string, label: string): string {
  const lines = source.trim().split(/\r?\n/).filter((entry) => entry.length > 0);
  if (lines.length !== 1) throw new Error(`${label} did not return exactly one path`);
  return resolve(lines[0]!);
}

function assertNodeBaseline(version: string): void {
  const [major, minor] = parseVersion(version, "Node.js");
  if (major !== 24 || minor < 19) {
    throw new Error(`Node.js ${version} is outside >=24.19.0 <25.0.0`);
  }
}

function assertPnpmBaseline(version: string): void {
  const [major, minor] = parseVersion(version, "pnpm");
  if (major !== 11 || minor < 21) {
    throw new Error(`pnpm ${version} is outside >=11.21.0 <12.0.0`);
  }
}

function parseVersion(value: string, name: string): readonly [number, number, number] {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (match === null) throw new Error(`${name} version is not stable SemVer: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

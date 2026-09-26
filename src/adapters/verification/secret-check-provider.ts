import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ChangedLines,
  ChangeSet,
  ChangeSetReader,
  CheckOutcome,
  CheckProvider,
  CheckRequest,
  FullCheck,
  ProcessRunner,
} from "../../domain/verification/checks.js";
import type { PinnedTool, ToolLocator } from "../platform/tools/pinned-tool.js";
import { ChangeAcceptance } from "./change-acceptance.js";

const betterleaksRelease = "https://github.com/betterleaks/betterleaks/releases/download/v1.8.1";

/** Betterleaks 1.8.1 as published in its GitHub release, with the digests of every platform. */
export const betterleaks: PinnedTool = Object.freeze({
  name: "betterleaks",
  version: "1.8.1",
  releaseUrl: betterleaksRelease,
  assets: Object.freeze({
    "darwin-arm64": {
      archive: "betterleaks_1.8.1_darwin_arm64.tar.gz",
      archiveSha256: "8e80f33b5f2a7426b390347b9fd466033723cb94b6bdffa7572632e2eaec964e",
      executableSha256: "a4808e33f9e9a405198dd7196496a5777023ae1f03eac59ecf24b3e787e344d2",
    },
    "darwin-x64": {
      archive: "betterleaks_1.8.1_darwin_x64.tar.gz",
      archiveSha256: "6abc37df76f881cffae406aa2cec72bea6e6ae64b4e771b3ed21b4aac472ed10",
      executableSha256: "d0aa388e456ca3eec1bc2d136fe1ac61e29d0a672dffca9f5dcd0e354fd8b959",
    },
    "linux-arm64": {
      archive: "betterleaks_1.8.1_linux_arm64.tar.gz",
      archiveSha256: "bbb578b12a2f65d7082ab436abf37724232bc71d8a078e3c41336574420f1b48",
      executableSha256: "1d5e40e7ea9070393744a34f0334c435edda1a230989974734fda96fe987001b",
    },
    "linux-x64": {
      archive: "betterleaks_1.8.1_linux_x64.tar.gz",
      archiveSha256: "efa407244e1ea8e35f582b8a42becdeac08bdead04f68eb752adda722d583c2a",
      executableSha256: "380a770d9ea9215e7d3b964246a72d8698b2975496addef2627d0e82b174a1f8",
    },
    "windows-arm64": {
      archive: "betterleaks_1.8.1_windows_arm64.zip",
      archiveSha256: "aa12beb9ce1f6a911da91e1d0d8a72d7e68daf56a52a53f930038fd81f10f0ba",
      executableSha256: "b4b4d88ab5cc3942a10fe85f27c9443a3c6319c2963670d2afb438e36ff915fc",
    },
    "windows-x64": {
      archive: "betterleaks_1.8.1_windows_x64.zip",
      archiveSha256: "94310d028285a1bcce7f160bc19eb62f87de6460c95bfd4319151ef5b501ed3f",
      executableSha256: "727820f1a9f9264319cc50458b99f01acbb93e93df7a39b8eaa2715a7b1aaed5",
    },
  }),
});

/** Exceptions a repository may keep on its default branch, in Betterleaks' order of preference. */
const configFiles = [".betterleaks.toml", ".gitleaks.toml"];
const ignoreFiles = [".betterleaksignore", ".gitleaksignore"];
const defaultConfig = "[extend]\nuseDefault = true\n";
const pathsPerScan = 200;
const scanTimeoutMs = 600_000;

interface Finding {
  readonly RuleID: string;
  readonly File: string;
  readonly StartLine: number;
  readonly EndLine: number;
  readonly Commit: string;
  readonly Fingerprint: string;
}

/**
 * Finds secrets a change would expose, with a pinned Betterleaks that runs locally: live
 * validation stays off and the report never holds a secret value.
 */
export class SecretCheckProvider implements CheckProvider {
  public readonly kinds = ["secret-exposure"] as const;
  readonly #acceptance: ChangeAcceptance;

  public constructor(
    private readonly process: ProcessRunner,
    private readonly changeSets: ChangeSetReader,
    private readonly tools: ToolLocator,
  ) {
    this.#acceptance = new ChangeAcceptance(process, changeSets);
  }

  public full(): FullCheck {
    return { kind: "skipped", reason: "Judges a change; run with --changed" };
  }

  public async run(kind: string, request: CheckRequest): Promise<CheckOutcome> {
    if (kind !== "secret-exposure") {
      return { status: "unavailable", summary: `Unknown secret check kind ${kind}`, details: [] };
    }
    const tool = await this.tools.locate(betterleaks, request.signal);
    if ("unavailable" in tool) {
      return { status: "unavailable", summary: `Betterleaks ${betterleaks.version} is not available`, details: [tool.unavailable] };
    }
    return await this.#acceptance.judge(request, kind, (scope) => this.#scan(request, scope, tool.path));
  }

  async #scan(request: CheckRequest, scope: ChangeSet, executable: string): Promise<CheckOutcome> {
    const root = request.repositoryRoot;
    const work = await mkdtemp(join(tmpdir(), "railguard-secrets-"));
    try {
      const options = await this.#baseExceptions(root, scope.base, work);
      const findings: string[] = [];
      if (scope.base !== null) {
        const committed = await this.#betterleaks(executable, root, ["git", `--log-opts=${scope.base}..HEAD`, ...options, "."], request.signal);
        if ("error" in committed) return scanFailed(committed.error);
        for (const finding of committed.findings) {
          findings.push(`${finding.File}:${finding.StartLine}: ${finding.RuleID} in commit ${finding.Commit.slice(0, 12)} (fingerprint ${finding.Fingerprint})`);
        }
      }
      // Committed content is judged above; this covers what is still only in the working tree.
      const pending = scope.base === null ? scope.files : (await this.changeSets.read(root, "HEAD")).files;
      const paths = await regularFiles(root, [...pending.keys()]);
      for (let start = 0; start < paths.length; start += pathsPerScan) {
        const chunk = paths.slice(start, start + pathsPerScan);
        const uncommitted = await this.#betterleaks(executable, root, ["dir", ...options, "--", ...chunk], request.signal);
        if ("error" in uncommitted) return scanFailed(uncommitted.error);
        for (const finding of uncommitted.findings) {
          const file = finding.File.replaceAll("\\", "/");
          if (!touchesChangedLines(pending.get(file), finding)) continue;
          findings.push(`${file}:${finding.StartLine}: ${finding.RuleID}, not committed (fingerprint ${finding.Fingerprint})`);
        }
      }
      if (findings.length === 0) return { status: "passed", summary: "No secret in the change", details: [] };
      return {
        status: "failed",
        summary: `${findings.length} secret(s) exposed by the change`,
        details: [
          ...findings,
          "Remove each secret instead of hiding it: read it from the environment or from a file Git ignores, and rewrite every commit that holds one (git commit --amend or git rebase) before pushing. Treat a real credential as exposed and rotate it.",
          "Never add a `Railguard-Allow` trailer yourself: only a person may accept a finding they judge harmless, with `Railguard-Allow: secret-exposure: <reason>` in a commit they make (`git commit --no-verify` for that commit). Recurring false positives belong in .betterleaks.toml or .betterleaksignore on the default branch; exceptions changed on this branch take effect only once they reach the base.",
        ],
      };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  /**
   * Flags shared by every scan. The configuration and ignore list come from the base, so a change
   * cannot exempt itself; inline allow comments are ignored for the same reason.
   */
  async #baseExceptions(root: string, base: string | null, work: string): Promise<readonly string[]> {
    const config = join(work, "config.toml");
    const ignored = join(work, "ignore");
    await mkdir(ignored);
    await writeFile(config, (await this.#firstAtBase(root, base, configFiles))?.content ?? defaultConfig);
    const ignore = await this.#firstAtBase(root, base, ignoreFiles);
    if (ignore !== null) await writeFile(join(ignored, ignore.name), ignore.content);
    return [
      "--config", config,
      "--gitleaks-ignore-path", ignored,
      "--ignore-gitleaks-allow",
      "--redact",
      "--no-banner",
      "--no-color",
      "--log-level", "error",
      "--report-format", "json",
      "--report-path", "-",
      "--exit-code", "0",
    ];
  }

  async #firstAtBase(
    root: string,
    base: string | null,
    names: readonly string[],
  ): Promise<{ readonly name: string; readonly content: string } | null> {
    if (base === null) return null;
    for (const name of names) {
      const shown = await this.process.run("git", ["show", `${base}:${name}`], { cwd: root, timeoutMs: 30_000 });
      if (shown.exitCode === 0) return { name, content: shown.stdout };
    }
    return null;
  }

  async #betterleaks(
    executable: string,
    root: string,
    args: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<{ readonly findings: readonly Finding[] } | { readonly error: string }> {
    const result = await this.process.run(executable, args, {
      cwd: root,
      timeoutMs: scanTimeoutMs,
      ...(signal === undefined ? {} : { signal }),
    });
    if (result.timedOut) return { error: `Betterleaks did not finish within ${scanTimeoutMs / 60_000} minutes` };
    if (result.exitCode !== 0) return { error: result.stderr.trim() || `Betterleaks exited with ${result.exitCode}` };
    try {
      const report = JSON.parse(result.stdout) as Finding[] | null;
      return { findings: report ?? [] };
    } catch {
      return { error: "Betterleaks did not produce a JSON report" };
    }
  }
}

/** A multi-line secret counts when any of its lines changed. */
function touchesChangedLines(lines: ChangedLines | undefined, finding: Finding): boolean {
  if (lines === undefined) return false;
  if (lines === "all") return true;
  for (let line = finding.StartLine; line <= Math.max(finding.StartLine, finding.EndLine); line += 1) {
    if (lines.has(line)) return true;
  }
  return false;
}

/** Regular files only: a directory such as a submodule would be scanned whole. */
async function regularFiles(root: string, paths: readonly string[]): Promise<readonly string[]> {
  const files: string[] = [];
  for (const path of [...paths].sort()) {
    try {
      if ((await lstat(join(root, path))).isFile()) files.push(path);
    } catch {
      // Removed since the change was read.
    }
  }
  return files;
}

function scanFailed(error: string): CheckOutcome {
  return { status: "unavailable", summary: "Betterleaks could not scan the change", details: error.split("\n").slice(-20) };
}

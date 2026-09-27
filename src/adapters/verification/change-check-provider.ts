import {
  changedLineCount,
  isTestFile,
  matchesAnyGlob,
  removedTestFindings,
  suppressionFindings,
} from "../../domain/verification/change-guard.js";
import type {
  ChangeSet,
  ChangeSetReader,
  CheckOutcome,
  CheckProvider,
  CheckRequest,
  FullCheck,
  ProcessRunner,
} from "../../domain/verification/checks.js";
import { ChangeAcceptance } from "./change-acceptance.js";

const maxScannedBytes = 16 * 1024 * 1024;

/** Stack-independent checks that judge the shape of a change rather than its code. */
export class ChangeCheckProvider implements CheckProvider {
  public readonly kinds = ["change-integrity", "change-size"] as const;
  readonly #acceptance: ChangeAcceptance;

  public constructor(
    private readonly process: ProcessRunner,
    private readonly changeSets: ChangeSetReader,
  ) {
    this.#acceptance = new ChangeAcceptance(process, changeSets);
  }

  public full(): FullCheck {
    return { kind: "skipped", reason: "Judges a change; run with --changed" };
  }

  public async run(kind: string, request: CheckRequest): Promise<CheckOutcome> {
    switch (kind) {
      case "change-integrity":
        return await this.#acceptance.judge(request, kind, (scope) => this.#integrity(request, scope));
      case "change-size":
        return await this.#acceptance.judge(request, kind, (scope) => this.#size(request, scope));
      default:
        return { status: "unavailable", summary: `Unknown change check kind ${kind}`, details: [] };
    }
  }

  async #integrity(request: CheckRequest, changes: ChangeSet): Promise<CheckOutcome> {
    const protectedPaths = request.inputs.protected_paths ?? [];
    const findings: string[] = [];
    for (const [path, lines] of changes.files) {
      if (matchesAnyGlob(path, protectedPaths)) {
        // Adding a configuration weakens nothing; changing one the base already had can.
        if (await this.#existsAtBase(request.repositoryRoot, changes.base, path)) {
          findings.push(`${path}: protected quality configuration changed`);
        }
        continue;
      }
      const content = await this.changeSets.content(request.repositoryRoot, path, changes.staged);
      if (content === null || isBinary(content)) continue;
      if (content.length > maxScannedBytes) {
        findings.push(`${path}: too large to scan for suppressions (over ${maxScannedBytes / 1024 / 1024} MiB)`);
        continue;
      }
      findings.push(...suppressionFindings(path, content.toString("utf8"), lines));
    }
    for (const path of changes.deleted) {
      if (isTestFile(path)) findings.push(`${path}: test file deleted`);
      else if (matchesAnyGlob(path, protectedPaths)) findings.push(`${path}: protected quality configuration deleted`);
    }
    findings.push(...removedTestFindings(await this.#changedTests(request.repositoryRoot, changes)));
    if (findings.length === 0) return passed("No suppression, removed test or protected configuration change");
    return {
      status: "failed",
      summary: `${findings.length} change(s) weaken what the checks can see`,
      details: [
        ...findings,
        "Fix the cause instead. Never add a `Railguard-Allow` trailer yourself: only a person may accept what the branch holds so far, with `Railguard-Allow: change-integrity: <reason>` in a commit they make (`git commit --no-verify` for that commit).",
      ],
    };
  }

  async #size(request: CheckRequest, changes: ChangeSet): Promise<CheckOutcome> {
    const limit = Number(request.inputs.max_changed_lines?.[0] ?? 400);
    const excluded = request.inputs.size_excluded_paths ?? [];
    const counted: { readonly path: string; readonly lines: number }[] = [];
    for (const [path, lines] of changes.files) {
      if (isTestFile(path) || matchesAnyGlob(path, excluded)) continue;
      if (lines !== "all") {
        counted.push({ path, lines: lines.size });
        continue;
      }
      // A binary file has no reviewable lines; every text file counts, however large.
      const content = await this.changeSets.content(request.repositoryRoot, path, changes.staged);
      if (content === null || isBinary(content)) continue;
      counted.push({ path, lines: changedLineCount(content.toString("utf8"), lines) });
    }
    const total = counted.reduce((sum, file) => sum + file.lines, 0);
    if (total <= limit) return passed(`${total} changed line(s) outside tests, within ${limit}`);
    return {
      status: "failed",
      summary: `${total} changed line(s) outside tests exceed the reviewable limit of ${limit}`,
      details: [
        ...counted.sort((left, right) => right.lines - left.lines).slice(0, 10).map((file) => `${file.path}: ${file.lines}`),
        "Split the change into smaller deliveries. Never add a `Railguard-Allow` trailer yourself: only a person may accept what the branch holds so far, with `Railguard-Allow: change-size: <reason>` in a commit they make.",
      ],
    };
  }

  /** Changed test files as the base held them and as the change holds them now. */
  async #changedTests(root: string, changes: ChangeSet): Promise<{ path: string; before: string; after: string }[]> {
    const tests: { path: string; before: string; after: string }[] = [];
    if (changes.base === null) return tests;
    for (const path of changes.files.keys()) {
      if (!isTestFile(path)) continue;
      const content = await this.changeSets.content(root, path, changes.staged);
      if (content === null || isBinary(content) || content.length > maxScannedBytes) continue;
      tests.push({ path, before: await this.#atBase(root, changes.base, path), after: content.toString("utf8") });
    }
    return tests;
  }

  /** A file as the base held it; empty when the change adds it. */
  async #atBase(root: string, base: string, path: string): Promise<string> {
    if (!(await this.#existsAtBase(root, base, path))) return "";
    const result = await this.process.run("git", ["cat-file", "blob", `${base}:${path}`], { cwd: root, timeoutMs: 30_000 });
    if (result.exitCode !== 0) throw new Error(`Cannot read ${path} at ${base}: ${result.stderr.trim()}`);
    return result.stdout;
  }

  async #existsAtBase(root: string, base: string | null, path: string): Promise<boolean> {
    if (base === null) return false;
    const result = await this.process.run("git", ["cat-file", "-e", `${base}:${path}`], { cwd: root, timeoutMs: 30_000 });
    return result.exitCode === 0;
  }
}

/** Git's own heuristic: a NUL byte in the first 8000 bytes marks the file as binary. */
function isBinary(content: Buffer): boolean {
  return content.subarray(0, 8000).includes(0);
}


function passed(summary: string): CheckOutcome {
  return { status: "passed", summary, details: [] };
}


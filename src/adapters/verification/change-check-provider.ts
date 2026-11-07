import {
  changedLineCount,
  declaredSymbols,
  declaresSymbols,
  isTestFile,
  matchesAnyGlob,
  suppressionFindings,
  testChanges,
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
    const policy = findingPolicy(request.inputs.finding_policy ?? defaultFindingPolicy);
    const findings: { readonly kind: FindingKind; readonly text: string }[] = [];
    const add = (kind: FindingKind, texts: readonly string[]) => findings.push(...texts.map((text) => ({ kind, text })));
    for (const [path, lines] of changes.files) {
      if (matchesAnyGlob(path, protectedPaths)) {
        // Adding a configuration weakens nothing; changing one the base already had can.
        if (await this.#existsAtBase(request.repositoryRoot, changes.base, path)) {
          add("protected-config", [`${path}: protected quality configuration changed`]);
        }
        continue;
      }
      const content = await this.changeSets.content(request.repositoryRoot, path, changes.staged);
      if (content === null || isBinary(content)) continue;
      if (content.length > maxScannedBytes) {
        add("unscannable", [`${path}: too large to scan for suppressions (over ${maxScannedBytes / 1024 / 1024} MiB)`]);
        continue;
      }
      add("suppression", suppressionFindings(path, content.toString("utf8"), lines));
    }
    for (const path of changes.deleted) {
      if (!isTestFile(path) && matchesAnyGlob(path, protectedPaths)) add("protected-config", [`${path}: protected quality configuration deleted`]);
    }
    const tests = testChanges(
      await this.#changedTests(request.repositoryRoot, changes),
      await this.#goneSymbols(request.repositoryRoot, changes),
    );
    add("test-deleted", tests.deleted);
    add("test-removed", tests.removed);
    add("test-renamed", tests.renamed);
    add("test-obsolete", tests.obsolete);
    const blocking = findings.filter(({ kind }) => policy.get(kind) !== "report").map(({ text }) => text);
    const reported = findings.filter(({ kind }) => policy.get(kind) === "report").map(({ kind, text }) => `${text} (reported: ${kind}=report)`);
    if (blocking.length === 0) {
      return reported.length === 0
        ? passed("No suppression, removed test or protected configuration change")
        : { status: "passed", summary: `${reported.length} change(s) reported, none blocking`, details: reported };
    }
    return {
      status: "failed",
      summary: `${blocking.length} change(s) weaken what the checks can see`,
      details: [
        ...blocking,
        ...reported,
        "Fix the cause instead of weakening the checks.",
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
        "Split the change into smaller deliveries.",
      ],
    };
  }

  /** Changed and deleted test files as the base held them and as the change holds them now. */
  async #changedTests(
    root: string,
    changes: ChangeSet,
  ): Promise<{ path: string; before: string; after: string; deleted?: boolean }[]> {
    const tests: { path: string; before: string; after: string; deleted?: boolean }[] = [];
    for (const path of changes.deleted) {
      if (!isTestFile(path)) continue;
      const before = changes.base === null ? "" : await this.#atBase(root, changes.base, path);
      tests.push({ path, before: before.length > maxScannedBytes ? "" : before, after: "", deleted: true });
    }
    if (changes.base === null) return tests;
    for (const path of changes.files.keys()) {
      if (!isTestFile(path)) continue;
      const content = await this.changeSets.content(root, path, changes.staged);
      if (content === null || isBinary(content) || content.length > maxScannedBytes) continue;
      tests.push({ path, before: await this.#atBase(root, changes.base, path), after: content.toString("utf8") });
    }
    return tests;
  }

  /**
   * Symbols that production files the change edits or deletes declared at the base and that no
   * file the change leaves, tracked or untracked, mentions anymore: code removed from the repository.
   */
  async #goneSymbols(root: string, changes: ChangeSet): Promise<ReadonlySet<string>> {
    const candidates = new Set<string>();
    if (changes.base === null) return candidates;
    const kept = new Set<string>();
    for (const path of [...changes.files.keys(), ...changes.deleted]) {
      if (!declaresSymbols(path)) continue;
      const before = await this.#atBase(root, changes.base, path);
      if (before.length > maxScannedBytes) continue;
      for (const symbol of declaredSymbols(path, before)) candidates.add(symbol);
      const content = changes.files.has(path) ? await this.changeSets.content(root, path, changes.staged) : null;
      if (content !== null && !isBinary(content)) for (const symbol of declaredSymbols(path, content.toString("utf8"))) kept.add(symbol);
    }
    for (const symbol of kept) candidates.delete(symbol);
    if (candidates.size === 0) return candidates;
    const patterns = [...candidates].flatMap((symbol) => ["-e", symbol]);
    const scope = changes.staged ? ["--cached"] : ["--untracked"];
    const result = await this.process.run(
      "git",
      ["grep", "-I", "-w", "-F", "-o", "-h", "--no-color", ...scope, ...patterns],
      { cwd: root, timeoutMs: 60_000 },
    );
    // 1 means no file mentions any of them; anything else unreadable keeps every symbol in use.
    if (result.exitCode === 1) return candidates;
    if (result.exitCode !== 0) return new Set();
    for (const found of result.stdout.split("\n")) candidates.delete(found.trim());
    return candidates;
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

/**
 * What a `change-integrity` finding is about. `finding_policy` may report one of the relaxable
 * kinds instead of blocking on it; a protected configuration and a file too large to scan always
 * block, since relaxing them would hide the policy itself or what nobody could read.
 */
const relaxableFindings = ["suppression", "test-deleted", "test-removed", "test-renamed", "test-obsolete"] as const;
type FindingKind = "protected-config" | "unscannable" | (typeof relaxableFindings)[number];

const defaultFindingPolicy = ["test-renamed=report", "test-obsolete=report"];

/** `<kind>=<block|report>` entries; the last entry of a kind decides, and other kinds always block. */
function findingPolicy(entries: readonly string[]): ReadonlyMap<string, "block" | "report"> {
  const policy = new Map<string, "block" | "report">();
  for (const entry of entries) {
    const [kind = "", level] = entry.split("=");
    if (!(relaxableFindings as readonly string[]).includes(kind)) continue;
    if (level === "block" || level === "report") policy.set(kind, level);
  }
  return policy;
}

/** Git's own heuristic: a NUL byte in the first 8000 bytes marks the file as binary. */
function isBinary(content: Buffer): boolean {
  return content.subarray(0, 8000).includes(0);
}


function passed(summary: string): CheckOutcome {
  return { status: "passed", summary, details: [] };
}


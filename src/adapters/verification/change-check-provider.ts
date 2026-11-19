import { createHash } from "node:crypto";
import {
  changedLineCount,
  declaresSymbols,
  isTestFile,
  justificationFor,
  matchesAnyGlob,
  removedSymbols,
  suppressionFindings,
  testChanges,
  type Justification,
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
        return await this.#acceptance.judge(request, kind, (scope, justified) => this.#integrity(request, scope, justified));
      case "change-size":
        return await this.#acceptance.judge(request, kind, (scope) => this.#size(request, scope));
      default:
        return { status: "unavailable", summary: `Unknown change check kind ${kind}`, details: [] };
    }
  }

  async #integrity(request: CheckRequest, changes: ChangeSet, justified: readonly Justification[]): Promise<CheckOutcome> {
    const protectedPaths = request.inputs.protected_paths ?? [];
    // An entry overrides the default of its kind only: relaxing one kind keeps the other defaults.
    const policy = findingPolicy([...defaultFindingPolicy, ...(request.inputs.finding_policy ?? [])]);
    const findings: Finding[] = [];
    const add = (kind: FindingKind, texts: readonly string[], key: (text: string) => string = (text) => text) =>
      findings.push(...texts.map((text) => ({ kind, text, key: `${kind}\u0000${key(text)}` })));
    for (const [path, lines] of changes.files) {
      if (matchesAnyGlob(path, protectedPaths)) {
        // Adding a configuration weakens nothing; changing one the base already had can.
        if (await this.#existsAtBase(request.repositoryRoot, changes.base, path)) {
          const content = await this.changeSets.content(request.repositoryRoot, path, changes.staged);
          const digest = content === null ? "unreadable" : createHash("sha256").update(content).digest("hex");
          add("protected-config", [`${path}: protected quality configuration changed`], () => `${path}@${digest}`);
        }
        continue;
      }
      const content = await this.changeSets.content(request.repositoryRoot, path, changes.staged);
      if (content === null || isBinary(content)) continue;
      if (content.length > maxScannedBytes) {
        add("unscannable", [`${path}: too large to scan for suppressions (over ${maxScannedBytes / 1024 / 1024} MiB)`], () => path);
        continue;
      }
      // A line number moves with every rebase; the marker and its text identify the finding.
      add("suppression", suppressionFindings(path, content.toString("utf8"), lines), (text) => text.replace(/:\d+: /u, ": "));
    }
    for (const path of changes.deleted) {
      if (!isTestFile(path) && matchesAnyGlob(path, protectedPaths)) {
        add("protected-config", [`${path}: protected quality configuration deleted`], () => `${path}@deleted`);
      }
    }
    const tests = testChanges(
      await this.#changedTests(request.repositoryRoot, changes),
      await this.#goneSymbols(request.repositoryRoot, changes),
    );
    add("test-deleted", tests.deleted);
    add("test-removed", tests.removed);
    add("test-renamed", tests.renamed);
    add("test-obsolete", tests.obsolete);
    const level = (kind: FindingKind) => policy.get(kind) ?? "block";
    // A justification names the finding's kind, or the check's to cover all of its justifiable kinds,
    // and may name the finding's file.
    const justification = ({ kind, text }: Finding) => justificationFor(justified, kind, "change-integrity", findingPath(text));
    const blocking = findings.filter((finding) =>
      level(finding.kind) === "block" || (level(finding.kind) === "justify" && justification(finding) === undefined));
    const passing = findings
      .filter((finding) => !blocking.includes(finding))
      .map((finding) => level(finding.kind) === "report"
        ? `${finding.text} (reported: ${finding.kind}=report)`
        : `${finding.text} (justified: ${justification(finding)})`);
    if (blocking.length === 0) {
      return passing.length === 0
        ? passed("No suppression, removed test or protected configuration change")
        : { status: "passed", summary: `${passing.length} change(s) reported or justified, none blocking`, details: passing };
    }
    const unjustified = [...new Set(blocking.filter(({ kind }) => level(kind) === "justify").map(({ kind }) => kind))].sort();
    return {
      status: "failed",
      summary: `${blocking.length} change(s) weaken what the checks can see`,
      details: [
        ...blocking.map(({ kind, text }) => level(kind) === "justify" ? `${text} (${kind}: needs a justification)` : text),
        ...passing,
        ...(unjustified.length === 0 ? [] : [justifyAdvice(unjustified)]),
        "Fix the cause instead of weakening the checks.",
      ],
      findings: [...new Set(blocking.map(({ key }) => key))].sort(),
    };
  }

  async #size(request: CheckRequest, changes: ChangeSet): Promise<CheckOutcome> {
    const limit = Number(request.inputs.max_changed_lines?.[0] ?? 400);
    const excluded = [
      ...(request.inputs.size_excluded_paths ?? []),
      ...(request.inputs.size_excluded_data ?? []).filter((glob) => glob !== "none"),
    ];
    const counted: { readonly path: string; readonly lines: number; readonly from?: string }[] = [];
    const renames = await this.#renames(request.repositoryRoot, changes);
    for (const [path, lines] of changes.files) {
      if (isTestFile(path) || matchesAnyGlob(path, excluded)) continue;
      const rename = renames.get(path);
      if (rename !== undefined) {
        // A moved file adds only the lines the move changed, such as its package clause and imports.
        counted.push({ path, lines: rename.added, from: rename.from });
        continue;
      }
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
        ...counted
          .sort((left, right) => right.lines - left.lines)
          .slice(0, 10)
          .map((file) => `${file.path}: ${file.lines}${file.from === undefined ? "" : ` (moved from ${file.from})`}`),
        "Split the change into smaller deliveries.",
      ],
      // A file the approved commit did not count is a new finding; more lines in the same files are not.
      findings: counted.map((file) => `change-size\u0000${file.path}`).sort(),
    };
  }

  /**
   * Files the change moved, by Git's rename detection (at least 50% similar to a file the change
   * deleted), with the lines added relative to their old path. Untracked files are not paired.
   */
  async #renames(root: string, changes: ChangeSet): Promise<ReadonlyMap<string, { readonly from: string; readonly added: number }>> {
    const renames = new Map<string, { readonly from: string; readonly added: number }>();
    if (changes.base === null || changes.deleted.length === 0) return renames;
    const result = await this.process.run(
      "git",
      ["-c", "core.quotePath=false", "diff", ...(changes.staged ? ["--cached"] : []), "--no-ext-diff", "--find-renames", "--numstat", "-z", changes.base, "--"],
      { cwd: root, timeoutMs: 60_000 },
    );
    if (result.exitCode !== 0) return renames;
    // `<added>\t<deleted>\t\0<from>\0<to>\0` for a rename; `<added>\t<deleted>\t<path>\0` otherwise.
    const fields = result.stdout.split("\0");
    for (let index = 0; index < fields.length; index += 1) {
      const match = /^(\d+|-)\t(?:\d+|-)\t(.*)$/su.exec(fields[index] ?? "");
      if (match === null || match[2] !== "") continue;
      const from = fields[index + 1] ?? "";
      const to = fields[index + 2] ?? "";
      index += 2;
      if (match[1] !== "-" && changes.files.has(to)) renames.set(to, { from, added: Number(match[1]) });
    }
    return renames;
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
    if (changes.base === null) return new Set();
    const files: { path: string; before: string; after: string }[] = [];
    for (const path of [...changes.files.keys(), ...changes.deleted]) {
      if (!declaresSymbols(path)) continue;
      const before = await this.#atBase(root, changes.base, path);
      const content = changes.files.has(path) ? await this.changeSets.content(root, path, changes.staged) : null;
      const after = content === null || isBinary(content) ? "" : content.toString("utf8");
      if (before.length > maxScannedBytes || after.length > maxScannedBytes) continue;
      files.push({ path, before, after });
    }
    const candidates = new Set(removedSymbols(files));
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
 * What a `change-integrity` finding is about. `finding_policy` sets each relaxable kind to `block`,
 * `justify` (passes once a `Railguard-Justify` trailer on the branch explains it) or `report` (shown,
 * never failing). A protected configuration and a file too large to scan always block, since
 * relaxing them would hide the policy itself or what nobody could read.
 */
const relaxableFindings = ["suppression", "test-deleted", "test-removed", "test-renamed", "test-obsolete"] as const;
type FindingKind = "protected-config" | "unscannable" | (typeof relaxableFindings)[number];
type FindingLevel = "block" | "justify" | "report";

interface Finding {
  readonly kind: FindingKind;
  readonly text: string;
  /** Kind and identity without line numbers, which a rebase moves. */
  readonly key: string;
}

/**
 * Tests that leave with the behavior they covered, or move, are routine: a reason keeps the
 * history honest without a person's approval. A suppression silences a check on code that stays,
 * so it keeps blocking.
 */
const defaultFindingPolicy = [
  "suppression=block",
  "test-deleted=justify",
  "test-removed=justify",
  "test-renamed=justify",
  "test-obsolete=justify",
];

/** `<kind>=<block|justify|report>` entries; the last entry of a kind decides, and other kinds always block. */
function findingPolicy(entries: readonly string[]): ReadonlyMap<string, FindingLevel> {
  const policy = new Map<string, FindingLevel>();
  for (const entry of entries) {
    const [kind = "", level] = entry.split("=");
    if (!(relaxableFindings as readonly string[]).includes(kind)) continue;
    if (level === "block" || level === "justify" || level === "report") policy.set(kind, level);
  }
  return policy;
}

/** How an agent explains findings that need only a reason. */
function justifyAdvice(kinds: readonly string[]): string {
  const kind = kinds.length === 1 ? kinds[0] as string : "change-integrity";
  return [
    `To keep ${kinds.join(", ")} on purpose, justify it: \`git commit --allow-empty -m "chore: justify ${kind}" -m "Railguard-Justify: ${kind}: <why this is right>"\`, then commit the change.`,
    "Use a finding kind to cover only that kind, or change-integrity to cover every justifiable finding of the branch.",
    `Name the file after the kind (\`Railguard-Justify: ${kind} <path>: <why>\`, one trailer per file) to keep each reason with its own findings; a reason without a file is shown on every finding of its kind, beside the other such reasons, in the checks and in \`railguard report\`.`,
  ].join(" ");
}

/** The file a finding is about: its text starts with the path, and a line number for a suppression. */
function findingPath(text: string): string {
  return /^(.+?)(?::\d+)?: /u.exec(text)?.[1] ?? text;
}

/** Git's own heuristic: a NUL byte in the first 8000 bytes marks the file as binary. */
function isBinary(content: Buffer): boolean {
  return content.subarray(0, 8000).includes(0);
}


function passed(summary: string): CheckOutcome {
  return { status: "passed", summary, details: [] };
}


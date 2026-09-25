import { readFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, normalize, posix, sep } from "node:path";
import { sha256 } from "../../domain/shared/types.js";
import {
  changedLineCount,
  isTestFile,
  matchesAnyGlob,
  parseAllowances,
  suppressionFindings,
} from "../../domain/verification/change-guard.js";
import {
  changeDigest,
  evaluateReview,
  parseReviewInput,
  type ActiveHandoff,
  type ReviewRecord,
} from "../../domain/verification/change-review.js";
import type {
  ChangeSet,
  ChangeSetReader,
  CheckOutcome,
  CheckProvider,
  CheckRequest,
  ProcessRunner,
} from "../../domain/verification/checks.js";
import { readActiveHandoffs } from "./knowledge-os-handoffs.js";

const maxScannedBytes = 2 * 1024 * 1024;

/** Stack-independent checks that judge the shape of a change rather than its code. */
export class ChangeCheckProvider implements CheckProvider {
  public readonly kinds = ["change-integrity", "change-size", "change-review"] as const;

  public constructor(
    private readonly process: ProcessRunner,
    private readonly review: ChangeReview,
  ) {}

  public async run(kind: string, request: CheckRequest): Promise<CheckOutcome> {
    const changes = request.changes;
    if (changes === null) return skipped("Judges a change; run with --changed");
    switch (kind) {
      case "change-integrity":
        return await this.#integrity(request, changes);
      case "change-size":
        return await this.#size(request, changes);
      case "change-review":
        return await this.review.evaluate(request.repositoryRoot, changes);
      default:
        return { status: "unavailable", summary: `Unknown change check kind ${kind}`, details: [] };
    }
  }

  async #integrity(request: CheckRequest, changes: ChangeSet): Promise<CheckOutcome> {
    const protectedPaths = request.inputs.protected_paths ?? [];
    const findings: string[] = [];
    for (const [path, lines] of changes.files) {
      if (matchesAnyGlob(path, protectedPaths)) {
        findings.push(`${path}: protected quality configuration changed`);
        continue;
      }
      const content = await readText(request.repositoryRoot, path);
      if (content !== null) findings.push(...suppressionFindings(path, content, lines));
    }
    for (const path of changes.deleted) {
      if (isTestFile(path)) findings.push(`${path}: test file deleted`);
      else if (matchesAnyGlob(path, protectedPaths)) findings.push(`${path}: protected quality configuration deleted`);
    }
    if (findings.length === 0) return passed("No suppression, deleted test or protected configuration change");
    return await this.#unlessAllowed(request, changes, "change-integrity", {
      status: "failed",
      summary: `${findings.length} change(s) weaken what the checks can see`,
      details: [
        ...findings,
        "Fix the cause instead. Only a person may accept this on purpose, with a `Railguard-Allow: change-integrity: <reason>` trailer in a commit of this branch.",
      ],
    });
  }

  async #size(request: CheckRequest, changes: ChangeSet): Promise<CheckOutcome> {
    const limit = Number(request.inputs.max_changed_lines?.[0] ?? 400);
    const excluded = request.inputs.size_excluded_paths ?? [];
    const counted: { readonly path: string; readonly lines: number }[] = [];
    for (const [path, lines] of changes.files) {
      if (isTestFile(path) || matchesAnyGlob(path, excluded)) continue;
      const content = lines === "all" ? await readText(request.repositoryRoot, path) : "";
      if (content === null) continue;
      counted.push({ path, lines: changedLineCount(content, lines) });
    }
    const total = counted.reduce((sum, file) => sum + file.lines, 0);
    if (total <= limit) return passed(`${total} changed line(s) outside tests, within ${limit}`);
    return await this.#unlessAllowed(request, changes, "change-size", {
      status: "failed",
      summary: `${total} changed line(s) outside tests exceed the reviewable limit of ${limit}`,
      details: [
        ...counted.sort((left, right) => right.lines - left.lines).slice(0, 10).map((file) => `${file.path}: ${file.lines}`),
        "Split the change into smaller deliveries. A person may accept it with a `Railguard-Allow: change-size: <reason>` trailer.",
      ],
    });
  }

  async #unlessAllowed(
    request: CheckRequest,
    changes: ChangeSet,
    kind: string,
    failure: CheckOutcome,
  ): Promise<CheckOutcome> {
    if (changes.base === null) return failure;
    const log = await this.process.run("git", ["log", "--format=%B", `${changes.base}..HEAD`], {
      cwd: request.repositoryRoot,
      timeoutMs: 60_000,
    });
    const reason = log.exitCode === 0 ? parseAllowances(log.stdout).get(kind) : undefined;
    if (reason === undefined) return failure;
    return { status: "passed", summary: `Accepted by Railguard-Allow: ${reason}`, details: failure.details.slice(0, -1) };
  }
}

/**
 * Review of a change against its active handoffs. The reviewer (ideally a subagent given only the
 * handoff and the diff) judges each criterion; Railguard records that judgment for the exact change
 * content and verifies mechanically that it is current, covers every handoff and cites real files.
 */
export class ChangeReview {
  public constructor(
    private readonly process: ProcessRunner,
    private readonly changeSets: ChangeSetReader,
  ) {}

  public async evaluate(root: string, changes: ChangeSet): Promise<CheckOutcome> {
    const handoffs = await readActiveHandoffs(root);
    if (handoffs.length === 0) return skipped("No active handoff to review against");
    if (changes.files.size === 0 && changes.deleted.length === 0) return skipped("No change to review");
    const digest = await this.#digest(root, changes);
    const record = await this.#readRecord(root);
    const evaluation = evaluateReview(record, handoffs, digest, (reference) => evidenceExists(root, reference));
    if (evaluation.stale.length > 0) {
      return {
        status: "failed",
        summary: "This change has no current review against its handoff",
        details: [...evaluation.stale, ...instructions(handoffs, changes)],
      };
    }
    if (evaluation.invalid.length > 0 || evaluation.unmet.length > 0) {
      return {
        status: "failed",
        summary: evaluation.unmet.length > 0 ? `${evaluation.unmet.length} handoff criterion(s) not met` : "The recorded review does not hold up",
        details: [
          ...evaluation.unmet.map((criterion) => `not met: ${criterion}`),
          ...evaluation.invalid,
          "Fix the change, review it again and run `railguard review record <file>`.",
        ],
      };
    }
    return passed(`Reviewed against ${handoffs.map((handoff) => handoff.family).join(", ")}`);
  }

  /** What a reviewer needs: the handoffs, the base to diff against and the expected record. */
  public async brief(root: string, base?: string): Promise<string> {
    const handoffs = await readActiveHandoffs(root);
    if (handoffs.length === 0) return "No active handoff in .knowledge-os-handoffs/ACTIVE.yaml; nothing to review.\n";
    const changes = await this.changeSets.read(root, base);
    const outcome = await this.evaluate(root, changes);
    return [
      `Review status: ${outcome.status} — ${outcome.summary}`,
      ...instructions(handoffs, changes),
      "",
    ].join("\n");
  }

  /** Stores a reviewer's criteria for the current change content, rejecting incomplete input. */
  public async record(root: string, inputFile: string, base?: string): Promise<{ readonly ok: boolean; readonly message: string }> {
    const handoffs = await readActiveHandoffs(root);
    if (handoffs.length === 0) return { ok: false, message: "No active handoff to record a review for." };
    let input: unknown;
    try {
      input = JSON.parse(await readFile(inputFile, "utf8"));
    } catch (error) {
      return { ok: false, message: `Cannot read the review: ${error instanceof Error ? error.message : String(error)}` };
    }
    const parsed = parseReviewInput(input);
    if ("errors" in parsed) return { ok: false, message: parsed.errors.join("\n") };
    const changes = await this.changeSets.read(root, base);
    const record: ReviewRecord = {
      schema: "railguard/review/v1",
      change_digest: await this.#digest(root, changes),
      base: changes.base,
      handoffs: handoffs.map((handoff) => ({ id: handoff.id, revision: handoff.revision })),
      reviewer: parsed.reviewer,
      criteria: parsed.criteria,
    };
    const evaluation = evaluateReview(record, handoffs, record.change_digest, (reference) => evidenceExists(root, reference));
    if (evaluation.invalid.length > 0) return { ok: false, message: evaluation.invalid.join("\n") };
    const path = await this.#recordPath(root);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
    const unmet = evaluation.unmet.length;
    return {
      ok: unmet === 0,
      message: unmet === 0
        ? `Review recorded for ${handoffs.map((handoff) => handoff.family).join(", ")}.`
        : `Review recorded with ${unmet} criterion(s) not met:\n${evaluation.unmet.join("\n")}`,
    };
  }

  async #digest(root: string, changes: ChangeSet): Promise<string> {
    const files: { path: string; digest: string }[] = [];
    for (const path of changes.files.keys()) {
      try {
        files.push({ path, digest: sha256(await readFile(join(root, path))) });
      } catch {
        files.push({ path, digest: "unreadable" });
      }
    }
    return changeDigest(files, changes.deleted);
  }

  async #readRecord(root: string): Promise<ReviewRecord | null> {
    try {
      const value = JSON.parse(await readFile(await this.#recordPath(root), "utf8")) as ReviewRecord;
      return value.schema === "railguard/review/v1" ? value : null;
    } catch {
      return null;
    }
  }

  /** Inside the worktree's own Git directory, so it is never versioned and each worktree has one. */
  async #recordPath(root: string): Promise<string> {
    const result = await this.process.run("git", ["rev-parse", "--absolute-git-dir"], { cwd: root, timeoutMs: 30_000 });
    if (result.exitCode !== 0) throw new Error("The review record needs a Git repository");
    return join(result.stdout.trim(), "railguard", "review.json");
  }
}

function instructions(handoffs: readonly ActiveHandoff[], changes: ChangeSet): readonly string[] {
  return [
    "Review the change against its handoff before delivering:",
    ...handoffs.map((handoff) => `  ${handoff.family} (${handoff.revision}): ${posix.join(handoff.directory, "scope.md")}, ${posix.join(handoff.directory, "context.md")}`),
    `1. Launch a subagent with no access to this conversation. Give it only those handoff files and \`git diff ${changes.base ?? "HEAD"}\` (plus untracked files). If your harness has no subagents, review with only those sources.`,
    "2. It lists every acceptance criterion of scope.md in a JSON file:",
    '   {"reviewer": "subagent", "criteria": [{"handoff": "<family>", "criterion": "...", "status": "met|not_met|not_applicable", "evidence": ["path:line"], "note": "..."}]}',
    "3. Fix every not_met criterion, then run `railguard review record <file>`.",
  ];
}

async function readText(root: string, path: string): Promise<string | null> {
  try {
    const absolute = join(root, path);
    if ((await stat(absolute)).size > maxScannedBytes) return null;
    const content = await readFile(absolute, "utf8");
    return content.includes("\0") ? null : content;
  } catch {
    return null;
  }
}

function evidenceExists(root: string, reference: string): boolean {
  const match = /^(.+?)(?::(\d+)(?:-\d+)?)?$/u.exec(reference);
  const path = match?.[1] ?? reference;
  if (isAbsolute(path) || normalize(path).split(sep).includes("..")) return false;
  try {
    const content = readFileSync(join(root, path), "utf8");
    const line = match?.[2] === undefined ? null : Number(match[2]);
    return line === null || (line >= 1 && line <= content.split("\n").length);
  } catch {
    return false;
  }
}

function passed(summary: string): CheckOutcome {
  return { status: "passed", summary, details: [] };
}

function skipped(summary: string): CheckOutcome {
  return { status: "skipped", summary, details: [] };
}

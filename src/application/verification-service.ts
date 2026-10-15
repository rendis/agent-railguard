import type { CatalogSnapshot, CatalogVerificationProfileComponent } from "../domain/catalog/model.js";
import { compareUtf8, relativePosixPath, type ComponentRef, type Diagnostic } from "../domain/shared/types.js";
import { DesiredStateModule } from "../project-state/desired-state.js";
import {
  acceptableKinds,
  assessApproval,
  pendingSuffix,
  type PullRequestReader,
  type PullRequestState,
} from "../domain/verification/acceptance.js";
import {
  changedFilesInUnit,
  changesAt,
  deletedFilesInUnit,
  type ChangeSet,
  type ChangeSetReader,
  type CheckOutcome,
  type CheckProvider,
  type CheckStage,
  type ProcessResult,
} from "../domain/verification/checks.js";
import {
  planFullSteps,
  profileInputs,
  profileUnits,
  renderVerifyScript,
  scriptExit,
  verifyScriptPath,
  type FullStep,
  type VerifyScript,
} from "../domain/verification/verify-script.js";
import type { ScanResult } from "./model.js";

export interface VerificationRequest {
  readonly root: string;
  readonly stage: CheckStage;
  /** Judge only what changed relative to the base instead of every project unit completely. */
  readonly changed: boolean;
  /** With `changed`, judge only what is staged for the next commit, as a pre-commit hook does. */
  readonly staged?: boolean;
  readonly base?: string;
  /** With `changed`, judge only these repository paths of the change, such as an agent's edit. */
  readonly paths?: readonly string[];
  /** Run only checks of these kinds; by default every check of the stage runs. */
  readonly kinds?: readonly string[];
  /**
   * Judge this pull request's change as CI's gate: only the checks whose findings a person may
   * accept, with a finding that a commit asked to accept resolved by the pull request's approval.
   */
  readonly pullRequest?: number;
  readonly signal?: AbortSignal;
}

export interface CheckResult {
  readonly profile: ComponentRef;
  readonly check: string;
  readonly kind: string;
  readonly unit: string;
  readonly outcome: CheckOutcome;
}

export type VerificationVerdict = "passed" | "pending" | "failed" | "unavailable" | "blocked";

/** What the pull request says about the findings a person was asked to accept. */
export interface PullRequestReport {
  readonly number: number;
  readonly head: string;
  readonly author: string;
  /** The acceptor whose approval of the head commit counts, or null. */
  readonly approvedBy: string | null;
  readonly approvers: readonly string[];
  readonly notes: readonly string[];
  /** How many findings asked for a person's acceptance and were settled by the reviews. */
  readonly requests: number;
}

export interface VerificationReport {
  readonly stage: CheckStage;
  readonly mode: "changed" | "staged" | "full";
  readonly base: string | null;
  readonly baseRef: string | null;
  readonly verdict: VerificationVerdict;
  readonly results: readonly CheckResult[];
  readonly diagnostics: readonly Diagnostic[];
  readonly pullRequest?: PullRequestReport;
}

export type VerificationProgress = (
  event:
    | { readonly type: "started"; readonly profile: ComponentRef; readonly check: string; readonly unit: string }
    | { readonly type: "completed"; readonly result: CheckResult },
) => void;

export interface VerificationDependencies {
  readonly scan: (root: string) => Promise<ScanResult>;
  readonly changeSets: ChangeSetReader;
  readonly providers: readonly CheckProvider[];
  readonly script: VerifyScript;
  readonly pullRequests?: PullRequestReader;
}

/**
 * Runs the checks of every selected verification profile. `check` runs the fast stage; `verify`
 * runs both stages. With `changed`, each check judges only what the change touched; without it,
 * every step of the repository's verify script runs, the same steps CI runs.
 */
export class VerificationService {
  readonly #dependencies: VerificationDependencies;
  readonly #providers: ReadonlyMap<string, CheckProvider>;

  public constructor(dependencies: VerificationDependencies) {
    this.#dependencies = dependencies;
    this.#providers = new Map(
      dependencies.providers.flatMap((provider) => provider.kinds.map((kind) => [kind, provider] as const)),
    );
  }

  public async run(
    request: VerificationRequest,
    progress: VerificationProgress = () => undefined,
  ): Promise<VerificationReport> {
    const mode = !request.changed ? "full" : request.staged === true ? "staged" : "changed";
    const scan = await this.#dependencies.scan(request.root);
    if (scan.kind === "blocked") return blocked(request.stage, mode, scan.diagnostics);
    if (scan.desired === null) {
      return blocked(request.stage, mode, [notInitializedDiagnostic()]);
    }
    const selectedInputs = new Map(
      scan.desired.state.selections.map((selection) => [selection.ref, selection.inputs ?? {}] as const),
    );
    const resolved = new Set(
      scan.resolution?.kind === "ready"
        ? scan.resolution.components.map((component) => component.ref)
        : scan.desired.state.selections.map((selection) => selection.ref),
    );
    const profiles = scan.catalog.components
      .filter(
        (component): component is CatalogVerificationProfileComponent =>
          component.kind === "verification-profile" && resolved.has(component.ref),
      )
      .sort((left, right) => compareUtf8(left.ref, right.ref));
    const projectUnits = scan.assessment.projectUnits;
    if (!request.changed) {
      const steps = planFullSteps(profiles, projectUnits, selectedInputs, this.#dependencies.providers);
      return await this.#runFull(request, scan.snapshot.realRoot, steps, progress);
    }
    let pullRequest: PullRequestState | null = null;
    if (request.pullRequest !== undefined) {
      const gate = await this.#readPullRequest(scan.snapshot.realRoot, request.pullRequest);
      if ("diagnostic" in gate) return blocked(request.stage, mode, [gate.diagnostic]);
      pullRequest = gate.pullRequest;
    }
    const kinds = pullRequest === null ? request.kinds : (request.kinds ?? acceptableKinds);
    let changes: ChangeSet;
    try {
      const read = await this.#dependencies.changeSets.read(scan.snapshot.realRoot, request.base, { staged: request.staged === true });
      changes = changesAt(read, request.paths);
    } catch (error) {
      return blocked(request.stage, mode, [changeSetDiagnostic(error)]);
    }

    const results: CheckResult[] = [];
    for (const profile of profiles) {
      const inputs = profileInputs(profile, selectedInputs.get(profile.ref));
      const checks = profile.checks.filter(
        (check) =>
          (request.stage === "verify" || check.stage === "check") &&
          (kinds === undefined || kinds.includes(check.kind)),
      );
      for (const unit of profileUnits(profile, projectUnits)) {
        for (const check of checks) {
          progress({ type: "started", profile: profile.ref, check: check.id, unit });
          const outcome = unitUnchanged(changes, unit)
            ? Object.freeze({ status: "skipped" as const, summary: "No change in this project unit", details: [] })
            : await this.#run(check.kind, {
                repositoryRoot: scan.snapshot.realRoot,
                unitRoot: unit,
                params: check.params,
                inputs,
                changes,
                ...(request.paths === undefined ? {} : { paths: request.paths }),
                ...(request.signal === undefined ? {} : { signal: request.signal }),
              });
          const result = Object.freeze({ profile: profile.ref, check: check.id, kind: check.kind, unit, outcome });
          results.push(result);
          progress({ type: "completed", result });
        }
      }
    }
    if (pullRequest === null) {
      return Object.freeze({
        stage: request.stage,
        mode,
        base: changes.base,
        baseRef: changes.baseRef,
        verdict: verdict(results),
        results: Object.freeze(results),
        diagnostics: Object.freeze([]),
      });
    }
    if (results.every((result) => result.outcome.status === "skipped")) {
      return blocked(request.stage, mode, [noAcceptanceProfileDiagnostic()]);
    }
    const approvers = await this.#approvers(
      scan.snapshot.realRoot,
      request.base ?? changes.base,
      scan.catalog,
    );
    const settled = resolvePending(results, pullRequest, approvers);
    return Object.freeze({
      stage: request.stage,
      mode,
      base: changes.base,
      baseRef: changes.baseRef,
      verdict: verdict(settled.results),
      results: Object.freeze(settled.results),
      diagnostics: Object.freeze([]),
      pullRequest: settled.report,
    });
  }

  async #readPullRequest(
    root: string,
    number: number,
  ): Promise<{ readonly pullRequest: PullRequestState } | { readonly diagnostic: Diagnostic }> {
    const reader = this.#dependencies.pullRequests;
    if (reader === undefined) return { diagnostic: pullRequestUnavailableDiagnostic(number, "This build cannot read pull requests.") };
    let pullRequest: PullRequestState;
    try {
      pullRequest = await reader.read(root, number);
    } catch (error) {
      return { diagnostic: pullRequestUnavailableDiagnostic(number, error instanceof Error ? error.message : String(error)) };
    }
    if (pullRequest.checkedOut !== pullRequest.head) {
      return { diagnostic: headMismatchDiagnostic(number, pullRequest) };
    }
    return { pullRequest };
  }

  /**
   * Who may accept each profile's findings, as the target branch holds the selection: a pull
   * request cannot add itself as an approver.
   */
  async #approvers(
    root: string,
    revision: string | null,
    catalog: CatalogSnapshot,
  ): Promise<ReadonlyMap<ComponentRef, readonly string[]>> {
    const approvers = new Map<ComponentRef, readonly string[]>();
    if (revision === null) return approvers;
    const source = await this.#dependencies.changeSets.show(root, revision, ".railguard/project.yaml");
    if (source === null) return approvers;
    const desired = new DesiredStateModule().evaluate({ kind: "yaml", source }, catalog);
    if (desired.kind !== "ready") return approvers;
    for (const selection of desired.state.selections) {
      const logins = selection.inputs.approvers;
      if (logins !== undefined) approvers.set(selection.ref, logins);
    }
    return approvers;
  }

  /** Runs the stage's steps through the versioned script, which must match the current selection. */
  async #runFull(
    request: VerificationRequest,
    root: string,
    steps: readonly FullStep[],
    progress: VerificationProgress,
  ): Promise<VerificationReport> {
    const expected = renderVerifyScript(steps);
    if (expected !== null) {
      const actual = await this.#dependencies.script.read(root);
      if (actual !== expected) return blocked(request.stage, "full", [staleScriptDiagnostic(actual === null)]);
    }
    const results: CheckResult[] = [];
    for (const step of steps.filter((candidate) => request.stage === "verify" || candidate.stage === "check")) {
      progress({ type: "started", profile: step.profile, check: step.check, unit: step.unit });
      const outcome: CheckOutcome = step.full.kind === "skipped"
        ? Object.freeze({ status: "skipped", summary: step.full.reason, details: [] })
        : stepOutcome(step, await this.#dependencies.script.step(root, step.id, request.signal));
      const result = Object.freeze({ profile: step.profile, check: step.check, kind: step.kind, unit: step.unit, outcome });
      results.push(result);
      progress({ type: "completed", result });
    }
    return Object.freeze({
      stage: request.stage,
      mode: "full",
      base: null,
      baseRef: null,
      verdict: verdict(results),
      results: Object.freeze(results),
      diagnostics: Object.freeze([]),
    });
  }

  async #run(kind: string, request: Parameters<CheckProvider["run"]>[1]): Promise<CheckOutcome> {
    const provider = this.#providers.get(kind);
    if (provider === undefined) {
      return { status: "unavailable", summary: `This railguard version has no provider for ${kind}`, details: [] };
    }
    try {
      return await provider.run(kind, request);
    } catch (error) {
      return {
        status: "unavailable",
        summary: `The ${kind} check could not run`,
        details: [error instanceof Error ? error.message : String(error)],
      };
    }
  }
}

/** The failed checks of a report as `profile/check`, such as `secret-guard/secrets`. */
export function failedChecks(report: VerificationReport): readonly string[] {
  return report.results
    .filter((result) => result.outcome.status === "failed")
    .map((result) => `${result.profile.slice(result.profile.indexOf(":") + 1)}/${result.check}`);
}

function stepOutcome(step: FullStep, result: ProcessResult): CheckOutcome {
  const text = `${result.stdout}\n${result.stderr}`.trim();
  const all = text.length === 0 ? [] : text.split("\n");
  const tail = all.slice(-60);
  const details = [
    ...(result.timedOut ? ["The step timed out."] : []),
    ...(all.length > tail.length ? [`… ${all.length - tail.length} earlier line(s) omitted`] : []),
    ...tail,
  ];
  switch (result.exitCode) {
    case scriptExit.passed:
      return Object.freeze({ status: "passed", summary: `${step.id} passed`, details: Object.freeze([]) });
    case scriptExit.unavailable:
      return Object.freeze({ status: "unavailable", summary: `${step.id} could not run`, details: Object.freeze(details) });
    case scriptExit.usage:
      return Object.freeze({
        status: "unavailable",
        summary: `${verifyScriptPath} has no step ${step.id}`,
        details: Object.freeze(["Run railguard sync --yes to regenerate it."]),
      });
    default:
      return Object.freeze({ status: "failed", summary: `${step.id} failed`, details: Object.freeze(details) });
  }
}

function unitUnchanged(changes: ChangeSet, unit: string): boolean {
  return changedFilesInUnit(changes, unit).size === 0 && deletedFilesInUnit(changes, unit).length === 0;
}

function verdict(results: readonly CheckResult[]): VerificationVerdict {
  if (results.some((result) => result.outcome.status === "failed")) return "failed";
  if (results.some((result) => result.outcome.status === "unavailable")) return "unavailable";
  if (results.some((result) => result.outcome.status === "pending")) return "pending";
  return "passed";
}

function blocked(
  stage: CheckStage,
  mode: VerificationReport["mode"],
  diagnostics: readonly Diagnostic[],
): VerificationReport {
  return Object.freeze({
    stage,
    mode,
    base: null,
    baseRef: null,
    verdict: "blocked",
    results: Object.freeze([]),
    diagnostics: Object.freeze([...diagnostics]),
  });
}

function notInitializedDiagnostic(): Diagnostic {
  return Object.freeze({
    code: "verification.project.uninitialized",
    severity: "blocked",
    phase: "verification",
    subjects: Object.freeze([]),
    location: null,
    message: "This repository has no Railguard selection, so no verification profile is configured.",
    evidence: Object.freeze([".railguard/project.yaml"]),
    impact: "No check can run.",
    action: "Run railguard init with a verification profile, for example pack:go-service-foundation.",
  });
}

function staleScriptDiagnostic(missing: boolean): Diagnostic {
  return Object.freeze({
    code: "verification.script.stale",
    severity: "blocked",
    phase: "verification",
    subjects: Object.freeze([]),
    location: Object.freeze({ path: relativePosixPath(verifyScriptPath) }),
    message: missing
      ? `${verifyScriptPath} is missing, so the complete checks cannot run.`
      : `${verifyScriptPath} does not match the selected profiles and inputs.`,
    evidence: Object.freeze([verifyScriptPath, ".railguard/project.yaml"]),
    impact: "A full run and CI would judge different rules than the repository selected.",
    action: "Run railguard sync --yes and commit the regenerated script.",
  });
}

function changeSetDiagnostic(error: unknown): Diagnostic {
  return Object.freeze({
    code: "verification.change-set.unavailable",
    severity: "blocked",
    phase: "verification",
    subjects: Object.freeze([]),
    location: null,
    message: "The change to judge could not be computed from Git.",
    evidence: Object.freeze([error instanceof Error ? error.message : String(error)]),
    impact: "No check ran.",
    action: "Pass an existing branch or commit with --base, or run without --changed.",
  });
}

/**
 * Settles the findings a commit asked a person to accept: each becomes `passed` when a configured
 * approver of its profile approved the pull request's head commit, and `failed` otherwise.
 */
function resolvePending(
  results: readonly CheckResult[],
  pullRequest: PullRequestState,
  approvers: ReadonlyMap<ComponentRef, readonly string[]>,
): { readonly results: readonly CheckResult[]; readonly report: PullRequestReport } {
  const head = pullRequest.head.slice(0, 12);
  const approvedBy = new Set<string>();
  const acceptors = new Set<string>();
  const notes = new Set<string>();
  let requests = 0;
  const settled = results.map((result): CheckResult => {
    const { outcome } = result;
    if (outcome.status !== "pending") return result;
    requests += 1;
    const logins = approvers.get(result.profile) ?? [];
    for (const login of logins) acceptors.add(login);
    const assessment = assessApproval(pullRequest, logins);
    const finding = outcome.summary.endsWith(pendingSuffix) ? outcome.summary.slice(0, -pendingSuffix.length) : outcome.summary;
    const requested = outcome.requested === undefined ? "" : ` (requested: ${outcome.requested})`;
    if (assessment.approvedBy !== null) {
      approvedBy.add(assessment.approvedBy);
      return Object.freeze({
        ...result,
        outcome: Object.freeze({
          status: "passed" as const,
          summary: `${finding}; accepted by the approval of ${assessment.approvedBy} on ${head}${requested}`,
          details: outcome.details,
        }),
      });
    }
    for (const note of assessment.notes) notes.add(note);
    const next = logins.length === 0
      ? `No approver is configured for ${result.profile}: set its \`approvers\` input in .railguard/project.yaml on the target branch, or have a person accept the finding with a trailer in a commit.`
      : `Waiting for an approving review of ${head} from ${logins.map((login) => `@${login}`).join(" or ")}.`;
    return Object.freeze({
      ...result,
      outcome: Object.freeze({
        status: "failed" as const,
        summary: `${finding}; awaiting approval${requested}`,
        details: Object.freeze([...outcome.details, next]),
      }),
    });
  });
  return {
    results: settled,
    report: Object.freeze({
      number: pullRequest.number,
      head: pullRequest.head,
      author: pullRequest.author,
      approvedBy: [...approvedBy].sort(compareUtf8)[0] ?? null,
      approvers: Object.freeze([...acceptors].sort(compareUtf8)),
      notes: Object.freeze([...notes].sort(compareUtf8)),
      requests,
    }),
  };
}

function pullRequestUnavailableDiagnostic(number: number, reason: string): Diagnostic {
  return Object.freeze({
    code: "verification.pull-request.unavailable",
    severity: "blocked",
    phase: "verification",
    subjects: Object.freeze([]),
    location: null,
    message: `Pull request #${number} could not be read.`,
    evidence: Object.freeze([reason]),
    impact: "Without its reviews no finding can be accepted by approval, so no check ran.",
    action: "In GitHub Actions give the job `pull-requests: read` and pass GITHUB_TOKEN; elsewhere sign in with `gh auth login`.",
  });
}

function headMismatchDiagnostic(number: number, pullRequest: PullRequestState): Diagnostic {
  return Object.freeze({
    code: "verification.pull-request.head-mismatch",
    severity: "blocked",
    phase: "verification",
    subjects: Object.freeze([]),
    location: null,
    message: `The checkout is not the head of pull request #${number}.`,
    evidence: Object.freeze([`checked out ${pullRequest.checkedOut.slice(0, 12)}`, `head ${pullRequest.head.slice(0, 12)}`]),
    impact: "An approval applies to the head commit, so judging another commit could accept a change nobody saw.",
    action: "Check out the pull request's head with full history: actions/checkout with ref: ${{ github.event.pull_request.head.sha }} and fetch-depth: 0.",
  });
}

function noAcceptanceProfileDiagnostic(): Diagnostic {
  return Object.freeze({
    code: "verification.pull-request.no-profile",
    severity: "blocked",
    phase: "verification",
    subjects: Object.freeze([]),
    location: Object.freeze({ path: relativePosixPath(".railguard/project.yaml") }),
    message: "No selected verification profile judges a change that a person may accept.",
    evidence: Object.freeze(acceptableKinds),
    impact: "The pull request gate would pass without judging anything.",
    action: "Select verification-profile:change-guard or verification-profile:secret-guard, or remove the gate from CI.",
  });
}

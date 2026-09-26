import type { CatalogVerificationProfileComponent } from "../domain/catalog/model.js";
import { compareUtf8, relativePosixPath, type ComponentRef, type Diagnostic } from "../domain/shared/types.js";
import {
  changedFilesInUnit,
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
  readonly base?: string;
  readonly signal?: AbortSignal;
}

export interface CheckResult {
  readonly profile: ComponentRef;
  readonly check: string;
  readonly kind: string;
  readonly unit: string;
  readonly outcome: CheckOutcome;
}

export type VerificationVerdict = "passed" | "failed" | "unavailable" | "blocked";

export interface VerificationReport {
  readonly stage: CheckStage;
  readonly mode: "changed" | "full";
  readonly base: string | null;
  readonly baseRef: string | null;
  readonly verdict: VerificationVerdict;
  readonly results: readonly CheckResult[];
  readonly diagnostics: readonly Diagnostic[];
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
    const mode = request.changed ? "changed" : "full";
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
    let changes: ChangeSet;
    try {
      changes = await this.#dependencies.changeSets.read(scan.snapshot.realRoot, request.base);
    } catch (error) {
      return blocked(request.stage, mode, [changeSetDiagnostic(error)]);
    }

    const results: CheckResult[] = [];
    for (const profile of profiles) {
      const inputs = profileInputs(profile, selectedInputs.get(profile.ref));
      const checks = profile.checks.filter((check) => request.stage === "verify" || check.stage === "check");
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
                ...(request.signal === undefined ? {} : { signal: request.signal }),
              });
          const result = Object.freeze({ profile: profile.ref, check: check.id, kind: check.kind, unit, outcome });
          results.push(result);
          progress({ type: "completed", result });
        }
      }
    }
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

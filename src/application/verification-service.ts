import type { CatalogVerificationProfileComponent } from "../domain/catalog/model.js";
import { compareUtf8, type ComponentRef, type Diagnostic } from "../domain/shared/types.js";
import {
  changedFilesInUnit,
  deletedFilesInUnit,
  type ChangeSet,
  type ChangeSetReader,
  type CheckOutcome,
  type CheckProvider,
  type CheckStage,
} from "../domain/verification/checks.js";
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
}

/**
 * Runs the checks of every selected verification profile. `check` runs the fast stage; `verify`
 * runs both stages. With `changed`, each check judges only what the change touched.
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
    let changes: ChangeSet | null = null;
    if (request.changed) {
      try {
        changes = await this.#dependencies.changeSets.read(scan.snapshot.realRoot, request.base);
      } catch (error) {
        return blocked(request.stage, mode, [changeSetDiagnostic(error)]);
      }
    }
    const selectedInputs = new Map(
      scan.desired.state.selections.map((selection) => [selection.ref, selection.inputs] as const),
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

    const results: CheckResult[] = [];
    for (const profile of profiles) {
      const languages = new Set(profile.applies?.languages ?? []);
      const units = scan.assessment.projectUnits
        .filter((unit) => languages.size === 0 || unit.languages.some((language) => languages.has(language)))
        .map((unit) => unit.root as string)
        .sort(compareUtf8);
      const inputs = Object.freeze({
        ...Object.fromEntries(profile.inputs.map((input) => [input.id, input.default])),
        ...selectedInputs.get(profile.ref),
      });
      const checks = profile.checks.filter((check) => request.stage === "verify" || check.stage === "check");
      for (const unit of units) {
        for (const check of checks) {
          progress({ type: "started", profile: profile.ref, check: check.id, unit });
          const outcome = changes !== null && unitUnchanged(changes, unit)
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
      base: changes?.base ?? null,
      baseRef: changes?.baseRef ?? null,
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

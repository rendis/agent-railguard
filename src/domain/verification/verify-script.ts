import type { CatalogVerificationProfileComponent } from "../catalog/model.js";
import type { ProjectUnit } from "../repository/model.js";
import { compareUtf8, type ComponentRef } from "../shared/types.js";
import type { CheckProvider, CheckStage, FullCheck, ProcessResult } from "./checks.js";

/**
 * The repository's complete quality checks as one versioned script, generated from the selected
 * profiles and their inputs. CI runs it without Railguard; a full `railguard check|verify` runs the
 * same steps, so the rules live in one place.
 */
export const verifyScriptPath = ".railguard/verify.sh";

/** Exit status of the script and of each step. */
export const scriptExit = Object.freeze({ passed: 0, failed: 1, usage: 2, unavailable: 4 });

/** The repository's generated verify script, which a full run executes step by step. */
export interface VerifyScript {
  read(root: string): Promise<string | null>;
  step(root: string, id: string, signal?: AbortSignal): Promise<ProcessResult>;
}

export interface FullStep {
  /** Stable identifier, `profile/check@unit`. */
  readonly id: string;
  readonly profile: ComponentRef;
  readonly check: string;
  readonly kind: string;
  readonly stage: CheckStage;
  readonly unit: string;
  readonly full: FullCheck;
}

/** Units a profile judges: those of its languages, or the repository once when it has none. */
export function profileUnits(
  profile: CatalogVerificationProfileComponent,
  projectUnits: readonly ProjectUnit[],
): readonly string[] {
  const languages = new Set(profile.applies?.languages ?? []);
  if (languages.size === 0) return ["."];
  return projectUnits
    .filter((unit) => unit.languages.some((language) => languages.has(language)))
    .map((unit) => unit.root as string)
    .sort(compareUtf8);
}

/** Catalog defaults overlaid with the inputs the repository selected. */
export function profileInputs(
  profile: CatalogVerificationProfileComponent,
  selected: Readonly<Record<string, readonly string[]>> | undefined,
): Readonly<Record<string, readonly string[]>> {
  return Object.freeze({
    ...Object.fromEntries(profile.inputs.map((input) => [input.id, input.default])),
    ...selected,
  });
}

/** Every check of every profile on every unit it judges, in a stable order. */
export function planFullSteps(
  profiles: readonly CatalogVerificationProfileComponent[],
  projectUnits: readonly ProjectUnit[],
  selectedInputs: ReadonlyMap<ComponentRef, Readonly<Record<string, readonly string[]>>>,
  providers: readonly CheckProvider[],
): readonly FullStep[] {
  const byKind = new Map(providers.flatMap((provider) => provider.kinds.map((kind) => [kind, provider] as const)));
  const steps: FullStep[] = [];
  for (const profile of [...profiles].sort((left, right) => compareUtf8(left.ref, right.ref))) {
    const inputs = profileInputs(profile, selectedInputs.get(profile.ref));
    const name = profile.ref.slice(profile.ref.indexOf(":") + 1);
    for (const unit of profileUnits(profile, projectUnits)) {
      for (const check of profile.checks) {
        const provider = byKind.get(check.kind);
        const full: FullCheck = provider === undefined
          ? { kind: "script", body: `unavailable ${shellQuote(`This railguard version has no provider for ${check.kind}`)}` }
          : provider.full(check.kind, { params: check.params, inputs });
        steps.push(Object.freeze({
          id: `${name}/${check.id}@${unit}`,
          profile: profile.ref,
          check: check.id,
          kind: check.kind,
          stage: check.stage,
          unit,
          full,
        }));
      }
    }
  }
  return Object.freeze(steps);
}

/** The script for these steps, or null when no step judges a whole unit. */
export function renderVerifyScript(steps: readonly FullStep[]): string | null {
  const scripted = steps.filter((step): step is FullStep & { full: { kind: "script"; body: string } } =>
    step.full.kind === "script");
  if (scripted.length === 0) return null;
  const run = (stage: CheckStage) => scripted
    .filter((step) => stage === "verify" || step.stage === "check")
    .map((step) => `    run ${shellQuote(step.id)}`);
  return [
    "#!/bin/sh",
    "# Managed by Railguard from .railguard/project.yaml; `railguard sync --yes` regenerates it.",
    "# The complete quality checks of this repository. CI runs this script directly, without",
    "# Railguard; `railguard check|verify` without --changed runs the same steps.",
    "#",
    "#   .railguard/verify.sh [check|verify]   every check of the stage (default: verify)",
    "#   .railguard/verify.sh --step ID        one check",
    "#",
    "# COVERAGE_PROFILE=PATH keeps the Go coverage profile. Exit status: 0 passed, 1 a check",
    "# failed, 2 invalid usage, 4 a check could not run.",
    "set -u",
    'case "${COVERAGE_PROFILE:-}" in',
    "  '' | /*) ;;",
    '  *) COVERAGE_PROFILE="$PWD/$COVERAGE_PROFILE" ;;',
    "esac",
    'cd "$(dirname "$0")/.." || exit 4',
    "",
    `unavailable() { echo "$*" >&2; exit ${scriptExit.unavailable}; }`,
    "",
    "step() {",
    '  case "$1" in',
    ...scripted.flatMap((step) => [
      `    ${shellQuote(step.id)}) (`,
      `      cd ${shellQuote(step.unit)} || exit ${scriptExit.unavailable}`,
      ...step.full.body.split("\n").map((line) => (line.length === 0 ? "" : `      ${line}`)),
      "    ) ;;",
    ]),
    `    *) echo "Unknown step: $1" >&2; return ${scriptExit.usage} ;;`,
    "  esac",
    "}",
    "",
    "failed=0",
    "unavailable=0",
    "run() {",
    '  echo "== $1"',
    '  step "$1"',
    "  case $? in",
    `    ${scriptExit.passed}) echo "-- $1 passed" ;;`,
    `    ${scriptExit.unavailable}) unavailable=1; echo "-- $1 could not run" >&2 ;;`,
    '    *) failed=1; echo "-- $1 failed" >&2 ;;',
    "  esac",
    "}",
    "",
    'if [ "${1:-}" = --step ]; then',
    `  [ $# -eq 2 ] || { echo "usage: .railguard/verify.sh --step ID" >&2; exit ${scriptExit.usage}; }`,
    '  step "$2"',
    "  exit $?",
    "fi",
    'case "${1:-verify}" in',
    "  check)",
    ...run("check"),
    "    ;;",
    "  verify)",
    ...run("verify"),
    "    ;;",
    `  *) echo "usage: .railguard/verify.sh [check|verify] | --step ID" >&2; exit ${scriptExit.usage} ;;`,
    "esac",
    `[ "$failed" -eq 0 ] || exit ${scriptExit.failed}`,
    `[ "$unavailable" -eq 0 ] || exit ${scriptExit.unavailable}`,
    'echo "All checks passed."',
    "",
  ].join("\n");
}

/** A POSIX shell word that expands to exactly `value`. */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./@:=,+-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

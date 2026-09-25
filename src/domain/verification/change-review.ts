import { compareUtf8, sha256 } from "../shared/types.js";

/** A work-item handoff the change must satisfy; `directory` is repository-relative. */
export interface ActiveHandoff {
  readonly id: string;
  readonly family: string;
  readonly revision: string;
  readonly directory: string;
}

export type CriterionStatus = "met" | "not_met" | "not_applicable";

export interface ReviewCriterion {
  /** Family or id of the handoff the criterion comes from. */
  readonly handoff: string;
  readonly criterion: string;
  readonly status: CriterionStatus;
  /** `path` or `path:line` references that show the criterion in the change. */
  readonly evidence: readonly string[];
  readonly note?: string;
}

export interface ReviewRecord {
  readonly schema: "railguard/review/v1";
  readonly change_digest: string;
  readonly base: string | null;
  readonly handoffs: readonly { readonly id: string; readonly revision: string }[];
  readonly reviewer: string;
  readonly criteria: readonly ReviewCriterion[];
}

const statuses: readonly CriterionStatus[] = ["met", "not_met", "not_applicable"];

/** Identity of the change content: every changed file's digest and every deleted path. */
export function changeDigest(
  files: readonly { readonly path: string; readonly digest: string }[],
  deleted: readonly string[],
): string {
  const records = [
    ...files.map((file) => `F\0${file.path}\0${file.digest}\n`),
    ...deleted.map((path) => `D\0${path}\n`),
  ].sort(compareUtf8);
  return sha256(records.join(""));
}

/** Validates what a reviewer wrote: the criteria and, optionally, who reviewed. */
export function parseReviewInput(
  value: unknown,
): { readonly criteria: readonly ReviewCriterion[]; readonly reviewer: string } | { readonly errors: readonly string[] } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { errors: ["The review must be a JSON object with a criteria array."] };
  }
  const input = value as Record<string, unknown>;
  const errors: string[] = [];
  const criteria: ReviewCriterion[] = [];
  if (!Array.isArray(input.criteria) || input.criteria.length === 0) {
    errors.push("criteria must be a non-empty array.");
  } else {
    input.criteria.forEach((entry, index) => {
      const at = `criteria[${index}]`;
      if (typeof entry !== "object" || entry === null) {
        errors.push(`${at} must be an object.`);
        return;
      }
      const item = entry as Record<string, unknown>;
      const handoff = nonEmptyString(item.handoff);
      const criterion = nonEmptyString(item.criterion);
      const status = statuses.find((candidate) => candidate === item.status);
      const evidence = Array.isArray(item.evidence) ? item.evidence.filter((ref): ref is string => typeof ref === "string" && ref.length > 0) : [];
      const note = nonEmptyString(item.note);
      if (handoff === null) errors.push(`${at}.handoff must name the handoff family or id.`);
      if (criterion === null) errors.push(`${at}.criterion must state the criterion.`);
      if (status === undefined) errors.push(`${at}.status must be met, not_met or not_applicable.`);
      if (status === "met" && evidence.length === 0) errors.push(`${at} is met but cites no evidence.`);
      if (status === "not_applicable" && note === null) errors.push(`${at} is not_applicable but gives no note explaining why.`);
      if (handoff !== null && criterion !== null && status !== undefined) {
        criteria.push(Object.freeze({ handoff, criterion, status, evidence: Object.freeze(evidence), ...(note === null ? {} : { note }) }));
      }
    });
  }
  if (errors.length > 0) return { errors };
  return { criteria: Object.freeze(criteria), reviewer: nonEmptyString(input.reviewer) ?? "unspecified" };
}

export interface ReviewEvaluation {
  /** The record is missing or describes another change or handoff revision. */
  readonly stale: readonly string[];
  /** The record does not hold up: uncovered handoffs or evidence that does not exist. */
  readonly invalid: readonly string[];
  /** Criteria the reviewer found unmet. */
  readonly unmet: readonly string[];
}

export function evaluateReview(
  record: ReviewRecord | null,
  active: readonly ActiveHandoff[],
  digest: string,
  evidenceExists: (reference: string) => boolean,
): ReviewEvaluation {
  if (record === null) return { stale: ["No review is recorded for this change."], invalid: [], unmet: [] };
  const stale: string[] = [];
  if (record.change_digest !== digest) stale.push("The change was modified after the recorded review.");
  const recorded = new Set(record.handoffs.map((handoff) => `${handoff.id}@${handoff.revision}`));
  for (const handoff of active) {
    if (!recorded.has(`${handoff.id}@${handoff.revision}`)) {
      stale.push(`Handoff ${handoff.family} ${handoff.revision} was not part of the recorded review.`);
    }
  }
  const invalid: string[] = [];
  for (const handoff of active) {
    if (!record.criteria.some((criterion) => criterion.handoff === handoff.family || criterion.handoff === handoff.id)) {
      invalid.push(`No criterion is reviewed for handoff ${handoff.family}.`);
    }
  }
  for (const criterion of record.criteria) {
    for (const reference of criterion.evidence) {
      if (!evidenceExists(reference)) invalid.push(`Evidence ${reference} for "${criterion.criterion}" does not exist.`);
    }
  }
  const unmet = record.criteria
    .filter((criterion) => criterion.status === "not_met")
    .map((criterion) => `${criterion.handoff}: ${criterion.criterion}${criterion.note === undefined ? "" : ` — ${criterion.note}`}`);
  return { stale, invalid, unmet };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

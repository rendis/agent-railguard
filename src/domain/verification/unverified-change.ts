/** A change an agent left failing after its stop hook ran out of retries. */
export interface UnverifiedChange {
  readonly schema: "railguard/unverified/v1";
  readonly stage: "check" | "verify";
  readonly attempts: number;
  readonly recordedAt: string;
  /** `profile/check: summary` of every failed check. */
  readonly failures: readonly string[];
}

/** Remembers an unverified change until a later `--changed` run of the repository passes. */
export interface UnverifiedChanges {
  read(root: string): Promise<UnverifiedChange | null>;
  record(root: string, change: UnverifiedChange): Promise<void>;
  clear(root: string): Promise<void>;
}

/** What the next agent session is told before it starts working. */
export function unverifiedNotice(change: UnverifiedChange): string {
  return [
    `Railguard: a previous agent session ended with this change failing \`railguard ${change.stage} --changed\` after ${change.attempts} attempts, so it is NOT verified:`,
    ...change.failures.map((failure) => `- ${failure}`),
    `Before other work, run \`.railguard/bin/railguard ${change.stage} --changed\` and fix every failure without weakening tests or checks, or tell the user why it cannot pass.`,
  ].join("\n");
}

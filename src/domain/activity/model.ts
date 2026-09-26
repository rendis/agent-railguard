/** A coding agent harness whose hooks Railguard manages. */
export type AgentHarness = "claude-code" | "codex" | "cursor";

/** Why the pre-action guard refused an agent's command or file edit. */
export type GuardRule = "skip-hooks" | "allow-trailer" | "hooks-path" | "guardrail-path" | "protected-path";

/**
 * What an agent hook did, recorded without code, paths or values: checks are named
 * `profile/check`, such as `secret-guard/secrets`.
 */
export type AgentActivity =
  | { readonly type: "stop-blocked"; readonly harness: AgentHarness; readonly checks: readonly string[] }
  | { readonly type: "stop-unverified"; readonly harness: AgentHarness; readonly checks: readonly string[] }
  | { readonly type: "action-refused"; readonly harness: AgentHarness; readonly rule: GuardRule }
  | { readonly type: "edit-flagged"; readonly harness: AgentHarness; readonly checks: readonly string[] };

export type RecordedActivity = AgentActivity & { readonly at: string };

/** Agent hook activity kept on this clone, outside versioned files. */
export interface ActivityLog {
  append(root: string, activity: AgentActivity): Promise<void>;
  read(root: string): Promise<readonly RecordedActivity[]>;
}

/** A guard finding a person accepted with a `Railguard-Allow` trailer. */
export interface Acceptance {
  readonly commit: string;
  readonly date: string;
  readonly author: string;
  readonly kind: string;
  readonly reason: string;
}

export interface AcceptanceHistory {
  /** Acceptances reachable from HEAD, newest first, optionally from a `YYYY-MM-DD` date on. */
  read(root: string, since: string | null): Promise<readonly Acceptance[]>;
}

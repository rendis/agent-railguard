/**
 * Findings a person may accept. An agent asks with a `Railguard-Request` trailer; a person accepts
 * with a `Railguard-Allow` trailer or, in CI, by approving the pull request.
 */
export const acceptableKinds = ["change-integrity", "change-size", "secret-exposure"] as const;

/** What a pending outcome appends to the summary of the finding it carries. */
export const pendingSuffix = "; pending a person's acceptance";

export interface PullRequestReview {
  readonly login: string;
  /** GitHub account type, such as `User` or `Bot`. */
  readonly accountType: string;
  /** `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED` or `PENDING`. */
  readonly state: string;
  /** The commit the reviewer was looking at when submitting. */
  readonly commit: string | null;
}

export interface PullRequestState {
  readonly number: number;
  readonly author: string;
  /** The pull request's current head commit. */
  readonly head: string;
  /** Reviews in the order GitHub recorded them. */
  readonly reviews: readonly PullRequestReview[];
  /** The commit the local checkout is on, which must be the head for the approval to apply. */
  readonly checkedOut: string;
}

/** Reads a pull request from the host that serves it, never from the checkout. */
export interface PullRequestReader {
  read(root: string, number: number): Promise<PullRequestState>;
}

export interface ApprovalAssessment {
  /** The acceptor whose approval of the head commit counts, or null. */
  readonly approvedBy: string | null;
  /**
   * Acceptors whose latest approval was given on an earlier commit, such as the head before a
   * rebase. Such an approval still counts for a finding only when the head's findings are the same
   * as, or fewer than, the ones that commit had.
   */
  readonly earlier: readonly { readonly login: string; readonly commit: string }[];
  /** Why other reviews do not count, for the person who has to act. */
  readonly notes: readonly string[];
}

/**
 * Whether the pull request carries an approval that accepts findings. Only the latest review of
 * each reviewer speaks for them, except that a plain comment changes nothing. An approval counts
 * only when a configured acceptor gave it and is neither the pull request's author nor a bot. One
 * given on the current head commit accepts the change; one given on an earlier commit is returned
 * in `earlier`, for the caller to compare the findings of that commit with the head's.
 */
export function assessApproval(pullRequest: PullRequestState, approvers: readonly string[]): ApprovalAssessment {
  const acceptors = new Set(approvers.map(normalizeLogin));
  const author = normalizeLogin(pullRequest.author);
  const latest = new Map<string, PullRequestReview>();
  for (const review of pullRequest.reviews) {
    if (review.state === "COMMENTED" || review.state === "PENDING") continue;
    latest.set(normalizeLogin(review.login), review);
  }
  const notes: string[] = [];
  const earlier: { readonly login: string; readonly commit: string }[] = [];
  let approvedBy: string | null = null;
  for (const [login, review] of [...latest].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
    if (review.state !== "APPROVED") continue;
    if (isBot(review)) {
      notes.push(`The approval of ${review.login} does not count: bots cannot accept a finding.`);
    } else if (login === author) {
      notes.push(`The approval of ${review.login} does not count: the author of the pull request cannot accept its own change.`);
    } else if (!acceptors.has(login)) {
      notes.push(`The approval of ${review.login} does not count: they are not one of the configured approvers.`);
    } else if (review.commit === null) {
      notes.push(`The approval of ${review.login} names no commit: approve again to accept this change.`);
    } else if (review.commit !== pullRequest.head) {
      earlier.push(Object.freeze({ login: review.login, commit: review.commit }));
    } else if (approvedBy === null) {
      approvedBy = review.login;
    }
  }
  return Object.freeze({ approvedBy, earlier: Object.freeze(earlier), notes: Object.freeze(notes) });
}

function normalizeLogin(login: string): string {
  return login.toLowerCase();
}

function isBot(review: PullRequestReview): boolean {
  return review.accountType.toLowerCase() === "bot" || review.login.toLowerCase().endsWith("[bot]");
}

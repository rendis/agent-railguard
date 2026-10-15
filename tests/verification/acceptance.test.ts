import { describe, expect, it } from "vitest";
import {
  assessApproval,
  type PullRequestReview,
  type PullRequestState,
} from "../../src/domain/verification/acceptance.js";
import { parseAllowances, parseRequests } from "../../src/domain/verification/change-guard.js";

const head = "a".repeat(40);
const older = "b".repeat(40);

function review(login: string, state: string, commit: string | null = head, accountType = "User"): PullRequestReview {
  return { login, accountType, state, commit };
}

function pullRequest(reviews: readonly PullRequestReview[], author = "baby-team-agent[bot]"): PullRequestState {
  return { number: 7, author, head, reviews, checkedOut: head };
}

describe("approval of a pull request", () => {
  it("counts an approval by a configured approver on the head commit", () => {
    expect(assessApproval(pullRequest([review("rendis", "APPROVED")]), ["rendis"])).toEqual({ approvedBy: "rendis", notes: [] });
  });

  it("matches logins regardless of case", () => {
    expect(assessApproval(pullRequest([review("Rendis", "APPROVED")]), ["rendis"]).approvedBy).toBe("Rendis");
  });

  it("does not count an approval given on an earlier commit and says why", () => {
    const result = assessApproval(pullRequest([review("rendis", "APPROVED", older)]), ["rendis"]);

    expect(result.approvedBy).toBeNull();
    expect(result.notes).toEqual([expect.stringContaining(`${older.slice(0, 12)}, not on the current head ${head.slice(0, 12)}`)]);
  });

  it("does not count an approval without a commit", () => {
    expect(assessApproval(pullRequest([review("rendis", "APPROVED", null)]), ["rendis"]).approvedBy).toBeNull();
  });

  it("never counts the author of the pull request", () => {
    const result = assessApproval(pullRequest([review("Rendis", "APPROVED")], "rendis"), ["rendis"]);

    expect(result.approvedBy).toBeNull();
    expect(result.notes).toEqual([expect.stringContaining("author of the pull request")]);
  });

  it("never counts a bot, whatever the configuration says", () => {
    const byType = assessApproval(pullRequest([review("ci-helper", "APPROVED", head, "Bot")]), ["ci-helper"]);
    const bySuffix = assessApproval(pullRequest([review("other-agent[bot]", "APPROVED")]), ["other-agent[bot]"]);

    expect(byType.approvedBy).toBeNull();
    expect(bySuffix.approvedBy).toBeNull();
    expect(bySuffix.notes).toEqual([expect.stringContaining("bots cannot accept")]);
  });

  it("ignores approvers that are not configured", () => {
    const result = assessApproval(pullRequest([review("mallory", "APPROVED")]), ["rendis"]);

    expect(result.approvedBy).toBeNull();
    expect(result.notes).toEqual([expect.stringContaining("not one of the configured approvers")]);
    expect(assessApproval(pullRequest([review("mallory", "APPROVED")]), []).approvedBy).toBeNull();
  });

  it("lets the latest decisive review of a reviewer speak for them", () => {
    const withdrawn = pullRequest([review("rendis", "APPROVED"), review("rendis", "CHANGES_REQUESTED")]);
    const dismissed = pullRequest([review("rendis", "DISMISSED")]);
    const commented = pullRequest([review("rendis", "APPROVED"), review("rendis", "COMMENTED")]);
    const reapproved = pullRequest([review("rendis", "CHANGES_REQUESTED"), review("rendis", "APPROVED")]);

    expect(assessApproval(withdrawn, ["rendis"]).approvedBy).toBeNull();
    expect(assessApproval(dismissed, ["rendis"]).approvedBy).toBeNull();
    expect(assessApproval(commented, ["rendis"]).approvedBy).toBe("rendis");
    expect(assessApproval(reapproved, ["rendis"]).approvedBy).toBe("rendis");
  });

  it("needs only one valid approval among several reviews", () => {
    const result = assessApproval(
      pullRequest([review("mallory", "APPROVED"), review("old", "APPROVED", older), review("rendis", "APPROVED")]),
      ["rendis", "old"],
    );

    expect(result.approvedBy).toBe("rendis");
    expect(result.notes).toHaveLength(2);
  });
});

describe("acceptance trailers", () => {
  it("reads requests like allowances, with a reason", () => {
    const message = "chore: ask\n\nRailguard-Request: change-integrity: tests moved to the e2e suite\nRailguard-Request: change-size:";

    expect(parseRequests(message)).toEqual(new Map([["change-integrity", "tests moved to the e2e suite"]]));
  });

  it("keeps requests and allowances apart", () => {
    const message = "Railguard-Request: change-size: reviewed\nRailguard-Allow: secret-exposure: example key";

    expect(parseRequests(message)).toEqual(new Map([["change-size", "reviewed"]]));
    expect(parseAllowances(message)).toEqual(new Map([["secret-exposure", "example key"]]));
  });
});

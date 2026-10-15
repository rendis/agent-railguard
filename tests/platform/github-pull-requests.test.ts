import { describe, expect, it } from "vitest";
import { GitHubPullRequests } from "../../src/adapters/platform/github/github-pull-requests.js";
import type { ProcessResult, ProcessRunner } from "../../src/domain/verification/checks.js";

const head = "a".repeat(40);

function result(stdout: string, exitCode = 0, stderr = ""): ProcessResult {
  return { exitCode, stdout, stderr, timedOut: false };
}

function runner(handlers: Readonly<Record<string, (args: readonly string[]) => ProcessResult>>): ProcessRunner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async run(command, args) {
      calls.push(`${command} ${args.join(" ")}`);
      const handler = handlers[command];
      if (handler === undefined) throw new Error(`unexpected command ${command}`);
      return handler(args);
    },
  };
}

const pull = { head: { sha: head }, user: { login: "baby-team-agent[bot]", type: "Bot" } };
const review = (login: string, state: string, commit: string, type = "User") => ({
  user: { login, type },
  state,
  commit_id: commit,
});

function api(pages: readonly unknown[][]) {
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  return {
    urls,
    headers,
    fetcher: async (url: string, init: { headers: Record<string, string> }) => {
      urls.push(url);
      headers.push(init.headers);
      const body = url.includes("/reviews") ? (pages[Number(new URL(url).searchParams.get("page")) - 1] ?? []) : pull;
      return { ok: true, status: 200, json: async () => body };
    },
  };
}

const git = (remote = "https://github.com/rendis/example.git\n") => (args: readonly string[]) =>
  args[0] === "rev-parse" ? result(`${head}\n`) : args[0] === "remote" ? result(remote) : result("", 1);

describe("GitHubPullRequests", () => {
  it("reads the pull request and every page of reviews with the job token", async () => {
    const first = Array.from({ length: 100 }, (_, index) => review(`user${index}`, "COMMENTED", head));
    const second = [review("rendis", "approved", head)];
    const { fetcher, urls, headers } = api([first, second]);
    const reader = new GitHubPullRequests(runner({ git: git() }), { GITHUB_TOKEN: "token", GITHUB_REPOSITORY: "rendis/baby-team" }, fetcher);

    const state = await reader.read("/repo", 7);

    expect(urls).toEqual([
      "https://api.github.com/repos/rendis/baby-team/pulls/7",
      "https://api.github.com/repos/rendis/baby-team/pulls/7/reviews?per_page=100&page=1",
      "https://api.github.com/repos/rendis/baby-team/pulls/7/reviews?per_page=100&page=2",
    ]);
    expect(headers[0]).toMatchObject({ authorization: "Bearer token" });
    expect(state).toMatchObject({ number: 7, author: "baby-team-agent[bot]", head, checkedOut: head });
    expect(state.reviews).toHaveLength(101);
    expect(state.reviews.at(-1)).toEqual({ login: "rendis", accountType: "User", state: "APPROVED", commit: head });
  });

  it("uses the Enterprise API address and falls back to the origin remote for the repository", async () => {
    const { fetcher, urls } = api([[]]);
    const reader = new GitHubPullRequests(
      runner({ git: git("git@github.com:rendis/example.git\n") }),
      { GH_TOKEN: "token", GITHUB_API_URL: "https://ghe.example/api/v3/" },
      fetcher,
    );

    await reader.read("/repo", 3);

    expect(urls[0]).toBe("https://ghe.example/api/v3/repos/rendis/example/pulls/3");
  });

  it("reads through the gh login when no token is set", async () => {
    const process = runner({
      git: git(),
      gh: (args) => result(JSON.stringify(args[1]?.includes("/reviews") ? [review("rendis", "APPROVED", head)] : pull)),
    });

    const state = await new GitHubPullRequests(process, {}, async () => { throw new Error("no network"); }).read("/repo", 9);

    expect(process.calls).toContain("gh api repos/rendis/example/pulls/9");
    expect(state.reviews).toEqual([{ login: "rendis", accountType: "User", state: "APPROVED", commit: head }]);
  });

  it("says what is missing instead of guessing", async () => {
    const denied = async () => ({ ok: false, status: 403, json: async () => ({}) });
    await expect(new GitHubPullRequests(runner({ git: git() }), { GITHUB_TOKEN: "t" }, denied).read("/repo", 1))
      .rejects.toThrow("GitHub answered 403");
    await expect(new GitHubPullRequests(runner({ git: git("https://example.org/x.git") }), { GITHUB_TOKEN: "t" }, denied).read("/repo", 1))
      .rejects.toThrow("The GitHub repository is unknown");
    await expect(new GitHubPullRequests(runner({ git: git(), gh: () => result("", 1, "not logged in") }), {}, denied).read("/repo", 1))
      .rejects.toThrow("not logged in");
    const malformed = async () => ({ ok: true, status: 200, json: async () => ({}) });
    await expect(new GitHubPullRequests(runner({ git: git() }), { GITHUB_TOKEN: "t" }, malformed).read("/repo", 1))
      .rejects.toThrow("unexpected pull request");
  });
});

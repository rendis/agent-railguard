import type { PullRequestReader, PullRequestReview, PullRequestState } from "../../../domain/verification/acceptance.js";
import type { ProcessRunner } from "../../../domain/verification/checks.js";

const timeoutMs = 30_000;
const pageSize = 100;
const maximumPages = 30;

type Environment = Readonly<Record<string, string | undefined>>;
type Fetcher = (url: string, init: { readonly headers: Record<string, string>; readonly signal: AbortSignal }) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}>;

/**
 * A pull request and its reviews as GitHub records them. In GitHub Actions the job's
 * `GITHUB_TOKEN` (which needs `pull-requests: read`) reads them; elsewhere the `gh` login does.
 * Nothing is written to GitHub, and nothing from the checkout decides who approved.
 */
export class GitHubPullRequests implements PullRequestReader {
  public constructor(
    private readonly runner: ProcessRunner,
    private readonly environment: Environment = globalThis.process.env,
    private readonly fetcher: Fetcher = fetch as Fetcher,
  ) {}

  public async read(root: string, number: number): Promise<PullRequestState> {
    const repository = await this.#repository(root);
    const base = `repos/${repository}/pulls/${number}`;
    const pull = asRecord(await this.#get(root, base));
    const head = asRecord(pull.head);
    const author = asRecord(pull.user);
    if (typeof head.sha !== "string" || typeof author.login !== "string") {
      throw new Error(`GitHub returned an unexpected pull request #${number}`);
    }
    const reviews: PullRequestReview[] = [];
    for (let page = 1; page <= maximumPages; page += 1) {
      const entries = await this.#get(root, `${base}/reviews?per_page=${pageSize}&page=${page}`);
      if (!Array.isArray(entries)) throw new Error(`GitHub returned unexpected reviews for pull request #${number}`);
      for (const entry of entries) reviews.push(toReview(asRecord(entry)));
      if (entries.length < pageSize) break;
    }
    const checkedOut = await this.runner.run("git", ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { cwd: root, timeoutMs });
    if (checkedOut.exitCode !== 0) throw new Error("The checkout has no commit");
    return Object.freeze({
      number,
      author: author.login,
      head: head.sha,
      reviews: Object.freeze(reviews),
      checkedOut: checkedOut.stdout.trim(),
    });
  }

  async #repository(root: string): Promise<string> {
    const fromEnvironment = this.environment.GITHUB_REPOSITORY;
    if (fromEnvironment !== undefined && /^[\w.-]+\/[\w.-]+$/u.test(fromEnvironment)) return fromEnvironment;
    const remote = await this.runner.run("git", ["remote", "get-url", "origin"], { cwd: root, timeoutMs });
    const match = remote.exitCode === 0 ? /github[^/:]*[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?\s*$/u.exec(remote.stdout) : null;
    if (match?.[1] === undefined) {
      throw new Error("The GitHub repository is unknown: set GITHUB_REPOSITORY or give the checkout a GitHub origin remote");
    }
    return match[1];
  }

  async #get(root: string, path: string): Promise<unknown> {
    const token = this.environment.GITHUB_TOKEN ?? this.environment.GH_TOKEN;
    if (token !== undefined && token.length > 0) {
      const api = (this.environment.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/u, "");
      const response = await this.fetcher(`${api}/${path}`, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${path}`);
      return await response.json();
    }
    const gh = await this.runner.run("gh", ["api", path], { cwd: root, timeoutMs });
    if (gh.exitCode !== 0) {
      throw new Error(`gh api ${path} failed: ${gh.stderr.trim() || "is gh installed and signed in?"}`);
    }
    return JSON.parse(gh.stdout) as unknown;
  }
}

function toReview(entry: Readonly<Record<string, unknown>>): PullRequestReview {
  const user = asRecord(entry.user);
  return Object.freeze({
    login: typeof user.login === "string" ? user.login : "ghost",
    accountType: typeof user.type === "string" ? user.type : "User",
    state: typeof entry.state === "string" ? entry.state.toUpperCase() : "COMMENTED",
    commit: typeof entry.commit_id === "string" ? entry.commit_id : null,
  });
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

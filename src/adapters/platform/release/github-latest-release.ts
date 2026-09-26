import { tmpdir } from "node:os";
import type { LatestRelease } from "../../../application/engine-update.js";
import type { ProcessRunner } from "../../../domain/verification/checks.js";

const timeoutMs = 15_000;

/**
 * The latest published engine version. An authenticated gh reads private repositories too; without
 * it the public API answers only for a public repository. Any failure means "unknown".
 */
export class GitHubLatestRelease implements LatestRelease {
  public constructor(
    private readonly process: ProcessRunner,
    private readonly repository: string,
  ) {}

  public async latest(): Promise<string | null> {
    const gh = await this.process.run(
      "gh",
      ["api", `repos/${this.repository}/releases/latest`, "--jq", ".tag_name"],
      { cwd: tmpdir(), timeoutMs },
    );
    if (gh.exitCode === 0) return versionFromTag(gh.stdout.trim());
    try {
      const response = await fetch(`https://api.github.com/repos/${this.repository}/releases/latest`, {
        headers: { accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return null;
      const body = (await response.json()) as { readonly tag_name?: unknown };
      return typeof body.tag_name === "string" ? versionFromTag(body.tag_name) : null;
    } catch {
      return null;
    }
  }
}

function versionFromTag(tag: string): string | null {
  return /^v(\d+\.\d+\.\d+)$/u.exec(tag)?.[1] ?? null;
}

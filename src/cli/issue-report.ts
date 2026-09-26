import bugTemplate from "../../.github/ISSUE_TEMPLATE/bug.md";
import improvementTemplate from "../../.github/ISSUE_TEMPLATE/improvement.md";
import guide from "../../docs/reporting-issues.md";
import { parseSafeYaml } from "../shared/safe-yaml.js";

export const issueKinds = ["bug", "improvement"] as const;
export type IssueKind = (typeof issueKinds)[number];

/** What the report may state about the reporter's setup; nothing that identifies a project. */
export interface IssueEnvironment {
  readonly engineVersion: string;
  /** Version pinned by the repository's launcher, when the command runs inside one. */
  readonly pinnedVersion: string | null;
  readonly platform: string;
}

interface IssueTemplate {
  readonly label: string;
  readonly body: string;
}

const templates: Readonly<Record<IssueKind, string>> = { bug: bugTemplate, improvement: improvementTemplate };

/** Splits a GitHub issue template into the label its front matter declares and its body. */
export function issueTemplate(text: string): IssueTemplate {
  const match = /^---\n([\s\S]*?)\n---\n+([\s\S]*)$/u.exec(text);
  if (match === null) throw new TypeError("Issue template has no front matter");
  const frontMatter = parseSafeYaml(match[1] ?? "");
  const label = frontMatter.kind === "ready" ? frontMatter.value.labels : undefined;
  if (typeof label !== "string") throw new TypeError("Issue template must declare one label");
  return { label, body: match[2] ?? "" };
}

/** The reporting guide, the template of this kind and the environment it can publish as is. */
export function issueReport(kind: IssueKind, environment: IssueEnvironment, repository: string): string {
  const { label, body } = issueTemplate(templates[kind]);
  const pinned = environment.pinnedVersion !== null && environment.pinnedVersion !== environment.engineVersion
    ? ` (this repository pins ${environment.pinnedVersion})`
    : "";
  return [
    guide.trimEnd(),
    "---",
    `## Template: ${kind} (label \`${label}\`)`,
    body.trimEnd(),
    "---",
    "## Detected environment, without project data",
    `- Railguard: ${environment.engineVersion}${pinned}\n- Platform: ${environment.platform}`,
    "## Publish, after the person's approval",
    "```bash\n" +
      `gh issue create --repo ${repository} --label ${label} --title "<title>" --body-file <draft outside the repository>.md\n` +
      "```",
  ].join("\n\n") + "\n";
}

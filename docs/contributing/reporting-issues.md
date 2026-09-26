# Reporting a bug or proposing an improvement

Issues on `rendis/agent-railguard` are visible to anyone with access to the
repository, and GitHub keeps the history of every edit: once published, it cannot be
fully withdrawn. That is why an issue describes what Railguard did, never the project
where it happened.

## 1. Get the template

```bash
railguard issue bug          # Railguard fails, hangs, or gives an incorrect verdict
railguard issue improvement  # a new capability or a behavior change
```

The command prints this guide, the template and the detected environment (Railguard's
version and platform), which can be copied as is. It does not read or send anything
from the repository. The same templates appear when creating an issue on GitHub.

Before writing, check whether it already exists:

```bash
gh issue list --repo rendis/agent-railguard --state all --search "<keywords>"
```

## 2. Protect privacy

Do not include:

- names of companies, clients, teams, products, projects, repositories, modules or
  services;
- names of people, users, emails or accounts;
- absolute paths, internal hosts, URLs or IPs, branch names, hashes or commit messages
  from the project;
- tokens, keys, passwords or values of environment variables or private configuration;
- code, diffs, logs or full outputs from the project.

Replace whatever needs naming with placeholders: `<repo>`, `<module>`, `<package>`,
`<file>.go`, `~/<path>`, and use the same placeholder for the same thing throughout the
issue.

From Railguard's output, the diagnostic's `code`, severity, message and exit code are
enough. `location` and `evidence` carry paths and content from the project: rewrite
them with placeholders or leave them out. If the case depends on code, reproduce it in
a minimal repository created for the issue and copy that instead.

## 3. Fill in the template

- Title: the behavior in one sentence, without project names; for example
  «`check --changed` does not detect a `//nolint` in a new file».
- Bug: what happened, what was expected, the minimal steps to reproduce it, the
  relevant output and the environment.
- Improvement: the problem it solves before the solution, and what alternatives were
  considered.

## 4. Review and publish

Save the draft outside the repository and review it from the repository where the
problem happened:

```bash
railguard issue --check <draft>.md
```

It finds the repository's name, its organization, the branch and the person who knows
Git, plus emails, absolute paths, internal URLs, IPs, secrets and commits from the
repository. It exits with `8` if it finds anything. It does not recognize every company
or project name, so afterward reread the draft against the list in section 2.

Publish it with the template's label, from
<https://github.com/rendis/agent-railguard/issues/new/choose> or with `gh`:

```bash
gh issue create --repo rendis/agent-railguard --label <label> --title "<title>" --body-file <draft>.md
```

`gh` needs an account with access to the repository.

If an agent prepares the issue, it drafts it with the template, fixes what
`railguard issue --check` finds, shows it in full, and only publishes it once the
person approves it. It does not attach files, full outputs or session context.

## 5. Pull requests

A pull request starts from an issue: link it with `Closes #<number>`, use Conventional
Commits and run `pnpm run check`. The privacy rules also apply to its commits, tests and
fixtures.

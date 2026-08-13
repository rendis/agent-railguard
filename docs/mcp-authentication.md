# MCP authentication and the Atlassian guide

Railguard installs each MCP's **configuration** inside the repository. Login is a
later, explicit operation owned by the harness. Railguard never receives, copies or
stores OAuth tokens and never modifies global configuration such as
`~/.codex/config.toml`, `~/.cursor/mcp.json` or equivalents.

Configuring an MCP does not run its tools. Authenticating Atlassian does not query Jira
or Confluence either: it only authorizes the harness. Later actions still remain
subject to the user's permissions, the organization's policies and the harness's
confirmations.

## Checking and managing the session

From the project root:

```bash
railguard mcp status mcp:atlassian-rovo --harness opencode --format json
railguard mcp login mcp:atlassian-rovo --harness opencode --yes --format json
railguard mcp logout mcp:atlassian-rovo --harness opencode --yes --format json
```

Without `--yes`, `login` and `logout` do not start a native action: they return the
command or the steps the person must follow. Several targets can be passed to
`--harness`; each harness keeps its own session and may require independent consent.

Several MCP integrations can coexist in the same native file. Each adapter merges only
the managed entry, keeps foreign servers and orders entries deterministically. Removing
Atlassian does not remove Context7 and does not run a logout. The `mcps.mapping` block
is recomposed as a single inventory of every resolved MCP; there is no per-server
block.

Possible states:

- `authenticated`: the harness confirmed an active session;
- `authentication-required`: authentication is missing or the login was canceled;
- `authentication-unknown`: the harness does not offer a stable signal, so a guided
  action is provided;
- `unsupported`: the installed version does not expose a compatible flow.

## Atlassian Rovo MCP

The `mcp:atlassian-rovo` component uses the official remote server
`https://mcp.atlassian.com/v1/mcp/authv2`. For a person present, OAuth is the initial
flow: no API keys are requested and no secrets are written to Git.

### OpenCode

Railguard can run the full official cycle:

```bash
railguard mcp login mcp:atlassian-rovo --harness opencode --yes
```

1. OpenCode opens Atlassian in the browser.
2. Select the correct account and corporate site.
3. Review and approve the consent.
4. Keep the final page open until the terminal confirms the callback.
5. Railguard runs the native status check afterward; it does not consider an exit code
   of `0` sufficient.

If the terminal is canceled, the local callback closes. A later approval will show that
the browser cannot connect to `127.0.0.1`; close that tab and start a new login. The
cancellation is not reported as a successful authentication.

### Cursor without Cursor Agent

Cursor uses the project's `.cursor/mcp.json`. The flow certified on Cursor 3.15.6 is:

1. Open the repository in Cursor.
2. Open **Settings** (`⌘,` on macOS) and go to **MCPs**.
3. Locate `atlassian-rovo` and open its configuration.
4. Enable the source that shows the repository's name and `.cursor/mcp.json`.
5. Check that it appears in **Needs Attention** with status **Needs authentication**.
6. Press **Authenticate** and complete OAuth in the browser.
7. Return to Cursor and confirm that `atlassian-rovo` appears in **Connected**.

The source's switch enables or disables the MCP for that project; it is not the same as
deleting the OAuth session. When Cursor exposes **Logout** or **Disconnect** for that
connection, use it from that same screen. Railguard does not delete keychains, tokens
or Cursor's internal stores. If `cursor-agent` is installed, Railguard can delegate
login/list to its official commands.

### Codex

Railguard writes only the project's `.codex/config.toml`. The observed Codex version
loads that file only for trusted repositories and currently persists that trust in
`~/.codex/config.toml`. Railguard does not modify that global file. While Codex keeps
that coupling, the CLI returns a pending action instead of working around the limit
with global configuration or hidden overrides.

### Claude Code

Claude Code discovers the MCP from `.mcp.json` and offers `claude mcp
login/list/logout`. If, before OAuth, an approval for organization-managed
configuration appears, that approval is independent of the MCP. Review it with the
administrator; Railguard does not accept it automatically.

### VS Code

VS Code uses `.vscode/mcp.json` and completes OAuth from its native UI. Railguard
presents this flow as guided, and it can only be certified when a real VS Code
installation is available; a `code` command that resolves to Cursor does not count as
VS Code.

## Uninstalling is not logging out

`railguard remove mcp:atlassian-rovo --yes` only removes the project-scoped artifacts
that Railguard manages. It does not revoke or delete the harness's credentials. Use
`railguard mcp logout` when the target has a native command; on guided targets, use the
harness's UI.

Official sources: [Atlassian Rovo MCP](https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/),
[Cursor MCP](https://docs.cursor.com/context/model-context-protocol),
[OpenCode MCP](https://dev.opencode.ai/docs/mcp-servers/),
[Claude Code MCP](https://code.claude.com/docs/en/mcp) and
[Codex MCP](https://developers.openai.com/codex/mcp/).

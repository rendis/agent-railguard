import type {
  CatalogAgentComponent,
  CatalogAgentHookComponent,
  CatalogMcpIntegrationComponent,
  CatalogSnapshot,
} from "../../../domain/catalog/model.js";
import type {
  ExecutableProbe,
  HarnessAdapter,
  HarnessInspection,
  HarnessProjection,
} from "../../../domain/harness/model.js";
import type { RepositorySnapshot } from "../../../domain/repository/model.js";
import type { ReadyResolution } from "../../../domain/resolution/model.js";
import { compareUtf8, harnessTargetId } from "../../../domain/shared/types.js";
import { agentHookHarnessCapabilities, inspectHarness } from "../shared/harness-inspection.js";
import { nativeComponents } from "../shared/native-components.js";
import {
  agentGuardScript,
  agentSessionStartScript,
  agentStopScript,
  componentId,
  nativeFileUnit,
  nativeProjectionIdentity,
  nativeSectionUnit,
  normalizedPrompt,
  stablePrettyJson,
} from "../shared/native-units.js";

export class CodexAdapter implements HarnessAdapter {
  public readonly id = harnessTargetId("codex");
  readonly #executableProbe: ExecutableProbe;

  public constructor(executableProbe: ExecutableProbe) {
    this.#executableProbe = executableProbe;
  }

  public inspect(snapshot: RepositorySnapshot): Promise<HarnessInspection> {
    return inspectHarness({
      target: this.id,
      capabilities: agentHookHarnessCapabilities,
      command: "codex",
      probe: this.#executableProbe,
      snapshot,
      surfaces: [
        { role: "instructions", path: "AGENTS.md", expected: "file" },
        { role: "skills", path: ".agents/skills", expected: "directory" },
        { role: "agents", path: ".codex/agents", expected: "directory" },
        { role: "mcp", path: ".codex/config.toml", expected: "file" },
        { role: "hooks", path: ".codex/hooks.json", expected: "file" },
      ],
    });
  }

  public project(resolution: ReadyResolution, catalog: CatalogSnapshot): HarnessProjection {
    const components = nativeComponents(resolution, catalog);
    const units = [
      ...components.agents.map((agent) =>
        nativeFileUnit({
          target: this.id,
          role: "agent",
          path: `.codex/agents/${componentId(agent.ref)}.toml`,
          text: renderAgent(agent),
          sources: [agent.ref],
        }),
      ),
      ...components.mcps.map((mcp) =>
        nativeSectionUnit({
          target: this.id,
          path: ".codex/config.toml",
          sectionId: `mcp.${componentId(mcp.ref)}`,
          body: renderMcpServer(mcp),
          source: mcp.ref,
        }),
      ),
      ...(components.agentHooks.length === 0
        ? []
        : [
            nativeFileUnit({
              target: this.id,
              role: "hook",
              path: ".codex/hooks.json",
              text: stablePrettyJson({ hooks: codexHooks(components.agentHooks) }),
              sources: components.agentHooks.map((hook) => hook.ref),
            }),
          ]),
    ].sort((left, right) => compareUtf8(left.ownershipId, right.ownershipId));
    return Object.freeze({
      identity: nativeProjectionIdentity(this.id, agentHookHarnessCapabilities),
      units: Object.freeze(units),
    });
  }
}

/** Hook commands resolve the repository from the session's working directory, as Codex advises. */
function codexHooks(hooks: readonly CatalogAgentHookComponent[]): Readonly<Record<string, unknown>> {
  const command = (script: string) => `"$(git rev-parse --show-toplevel)/${script}" codex`;
  return {
    ...(hooks.some((hook) => hook.event === "pre-action")
      ? {
          PreToolUse: [
            {
              matcher: "^(Bash|apply_patch)$",
              hooks: [{ type: "command", command: command(agentGuardScript), timeout: 60 }],
            },
          ],
        }
      : {}),
    ...(hooks.some((hook) => hook.event === "stop")
      ? {
          SessionStart: [{ hooks: [{ type: "command", command: command(agentSessionStartScript), timeout: 60 }] }],
          Stop: [{ hooks: [{ type: "command", command: command(agentStopScript), timeout: 900 }] }],
        }
      : {}),
  };
}

function renderMcpServer(mcp: CatalogMcpIntegrationComponent): string {
  const header = `[mcp_servers.${componentId(mcp.ref)}]`;
  switch (mcp.connection.type) {
    case "stdio":
      return [
        header,
        `command = ${JSON.stringify(mcp.connection.command)}`,
        `args = ${JSON.stringify(mcp.connection.args)}`,
      ].join("\n");
    case "remote-http":
      return [header, `url = ${JSON.stringify(mcp.connection.url)}`].join("\n");
  }
}

function renderAgent(agent: CatalogAgentComponent): string {
  return [
    `name = ${JSON.stringify(componentId(agent.ref))}`,
    `description = ${JSON.stringify(agent.description)}`,
    'sandbox_mode = "read-only"',
    `developer_instructions = ${JSON.stringify(normalizedPrompt(agent.prompt))}`,
    "",
  ].join("\n");
}

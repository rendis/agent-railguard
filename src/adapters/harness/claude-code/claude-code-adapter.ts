import type {
  CatalogAgentComponent,
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
  agentStopScript,
  componentId,
  nativeFileUnit,
  nativeJsonMemberUnit,
  nativeProjectionIdentity,
  normalizedPrompt,
  stablePrettyJson,
  yamlString,
} from "../shared/native-units.js";

export class ClaudeCodeAdapter implements HarnessAdapter {
  public readonly id = harnessTargetId("claude-code");
  readonly #executableProbe: ExecutableProbe;

  public constructor(executableProbe: ExecutableProbe) {
    this.#executableProbe = executableProbe;
  }

  public inspect(snapshot: RepositorySnapshot): Promise<HarnessInspection> {
    return inspectHarness({
      target: this.id,
      capabilities: agentHookHarnessCapabilities,
      command: "claude",
      probe: this.#executableProbe,
      snapshot,
      surfaces: [
        { role: "instructions", path: "AGENTS.md", expected: "file" },
        { role: "instructions", path: "CLAUDE.md", expected: "file" },
        { role: "skills", path: ".claude/skills", expected: "directory" },
        { role: "agents", path: ".claude/agents", expected: "directory" },
        { role: "mcp", path: ".mcp.json", expected: "file" },
        { role: "hooks", path: ".claude/settings.json", expected: "file" },
      ],
    });
  }

  public project(resolution: ReadyResolution, catalog: CatalogSnapshot): HarnessProjection {
    const components = nativeComponents(resolution, catalog);
    const units = components.agents.map((agent) =>
      nativeFileUnit({
        target: this.id,
        role: "agent",
        path: `.claude/agents/${componentId(agent.ref)}.md`,
        text: renderAgent(agent),
        sources: [agent.ref],
      }),
    );
    if (components.mcps.length > 0) {
      units.push(
        nativeFileUnit({
          target: this.id,
          role: "mcp",
          path: ".mcp.json",
          text: stablePrettyJson({
            mcpServers: Object.fromEntries(
              components.mcps.map((mcp) => [
                componentId(mcp.ref),
                renderMcpServer(mcp),
              ]),
            ),
          }),
          sources: components.mcps.map((mcp) => mcp.ref),
        }),
      );
    }
    if (components.agentHooks.length > 0) {
      units.push(
        nativeJsonMemberUnit({
          target: this.id,
          role: "hook",
          path: ".claude/settings.json",
          pointer: ["hooks", "Stop"],
          value: [
            {
              hooks: [
                {
                  type: "command",
                  command: `"$CLAUDE_PROJECT_DIR"/${agentStopScript} claude-code`,
                  timeout: 900,
                },
              ],
            },
          ],
          sources: components.agentHooks.map((hook) => hook.ref),
        }),
      );
    }
    units.sort((left, right) => compareUtf8(left.ownershipId, right.ownershipId));
    return Object.freeze({ identity: nativeProjectionIdentity(this.id, agentHookHarnessCapabilities), units: Object.freeze(units) });
  }
}

function renderMcpServer(mcp: CatalogMcpIntegrationComponent): Readonly<Record<string, unknown>> {
  switch (mcp.connection.type) {
    case "stdio":
      return {
        type: "stdio",
        command: mcp.connection.command,
        args: [...mcp.connection.args],
      };
    case "remote-http":
      return { type: "http", url: mcp.connection.url };
  }
}

function renderAgent(agent: CatalogAgentComponent): string {
  const skills = agent.relations
    .filter((relation) => relation.kind === "requires" && relation.target.startsWith("skill:"))
    .map((relation) => componentId(relation.target));
  return [
    "---",
    `name: ${componentId(agent.ref)}`,
    `description: ${yamlString(agent.description)}`,
    "permissionMode: plan",
    ...(skills.length === 0 ? [] : ["skills:", ...skills.map((skill) => `  - ${skill}`)]),
    "---",
    "",
    normalizedPrompt(agent.prompt),
    "",
  ].join("\n");
}

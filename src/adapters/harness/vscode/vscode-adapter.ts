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
import { harnessCapabilities, inspectHarness } from "../shared/harness-inspection.js";
import { nativeComponents } from "../shared/native-components.js";
import {
  componentId,
  nativeFileUnit,
  nativeProjectionIdentity,
  normalizedPrompt,
  stablePrettyJson,
  yamlString,
} from "../shared/native-units.js";

export class VsCodeAdapter implements HarnessAdapter {
  public readonly id = harnessTargetId("vscode");
  readonly #executableProbe: ExecutableProbe;

  public constructor(executableProbe: ExecutableProbe) {
    this.#executableProbe = executableProbe;
  }

  public inspect(snapshot: RepositorySnapshot): Promise<HarnessInspection> {
    return inspectHarness({
      target: this.id,
      capabilities: harnessCapabilities,
      command: "code",
      probe: this.#executableProbe,
      snapshot,
      surfaces: [
        { role: "instructions", path: "AGENTS.md", expected: "file" },
        { role: "skills", path: ".agents/skills", expected: "directory" },
        { role: "agents", path: ".github/agents", expected: "directory" },
        { role: "mcp", path: ".vscode/mcp.json", expected: "file" },
      ],
    });
  }

  public project(resolution: ReadyResolution, catalog: CatalogSnapshot): HarnessProjection {
    const components = nativeComponents(resolution, catalog);
    const units = components.agents.map((agent) =>
      nativeFileUnit({
        target: this.id,
        role: "agent",
        path: `.github/agents/${componentId(agent.ref)}.agent.md`,
        text: renderAgent(agent),
        sources: [agent.ref],
      }),
    );
    if (components.mcps.length > 0) {
      units.push(
        nativeFileUnit({
          target: this.id,
          role: "mcp",
          path: ".vscode/mcp.json",
          text: stablePrettyJson({
            servers: Object.fromEntries(
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
    units.sort((left, right) => compareUtf8(left.ownershipId, right.ownershipId));
    return Object.freeze({ identity: nativeProjectionIdentity(this.id, harnessCapabilities), units: Object.freeze(units) });
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
  return [
    "---",
    `name: ${componentId(agent.ref)}`,
    `description: ${yamlString(agent.description)}`,
    "---",
    "",
    normalizedPrompt(agent.prompt),
    "",
  ].join("\n");
}

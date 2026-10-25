import type { ManagedArtifactOwnership } from "../ownership/model.js";
import { sha256 } from "../shared/types.js";

const legacySurfaces: Readonly<Record<string, { readonly path: string; readonly group: string }>> = {
  "claude-code": { path: ".mcp.json", group: "mcpServers" },
  cursor: { path: ".cursor/mcp.json", group: "mcpServers" },
  vscode: { path: ".vscode/mcp.json", group: "servers" },
  opencode: { path: "opencode.json", group: "mcp" },
};

/** Narrows the whole-file MCP ownership emitted through 0.1.22 to its recorded servers. */
export function legacyMcpPointers(
  previous: readonly ManagedArtifactOwnership[],
): readonly (readonly string[])[] | null {
  if (previous.length !== 1) return null;
  const artifact = previous[0]!;
  if (artifact.kind !== "file" || artifact.adapter !== artifact.target || artifact.sources.length === 0 ||
      artifact.sources.some((source) => !source.startsWith("mcp:"))) return null;
  const surface = legacySurfaces[artifact.target];
  if (surface === undefined || artifact.path !== surface.path ||
      artifact.ownership_id !== `${artifact.target}.mcp.file.${sha256(artifact.path).slice(7, 19)}`) return null;
  return artifact.sources.map((source) => [surface.group, source.slice("mcp:".length)]);
}

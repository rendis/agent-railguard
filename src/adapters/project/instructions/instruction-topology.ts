import { resolve } from "node:path";
import {
  removeManagedSection,
  type ManagedSectionPlacement,
} from "../../../domain/managed-section/managed-section.js";
import type { RepositoryEntry, RepositorySnapshot } from "../../../domain/repository/model.js";
import {
  compareDiagnostics,
  relativePosixPath,
  type Diagnostic,
  type HarnessTargetId,
  type RelativePosixPath,
} from "../../../domain/shared/types.js";

export type InstructionTopology =
  | {
      readonly kind: "ready";
      readonly instructionPath: RelativePosixPath;
      readonly claudeImport: "not-required" | "managed" | "existing" | "alias";
      readonly diagnostics: readonly Diagnostic[];
    }
  | {
      readonly kind: "blocked";
      readonly diagnostics: readonly [Diagnostic, ...Diagnostic[]];
    };

const agentsPath = relativePosixPath("AGENTS.md");
const claudePath = relativePosixPath("CLAUDE.md");
const managedImportSection = "claude.agents-import";

export async function resolveInstructionTopology(
  snapshot: RepositorySnapshot,
  targets: readonly HarnessTargetId[],
): Promise<InstructionTopology> {
  const agents = findEntry(snapshot, agentsPath);
  const claude = findEntry(snapshot, claudePath);
  const claudeSelected = targets.includes("claude-code" as HarnessTargetId);

  if (agents?.kind === "symlink") {
    const diagnostic = validateAlias(snapshot, agents, claudePath, claude);
    if (diagnostic !== null) return blocked(diagnostic);
    return ready(claudePath, claudeSelected ? "alias" : "not-required");
  }
  if (agents !== undefined && agents.kind !== "file") {
    return blocked(unsafeTopologyDiagnostic(agentsPath, agents.kind));
  }
  if (!claudeSelected) return ready(agentsPath, "not-required");

  if (claude?.kind === "symlink") {
    const diagnostic = validateAlias(snapshot, claude, agentsPath, agents);
    if (diagnostic !== null) return blocked(diagnostic);
    return ready(agentsPath, "alias");
  }
  if (claude === undefined) return ready(agentsPath, "managed");
  if (claude.kind !== "file") {
    return blocked(unsafeTopologyDiagnostic(claudePath, claude.kind));
  }

  try {
    const read = await snapshot.read(claudePath, 1024 * 1024);
    const source = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes.copy());
    return ready(agentsPath, hasExternalAgentsImport(source) ? "existing" : "managed");
  } catch (error) {
    return blocked(unreadableTopologyDiagnostic(claudePath, error));
  }
}

function validateAlias(
  snapshot: RepositorySnapshot,
  alias: Extract<RepositoryEntry, { readonly kind: "symlink" }>,
  expectedTarget: RelativePosixPath,
  targetEntry: RepositoryEntry | undefined,
): Diagnostic | null {
  const expectedResolved = resolve(snapshot.realRoot, expectedTarget);
  if (
    alias.resolvedPath === null ||
    alias.escapesRoot ||
    alias.resolvedPath !== expectedResolved ||
    targetEntry?.kind !== "file"
  ) {
    return unsafeTopologyDiagnostic(alias.path, "symlink", [
      `target:${alias.target}`,
      `resolved:${alias.resolvedPath ?? "missing"}`,
      `expected:${expectedTarget}`,
    ]);
  }
  return null;
}

function hasExternalAgentsImport(source: string): boolean {
  let candidate = source;
  for (const placement of ["whole-file", "append"] as const satisfies readonly ManagedSectionPlacement[]) {
    const removal = removeManagedSection(
      source,
      managedImportSection,
      "markdown",
      placement,
    );
    if (removal.kind === "ready" && removal.removed) {
      candidate = removal.text;
      break;
    }
  }
  return /^\s*@AGENTS\.md\s*$/mu.test(candidate);
}

function findEntry(
  snapshot: RepositorySnapshot,
  path: RelativePosixPath,
): RepositoryEntry | undefined {
  return snapshot.entries.find((entry) => entry.path === path);
}

function ready(
  instructionPath: RelativePosixPath,
  claudeImport: Extract<InstructionTopology, { readonly kind: "ready" }>["claudeImport"],
): InstructionTopology {
  return Object.freeze({
    kind: "ready",
    instructionPath,
    claudeImport,
    diagnostics: Object.freeze([]),
  });
}

function blocked(diagnostic: Diagnostic): InstructionTopology {
  return Object.freeze({
    kind: "blocked",
    diagnostics: Object.freeze([diagnostic].sort(compareDiagnostics)) as readonly [
      Diagnostic,
      ...Diagnostic[],
    ],
  });
}

function unsafeTopologyDiagnostic(
  path: RelativePosixPath,
  kind: string,
  extraEvidence: readonly string[] = [],
): Diagnostic {
  return Object.freeze({
    code: "project.instructions.topology-unsafe",
    severity: "blocked",
    phase: "harness",
    subjects: Object.freeze([]),
    location: Object.freeze({ path }),
    message: "A canonical instruction path has an unsafe filesystem topology.",
    evidence: Object.freeze([`kind:${kind}`, ...extraEvidence]),
    impact: "AI Harness cannot determine one project-local instruction container safely.",
    action: "Use regular AGENTS.md/CLAUDE.md files or one healthy symlink between them.",
  });
}

function unreadableTopologyDiagnostic(path: RelativePosixPath, error: unknown): Diagnostic {
  return Object.freeze({
    code: "project.instructions.topology-unreadable",
    severity: "blocked",
    phase: "harness",
    subjects: Object.freeze([]),
    location: Object.freeze({ path }),
    message: "The Claude instruction file could not be inspected safely.",
    evidence: Object.freeze([error instanceof Error ? error.message : String(error)]),
    impact: "AI Harness cannot determine whether Claude already imports AGENTS.md.",
    action: "Make CLAUDE.md a readable UTF-8 file no larger than 1 MiB.",
  });
}

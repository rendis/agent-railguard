import type {
  ExecutableProbe,
  HarnessInspection,
  HarnessSurface,
} from "../../../domain/harness/model.js";
import type { RepositoryEntry, RepositorySnapshot } from "../../../domain/repository/model.js";
import {
  capabilityId,
  compareDiagnostics,
  compareUtf8,
  relativePosixPath,
  type Diagnostic,
  type HarnessTargetId,
  type RelativePosixPath,
} from "../../../domain/shared/types.js";

export const harnessCapabilities = Object.freeze([
  capabilityId("project.agents"),
  capabilityId("project.instructions"),
  capabilityId("project.mcp"),
  capabilityId("project.skills"),
]);

export interface HarnessSurfaceSpec {
  readonly role: HarnessSurface["role"];
  readonly path: string;
  readonly expected: "file" | "directory";
}

export async function inspectHarness(input: {
  readonly target: HarnessTargetId;
  readonly command: string;
  readonly probe: ExecutableProbe;
  readonly snapshot: RepositorySnapshot;
  readonly surfaces: readonly HarnessSurfaceSpec[];
}): Promise<HarnessInspection> {
  const executable = await input.probe.probe(input.command, ["--version"]);
  const diagnostics: Diagnostic[] = [...executable.diagnostics];
  const surfaces = input.surfaces.map((spec) => {
    const path = relativePosixPath(spec.path);
    const entry = findEntry(input.snapshot, path);
    const surface = classifySurface(spec.role, path, spec.expected, entry);
    if (
      surface.kind === "unsafe" ||
      (surface.kind === "symlink" &&
        (spec.role !== "instructions" ||
          entry?.kind !== "symlink" ||
          entry.resolvedPath === null ||
          entry.escapesRoot))
    ) {
      diagnostics.push(unsafeSurfaceDiagnostic(input.target, surface, entry));
    }
    return Object.freeze(surface);
  });
  surfaces.sort((left, right) =>
    compareUtf8(`${left.role}:${left.path}`, `${right.role}:${right.path}`),
  );

  return Object.freeze({
    target: input.target,
    detected: executable.detected,
    executablePath: executable.path,
    version: executable.version,
    capabilities: harnessCapabilities,
    surfaces: Object.freeze(surfaces),
    diagnostics: Object.freeze(diagnostics.sort(compareDiagnostics)),
  });
}

function classifySurface(
  role: HarnessSurface["role"],
  path: RelativePosixPath,
  expected: "file" | "directory",
  entry: RepositoryEntry | undefined,
): HarnessSurface {
  if (entry === undefined) return { role, path, kind: "absent" };
  if (entry.kind === "symlink") return { role, path, kind: "symlink" };
  if (entry.kind === expected) return { role, path, kind: entry.kind };
  return { role, path, kind: "unsafe" };
}

function findEntry(
  snapshot: RepositorySnapshot,
  path: RelativePosixPath,
): RepositoryEntry | undefined {
  return snapshot.entries.find((entry) => entry.path === path);
}

function unsafeSurfaceDiagnostic(
  target: HarnessTargetId,
  surface: HarnessSurface,
  entry: RepositoryEntry | undefined,
): Diagnostic {
  return Object.freeze({
    code: `harness.${target}.topology-unsafe`,
    severity: "blocked",
    phase: "harness",
    subjects: Object.freeze([]),
    location: Object.freeze({ path: surface.path }),
    message: "A harness project surface has an unsafe filesystem topology.",
    evidence: Object.freeze([
      `role:${surface.role}`,
      `kind:${entry?.kind ?? "absent"}`,
      ...(entry?.kind === "symlink"
        ? [`target:${entry.target}`, `resolved:${entry.resolvedPath ?? "missing"}`]
        : []),
    ]),
    impact: "Native project configuration cannot be materialized safely.",
    action: "Restore the path as the expected project-local file or directory.",
  });
}

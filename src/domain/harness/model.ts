import type { CatalogSnapshot } from "../catalog/model.js";
import type { ManagedProjection } from "../projection/model.js";
import type { ReadyResolution } from "../resolution/model.js";
import type {
  CapabilityId,
  Diagnostic,
  HarnessTargetId,
  RelativePosixPath,
} from "../shared/types.js";
import type { RepositorySnapshot } from "../repository/model.js";

export interface ExecutableProbeResult {
  readonly detected: boolean;
  readonly path: string | null;
  readonly version: string | null;
  readonly diagnostics: readonly Diagnostic[];
}

export interface ExecutableProbe {
  probe(command: string, args: readonly string[]): Promise<ExecutableProbeResult>;
}

export interface HarnessInspection {
  readonly target: HarnessTargetId;
  readonly detected: boolean;
  readonly executablePath: string | null;
  readonly version: string | null;
  readonly capabilities: readonly CapabilityId[];
  readonly surfaces: readonly HarnessSurface[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface HarnessSurface {
  readonly role: "instructions" | "skills" | "agents" | "mcp";
  readonly path: RelativePosixPath;
  readonly kind: "absent" | "file" | "directory" | "symlink" | "unsafe";
}

export type HarnessProjection = ManagedProjection;

export interface HarnessAdapter {
  readonly id: HarnessTargetId;
  inspect(snapshot: RepositorySnapshot): Promise<HarnessInspection>;
  project(resolution: ReadyResolution, catalog: CatalogSnapshot): HarnessProjection;
}

export interface ProjectedPath {
  readonly path: RelativePosixPath;
}

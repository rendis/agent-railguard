import type { Diagnostic, RelativePosixPath } from "../shared/types.js";

export interface VerificationResult {
  readonly materialization: "verified" | "drift" | "missing" | "unknown";
  readonly hostDiscovery: "not-observable";
  readonly diagnostics: readonly Diagnostic[];
  readonly verifiedPaths: readonly RelativePosixPath[];
}

import type { Diagnostic } from "../shared/types.js";

export type RepositoryGateResult = Readonly<{
  kind: "ready" | "blocked";
  rootRealPath: string;
  gitCommonDirectory: string | null;
  gitDirectory: string | null;
  diagnostics: readonly Diagnostic[];
}>;

export interface RepositoryGate {
  check(root: string): Promise<RepositoryGateResult>;
}

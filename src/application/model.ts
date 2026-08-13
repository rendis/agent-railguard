import type { CatalogLoadResult, CatalogSnapshot } from "../domain/catalog/model.js";
import type { HarnessInspection } from "../domain/harness/model.js";
import type { ObservedProjectState } from "../domain/observation/model.js";
import type { RecommendationSet } from "../domain/recommendation/model.js";
import type { ReconciliationResult } from "../domain/reconciliation/reconciler.js";
import type {
  RepositoryAssessmentResult,
  RepositorySnapshot,
} from "../domain/repository/model.js";
import type { ResolutionResult } from "../domain/resolution/model.js";
import type {
  ComponentRef,
  Diagnostic,
  HarnessTargetId,
} from "../domain/shared/types.js";
import type {
  DurableApplyResult,
  DurableApplyOptions,
  DurableProjectPlan,
  ReadyDesiredState,
  ReadyPortableLock,
  RecoveryResult,
} from "../domain/transaction/model.js";
import type { VerificationResult } from "../domain/verification/model.js";
import type {
  McpSessionAggregateResult,
  McpSessionOperation,
} from "../domain/mcp/session.js";

export interface ApplicationEvent {
  readonly operation:
    | "repository-gate"
    | "catalog"
    | "doctor"
    | "recovery"
    | "scan"
    | "recommend"
    | "resolve"
    | "plan"
    | "apply"
    | "mcp-session"
    | "verify";
  readonly phase: string;
  readonly status: "started" | "completed" | "failed";
  readonly message: string;
  readonly current?: number;
  readonly total?: number;
}

export type ApplicationEventSink = (event: ApplicationEvent) => void;

export type ReadyScanResult = Readonly<{
  kind: "ready";
  snapshot: RepositorySnapshot;
  catalog: CatalogSnapshot;
  assessment: RepositoryAssessmentResult;
  harnesses: readonly HarnessInspection[];
  desired: ReadyDesiredState | null;
  lock: ReadyPortableLock | null;
  observed: ObservedProjectState | null;
  resolution: ResolutionResult | null;
  reconciliation: ReconciliationResult;
  recovery: RecoveryResult;
  diagnostics: readonly Diagnostic[];
}>;

export type ScanResult =
  | ReadyScanResult
  | {
      readonly kind: "blocked";
      readonly snapshot: RepositorySnapshot;
      readonly recovery: RecoveryResult | null;
      readonly diagnostics: readonly [Diagnostic, ...Diagnostic[]];
    };

export interface InstallPreparation {
  readonly desired: ReadyDesiredState | null;
  readonly resolution: ResolutionResult;
  readonly plan: DurableProjectPlan | null;
  readonly diagnostics: readonly Diagnostic[];
}

export interface StatusResult {
  readonly scan: ScanResult;
  readonly verification: VerificationResult | null;
}

export type RemoveRequest =
  | { readonly all: true }
  | { readonly components: readonly ComponentRef[] };

export interface ComponentSelectionDraft {
  readonly ref: ComponentRef;
  readonly inputs?: Readonly<Record<string, readonly string[]>>;
}

export interface DoctorCheck {
  readonly id: "catalog" | "recovery" | "repository" | "materialization";
  readonly status: "passed" | "warning" | "failed";
  readonly message: string;
}

export interface DoctorResult {
  readonly kind: "ready" | "blocked";
  readonly scan: ScanResult;
  readonly checks: readonly DoctorCheck[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface AiHarnessCases {
  catalog(): Promise<CatalogLoadResult>;
  scan(root: string): Promise<ScanResult>;
  recommendations(scan: ScanResult): Promise<RecommendationSet>;
  resolve(
    scan: ScanResult,
    directSelections: readonly ComponentRef[],
    targets: readonly HarnessTargetId[],
  ): ResolutionResult;
  prepareInstall(
    scan: ScanResult,
    directSelections: readonly ComponentRef[],
    targets: readonly HarnessTargetId[],
  ): Promise<InstallPreparation>;
  preparePlan(
    scan: ScanResult,
    selections: readonly ComponentSelectionDraft[],
    targets: readonly HarnessTargetId[],
    mode: "reconcile" | "repair" | "remove",
  ): Promise<InstallPreparation>;
  prepareSync(scan: ScanResult): Promise<InstallPreparation>;
  prepareRepair(scan: ScanResult): Promise<InstallPreparation>;
  apply(
    plan: Extract<DurableProjectPlan, { readonly kind: "ready" }>,
    options?: DurableApplyOptions,
  ): Promise<DurableApplyResult>;
  status(root: string, targets?: readonly HarnessTargetId[]): Promise<StatusResult>;
  prepareRemove(scan: ScanResult, request: RemoveRequest): Promise<InstallPreparation>;
  doctor(root: string): Promise<DoctorResult>;
  mcpSession(
    root: string,
    component: ComponentRef,
    targets: readonly HarnessTargetId[],
    operation: McpSessionOperation,
    signal?: AbortSignal,
  ): Promise<McpSessionAggregateResult>;
}

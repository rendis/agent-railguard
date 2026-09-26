import type { Catalog } from "../domain/catalog/model.js";
import type { CatalogMcpIntegrationComponent } from "../domain/catalog/model.js";
import type { HarnessAdapter, HarnessInspection } from "../domain/harness/model.js";
import type { ProjectObserver } from "../domain/observation/model.js";
import type {
  ProjectArtifactProjector,
  ProjectProjectionCoordinator,
} from "../domain/project/model.js";
import { recommend } from "../domain/recommendation/recommend.js";
import type { Reconciler } from "../domain/reconciliation/reconciler.js";
import type { RepositoryAssessment, RepositoryInventory } from "../domain/repository/model.js";
import type { RepositoryGate } from "../domain/repository/gate.js";
import type { Resolver } from "../domain/resolution/model.js";
import {
  compareDiagnostics,
  compareUtf8,
  relativePosixPath,
  sha256,
  type ComponentRef,
  type Diagnostic,
  type HarnessTargetId,
} from "../domain/shared/types.js";
import type {
  DurableMutationEngine,
  DurableApplyOptions,
  DurableProjectPlanning,
} from "../domain/transaction/model.js";
import {
  DesiredStateModule,
  type DesiredSelectionDraft,
} from "../project-state/desired-state.js";
import type { ProjectStateReader } from "../project-state/store.js";
import type {
  RailguardCases,
  ApplicationEvent,
  ApplicationEventSink,
  ComponentSelectionDraft,
  DoctorResult,
  InstallPreparation,
  ReadyScanResult,
  RemoveRequest,
  ScanResult,
  StatusResult,
} from "./model.js";
import { McpSessionCoordinator } from "./mcp-session-coordinator.js";
import type { McpSessionOperation } from "../domain/mcp/session.js";

export interface RailguardApplicationDependencies {
  readonly catalog: Catalog;
  readonly inventory: RepositoryInventory;
  readonly repositoryGate: RepositoryGate;
  readonly assessment: RepositoryAssessment;
  readonly resolver: Resolver;
  readonly harnesses: readonly HarnessAdapter[];
  readonly projectors: readonly ProjectArtifactProjector[];
  readonly projectionCoordinator: ProjectProjectionCoordinator;
  readonly planner: DurableProjectPlanning;
  readonly mutationEngine: DurableMutationEngine;
  readonly projectState: ProjectStateReader;
  readonly observer: ProjectObserver;
  readonly reconciler: Reconciler;
  readonly desiredState?: DesiredStateModule;
  readonly events?: ApplicationEventSink;
  readonly mcpSessions?: McpSessionCoordinator;
}

export class RailguardApplication implements RailguardCases {
  readonly #catalog: Catalog;
  readonly #inventory: RepositoryInventory;
  readonly #repositoryGate: RepositoryGate;
  readonly #assessment: RepositoryAssessment;
  readonly #resolver: Resolver;
  readonly #harnesses: ReadonlyMap<HarnessTargetId, HarnessAdapter>;
  readonly #projectors: readonly ProjectArtifactProjector[];
  readonly #projectionCoordinator: ProjectProjectionCoordinator;
  readonly #planner: DurableProjectPlanning;
  readonly #mutationEngine: DurableMutationEngine;
  readonly #projectState: ProjectStateReader;
  readonly #observer: ProjectObserver;
  readonly #reconciler: Reconciler;
  readonly #desiredState: DesiredStateModule;
  readonly #events: ApplicationEventSink;
  readonly #mcpSessions: McpSessionCoordinator;

  public constructor(dependencies: RailguardApplicationDependencies) {
    this.#catalog = dependencies.catalog;
    this.#inventory = dependencies.inventory;
    this.#repositoryGate = dependencies.repositoryGate;
    this.#assessment = dependencies.assessment;
    this.#resolver = dependencies.resolver;
    this.#planner = dependencies.planner;
    this.#mutationEngine = dependencies.mutationEngine;
    this.#projectState = dependencies.projectState;
    this.#observer = dependencies.observer;
    this.#reconciler = dependencies.reconciler;
    this.#desiredState = dependencies.desiredState ?? new DesiredStateModule();
    this.#projectors = Object.freeze([...dependencies.projectors]);
    this.#projectionCoordinator = dependencies.projectionCoordinator;
    this.#events = dependencies.events ?? (() => undefined);
    this.#mcpSessions = dependencies.mcpSessions ?? new McpSessionCoordinator({ adapters: [] });
    const entries = [...dependencies.harnesses]
      .sort((left, right) => compareUtf8(left.id, right.id))
      .map((adapter) => [adapter.id, adapter] as const);
    if (new Set(entries.map(([id]) => id)).size !== entries.length) {
      throw new TypeError("Harness adapter IDs must be unique");
    }
    this.#harnesses = new Map(entries);
  }

  public async catalog() {
    this.#emit("catalog", "load", "started", "Resolving the current project-content source");
    const result = await this.#catalog.load();
    this.#emit(
      "catalog",
      "load",
      result.kind === "ready" ? "completed" : "failed",
      result.kind === "ready" ? "Current project content loaded" : "Project-content validation failed",
    );
    return result;
  }

  public async scan(root: string): Promise<ScanResult> {
    this.#emit("scan", "inventory", "started", "Scanning repository inventory");
    this.#emit("scan", "catalog", "started", "Resolving the current project-content manifest");
    const [snapshot, catalogResult] = await Promise.all([
      this.#inventory.snapshot(root).then((result) => {
        this.#emit("scan", "inventory", "completed", "Repository inventory captured");
        return result;
      }),
      this.#catalog.load().then((result) => {
        this.#emit(
          "scan",
          "catalog",
          result.kind === "ready" ? "completed" : "failed",
          result.kind === "ready" ? "Current project content loaded" : "Project-content validation failed",
        );
        return result;
      }),
    ]);
    if (catalogResult.kind === "invalid") {
      return blockedScan(snapshot, catalogResult.diagnostics);
    }

    this.#emit("scan", "assessment", "started", "Assessing registered stacks");
    const [assessment, harnesses] = await Promise.all([
      this.#assessment.assess(snapshot).then((result) => {
        this.#emit("scan", "assessment", "completed", "Registered stack assessment completed");
        return result;
      }),
      this.#inspectHarnesses(snapshot),
    ]);

    const desiredResult = await this.#projectState.loadDesired(snapshot.realRoot, catalogResult.catalog);
    if (desiredResult.kind === "invalid") {
      return blockedScan(snapshot, desiredResult.diagnostics);
    }
    const desired = desiredResult.kind === "ready" ? desiredResult : null;
    const lockResult = await this.#projectState.loadLock(snapshot.realRoot, {
      desiredDigest: desired?.digest ?? sha256("railguard:desired-absent"),
      catalog: catalogResult.catalog,
    });
    if (lockResult.kind === "invalid") {
      return blockedScan(snapshot, lockResult.diagnostics);
    }
    const lock = lockResult.kind === "ready" ? lockResult : null;
    const resolution = desired === null
      ? null
      : this.#resolve(
          catalogResult.catalog,
          assessment,
          harnesses,
          desired.state.selections.map((selection) => selection.ref),
          desired.state.targets,
        );
    const observed = lock === null
      ? null
      : await this.#observer.observe(snapshot, lock.state);
    const reconciliation = this.#reconciler.reconcile({
      desired,
      lock,
      observed,
      catalog: catalogResult.catalog,
      assessment,
      resolution,
    });
    const diagnostics = [
      ...catalogResult.diagnostics,
      ...harnesses.flatMap((inspection) => inspection.diagnostics),
      ...reconciliation.diagnostics,
    ].sort(compareDiagnostics);
    return Object.freeze({
      kind: "ready",
      snapshot,
      catalog: catalogResult.catalog,
      assessment,
      harnesses: Object.freeze(harnesses),
      desired,
      lock,
      observed,
      resolution,
      reconciliation,
      diagnostics: Object.freeze(diagnostics),
    });
  }

  public async recommendations(scan: ScanResult) {
    const ready = requireReadyScan(scan);
    this.#emit("recommend", "compute", "started", "Computing catalog recommendations");
    const result = recommend({
      catalog: ready.catalog,
      projectUnits: ready.assessment.projectUnits,
      activeComponents: ready.lock?.state.components.map((component) => component.ref) ?? [],
    });
    this.#emit("recommend", "compute", "completed", "Catalog recommendations computed");
    return result;
  }

  public resolve(
    scan: ScanResult,
    directSelections: readonly ComponentRef[],
    targets: readonly HarnessTargetId[],
  ) {
    const ready = requireReadyScan(scan);
    this.#emit("resolve", "graph", "started", "Resolving desired component graph");
    const result = this.#resolve(
      ready.catalog,
      ready.assessment,
      ready.harnesses,
      directSelections,
      targets,
    );
    this.#emit(
      "resolve",
      "graph",
      result.kind === "ready" ? "completed" : "failed",
      result.kind === "ready" ? "Desired graph resolved" : "Desired graph is blocked",
    );
    return result;
  }

  public async prepareInstall(
    scan: ScanResult,
    directSelections: readonly ComponentRef[],
    targets: readonly HarnessTargetId[],
  ): Promise<InstallPreparation> {
    return this.preparePlan(
      scan,
      directSelections.map((ref) => ({ ref })),
      targets,
      "reconcile",
    );
  }

  public async preparePlan(
    scan: ScanResult,
    selections: readonly ComponentSelectionDraft[],
    targets: readonly HarnessTargetId[],
    mode: "reconcile" | "repair" | "remove",
  ): Promise<InstallPreparation> {
    return this.#prepare(scan, selections, targets, mode, false);
  }

  public async prepareSync(scan: ScanResult): Promise<InstallPreparation> {
    const ready = requireReadyScan(scan);
    if (ready.desired === null) {
      return blockedUninitializedPreparation(
        this.resolve(ready, [], []),
        "sync",
      );
    }
    return this.#prepare(
      ready,
      currentSelections(ready),
      ready.desired.state.targets,
      "reconcile",
      false,
    );
  }

  public async prepareRepair(scan: ScanResult): Promise<InstallPreparation> {
    const ready = requireReadyScan(scan);
    if (ready.desired === null) {
      return blockedUninitializedPreparation(
        this.resolve(ready, [], []),
        "repair",
      );
    }
    return this.#prepare(
      ready,
      currentSelections(ready),
      ready.desired.state.targets,
      "repair",
      false,
    );
  }

  public async prepareRemove(
    scan: ScanResult,
    request: RemoveRequest,
  ): Promise<InstallPreparation> {
    const ready = requireReadyScan(scan);
    if ("all" in request) {
      return this.#prepare(
        ready,
        [],
        ready.desired?.state.targets ?? [],
        "remove",
        true,
      );
    }
    const currentSelections = ready.desired?.state.selections ?? [];
    const currentRefs = new Set(currentSelections.map((selection) => selection.ref));
    const requested = new Set(request.components);
    const unknown = [...requested].filter((ref) => !currentRefs.has(ref)).sort(compareUtf8);
    const remaining: DesiredSelectionDraft[] = currentSelections
      .filter((selection) => !requested.has(selection.ref))
      .map((selection) => ({ ref: selection.ref, inputs: selection.inputs }));
    const preparation = await this.#prepare(
      ready,
      remaining,
      ready.desired?.state.targets ?? [],
      "remove",
      false,
      unknown.map(removeSelectionDiagnostic),
    );
    return preparation;
  }

  public async apply(
    plan: Parameters<DurableMutationEngine["apply"]>[0],
    options: DurableApplyOptions = {},
  ) {
    this.#emit("apply", plan.mode, "started", `Applying ${plan.mode} plan`);
    const result = await this.#mutationEngine.apply(plan, options);
    this.#emit(
      "apply",
      plan.mode,
      result.kind === "applied" || result.kind === "no-changes" ? "completed" : "failed",
      `Apply result: ${result.kind}`,
    );
    return result;
  }

  public async status(
    root: string,
    _targets: readonly HarnessTargetId[] = [],
  ): Promise<StatusResult> {
    const scan = await this.scan(root);
    if (scan.kind === "blocked") return Object.freeze({ scan, verification: null });
    const cleanIds = new Set(
      scan.observed?.units
        .filter((unit) => unit.status === "clean")
        .map((unit) => unit.ownershipId) ?? [],
    );
    const verifiedPaths = scan.lock?.state.artifacts
      .filter((artifact) => cleanIds.has(artifact.ownership_id))
      .map((artifact) => artifact.path)
      .sort(compareUtf8) ?? [];
    const materialization = scan.lock === null
      ? "verified"
      : scan.reconciliation.integrity === "clean"
        ? "verified"
        : scan.reconciliation.integrity === "drifted"
          ? "drift"
          : "unknown";
    this.#emit(
      "verify",
      "materialization",
      materialization === "verified" ? "completed" : "failed",
      `Materialization: ${materialization}`,
    );
    return Object.freeze({
      scan,
      verification: Object.freeze({
        materialization,
        hostDiscovery: "not-observable",
        diagnostics: scan.reconciliation.diagnostics,
        verifiedPaths: Object.freeze(verifiedPaths),
      }),
    });
  }

  public async mcpSession(
    root: string,
    componentRef: ComponentRef,
    targets: readonly HarnessTargetId[],
    operation: McpSessionOperation,
    signal?: AbortSignal,
  ) {
    const scan = await this.scan(root);
    if (scan.kind !== "ready") {
      throw new TypeError("MCP session operations require a ready repository scan");
    }
    const component = scan.catalog.components.find(
      (candidate): candidate is CatalogMcpIntegrationComponent =>
        candidate.ref === componentRef && candidate.kind === "mcp-integration",
    );
    if (component === undefined) {
      throw new TypeError(`MCP integration not found: ${componentRef}`);
    }
    const installed = scan.resolution?.kind === "ready"
      ? scan.resolution.components.some((candidate) => candidate.ref === componentRef)
      : false;
    if (!installed) {
      throw new TypeError(`${componentRef} is not configured in this repository`);
    }
    const installedTargets = scan.desired?.state.targets ?? [];
    const effectiveTargets = targets.length === 0 ? installedTargets : targets;
    const invalidTargets = effectiveTargets.filter((target) => !installedTargets.includes(target));
    if (invalidTargets.length > 0) {
      throw new TypeError(
        `MCP session targets are not configured: ${invalidTargets.sort(compareUtf8).join(", ")}`,
      );
    }
    return await this.#mcpSessions.execute(
      operation,
      {
        root: scan.snapshot.realRoot,
        component: component.ref,
        serverId: component.ref.slice("mcp:".length),
        auth: component.auth,
        ...(signal === undefined ? {} : { signal }),
      },
      effectiveTargets,
    );
  }

  public async doctor(root: string): Promise<DoctorResult> {
    this.#emit("doctor", "scan", "started", "Running project diagnostics");
    const scan = await this.scan(root);
    if (scan.kind === "blocked") {
      const result = Object.freeze({
        kind: "blocked" as const,
        scan,
        checks: Object.freeze([
          Object.freeze({ id: "repository" as const, status: "failed" as const, message: "Repository scan is blocked." }),
        ]),
        diagnostics: scan.diagnostics,
      });
      this.#emit("doctor", "scan", "failed", "Project diagnostics found a blocker");
      return result;
    }
    const checks = Object.freeze([
      Object.freeze({ id: "catalog" as const, status: "passed" as const, message: "Bundled catalog is valid." }),
      Object.freeze({
        id: "repository" as const,
        status: scan.reconciliation.readiness === "ready" ? ("passed" as const) : ("failed" as const),
        message: `Repository readiness is ${scan.reconciliation.readiness}.`,
      }),
      Object.freeze({
        id: "materialization" as const,
        status:
          scan.reconciliation.management === "uninitialized" ||
          scan.reconciliation.integrity === "clean"
            ? ("passed" as const)
            : scan.reconciliation.integrity === "drifted"
              ? ("failed" as const)
              : ("warning" as const),
        message: `Materialization integrity is ${scan.reconciliation.integrity}.`,
      }),
    ]);
    const kind = checks.some((check) => check.status === "failed") ? "blocked" : "ready";
    this.#emit(
      "doctor",
      "scan",
      kind === "ready" ? "completed" : "failed",
      kind === "ready" ? "Project diagnostics passed" : "Project diagnostics found a blocker",
    );
    return Object.freeze({ kind, scan, checks, diagnostics: scan.diagnostics });
  }

  async #prepare(
    scan: ScanResult,
    selections: readonly DesiredSelectionDraft[],
    targets: readonly HarnessTargetId[],
    mode: "reconcile" | "repair" | "remove",
    uninitialize: boolean,
    initialDiagnostics: readonly Diagnostic[] = [],
  ): Promise<InstallPreparation> {
    const ready = requireReadyScan(scan);
    const canonicalTargetIds = canonicalTargets(targets);
    const directSelections = selections.map((selection) => selection.ref as ComponentRef);
    const resolution = this.resolve(ready, directSelections, canonicalTargetIds);
    const desiredResult = uninitialize
      ? null
      : this.#desiredState.evaluate(
          {
            kind: "draft",
            targets: canonicalTargetIds,
            selections,
          },
          ready.catalog,
        );
    if (desiredResult?.kind === "invalid") {
      return Object.freeze({
        desired: null,
        resolution,
        plan: null,
        diagnostics: desiredResult.diagnostics,
      });
    }
    const desired = desiredResult?.kind === "ready" ? desiredResult : null;
    if (resolution.kind === "blocked") {
      return Object.freeze({
        desired,
        resolution,
        plan: null,
        diagnostics: resolution.diagnostics,
      });
    }
    if (initialDiagnostics.some((diagnostic) => diagnostic.severity === "blocked" || diagnostic.severity === "failed")) {
      return Object.freeze({
        desired,
        resolution,
        plan: null,
        diagnostics: Object.freeze([...initialDiagnostics].sort(compareDiagnostics)),
      });
    }

    this.#emit("repository-gate", "preflight", "started", "Checking mutable repository readiness");
    const repositoryGate = await this.#repositoryGate.check(ready.snapshot.realRoot);
    this.#emit(
      "repository-gate",
      "preflight",
      repositoryGate.kind === "ready" ? "completed" : "failed",
      repositoryGate.kind === "ready"
        ? "Repository is ready for a reversible transaction"
        : "Repository preflight blocked mutable planning",
    );
    if (repositoryGate.kind === "blocked") {
      return Object.freeze({
        desired,
        resolution,
        plan: null,
        diagnostics: Object.freeze(
          [...resolution.diagnostics, ...repositoryGate.diagnostics].sort(compareDiagnostics),
        ),
      });
    }

    const projectProjections = uninitialize
      ? []
      : await Promise.all(
          this.#projectors.map((projector) =>
            projector.project(
              resolution,
              ready.catalog,
              ready.snapshot,
              ready.assessment,
              canonicalTargetIds,
              new Map(
                desired?.state.selections.map((selection) => [
                  selection.ref,
                  selection.inputs,
                ]) ?? [],
              ),
            ),
          ),
        );
    const coordinatedProjectProjection = uninitialize
      ? null
      : this.#projectionCoordinator.coordinate(projectProjections);
    const projections = uninitialize
      ? []
      : [
          coordinatedProjectProjection!,
          ...canonicalTargetIds.map((target) =>
            this.#requireHarness(target).project(resolution, ready.catalog),
          ),
        ];
    const projectionDiagnostics = projectProjections.flatMap(
      (projection) => projection.diagnostics,
    );
    this.#emit("plan", mode, "started", `Planning project-scoped ${mode}`);
    const plan = await this.#planner.plan({
      mode,
      snapshot: ready.snapshot,
      catalog: ready.catalog,
      resolution,
      projections,
      desiredBefore: ready.desired,
      lockBefore: ready.lock,
      desiredAfter: desired,
      diagnostics: [...initialDiagnostics, ...projectionDiagnostics],
    });
    this.#emit(
      "plan",
      mode,
      plan.kind === "ready" ? "completed" : "failed",
      plan.kind === "ready" ? "Project plan ready" : "Project plan blocked",
    );
    return Object.freeze({
      desired,
      resolution,
      plan,
      diagnostics: Object.freeze([...resolution.diagnostics, ...plan.diagnostics].sort(compareDiagnostics)),
    });
  }

  #resolve(
    catalog: ReadyScanResult["catalog"],
    assessment: ReadyScanResult["assessment"],
    harnesses: readonly HarnessInspection[],
    directSelections: readonly ComponentRef[],
    targets: readonly HarnessTargetId[],
  ) {
    const targetFacts = canonicalTargets(targets).map((target) => {
      const inspection = harnesses.find((candidate) => candidate.target === target);
      return {
        target,
        capabilities: inspection?.capabilities ?? [],
      };
    });
    return this.#resolver.resolve({
      catalog,
      directSelections,
      projectUnits: assessment.projectUnits,
      targets: targetFacts,
    });
  }

  async #inspectHarnesses(snapshot: ReadyScanResult["snapshot"]): Promise<readonly HarnessInspection[]> {
    return Promise.all(
      [...this.#harnesses.values()].map(async (adapter) => {
        this.#emit("scan", `harness:${adapter.id}`, "started", `Inspecting ${adapter.id}`);
        try {
          const inspection = await adapter.inspect(snapshot);
          this.#emit("scan", `harness:${adapter.id}`, "completed", `${adapter.id} inspection completed`);
          return inspection;
        } catch (error) {
          this.#emit("scan", `harness:${adapter.id}`, "failed", `${adapter.id} inspection failed`);
          throw error;
        }
      }),
    );
  }

  #requireHarness(target: HarnessTargetId): HarnessAdapter {
    const adapter = this.#harnesses.get(target);
    if (adapter === undefined) {
      throw new TypeError(`No harness adapter is registered for target: ${target}`);
    }
    return adapter;
  }

  #emit(
    operation: ApplicationEvent["operation"],
    phase: string,
    status: ApplicationEvent["status"],
    message: string,
  ): void {
    this.#events(Object.freeze({ operation, phase, status, message }));
  }
}

function requireReadyScan(scan: ScanResult): ReadyScanResult {
  if (scan.kind !== "ready") {
    throw new TypeError("This use case requires a complete valid scan");
  }
  return scan;
}

function canonicalTargets(targets: readonly HarnessTargetId[]): readonly HarnessTargetId[] {
  return Object.freeze([...new Set(targets)].sort(compareUtf8));
}

function blockedScan(
  snapshot: ReadyScanResult["snapshot"],
  diagnostics: readonly Diagnostic[],
): Extract<ScanResult, { readonly kind: "blocked" }> {
  const sorted = [...diagnostics].sort(compareDiagnostics);
  const first = sorted[0];
  if (first === undefined) throw new TypeError("A blocked scan requires a diagnostic");
  return Object.freeze({
    kind: "blocked",
    snapshot,
    diagnostics: Object.freeze([first, ...sorted.slice(1)]) as readonly [
      Diagnostic,
      ...Diagnostic[],
    ],
  });
}

function removeSelectionDiagnostic(ref: ComponentRef): Diagnostic {
  return Object.freeze({
    code: "remove.selection.not-direct",
    severity: "blocked",
    phase: "planning",
    subjects: Object.freeze([ref]),
    location: Object.freeze({ path: relativePosixPath(".railguard/project.yaml") }),
    message: `${ref} is not a direct installed selection.`,
    evidence: Object.freeze([ref]),
    impact: "A transitive dependency cannot be removed while another selection still requires it.",
    action: "Remove the direct selection that introduces it, or use remove --all.",
  });
}

function currentSelections(scan: ReadyScanResult): readonly DesiredSelectionDraft[] {
  return Object.freeze(
    scan.desired?.state.selections.map((selection) =>
      Object.freeze({ ref: selection.ref, inputs: selection.inputs }),
    ) ?? [],
  );
}

function blockedUninitializedPreparation(
  resolution: ReturnType<RailguardApplication["resolve"]>,
  command: "sync" | "repair",
): InstallPreparation {
  const diagnostic: Diagnostic = Object.freeze({
    code: `application.${command}.uninitialized`,
    severity: "blocked",
    phase: "planning",
    subjects: Object.freeze([]),
    location: Object.freeze({ path: relativePosixPath(".railguard/project.yaml") }),
    message: `The repository is not initialized, so ${command} has no desired state to reconcile.`,
    evidence: Object.freeze(["desired-state:absent"]),
    impact: "No project configuration was changed.",
    action: "Run init with an explicit component selection and harness target first.",
  });
  return Object.freeze({
    desired: null,
    resolution,
    plan: null,
    diagnostics: Object.freeze([diagnostic]),
  });
}

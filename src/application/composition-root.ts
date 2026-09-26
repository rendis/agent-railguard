import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAdapter } from "../adapters/harness/codex/codex-adapter.js";
import { CodexMcpSessionAdapter } from "../adapters/harness/codex/codex-mcp-session-adapter.js";
import { ClaudeCodeAdapter } from "../adapters/harness/claude-code/claude-code-adapter.js";
import { ClaudeCodeMcpSessionAdapter } from "../adapters/harness/claude-code/claude-code-mcp-session-adapter.js";
import { CursorAdapter } from "../adapters/harness/cursor/cursor-adapter.js";
import { CursorMcpSessionAdapter } from "../adapters/harness/cursor/cursor-mcp-session-adapter.js";
import { OpenCodeAdapter } from "../adapters/harness/opencode/opencode-adapter.js";
import { OpenCodeMcpSessionAdapter } from "../adapters/harness/opencode/opencode-mcp-session-adapter.js";
import { VsCodeAdapter } from "../adapters/harness/vscode/vscode-adapter.js";
import { VsCodeMcpSessionAdapter } from "../adapters/harness/vscode/vscode-mcp-session-adapter.js";
import { NodeInteractiveCommandRunner } from "../adapters/platform/process/node-interactive-command-runner.js";
import { NodeChangeSetReader } from "../adapters/platform/git/node-change-set-reader.js";
import { NodeGitConfig } from "../adapters/platform/git/node-git-config.js";
import { NodeGitHookInventory } from "../adapters/platform/git/node-git-hook-inventory.js";
import { NodeExecutableProbe } from "../adapters/platform/process/node-executable-probe.js";
import { NodeProcessRunner } from "../adapters/platform/process/node-process-runner.js";
import { NodeRepositoryInventory } from "../adapters/platform/repository-inventory/node-repository-inventory.js";
import { NodeRepositoryGate } from "../adapters/platform/repository-gate/node-repository-gate.js";
import { NodeProjectStateStore } from "../adapters/platform/state/project-state-store.js";
import { NodeMutationEngine } from "../adapters/platform/transaction/node-mutation-engine.js";
import { PinnedToolInstaller, toolCacheRoot } from "../adapters/platform/tools/pinned-tool.js";
import { QualityProjector } from "../adapters/project/quality/quality-projector.js";
import { InstructionProjector } from "../adapters/project/instructions/instruction-projector.js";
import { SharedSkillProjector } from "../adapters/project/skills/shared-skill-projector.js";
import { registeredCheckProviders, registeredStackAdapters } from "../adapters/stack/registry.js";
import { ChangeCheckProvider, ChangeReview } from "../adapters/verification/change-check-provider.js";
import { SecretCheckProvider } from "../adapters/verification/secret-check-provider.js";
import { NodeVerifyScript } from "../adapters/verification/node-verify-script.js";
import { UnverifiedChangeStore } from "../adapters/verification/unverified-change-store.js";
import { createDefaultContentSource } from "../catalog/source/content-source-composition.js";
import type { ContentSource, ContentSourceProgress } from "../catalog/source/content-source.js";
import { SourcedCatalog } from "../catalog/source/sourced-catalog.js";
import type { ExecutableProbe } from "../domain/harness/model.js";
import type { CommandRunner } from "../domain/process/command-runner.js";
import { DefaultProjectObserver } from "../domain/observation/observer.js";
import { DefaultProjectProjectionCoordinator } from "../domain/harness/projection-coordinator.js";
import { DefaultReconciler } from "../domain/reconciliation/reconciler.js";
import { DefaultRepositoryAssessment } from "../domain/repository/assessment.js";
import { DefaultResolver } from "../domain/resolution/resolver.js";
import { DurableProjectPlanner } from "../domain/transaction/project-planner.js";
import { engineVersion, releaseRepository } from "./engine-release.js";
import { RailguardApplication } from "./railguard-application.js";
import { McpSessionCoordinator } from "./mcp-session-coordinator.js";
import type { ApplicationEventSink } from "./model.js";
import { VerificationService } from "./verification-service.js";

export interface DefaultApplicationOptions {
  readonly sourcePath?: string;
  readonly catalogFile?: string;
  readonly contentSource?: ContentSource;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly contentCacheRoot?: string;
  readonly developmentCatalogFile?: string;
  readonly executableProbe?: ExecutableProbe;
  readonly mcpCommandRunner?: CommandRunner;
  readonly events?: ApplicationEventSink;
}

export interface DefaultApplicationRuntime {
  readonly application: RailguardApplication;
  readonly verification: VerificationService;
  readonly review: ChangeReview;
  readonly unverified: UnverifiedChangeStore;
  dispose(): Promise<void>;
}

/** The unverified-change record alone, for hooks that must answer without loading the catalog. */
export function createUnverifiedChanges(): UnverifiedChangeStore {
  return new UnverifiedChangeStore(new NodeProcessRunner());
}

export async function createDefaultApplication(
  options: DefaultApplicationOptions = {},
): Promise<DefaultApplicationRuntime> {
  const inventory = new NodeRepositoryInventory();
  const stackAdapters = registeredStackAdapters();
  const assessment = new DefaultRepositoryAssessment(stackAdapters);
  const executableProbe = options.executableProbe ?? new NodeExecutableProbe();
  const harnesses = [
    new ClaudeCodeAdapter(executableProbe),
    new CodexAdapter(executableProbe),
    new CursorAdapter(executableProbe),
    new OpenCodeAdapter(executableProbe),
    new VsCodeAdapter(executableProbe),
  ];
  const gitConfig = new NodeGitConfig();
  const commandRunner = options.mcpCommandRunner ?? new NodeInteractiveCommandRunner();
  const progress = (event: ContentSourceProgress) =>
    options.events?.({
      operation: "catalog",
      phase: `source:${event.phase}`,
      status: event.status,
      message: event.message,
      ...(event.current === undefined ? {} : { current: event.current }),
      ...(event.total === undefined ? {} : { total: event.total }),
    });
  const contentSource = options.contentSource ?? createDefaultContentSource({
    ...(options.sourcePath === undefined ? {} : { sourcePath: options.sourcePath }),
    ...(options.catalogFile === undefined ? {} : { catalogFile: options.catalogFile }),
    developmentCatalogFile: options.developmentCatalogFile ?? defaultCatalogFile(),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.contentCacheRoot === undefined ? {} : { cacheRoot: options.contentCacheRoot }),
    progress,
  });
  const processRunner = new NodeProcessRunner();
  const changeSets = new NodeChangeSetReader(processRunner);
  const review = new ChangeReview(processRunner, changeSets);
  const checkProviders = [
    ...registeredCheckProviders(processRunner),
    new ChangeCheckProvider(processRunner, changeSets, review),
    new SecretCheckProvider(
      processRunner,
      changeSets,
      new PinnedToolInstaller({ cacheRoot: toolCacheRoot(options.environment ?? process.env), process: processRunner }),
    ),
  ];
  const application = new RailguardApplication({
    catalog: new SourcedCatalog({
      source: contentSource,
      supportedLanguages: stackAdapters.map((adapter) => adapter.id),
    }),
    inventory,
    repositoryGate: new NodeRepositoryGate(),
    assessment,
    resolver: new DefaultResolver(),
    harnesses,
    projectors: [
      new SharedSkillProjector(),
      new InstructionProjector(),
      new QualityProjector(
        executableProbe,
        new NodeGitHookInventory(),
        { version: engineVersion, repository: releaseRepository },
        checkProviders,
      ),
    ],
    projectionCoordinator: new DefaultProjectProjectionCoordinator(),
    planner: new DurableProjectPlanner(gitConfig),
    mutationEngine: new NodeMutationEngine(
      gitConfig,
      (event) =>
        options.events?.({
          operation: "apply",
          phase: event.unitId === undefined ? event.phase : `${event.phase}:${event.unitId}`,
          status: event.status,
          message: event.message,
          ...(event.current === undefined ? {} : { current: event.current }),
          ...(event.total === undefined ? {} : { total: event.total }),
        }),
    ),
    projectState: new NodeProjectStateStore(),
    observer: new DefaultProjectObserver(gitConfig),
    reconciler: new DefaultReconciler(),
    mcpSessions: new McpSessionCoordinator({
      adapters: [
        new ClaudeCodeMcpSessionAdapter(commandRunner),
        new CodexMcpSessionAdapter(commandRunner),
        new CursorMcpSessionAdapter(commandRunner, executableProbe),
        new OpenCodeMcpSessionAdapter(commandRunner),
        new VsCodeMcpSessionAdapter(),
      ],
      progress: (event) => options.events?.({
        operation: "mcp-session",
        phase: `${event.operation}:${event.target}`,
        status: event.status,
        message: event.message,
      }),
    }),
    ...(options.events === undefined ? {} : { events: options.events }),
  });
  const verification = new VerificationService({
    scan: (root) => application.scan(root),
    changeSets,
    providers: checkProviders,
    script: new NodeVerifyScript(processRunner),
  });
  return Object.freeze({
    application,
    verification,
    review,
    unverified: new UnverifiedChangeStore(processRunner),
    async dispose() {
      // Durable state is repository-owned; there is no process-local store to remove.
    },
  });
}

function defaultCatalogFile(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  return resolve(
    moduleDirectory,
    basename(moduleDirectory) === "dist" ? "../railguard.yaml" : "../../railguard.yaml",
  );
}

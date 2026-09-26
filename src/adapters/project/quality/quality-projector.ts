import type {
  CatalogAgentHookComponent,
  CatalogComponent,
  CatalogGitGateComponent,
  CatalogSnapshot,
  CatalogVerificationProfileComponent,
} from "../../../domain/catalog/model.js";
import type { ExecutableProbe } from "../../../domain/harness/model.js";
import type { HarnessTargetId } from "../../../domain/shared/types.js";
import type { ArtifactIntent } from "../../../domain/planning/model.js";
import type {
  ProjectArtifactProjector,
  ProjectProjection,
  ProjectSelectionInputs,
  GitHookInventory,
} from "../../../domain/project/model.js";
import type { CheckProvider } from "../../../domain/verification/checks.js";
import {
  planFullSteps,
  profileInputs,
  renderVerifyScript,
  verifyScriptPath,
} from "../../../domain/verification/verify-script.js";
import type { RepositoryAssessmentResult, RepositorySnapshot } from "../../../domain/repository/model.js";
import type { ReadyResolution } from "../../../domain/resolution/model.js";
import {
  ReadonlyBytes,
  compareDiagnostics,
  compareUtf8,
  componentRef,
  relativePosixPath,
  harnessTargetId,
  semVer,
  type Diagnostic,
  type ComponentRef,
} from "../../../domain/shared/types.js";
import {
  projectProjectionTargetId,
  type ProjectedUnit,
} from "../../../domain/projection/model.js";
import { engineUnavailable, launcherBody, launcherPath, type EngineRelease } from "./launcher.js";

export class QualityProjector implements ProjectArtifactProjector {
  readonly #executableProbe: ExecutableProbe;
  readonly #gitHooks: GitHookInventory;
  readonly #engine: EngineRelease;
  readonly #checkProviders: readonly CheckProvider[];

  public constructor(
    executableProbe: ExecutableProbe,
    gitHooks: GitHookInventory,
    engine: EngineRelease,
    checkProviders: readonly CheckProvider[],
  ) {
    this.#executableProbe = executableProbe;
    this.#gitHooks = gitHooks;
    this.#engine = engine;
    this.#checkProviders = checkProviders;
  }

  public async project(
    resolution: ReadyResolution,
    catalog: CatalogSnapshot,
    snapshot: RepositorySnapshot,
    assessment: RepositoryAssessmentResult,
    _targets: readonly HarnessTargetId[],
    selectionInputs: ProjectSelectionInputs,
  ): Promise<ProjectProjection> {
    const byRef = new Map(catalog.components.map((component) => [component.ref, component]));
    const components = resolution.components
      .map((resolved) => requireComponent(byRef, resolved.ref))
      .sort((left, right) => compareUtf8(left.ref, right.ref));
    const profiles = components.filter(
      (component): component is CatalogVerificationProfileComponent =>
        component.kind === "verification-profile",
    );
    const gates = components.filter(
      (component): component is CatalogGitGateComponent => component.kind === "git-gate",
    );
    const agentHooks = components.filter(
      (component): component is CatalogAgentHookComponent => component.kind === "agent-hook",
    );
    const stopHooks = agentHooks.filter((hook) => hook.event === "stop");
    const guardHooks = agentHooks.filter((hook) => hook.event === "pre-action");
    if (profiles.length === 0 && gates.length === 0 && agentHooks.length === 0) {
      return emptyProjection();
    }

    const diagnostics: Diagnostic[] = [];
    const executables = [...new Set(profiles.flatMap((profile) => profile.executables))].sort(compareUtf8);
    for (const executable of executables) {
      const executableProbe = await this.#executableProbe.probe(executable, []);
      diagnostics.push(...executableProbe.diagnostics);
      if (!executableProbe.detected) {
        diagnostics.push(
          readinessDiagnostic(
            "quality.executable.missing",
            executable,
          ),
        );
      }
    }
    if (gates.length > 0) {
      try {
        const hiddenHooks = await this.#gitHooks.executableDefaultHooks(snapshot.realRoot);
        if (hiddenHooks.length > 0) {
          diagnostics.push(existingGitHooksDiagnostic(hiddenHooks));
        }
      } catch (error) {
        diagnostics.push(gitHooksUnreadableDiagnostic(error));
      }
    }
    const intents: ArtifactIntent[] = [
      Object.freeze({
        kind: "file",
        owner: "railguard:launcher",
        scopeRoot: relativePosixPath(".railguard/bin"),
        path: relativePosixPath(launcherPath),
        bytes: new ReadonlyBytes(Buffer.from(launcherBody(this.#engine), "utf8")),
        mode: 0o755,
      }),
    ];
    const fullSteps = planFullSteps(profiles, assessment.projectUnits, selectionInputs, this.#checkProviders);
    const scriptSources = [...new Set(fullSteps.filter((step) => step.full.kind === "script").map((step) => step.profile))];
    const verifyScript = renderVerifyScript(fullSteps);
    if (verifyScript !== null) {
      intents.push(
        Object.freeze({
          kind: "file",
          owner: "railguard:verify-script",
          scopeRoot: relativePosixPath(".railguard"),
          path: relativePosixPath(verifyScriptPath),
          bytes: new ReadonlyBytes(Buffer.from(verifyScript, "utf8")),
          mode: 0o755,
        }),
      );
    }
    for (const [event, eventGates] of groupGatesByEvent(gates)) {
      intents.push(
        Object.freeze({
          kind: "file",
          owner: `git-gates:${event}`,
          scopeRoot: relativePosixPath(".railguard/hooks"),
          path: relativePosixPath(`.railguard/hooks/${event}`),
          bytes: new ReadonlyBytes(
            Buffer.from(hookBody(event, eventGates), "utf8"),
          ),
          mode: 0o755,
        }),
      );
    }
    if (stopHooks.length > 0) {
      intents.push(
        Object.freeze({
          kind: "file",
          owner: "agent-hooks:stop",
          scopeRoot: relativePosixPath(".railguard/agent-hooks"),
          path: relativePosixPath(agentStopScriptPath),
          bytes: new ReadonlyBytes(Buffer.from(agentStopBody(stopHooks), "utf8")),
          mode: 0o755,
        }),
        Object.freeze({
          kind: "file",
          owner: "agent-hooks:session-start",
          scopeRoot: relativePosixPath(".railguard/agent-hooks"),
          path: relativePosixPath(agentSessionStartScriptPath),
          bytes: new ReadonlyBytes(Buffer.from(agentSessionStartBody(), "utf8")),
          mode: 0o755,
        }),
      );
    }
    if (guardHooks.length > 0) {
      const changeGuard = profiles.find((profile) => profile.ref === changeGuardRef);
      const protectedPaths = changeGuard === undefined
        ? []
        : profileInputs(changeGuard, selectionInputs.get(changeGuard.ref)).protected_paths ?? [];
      intents.push(
        Object.freeze({
          kind: "file",
          owner: "agent-hooks:guard",
          scopeRoot: relativePosixPath(".railguard/agent-hooks"),
          path: relativePosixPath(agentGuardScriptPath),
          bytes: new ReadonlyBytes(Buffer.from(agentGuardBody(protectedPaths), "utf8")),
          mode: 0o755,
        }),
      );
    }
    if (gates.length > 0) {
      intents.push(
        Object.freeze({
          kind: "git-config",
          owner: "git-gates:activation",
          path: relativePosixPath(".git/config"),
          key: "core.hooksPath",
          value: ".railguard/hooks",
        }),
      );
    }
    intents.sort((left, right) => compareUtf8(left.path, right.path));
    diagnostics.sort(compareDiagnostics);
    const units = intents.map<ProjectedUnit>((intent) => {
      if (intent.kind === "git-config") {
        return Object.freeze({
          kind: "local-effect",
          ownershipId: "project.git-gates.activation",
          sources: Object.freeze(gates.map((gate) => gate.ref)),
          intent,
        });
      }
      if (intent.path === launcherPath) {
        return Object.freeze({
          kind: "artifact",
          ownershipId: "project.launcher",
          sources: Object.freeze([...profiles, ...gates, ...agentHooks].map((component) => component.ref)),
          intent,
        });
      }
      if (intent.path === verifyScriptPath) {
        return Object.freeze({
          kind: "artifact",
          ownershipId: "project.verify-script",
          sources: Object.freeze(scriptSources),
          intent,
        });
      }
      if (intent.path === agentStopScriptPath) {
        return Object.freeze({
          kind: "artifact",
          ownershipId: "project.agent-hook.stop",
          sources: Object.freeze(stopHooks.map((hook) => hook.ref)),
          intent,
        });
      }
      if (intent.path === agentSessionStartScriptPath) {
        return Object.freeze({
          kind: "artifact",
          ownershipId: "project.agent-hook.session-start",
          sources: Object.freeze(stopHooks.map((hook) => hook.ref)),
          intent,
        });
      }
      if (intent.path === agentGuardScriptPath) {
        const changeGuard = profiles.some((profile) => profile.ref === changeGuardRef) ? [componentRef(changeGuardRef)] : [];
        return Object.freeze({
          kind: "artifact",
          ownershipId: "project.agent-hook.guard",
          sources: Object.freeze([...guardHooks.map((hook) => hook.ref), ...changeGuard].sort(compareUtf8)),
          intent,
        });
      }
      const sources = intentSources(intent, gates);
      return Object.freeze({
        kind: "artifact",
        ownershipId:
          intent.kind === "managed-section"
            ? `project.${intent.sectionId}`
            : `project.git-gate.${intent.path.slice(".railguard/hooks/".length)}`,
        sources: Object.freeze(sources),
        intent,
      });
    });
    units.sort((left, right) => compareUtf8(left.ownershipId, right.ownershipId));
    return Object.freeze({
      identity: qualityIdentity(),
      units: Object.freeze(units),
      diagnostics: Object.freeze(diagnostics),
    });
  }
}

function emptyProjection(): ProjectProjection {
  return Object.freeze({
    identity: qualityIdentity(),
    units: Object.freeze([]),
    diagnostics: Object.freeze([]),
  });
}

function qualityIdentity() {
  return Object.freeze({
    target: projectProjectionTargetId,
    adapter: Object.freeze({ id: harnessTargetId("quality"), version: semVer("0.1.0") }),
    capabilities: Object.freeze([]),
  });
}

function intentSources(
  intent: Exclude<ArtifactIntent, { readonly kind: "git-config" }>,
  gates: readonly CatalogGitGateComponent[],
): readonly ComponentRef[] {
  if (intent.kind === "file") {
    const event = intent.path.slice(".railguard/hooks/".length);
    const sources = gates.filter((gate) => gate.event === event).map((gate) => gate.ref);
    if (sources.length > 0) return sources;
  }
  throw new TypeError(`Projection intent has no component source: ${intent.owner}`);
}

function groupGatesByEvent(
  gates: readonly CatalogGitGateComponent[],
): readonly [CatalogGitGateComponent["event"], readonly CatalogGitGateComponent[]][] {
  const grouped = new Map<CatalogGitGateComponent["event"], CatalogGitGateComponent[]>();
  for (const gate of gates) {
    const values = grouped.get(gate.event) ?? [];
    values.push(gate);
    grouped.set(gate.event, values);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => compareUtf8(left, right))
    .map(([event, values]) => [
      event,
      Object.freeze(
        values.sort((left, right) =>
          compareUtf8(`${left.operation}\0${left.ref}`, `${right.operation}\0${right.ref}`),
        ),
      ),
    ] as const);
}

const agentStopScriptPath = ".railguard/agent-hooks/stop";
const agentGuardScriptPath = ".railguard/agent-hooks/guard";
const agentSessionStartScriptPath = ".railguard/agent-hooks/session-start";

/**
 * Called by every harness when an agent session starts: it tells the agent about a change an
 * earlier session left unverified. Without the engine it adds nothing.
 */
function agentSessionStartBody(): string {
  return [
    "#!/bin/sh",
    "# Managed by Railguard: runs when a coding agent session starts.",
    'cd "$(git rev-parse --show-toplevel)" || exit 0',
    `${launcherPath} hook session-start --harness "$1" || exit 0`,
    "",
  ].join("\n");
}
const changeGuardRef = "verification-profile:change-guard";

/**
 * Called by every harness's pre-action hook with the harness id, before the agent runs a command or
 * edits a file. The protected paths are written here so the engine decides without loading the
 * catalog. Without the engine the action proceeds; Cursor needs an explicit allow to do so.
 */
function agentGuardBody(protectedPaths: readonly string[]): string {
  const protect = protectedPaths.length === 0
    ? ""
    : ` --protect ${[...protectedPaths].sort(compareUtf8).map(shellQuote).join(" ")}`;
  return [
    "#!/bin/sh",
    "# Managed by Railguard: runs before a coding agent runs a command or edits a file.",
    'cd "$(git rev-parse --show-toplevel)" || exit 0',
    "status=0",
    `${launcherPath} hook guard --harness "$1"${protect} || status=$?`,
    `if [ "$status" -eq ${engineUnavailable} ]; then`,
    '  echo "Railguard is unavailable; this action was not checked." >&2',
    '  if [ "$1" = cursor ]; then echo \'{"permission":"allow"}\'; fi',
    "  exit 0",
    "fi",
    'exit "$status"',
    "",
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Called by every harness's stop hook with the harness id. It delegates to the engine, which owns
 * each harness's protocol and the retry budget; without the engine the agent may finish.
 */
function agentStopBody(hooks: readonly CatalogAgentHookComponent[]): string {
  const operation = hooks.some((hook) => hook.operation === "verify") ? "verify" : "check";
  return [
    "#!/bin/sh",
    "# Managed by Railguard: runs when a coding agent tries to finish its turn.",
    'cd "$(git rev-parse --show-toplevel)" || exit 0',
    "status=0",
    `${launcherPath} hook stop --harness "$1" --operation ${operation} || status=$?`,
    `if [ "$status" -eq ${engineUnavailable} ]; then`,
    '  echo "Railguard is unavailable; this change was not verified." >&2',
    "  exit 0",
    "fi",
    'exit "$status"',
    "",
  ].join("\n");
}

/**
 * The hook only delegates to the pinned engine, so it judges the same change as agents and CI.
 * Without the engine it warns and lets Git continue; CI remains the authoritative gate.
 */
function hookBody(
  event: CatalogGitGateComponent["event"],
  gates: readonly CatalogGitGateComponent[],
): string {
  const operation = gates.some((gate) => gate.operation === "verify") ? "verify" : "check";
  return [
    "#!/bin/sh",
    "# Managed by Railguard.",
    "set -u",
    'cd "$(git rev-parse --show-toplevel)" || exit 1',
    "status=0",
    `${launcherPath} ${operation} --changed || status=$?`,
    `if [ "$status" -eq ${engineUnavailable} ]; then`,
    `  echo "Railguard is unavailable; skipping the ${event} ${operation}." >&2`,
    "  exit 0",
    "fi",
    'exit "$status"',
    "",
  ].join("\n");
}

function readinessDiagnostic(code: string, executable: string): Diagnostic {
  return Object.freeze({
    code,
    severity: "blocked",
    phase: "planning",
    subjects: Object.freeze([]),
    location: null,
    message: `The required ${executable} executable is unavailable.`,
    evidence: Object.freeze([executable]),
    impact: "The canonical verification contract cannot run after installation.",
    action: `Install ${executable} and prepare the plan again.`,
  });
}

function existingGitHooksDiagnostic(events: readonly string[]): Diagnostic {
  return Object.freeze({
    code: "quality.git-hooks.conflict",
    severity: "blocked",
    phase: "planning",
    subjects: Object.freeze([]),
    location: Object.freeze({ path: relativePosixPath(".git/hooks") }),
    message: "Activating the managed hook root would hide existing executable Git hooks.",
    evidence: Object.freeze([...events].sort(compareUtf8)),
    impact: "Existing local commit or push automation would stop running.",
    action: "Remove, migrate, or explicitly compose the existing hooks before planning again.",
  });
}

function gitHooksUnreadableDiagnostic(error: unknown): Diagnostic {
  return Object.freeze({
    code: "quality.git-hooks.unreadable",
    severity: "blocked",
    phase: "planning",
    subjects: Object.freeze([]),
    location: Object.freeze({ path: relativePosixPath(".git/hooks") }),
    message: "The existing Git hook surface could not be inspected.",
    evidence: Object.freeze([error instanceof Error ? error.message : String(error)]),
    impact: "Railguard cannot prove that activating a new hook root preserves local automation.",
    action: "Repair the local Git repository and prepare the plan again.",
  });
}

function requireComponent(
  byRef: ReadonlyMap<string, CatalogComponent>,
  ref: string,
): CatalogComponent {
  const component = byRef.get(ref);
  if (component === undefined) {
    throw new TypeError(`Resolution/catalog mismatch for component: ${ref}`);
  }
  return component;
}

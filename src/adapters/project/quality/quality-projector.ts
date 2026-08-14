import type {
  CatalogComponent,
  CatalogGitGateComponent,
  CatalogSnapshot,
  CatalogVerificationProfileComponent,
} from "../../../domain/catalog/model.js";
import type { ExecutableProbe } from "../../../domain/harness/model.js";
import { inspectMakeTargets, type MakeTargetDeclaration } from "../../../domain/make/make-targets.js";
import type { ArtifactIntent, ExactTextEdit } from "../../../domain/planning/model.js";
import type {
  ProjectArtifactProjector,
  ProjectPlanningContext,
  ProjectProjection,
  GitHookInventory,
  ProjectSelectionInputs,
} from "../../../domain/project/model.js";
import type {
  RepositoryAssessmentResult,
  RepositorySnapshot,
} from "../../../domain/repository/model.js";
import type { ReadyResolution } from "../../../domain/resolution/model.js";
import {
  ReadonlyBytes,
  compareDiagnostics,
  compareUtf8,
  relativePosixPath,
  harnessTargetId,
  semVer,
  type Diagnostic,
  type ComponentRef,
  type HarnessTargetId,
} from "../../../domain/shared/types.js";
import {
  projectProjectionTargetId,
  type ProjectedUnit,
} from "../../../domain/projection/model.js";

const maximumMakefileBytes = 4 * 1024 * 1024;

export class QualityProjector implements ProjectArtifactProjector {
  readonly #executableProbe: ExecutableProbe;
  readonly #gitHooks: GitHookInventory;

  public constructor(executableProbe: ExecutableProbe, gitHooks: GitHookInventory) {
    this.#executableProbe = executableProbe;
    this.#gitHooks = gitHooks;
  }

  public async project(
    resolution: ReadyResolution,
    catalog: CatalogSnapshot,
    snapshot: RepositorySnapshot,
    assessment: RepositoryAssessmentResult,
    _targets: readonly HarnessTargetId[],
    selectionInputs: ProjectSelectionInputs,
    context: ProjectPlanningContext = Object.freeze({ conflictResolutions: Object.freeze([]) }),
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
    if (profiles.length === 0 && gates.length === 0) {
      return emptyProjection();
    }

    const diagnostics: Diagnostic[] = [];
    const executables = [...new Set(profiles.flatMap((profile) => profile.executables))].sort(compareUtf8);
    for (const executable of executables) {
      const executableProbe = await this.#executableProbe.probe(executable, ["--version"]);
      diagnostics.push(...executableProbe.diagnostics);
      if (!executableProbe.detected) {
        diagnostics.push(
          readinessDiagnostic(
            executable === "make" ? "quality.make.missing" : "quality.executable.missing",
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
    const replaceCollisions = context.conflictResolutions.some(
      (resolution) =>
        resolution.code === "quality.make.target-collision" && resolution.action === "replace",
    );
    const makeCollisions = await assessMakeCollisions(snapshot, profiles, replaceCollisions);
    diagnostics.push(...makeCollisions.diagnostics);

    const intents: ArtifactIntent[] = profiles.map((profile) =>
      Object.freeze({
        kind: "managed-section" as const,
        owner: profile.ref,
        path: relativePosixPath("Makefile"),
        sectionId: `verification.${profile.ref.slice("verification-profile:".length)}`,
        body: verificationBody(profile, selectionInputs.get(profile.ref), assessment),
        mode: 0o644,
        markerStyle: "hash",
      }),
    );
    if (profiles.length > 0) {
      intents.push(
        Object.freeze({
          kind: "managed-section" as const,
          owner: "verification-profiles:entrypoints",
          path: relativePosixPath("Makefile"),
          sectionId: "verification.entrypoints",
          body: verificationEntrypoints(profiles),
          mode: 0o644,
          markerStyle: "hash",
          ...(makeCollisions.edits.length === 0
            ? {}
            : { containerEdits: makeCollisions.edits }),
        }),
      );
    }
    for (const [event, eventGates] of groupGatesByEvent(gates)) {
      intents.push(
        Object.freeze({
          kind: "file",
          owner: `git-gates:${event}`,
          scopeRoot: relativePosixPath(".ai-harness/hooks"),
          path: relativePosixPath(`.ai-harness/hooks/${event}`),
          bytes: new ReadonlyBytes(
            Buffer.from(hookBody(eventGates, selectionInputs), "utf8"),
          ),
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
          value: ".ai-harness/hooks",
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
      const sources = intentSources(intent, profiles, gates);
      return Object.freeze({
        kind: "artifact",
        ownershipId:
          intent.kind === "managed-section"
            ? `project.${intent.sectionId}`
            : `project.git-gate.${intent.path.slice(".ai-harness/hooks/".length)}`,
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

function verificationBody(
  profile: CatalogVerificationProfileComponent,
  values: Readonly<Record<string, readonly string[]>> | undefined,
  assessment: RepositoryAssessmentResult,
): string {
  const variables = profile.inputs.flatMap((input) => {
    if (input.makeVariable === null) return [];
    const selected =
      values?.[input.id] ??
      (input.source === "project-units"
        ? matchingProjectRoots(profile, assessment)
        : input.default);
    return [`${input.makeVariable} := ${selected.join(" ")}`];
  });
  return [...variables, ...(variables.length === 0 ? [] : [""]), profile.make.body].join("\n");
}

function matchingProjectRoots(
  profile: CatalogVerificationProfileComponent,
  assessment: RepositoryAssessmentResult,
): readonly string[] {
  const languages = new Set(profile.applies?.languages ?? []);
  const roots = assessment.projectUnits
    .filter((unit) => languages.size === 0 || unit.languages.some((language) => languages.has(language)))
    .map((unit) => unit.root)
    .sort(compareUtf8);
  return roots.length > 0 ? roots : ["."];
}

function verificationEntrypoints(
  profiles: readonly CatalogVerificationProfileComponent[],
): string {
  const operations = new Map<string, string[]>();
  for (const profile of profiles) {
    for (const [operation, target] of Object.entries(profile.make.operations)) {
      const targets = operations.get(operation) ?? [];
      targets.push(target);
      operations.set(operation, targets);
    }
  }
  const names = [...operations.keys()].sort(compareUtf8);
  return [
    `.PHONY: ${names.join(" ")}`,
    "",
    ...names.flatMap((name, index) => [
      `${name}: ${[...new Set(operations.get(name) ?? [])].sort(compareUtf8).join(" ")}`,
      ...(index === names.length - 1 ? [] : [""]),
    ]),
  ].join("\n");
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
  profiles: readonly CatalogVerificationProfileComponent[],
  gates: readonly CatalogGitGateComponent[],
): readonly ComponentRef[] {
  if (intent.kind === "managed-section") {
    if (intent.sectionId === "verification.entrypoints") {
      return profiles.map((profile) => profile.ref);
    }
    const source = profiles.find((profile) => profile.ref === intent.owner);
    if (source !== undefined) return [source.ref];
  }
  if (intent.kind === "file") {
    const event = intent.path.slice(".ai-harness/hooks/".length);
    const sources = gates.filter((gate) => gate.event === event).map((gate) => gate.ref);
    if (sources.length > 0) return sources;
  }
  throw new TypeError(`Projection intent has no component source: ${intent.owner}`);
}

interface MakeCollisionAssessment {
  readonly diagnostics: readonly Diagnostic[];
  readonly edits: readonly ExactTextEdit[];
}

async function assessMakeCollisions(
  snapshot: RepositorySnapshot,
  profiles: readonly CatalogVerificationProfileComponent[],
  replace: boolean,
): Promise<MakeCollisionAssessment> {
  const entry = snapshot.entries.find((candidate) => candidate.path === "Makefile");
  if (entry === undefined) {
    return Object.freeze({ diagnostics: Object.freeze([]), edits: Object.freeze([]) });
  }
  if (entry.kind !== "file") {
    return Object.freeze({
      diagnostics: Object.freeze([collisionPathDiagnostic(entry.kind, profiles)]),
      edits: Object.freeze([]),
    });
  }
  const source = (await snapshot.read(relativePosixPath("Makefile"), maximumMakefileBytes)).bytes.toString();
  let unmanaged = source;
  for (const profile of profiles) {
    const id = `verification.${profile.ref.slice("verification-profile:".length)}`;
    unmanaged = maskManagedSection(unmanaged, id);
  }
  unmanaged = maskManagedSection(unmanaged, "verification.entrypoints");
  const targets = profiles
    .flatMap((profile) => [
      ...profile.make.targets,
      ...Object.keys(profile.make.operations),
    ])
    .sort(compareUtf8);
  const collisions = inspectMakeTargets(unmanaged, targets);
  if (collisions.length === 0) {
    return Object.freeze({ diagnostics: Object.freeze([]), edits: Object.freeze([]) });
  }
  const replaceable = collisions.every((collision) => collision.replaceable);
  if (!replace || !replaceable) {
    return Object.freeze({
      diagnostics: Object.freeze([
        collisionDiagnostic(collisions, profiles, !replaceable),
      ]),
      edits: Object.freeze([]),
    });
  }
  return Object.freeze({
    diagnostics: Object.freeze([]),
    edits: Object.freeze(
      collisions.map((collision) => Object.freeze({
        start: collision.start,
        end: collision.end,
        expected: source.slice(collision.start, collision.end),
        replacement: "",
      })),
    ),
  });
}

function maskManagedSection(source: string, sectionId: string): string {
  const start = `# ai-harness:managed:start id="${sectionId}"`;
  const end = `# ai-harness:managed:end id="${sectionId}"`;
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end);
  if (startIndex < 0 || endIndex < startIndex) {
    return source;
  }
  const masked = source
    .slice(startIndex, endIndex + end.length)
    .replace(/[^\r\n]/gu, " ");
  return `${source.slice(0, startIndex)}${masked}${source.slice(endIndex + end.length)}`;
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

function hookBody(
  gates: readonly CatalogGitGateComponent[],
  selectionInputs: ProjectSelectionInputs,
): string {
  const commands = gates.flatMap((gate) => {
    const scopesInput = gate.inputs.find((input) => input.id === "scopes");
    const scopes = selectionInputs.get(gate.ref)?.scopes ?? scopesInput?.default ?? ["*"];
    return scopes.includes("*")
      ? [`make ${gate.operation}`]
      : scopes.map((scope) => `make ${gate.operation} SCOPE=${shellSingleQuote(scope)}`);
  });
  return [
    "#!/bin/sh",
    "set -eu",
    'repository_root="$(git rev-parse --show-toplevel)"',
    'cd "$repository_root"',
    ...commands,
    "",
  ].join("\n");
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
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

function collisionDiagnostic(
  declarations: readonly MakeTargetDeclaration[],
  profiles: readonly CatalogVerificationProfileComponent[],
  unsupportedReplacement: boolean,
): Diagnostic {
  const summary = declarations
    .map((declaration) => `"${declaration.target}" at line ${declaration.line}`)
    .join(", ");
  return Object.freeze({
    code: "quality.make.target-collision",
    severity: "blocked",
    phase: "planning",
    subjects: Object.freeze(profiles.map((profile) => profile.ref).sort(compareUtf8)),
    location: Object.freeze({
      path: relativePosixPath("Makefile"),
      pointer: `line:${declarations[0]!.line}`,
    }),
    message: `Makefile defines unmanaged canonical target${declarations.length === 1 ? "" : "s"} ${summary}.`,
    evidence: Object.freeze(
      declarations.map(
        (declaration) =>
          `target "${declaration.target}" at line ${declaration.line}: ${declaration.declaration}`,
      ),
    ),
    impact: "AI Harness cannot own the canonical verification entrypoint while these rules remain.",
    action: unsupportedReplacement
      ? "Rename the unsupported Make declaration before planning again."
      : "Choose explicit replacement to remove these rules, or rename them before planning again.",
    ...(unsupportedReplacement
      ? {}
      : {
          resolutions: Object.freeze([
            Object.freeze({
              action: "replace" as const,
              label: "Replace conflicting Make targets",
              destructive: true,
            }),
          ]),
        }),
  });
}

function collisionPathDiagnostic(
  kind: string,
  profiles: readonly CatalogVerificationProfileComponent[],
): Diagnostic {
  return Object.freeze({
    code: "quality.make.target-collision",
    severity: "blocked",
    phase: "planning",
    subjects: Object.freeze(profiles.map((profile) => profile.ref).sort(compareUtf8)),
    location: Object.freeze({ path: relativePosixPath("Makefile") }),
    message: `Makefile is a ${kind}, not a writable regular file.`,
    evidence: Object.freeze([`Makefile:${kind}`]),
    impact: "AI Harness cannot define canonical verification entrypoints at this path.",
    action: "Replace Makefile with a regular file before planning again.",
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
    impact: "AI Harness cannot prove that activating a new hook root preserves local automation.",
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

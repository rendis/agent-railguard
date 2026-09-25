import {
  getJsonMember,
  jsonMemberDigest,
  parseJsonContainer,
} from "../managed-json/managed-json.js";
import {
  inspectManagedSection,
} from "../managed-section/managed-section.js";
import type {
  ManagedArtifactOwnership,
  ManagedDirectoryOwnership,
  ManagedGitConfigOwnership,
  PortableOwnershipState,
} from "../ownership/model.js";
import type { GitConfigPort } from "../planning/model.js";
import type { RepositoryEntry, RepositorySnapshot } from "../repository/model.js";
import {
  compareDiagnostics,
  compareUtf8,
  sha256,
  type ComponentRef,
  type Diagnostic,
  type RelativePosixPath,
  type Sha256Digest,
} from "../shared/types.js";
import type {
  ObservedManagedUnit,
  ObservedProjectState,
  ProjectObserver,
} from "./model.js";

const maximumManagedContainerBytes = 4 * 1024 * 1024;

export class DefaultProjectObserver implements ProjectObserver {
  public constructor(private readonly gitConfig: GitConfigPort) {}

  public async observe(
    snapshot: RepositorySnapshot,
    lock: PortableOwnershipState,
  ): Promise<ObservedProjectState> {
    const entries = new Map(snapshot.entries.map((entry) => [entry.path, entry]));
    const diagnostics: Diagnostic[] = [];
    const units: ObservedManagedUnit[] = [];

    for (const directory of lock.directories) {
      units.push(observeDirectory(directory, entries.get(directory.path), diagnostics));
    }
    for (const artifact of lock.artifacts) {
      const observed = artifact.kind === "file"
        ? observeFile(artifact, entries.get(artifact.path), diagnostics)
        : artifact.kind === "symlink"
          ? observeSymlink(artifact, entries.get(artifact.path), diagnostics)
          : artifact.kind === "json-member"
            ? await observeJsonMember(snapshot, artifact, entries.get(artifact.path), diagnostics)
            : await observeSection(snapshot, artifact, entries.get(artifact.path), diagnostics);
      units.push(observed);
    }
    for (const effect of lock.local_effects) {
      units.push(await this.#observeGitConfig(snapshot.realRoot, effect, diagnostics));
    }

    units.sort((left, right) => compareUtf8(left.ownershipId, right.ownershipId));
    diagnostics.sort(compareDiagnostics);
    return Object.freeze({
      snapshotFingerprint: snapshot.fingerprint,
      units: Object.freeze(units),
      diagnostics: Object.freeze(diagnostics),
    });
  }

  async #observeGitConfig(
    rootRealPath: string,
    effect: ManagedGitConfigOwnership,
    diagnostics: Diagnostic[],
  ): Promise<ObservedManagedUnit> {
    const expectedDigest = sha256(effect.expected_value);
    try {
      const current = await this.gitConfig.get(rootRealPath, effect.key);
      if (current.kind === "absent") {
        return unit(effect.effect_id, "git-config", "missing", expectedDigest, null);
      }
      const observedDigest = sha256(current.value);
      return unit(
        effect.effect_id,
        "git-config",
        current.value === effect.expected_value ? "clean" : "drifted",
        expectedDigest,
        observedDigest,
      );
    } catch (error) {
      diagnostics.push(
        observationDiagnostic({
          code: "observation.git-config.unavailable",
          path: null,
          subjects: effect.sources,
          evidence: [errorMessage(error)],
          message: `Git config ${effect.key} could not be observed.`,
          impact: "Railguard cannot classify the local effect as installed or missing.",
          action: "Restore repository-local Git config access and run status again.",
        }),
      );
      return unit(effect.effect_id, "git-config", "unknown", expectedDigest, null);
    }
  }
}

function observeSymlink(
  artifact: Extract<ManagedArtifactOwnership, { readonly kind: "symlink" }>,
  entry: RepositoryEntry | undefined,
  diagnostics: Diagnostic[],
): ObservedManagedUnit {
  if (entry === undefined) return unit(artifact.ownership_id, "symlink", "missing", artifact.content_digest, null);
  if (entry.kind !== "symlink" || entry.escapesRoot || entry.resolvedPath === null) {
    diagnostics.push(unsafeEntryDiagnostic(artifact, entry));
    return unit(artifact.ownership_id, "symlink", "unknown", artifact.content_digest, null);
  }
  const observedDigest = sha256(entry.target);
  return unit(
    artifact.ownership_id,
    "symlink",
    entry.target === artifact.link_target ? "clean" : "drifted",
    artifact.content_digest,
    observedDigest,
  );
}

function observeDirectory(
  directory: ManagedDirectoryOwnership,
  entry: RepositoryEntry | undefined,
  diagnostics: Diagnostic[],
): ObservedManagedUnit {
  const expectedDigest = sha256("directory");
  if (entry === undefined) {
    return unit(directory.ownership_id, "directory", "missing", expectedDigest, null);
  }
  if (entry.kind !== "directory") {
    diagnostics.push(
      observationDiagnostic({
        code: "observation.directory.unsafe",
        path: directory.path,
        subjects: directory.sources,
        evidence: [entry.kind],
        message: "A managed directory path has an unsafe filesystem type.",
        impact: "Railguard cannot prove its directory ownership safely.",
        action: "Restore the project-local directory and run status again.",
      }),
    );
    return unit(directory.ownership_id, "directory", "unknown", expectedDigest, null);
  }
  return unit(directory.ownership_id, "directory", "clean", expectedDigest, expectedDigest);
}

function observeFile(
  artifact: Extract<ManagedArtifactOwnership, { readonly kind: "file" }>,
  entry: RepositoryEntry | undefined,
  diagnostics: Diagnostic[],
): ObservedManagedUnit {
  if (entry === undefined) {
    return unit(artifact.ownership_id, "file", "missing", artifact.content_digest, null);
  }
  if (entry.kind !== "file") {
    diagnostics.push(unsafeEntryDiagnostic(artifact, entry));
    return unit(artifact.ownership_id, "file", "unknown", artifact.content_digest, null);
  }
  const executable = (entry.mode & 0o111) !== 0;
  const expectedExecutable = artifact.portable_mode === "executable";
  return unit(
    artifact.ownership_id,
    "file",
    entry.digest === artifact.content_digest && executable === expectedExecutable
      ? "clean"
      : "drifted",
    artifact.content_digest,
    entry.digest,
  );
}

async function observeSection(
  snapshot: RepositorySnapshot,
  artifact: Extract<ManagedArtifactOwnership, { readonly kind: "managed-section" }>,
  entry: RepositoryEntry | undefined,
  diagnostics: Diagnostic[],
): Promise<ObservedManagedUnit> {
  if (entry === undefined) {
    return unit(
      artifact.ownership_id,
      "managed-section",
      "missing",
      artifact.content_digest,
      null,
    );
  }
  if (entry.kind !== "file") {
    diagnostics.push(unsafeEntryDiagnostic(artifact, entry));
    return unit(
      artifact.ownership_id,
      "managed-section",
      "unknown",
      artifact.content_digest,
      null,
    );
  }

  let source: string;
  try {
    const read = await snapshot.read(artifact.path, maximumManagedContainerBytes);
    source = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes.copy());
  } catch (error) {
    diagnostics.push(
      observationDiagnostic({
        code: "observation.managed-section.unreadable",
        path: artifact.path,
        subjects: artifact.sources,
        evidence: [errorMessage(error)],
        message: "The managed section container could not be read as bounded UTF-8.",
        impact: "Railguard cannot identify its owned envelope safely.",
        action: "Restore a regular UTF-8 container below the size limit and run status again.",
      }),
    );
    return unit(
      artifact.ownership_id,
      "managed-section",
      "unknown",
      artifact.content_digest,
      null,
    );
  }

  const inspection = inspectManagedSection(
    source,
    artifact.section_id,
    artifact.marker_style,
    artifact.placement,
  );
  if (inspection.kind === "absent") {
    return unit(
      artifact.ownership_id,
      "managed-section",
      "missing",
      artifact.content_digest,
      null,
    );
  }
  if (inspection.kind === "invalid") {
    diagnostics.push(
      observationDiagnostic({
        code: "observation.managed-section.invalid",
        path: artifact.path,
        subjects: artifact.sources,
        evidence: inspection.evidence,
        message: "Managed section markers are duplicate, incomplete, malformed, or nested.",
        impact: "Railguard cannot prove a unique owned envelope.",
        action: "Repair the managed markers before applying another change.",
      }),
    );
    return unit(
      artifact.ownership_id,
      "managed-section",
      "unknown",
      artifact.content_digest,
      null,
    );
  }
  return unit(
    artifact.ownership_id,
    "managed-section",
    inspection.digest === artifact.content_digest ? "clean" : "drifted",
    artifact.content_digest,
    inspection.digest,
  );
}

async function observeJsonMember(
  snapshot: RepositorySnapshot,
  artifact: Extract<ManagedArtifactOwnership, { readonly kind: "json-member" }>,
  entry: RepositoryEntry | undefined,
  diagnostics: Diagnostic[],
): Promise<ObservedManagedUnit> {
  const observed = (status: ObservedManagedUnit["status"], digest: Sha256Digest | null) =>
    unit(artifact.ownership_id, "json-member", status, artifact.content_digest, digest);
  if (entry === undefined) return observed("missing", null);
  if (entry.kind !== "file") {
    diagnostics.push(unsafeEntryDiagnostic(artifact, entry));
    return observed("unknown", null);
  }
  let source: string;
  try {
    const read = await snapshot.read(artifact.path, maximumManagedContainerBytes);
    source = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes.copy());
  } catch (error) {
    diagnostics.push(jsonUnreadableDiagnostic(artifact, [errorMessage(error)]));
    return observed("unknown", null);
  }
  const parsed = parseJsonContainer(source);
  if (parsed.kind === "invalid") {
    diagnostics.push(jsonUnreadableDiagnostic(artifact, parsed.evidence));
    return observed("unknown", null);
  }
  const value = getJsonMember(parsed.value, artifact.pointer);
  if (value === undefined) return observed("missing", null);
  const digest = jsonMemberDigest(artifact.pointer, value);
  return observed(digest === artifact.content_digest ? "clean" : "drifted", digest);
}

function jsonUnreadableDiagnostic(
  artifact: Extract<ManagedArtifactOwnership, { readonly kind: "json-member" }>,
  evidence: readonly string[],
): Diagnostic {
  return observationDiagnostic({
    code: "observation.json-member.unreadable",
    path: artifact.path,
    subjects: artifact.sources,
    evidence,
    message: `${artifact.path} is not a readable JSON object.`,
    impact: `Railguard cannot observe its ${artifact.pointer.join(".")} entry.`,
    action: "Fix the JSON file and run status again.",
  });
}

function unit(
  ownershipId: string,
  kind: ObservedManagedUnit["kind"],
  status: ObservedManagedUnit["status"],
  expectedDigest: Sha256Digest,
  observedDigest: Sha256Digest | null,
): ObservedManagedUnit {
  return Object.freeze({ ownershipId, kind, status, expectedDigest, observedDigest });
}

function unsafeEntryDiagnostic(
  artifact: ManagedArtifactOwnership,
  entry: RepositoryEntry,
): Diagnostic {
  return observationDiagnostic({
    code: "observation.path.unsafe",
    path: artifact.path,
    subjects: artifact.sources,
    evidence: [entry.kind],
    message: "A locked artifact path has an unexpected filesystem type.",
    impact: "Railguard cannot observe the managed unit safely.",
    action: "Restore the expected project-local artifact and run status again.",
  });
}

function observationDiagnostic(input: {
  readonly code: string;
  readonly path: RelativePosixPath | null;
  readonly subjects: readonly ComponentRef[];
  readonly evidence: readonly string[];
  readonly message: string;
  readonly impact: string;
  readonly action: string;
}): Diagnostic {
  return Object.freeze({
    code: input.code,
    severity: "blocked",
    phase: "observation",
    subjects: Object.freeze([...input.subjects]),
    location: input.path === null ? null : Object.freeze({ path: input.path }),
    message: input.message,
    evidence: Object.freeze([...input.evidence].sort(compareUtf8)),
    impact: input.impact,
    action: input.action,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { describe, expect, it } from "vitest";
import type { CatalogSnapshot } from "../../src/domain/catalog/model.js";
import type { ObservedProjectState } from "../../src/domain/observation/model.js";
import type { RepositoryAssessmentResult } from "../../src/domain/repository/model.js";
import type { ReadyResolution } from "../../src/domain/resolution/model.js";
import {
  ReadonlyBytes,
  capabilityId,
  componentRef,
  harnessTargetId,
  relativePosixPath,
  semVer,
  sha256,
} from "../../src/domain/shared/types.js";
import { DefaultReconciler } from "../../src/domain/reconciliation/reconciler.js";
import type { DesiredState } from "../../src/project-state/desired-state.js";
import type { LockState } from "../../src/project-state/lock-state.js";

const ref = componentRef("skill:tdd");
const target = harnessTargetId("codex");
const adapter = harnessTargetId("codex");
const path = relativePosixPath(".agents/skills/tdd/SKILL.md");
const fingerprint = sha256("repository");
const desiredDigest = sha256("desired");
const contentDigest = sha256("skill content");

describe("DefaultReconciler", () => {
  it("classifies a repository without durable state as uninitialized", () => {
    const result = reconcile({ desired: null, lock: null, observed: null, resolution: null });

    expect(result).toMatchObject({
      management: "uninitialized",
      integrity: "unknown",
      updates: { kind: "unknown", components: [] },
      readiness: "ready",
      units: [],
    });
  });

  it("classifies matching desired, lock and observed evidence as managed and clean", () => {
    const result = reconcile({
      desired: { state: desired(), digest: desiredDigest },
      lock: { state: lock(), digest: sha256("lock") },
      observed: observed("clean", contentDigest),
      resolution: resolution(),
    });

    expect(result).toMatchObject({
      management: "managed",
      integrity: "clean",
      updates: { kind: "none", components: [] },
      readiness: "ready",
      units: [{ ownershipId: "codex.skill.tdd", classification: "clean" }],
      pendingComponents: [],
      orphanedComponents: [],
      orphanedUnits: [],
    });
  });

  it("does not treat the internal project projection as a selected harness target", () => {
    const portableLock = lock();
    const lockWithProjectProjection: LockState = Object.freeze({
      ...portableLock,
      targets: Object.freeze([
        ...portableLock.targets,
        Object.freeze({
          id: harnessTargetId("project"),
          adapter: Object.freeze({ id: harnessTargetId("quality"), version: semVer("0.1.0") }),
          capabilities: Object.freeze([]),
        }),
      ]),
    });

    const result = reconcile({
      desired: { state: desired(), digest: desiredDigest },
      lock: { state: lockWithProjectProjection, digest: sha256("lock") },
      observed: observed("clean", contentDigest),
      resolution: resolution(),
    });

    expect(result.management).toBe("managed");
  });

  it("surfaces manual deletion and drift without pretending the repository is uninitialized", () => {
    const missing = reconcile({
      desired: { state: desired(), digest: desiredDigest },
      lock: { state: lock(), digest: sha256("lock") },
      observed: observed("missing", null),
      resolution: resolution(),
    });
    const drifted = reconcile({
      desired: { state: desired(), digest: desiredDigest },
      lock: { state: lock(), digest: sha256("lock") },
      observed: observed("drifted", sha256("edited")),
      resolution: resolution(),
    });

    expect(missing).toMatchObject({
      management: "managed",
      integrity: "drifted",
      units: [{ classification: "missing" }],
    });
    expect(drifted).toMatchObject({
      management: "managed",
      integrity: "drifted",
      units: [{ classification: "drifted" }],
    });
  });

  it("identifies component updates and units left by a removed selection", () => {
    const newerCatalog = catalog("0.2.0", sha256("new component"));
    const removedResolution = Object.freeze({ ...resolution(), components: Object.freeze([]) });
    const result = new DefaultReconciler().reconcile({
      desired: { state: Object.freeze({ ...desired(), selections: Object.freeze([]) }), digest: sha256("removed") },
      lock: { state: lock(), digest: sha256("lock") },
      observed: observed("clean", contentDigest),
      catalog: newerCatalog,
      assessment: assessment(),
      resolution: removedResolution,
    });

    expect(result.updates).toEqual({ kind: "components", components: [ref] });
    expect(result.orphanedComponents).toEqual([ref]);
    expect(result.orphanedUnits).toEqual(["codex.skill.tdd"]);
    expect(result.units[0]).toMatchObject({ classification: "removal-pending" });
  });
});

function reconcile(overrides: {
  readonly desired: { readonly state: DesiredState; readonly digest: ReturnType<typeof sha256> } | null;
  readonly lock: { readonly state: LockState; readonly digest: ReturnType<typeof sha256> } | null;
  readonly observed: ObservedProjectState | null;
  readonly resolution: ReadyResolution | null;
}) {
  return new DefaultReconciler().reconcile({
    ...overrides,
    catalog: catalog(),
    assessment: assessment(),
  });
}

function catalog(version = "0.1.0", digest = contentDigest): CatalogSnapshot {
  return Object.freeze({
    revision: semVer(version),
    digest: sha256(`catalog:${version}`),
    components: Object.freeze([
      Object.freeze({
        kind: "skill" as const,
        ref,
        version: semVer(version),
        description: "TDD",
        details: "Detailed TDD workflow guidance for this reconciliation test fixture.",
        capabilities: Object.freeze([capabilityId("project.skills")]),
        applies: null,
        relations: Object.freeze([]),
        trust: "passive" as const,
        payload: Object.freeze({
          entry: relativePosixPath("SKILL.md"),
          files: Object.freeze([
            Object.freeze({
              path: relativePosixPath("SKILL.md"),
              mode: "100644" as const,
              digest,
              bytes: new ReadonlyBytes(Buffer.from("skill content")),
            }),
          ]),
        }),
        integrity: Object.freeze({ definition: digest, payload: digest, component: digest }),
      }),
    ]),
  });
}

function desired(): DesiredState {
  return Object.freeze({
    schema: "ai-harness/project/v1",
    targets: Object.freeze([target]),
    selections: Object.freeze([Object.freeze({ ref, inputs: Object.freeze({}) })]),
  });
}

function lock(): LockState {
  return Object.freeze({
    schema: "ai-harness/lock/v1",
    desired_digest: desiredDigest,
    catalog: Object.freeze({ revision: semVer("0.1.0"), digest: sha256("catalog:0.1.0") }),
    targets: Object.freeze([
      Object.freeze({
        id: target,
        adapter: Object.freeze({ id: adapter, version: semVer("0.1.0") }),
        capabilities: Object.freeze([capabilityId("project.skills")]),
      }),
    ]),
    components: Object.freeze([
      Object.freeze({
        ref,
        version: semVer("0.1.0"),
        digest: contentDigest,
        direct: true,
        causes: Object.freeze([]),
      }),
    ]),
    directories: Object.freeze([]),
    artifacts: Object.freeze([
      Object.freeze({
        kind: "file" as const,
        ownership_id: "codex.skill.tdd",
        target,
        adapter,
        path,
        sources: Object.freeze([ref]),
        content_digest: contentDigest,
        portable_mode: "regular" as const,
      }),
    ]),
    local_effects: Object.freeze([]),
  });
}

function observed(
  status: "clean" | "missing" | "drifted",
  observedDigest: ReturnType<typeof sha256> | null,
): ObservedProjectState {
  return Object.freeze({
    snapshotFingerprint: fingerprint,
    units: Object.freeze([
      Object.freeze({
        ownershipId: "codex.skill.tdd",
        kind: "file" as const,
        status,
        expectedDigest: contentDigest,
        observedDigest,
      }),
    ]),
    diagnostics: Object.freeze([]),
  });
}

function resolution(): ReadyResolution {
  return Object.freeze({
    kind: "ready",
    catalogDigest: sha256("catalog:0.1.0"),
    components: Object.freeze([
      Object.freeze({
        ref,
        version: semVer("0.1.0"),
        componentDigest: contentDigest,
        direct: true,
        includedBy: Object.freeze([]),
        applicability: Object.freeze({ kind: "portable" as const }),
      }),
    ]),
    recommendations: Object.freeze([]),
    associations: Object.freeze([]),
    diagnostics: Object.freeze([]),
    blockers: Object.freeze([]) as readonly [],
    readyBrand: Symbol("test"),
  });
}

function assessment(): RepositoryAssessmentResult {
  return Object.freeze({
    snapshotFingerprint: fingerprint,
    projectUnits: Object.freeze([]),
    diagnostics: Object.freeze([]),
  });
}

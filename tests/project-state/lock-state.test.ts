import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FilesystemCatalog } from "../../src/catalog/filesystem-catalog.js";
import type { CatalogSnapshot } from "../../src/domain/catalog/model.js";
import type { ReadyResolution } from "../../src/domain/resolution/model.js";
import type { ManagedProjection } from "../../src/domain/projection/model.js";
import {
  ReadonlyBytes,
  capabilityId,
  componentRef,
  harnessTargetId,
  languageId,
  relativePosixPath,
  semVer,
  sha256,
} from "../../src/domain/shared/types.js";
import { LockStateModule } from "../../src/project-state/lock-state.js";

describe("LockStateModule", () => {
  it("builds identical portable bytes from equivalent unordered projections", async () => {
    const catalog = await readyCatalog();
    const resolution = readyResolution(catalog);
    const desiredDigest = sha256("desired");
    const profileDigest = sha256("make-section");
    const hookDigest = sha256("pre-commit-hook");
    const module = new LockStateModule();
    const targets = [
      {
        id: harnessTargetId("codex"),
        adapter: { id: harnessTargetId("codex"), version: semVer("0.1.0") },
        capabilities: [capabilityId("project.skills")],
      },
      {
        id: harnessTargetId("project"),
        adapter: { id: harnessTargetId("quality"), version: semVer("0.1.0") },
        capabilities: [],
      },
    ];
    const artifacts = [
      {
        kind: "file" as const,
        ownershipId: "git-gate.pre-commit",
        target: harnessTargetId("project"),
        adapter: harnessTargetId("quality"),
        path: relativePosixPath(".railguard/hooks/pre-commit"),
        sources: [componentRef("git-gate:pre-commit-check")],
        contentDigest: hookDigest,
        portableMode: "executable" as const,
      },
      {
        kind: "managed-section" as const,
        ownershipId: "verification.go-quality",
        target: harnessTargetId("project"),
        adapter: harnessTargetId("quality"),
        path: relativePosixPath("Makefile"),
        sectionId: "verification.go-quality",
        placement: "append" as const,
        markerStyle: "hash" as const,
        sources: [componentRef("verification-profile:go-quality")],
        contentDigest: profileDigest,
      },
    ];
    const localEffects = [
      {
        kind: "git-config" as const,
        effectId: "git-gates.activation",
        sources: [componentRef("git-gate:pre-commit-check")],
        key: "core.hooksPath" as const,
        expectedValue: ".railguard/hooks",
      },
    ];

    const first = module.build({
      desiredDigest,
      catalog,
      resolution,
      targets,
      artifacts,
      localEffects,
    });
    const second = module.build({
      desiredDigest,
      catalog,
      resolution: {
        ...resolution,
        components: [...resolution.components].reverse(),
      },
      targets,
      artifacts: [...artifacts].reverse(),
      localEffects,
    });

    expect(first.kind).toBe("ready");
    expect(second.kind).toBe("ready");
    if (first.kind !== "ready" || second.kind !== "ready") return;
    expect(first.bytes.toString()).toBe(second.bytes.toString());
    expect(first.digest).toBe(second.digest);
    expect(first.state.desired_digest).toBe(desiredDigest);
    expect(first.state.components.map((component) => component.ref)).toEqual([
      "git-gate:pre-commit-check",
      "verification-profile:go-quality",
    ]);
    expect(first.bytes.toString()).not.toContain("preimage");
    expect(first.bytes.toString()).not.toContain("/Users/");

    const decoded = module.decode(first.bytes.toString(), { desiredDigest, catalog });
    expect(decoded).toEqual(first);
  });

  it("fails closed when resolution identity or managed-unit provenance is inconsistent", async () => {
    const catalog = await readyCatalog();
    const resolution = readyResolution(catalog);
    const result = new LockStateModule().build({
      desiredDigest: sha256("desired"),
      catalog,
      resolution: { ...resolution, catalogDigest: sha256("different-catalog") },
      targets: [
        {
          id: harnessTargetId("project"),
          adapter: { id: harnessTargetId("quality"), version: semVer("0.1.0") },
          capabilities: [],
        },
      ],
      artifacts: [
        {
          kind: "file",
          ownershipId: "invalid.source",
          target: harnessTargetId("project"),
          adapter: harnessTargetId("quality"),
          path: relativePosixPath("generated.txt"),
          sources: [componentRef("skill:tdd")],
          contentDigest: sha256("generated"),
          portableMode: "regular",
        },
      ],
      localEffects: [],
    });

    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
        "lock.catalog-mismatch",
        "lock.source-invalid",
      ]);
    }
  });

  it("rejects two local effects that govern the same Git key", async () => {
    const catalog = await readyCatalog();
    const result = new LockStateModule().build({
      desiredDigest: sha256("desired"),
      catalog,
      resolution: readyResolution(catalog),
      targets: [],
      artifacts: [],
      localEffects: [
        {
          kind: "git-config",
          effectId: "git-gates.activation-a",
          sources: [componentRef("git-gate:pre-commit-check")],
          key: "core.hooksPath",
          expectedValue: ".railguard/hooks",
        },
        {
          kind: "git-config",
          effectId: "git-gates.activation-b",
          sources: [componentRef("git-gate:pre-commit-check")],
          key: "core.hooksPath",
          expectedValue: ".other-hooks",
        },
      ],
    });

    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        "lock.effect-key-duplicate",
      );
    }
  });

  it("rejects a canonical lock whose resolved component identity was altered", async () => {
    const catalog = await readyCatalog();
    const module = new LockStateModule();
    const built = module.build({
      desiredDigest: sha256("desired"),
      catalog,
      resolution: readyResolution(catalog),
      targets: [],
      artifacts: [],
      localEffects: [],
    });
    expect(built.kind).toBe("ready");
    if (built.kind !== "ready") return;

    const original = built.state.components[0]!.digest;
    const tampered = built.bytes.toString().replace(original, sha256("tampered-component"));
    const decoded = module.decode(tampered, {
      desiredDigest: sha256("desired"),
      catalog,
    });

    expect(decoded.kind).toBe("invalid");
    if (decoded.kind === "invalid") {
      expect(decoded.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
        "lock.component-catalog-mismatch",
      ]);
    }
  });

  it("decodes an older lock so reconciliation can report desired and catalog updates", async () => {
    const catalog = await readyCatalog();
    const module = new LockStateModule();
    const built = module.build({
      desiredDigest: sha256("old-desired"),
      catalog,
      resolution: readyResolution(catalog),
      targets: [],
      artifacts: [],
      localEffects: [],
    });
    expect(built.kind).toBe("ready");
    if (built.kind !== "ready") return;
    const newerCatalog = Object.freeze({
      ...catalog,
      revision: semVer("0.2.0"),
      digest: sha256("newer-catalog"),
    });

    const decoded = module.decode(built.bytes.toString(), {
      desiredDigest: sha256("new-desired"),
      catalog: newerCatalog,
    });

    expect(decoded.kind).toBe("ready");
    if (decoded.kind === "ready") expect(decoded.state).toEqual(built.state);
  });

  it("derives portable ownership directly from managed projections", async () => {
    const catalog = await readyCatalog();
    const resolution = readyResolution(catalog);
    const profile = componentRef("verification-profile:go-quality");
    const gate = componentRef("git-gate:pre-commit-check");
    const projection: ManagedProjection = Object.freeze({
      identity: Object.freeze({
        target: harnessTargetId("project"),
        adapter: Object.freeze({ id: harnessTargetId("quality"), version: semVer("0.1.0") }),
        capabilities: Object.freeze([]),
      }),
      units: Object.freeze([
        Object.freeze({
          kind: "artifact" as const,
          ownershipId: "project.verification.go-quality",
          sources: Object.freeze([profile]),
          intent: Object.freeze({
            kind: "managed-section" as const,
            owner: profile,
            path: relativePosixPath("Makefile"),
            sectionId: "verification.go-quality",
            body: "check:\n\t@true\n",
            mode: 0o644,
            markerStyle: "hash" as const,
          }),
        }),
        Object.freeze({
          kind: "artifact" as const,
          ownershipId: "project.git-gate.pre-commit",
          sources: Object.freeze([gate]),
          intent: Object.freeze({
            kind: "file" as const,
            owner: gate,
            scopeRoot: relativePosixPath(".railguard/hooks"),
            path: relativePosixPath(".railguard/hooks/pre-commit"),
            bytes: new ReadonlyBytes(Buffer.from("#!/bin/sh\nmake check\n")),
            mode: 0o755,
          }),
        }),
        Object.freeze({
          kind: "local-effect" as const,
          ownershipId: "project.git-gates.activation",
          sources: Object.freeze([gate]),
          intent: Object.freeze({
            kind: "git-config" as const,
            owner: "git-gates:activation",
            path: relativePosixPath(".git/config"),
            key: "core.hooksPath" as const,
            value: ".railguard/hooks",
          }),
        }),
      ]),
    });

    const result = new LockStateModule().buildFromProjections({
      desiredDigest: sha256("desired"),
      catalog,
      resolution,
      projections: [projection],
      managedSectionPlacements: new Map([["project.verification.go-quality", "append"]]),
    });

    expect(result.kind).toBe("ready");
    if (result.kind === "ready") {
      expect(result.state.targets).toHaveLength(1);
      expect(result.state.artifacts).toHaveLength(2);
      expect(result.state.local_effects).toHaveLength(1);
      expect(result.bytes.toString()).not.toContain("#!/bin/sh");
    }
  });
});

async function readyCatalog(): Promise<CatalogSnapshot> {
  const loaded = await new FilesystemCatalog({
    catalogFile: resolve("railguard.yaml"),
    supportedLanguages: [languageId("go")],
  }).load();
  if (loaded.kind !== "ready") throw new Error("Expected catalog to load");
  return loaded.catalog;
}

function readyResolution(catalog: CatalogSnapshot): ReadyResolution {
  const refs = [
    componentRef("verification-profile:go-quality"),
    componentRef("git-gate:pre-commit-check"),
  ];
  const byRef = new Map(catalog.components.map((component) => [component.ref, component]));
  return Object.freeze({
    kind: "ready",
    catalogDigest: catalog.digest,
    components: Object.freeze(
      refs.map((ref) => {
        const component = byRef.get(ref);
        if (component === undefined) throw new Error(`Missing ${ref}`);
        return Object.freeze({
          ref,
          version: component.version,
          componentDigest: component.integrity.component,
          direct: ref === "git-gate:pre-commit-check",
          includedBy:
            ref === "git-gate:pre-commit-check"
              ? Object.freeze([])
              : Object.freeze([
                  {
                    kind: "requires" as const,
                    from: componentRef("git-gate:pre-commit-check"),
                    reason: "The hook requires a project-owned check target.",
                  },
                ]),
          applicability: Object.freeze({ kind: "portable" as const }),
        });
      }),
    ),
    recommendations: Object.freeze([]),
    associations: Object.freeze([]),
    blockers: Object.freeze([]) as readonly [],
    diagnostics: Object.freeze([]),
    readyBrand: Symbol("ready-resolution"),
  });
}

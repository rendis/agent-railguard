import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ScanResult } from "../../src/application/model.js";
import { VerificationService } from "../../src/application/verification-service.js";
import { FilesystemCatalog } from "../../src/catalog/filesystem-catalog.js";
import { componentRef, languageId } from "../../src/domain/shared/types.js";
import type {
  CatalogSnapshot,
  CatalogVerificationProfileComponent,
} from "../../src/domain/catalog/model.js";
import type {
  ChangedLines,
  ChangeSet,
  CheckOutcome,
  CheckProvider,
  CheckRequest,
  FullCheckRequest,
} from "../../src/domain/verification/checks.js";
import { planFullSteps, renderVerifyScript } from "../../src/domain/verification/verify-script.js";

describe("VerificationService", () => {
  it("runs the stage's steps of the verify script in full mode", async () => {
    const provider = recordingProvider(() => passed());
    const { service, steps } = await serviceFor(provider, ["verification-profile:go-quality"]);

    const check = await service.run({ root: "/repo", stage: "check", changed: false });
    const verify = await service.run({ root: "/repo", stage: "verify", changed: false });

    expect(check.results.map((result) => result.check)).toEqual(["format", "vet", "test"]);
    expect(verify.results.map((result) => result.check)).toEqual(["format", "vet", "test", "race"]);
    expect(steps.slice(-4)).toEqual([
      "go-quality/format@.", "go-quality/vet@.", "go-quality/test@.", "go-quality/race@.",
    ]);
    expect(provider.fullRequests.at(-1)?.params).toEqual({ race: true });
    expect(provider.requests).toEqual([]);
    expect(verify).toMatchObject({ mode: "full", verdict: "passed" });
  });

  it("merges selected inputs over catalog defaults", async () => {
    const provider = recordingProvider(() => passed());
    const { service } = await serviceFor(provider, ["verification-profile:go-assurance"], {
      "verification-profile:go-assurance": { core_packages: ["./domain/..."] },
    });

    await service.run({ root: "/repo", stage: "verify", changed: false });

    expect(provider.fullRequests[0]?.inputs).toMatchObject({
      core_packages: ["./domain/..."],
      test_packages: ["./..."],
      tool_modfile: ["go.mod"],
    });
  });

  it("maps step exit codes and ranks failed above unavailable", async () => {
    const exits = (codes: Readonly<Record<string, number>>) => (id: string) => codes[id] ?? 0;
    const unavailable = await (await serviceFor(recordingProvider(() => passed()), ["verification-profile:go-quality"], {}, ["."], undefined, {
      exit: exits({ "go-quality/vet@.": 4 }),
    })).service.run({ root: "/repo", stage: "check", changed: false });
    const failed = await (await serviceFor(recordingProvider(() => passed()), ["verification-profile:go-quality"], {}, ["."], undefined, {
      exit: exits({ "go-quality/vet@.": 4, "go-quality/test@.": 1 }),
    })).service.run({ root: "/repo", stage: "check", changed: false });

    expect(unavailable.verdict).toBe("unavailable");
    expect(failed.verdict).toBe("failed");
    expect(failed.results.map((result) => result.outcome.status)).toEqual(["passed", "unavailable", "failed"]);
    expect(failed.results[2]?.outcome.details).toEqual(["output of go-quality/test@."]);
  });

  it("blocks a full run when the verify script is missing or out of date", async () => {
    for (const content of ["missing", "stale"] as const) {
      const { service, steps } = await serviceFor(recordingProvider(() => passed()), ["verification-profile:go-quality"], {}, ["."], undefined, { content });

      const report = await service.run({ root: "/repo", stage: "check", changed: false });

      expect(report.verdict).toBe("blocked");
      expect(report.diagnostics.map((entry) => entry.code)).toEqual(["verification.script.stale"]);
      expect(steps).toEqual([]);
    }
  });

  it("reports a check that does not judge a whole unit as skipped without a script", async () => {
    const provider: CheckProvider = {
      kinds: ["change-integrity", "change-size"],
      async run() { return passed(); },
      full() { return { kind: "skipped", reason: "Judges a change" }; },
    };
    const { service, steps } = await serviceFor(provider, ["verification-profile:change-guard"], {}, ["."], undefined, { content: "missing" });

    const report = await service.run({ root: "/repo", stage: "verify", changed: false });

    expect(report.results.map((result) => result.outcome)).toEqual([
      { status: "skipped", summary: "Judges a change", details: [] },
      { status: "skipped", summary: "Judges a change", details: [] },
    ]);
    expect(steps).toEqual([]);
  });

  it("judges only the requested kinds on the requested paths of the change", async () => {
    const provider = recordingProvider(() => passed());
    const changes: ChangeSet = {
      base: "a".repeat(40),
      baseRef: "main",
      files: new Map<string, ChangedLines>([["a.go", "all"], ["b.go", new Set([3])]]),
      deleted: ["old_test.go"],
    };
    const { service } = await serviceFor(
      provider,
      ["verification-profile:go-quality", "verification-profile:change-guard", "verification-profile:secret-guard"],
      {},
      ["."],
      changes,
    );

    const report = await service.run({
      root: "/repo", stage: "check", changed: true, paths: ["a.go", "old_test.go"], kinds: ["change-integrity", "secret-exposure"],
    });

    expect(report.results.map((result) => result.kind)).toEqual(["change-integrity", "secret-exposure"]);
    for (const request of provider.requests) {
      expect([...request.changes.files.keys()]).toEqual(["a.go"]);
      expect(request.changes.deleted).toEqual(["old_test.go"]);
      expect(request.paths).toEqual(["a.go", "old_test.go"]);
    }
  });

  it("skips units without changes and hands the change set to providers", async () => {
    const provider = recordingProvider(() => passed());
    const changes: ChangeSet = {
      base: "a".repeat(40),
      baseRef: "main",
      files: new Map([["svc/b/main.go", "all"]]),
      deleted: [],
    };
    const { service } = await serviceFor(provider, ["verification-profile:go-quality"], {}, ["svc/a", "svc/b"], changes);

    const report = await service.run({ root: "/repo", stage: "check", changed: true });

    expect(report).toMatchObject({ mode: "changed", baseRef: "main" });
    expect(report.results.filter((result) => result.unit === "svc/a").every((result) => result.outcome.status === "skipped")).toBe(true);
    expect(provider.requests.every((request) => request.unitRoot === "svc/b" && request.changes === changes)).toBe(true);
  });

  it("runs a profile without languages once for the whole repository", async () => {
    const provider = recordingProvider(() => passed());
    const changes: ChangeSet = { base: "a".repeat(40), baseRef: "main", files: new Map([["svc/b/main.go", "all"]]), deleted: [] };
    const { service } = await serviceFor(
      { ...provider, kinds: ["change-integrity", "change-size"] },
      ["verification-profile:change-guard"],
      {},
      ["svc/a", "svc/b"],
      changes,
    );

    const report = await service.run({ root: "/repo", stage: "verify", changed: true });

    expect(report.results.map((result) => [result.check, result.unit])).toEqual([["integrity", "."], ["size", "."]]);
    expect(provider.requests.map((request) => request.inputs.max_changed_lines)).toEqual([["400"], ["400"]]);
  });

  it("reports a changed-mode check kind without provider as unavailable", async () => {
    const changes: ChangeSet = { base: "a".repeat(40), baseRef: "main", files: new Map([["main.go", "all"]]), deleted: [] };
    const { service } = await serviceFor(
      { kinds: [], async run() { return passed(); }, full() { return { kind: "skipped", reason: "none" }; } },
      ["verification-profile:go-quality"],
      {},
      ["."],
      changes,
    );

    const report = await service.run({ root: "/repo", stage: "check", changed: true });

    expect(report.verdict).toBe("unavailable");
    expect(report.results[0]?.outcome.summary).toContain("no provider for go-format");
  });

  it("blocks an uninitialized repository instead of passing vacuously", async () => {
    const { service } = await serviceFor(recordingProvider(() => passed()), null);

    const report = await service.run({ root: "/repo", stage: "check", changed: false });

    expect(report.verdict).toBe("blocked");
    expect(report.diagnostics.map((entry) => entry.code)).toEqual(["verification.project.uninitialized"]);
  });
});

function passed(): CheckOutcome {
  return { status: "passed", summary: "ok", details: [] };
}

function recordingProvider(
  outcome: (kind: string) => CheckOutcome,
): CheckProvider & { requests: CheckRequest[]; fullRequests: FullCheckRequest[] } {
  const requests: CheckRequest[] = [];
  const fullRequests: FullCheckRequest[] = [];
  return {
    requests,
    fullRequests,
    kinds: [
      "go-format", "go-vet", "go-test", "go-mod-verify", "golangci-lint", "go-coverage", "govulncheck",
      "change-integrity", "change-size", "secret-exposure",
    ],
    async run(kind, request) {
      requests.push(request);
      return outcome(kind);
    },
    full(kind, request) {
      fullRequests.push(request);
      return { kind: "script", body: `echo ${kind}` };
    },
  };
}

interface ScriptFake {
  readonly content?: "current" | "stale" | "missing";
  readonly exit?: (id: string) => number;
}

async function serviceFor(
  provider: CheckProvider,
  selections: readonly string[] | null,
  inputs: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {},
  units: readonly string[] = ["."],
  changes?: ChangeSet,
  script: ScriptFake = {},
): Promise<{ service: VerificationService; steps: string[] }> {
  const catalog = await loadCatalog();
  const projectUnits = units.map((root) => ({ id: root, root, languages: [languageId("go")] }));
  const scan = {
    kind: "ready",
    snapshot: { realRoot: "/repo" },
    catalog,
    assessment: { projectUnits },
    desired: selections === null
      ? null
      : {
          state: {
            selections: selections.map((ref) => ({ ref: componentRef(ref), inputs: inputs[ref] ?? {} })),
          },
        },
    resolution: null,
  } as unknown as ScanResult;
  const profiles = catalog.components.filter(
    (component): component is CatalogVerificationProfileComponent =>
      component.kind === "verification-profile" && (selections ?? []).includes(component.ref),
  );
  const probe = { ...provider, full: (kind: string, request: FullCheckRequest) => provider.full(kind, request) };
  const current = renderVerifyScript(planFullSteps(
    profiles,
    projectUnits as never,
    new Map(Object.entries(inputs).map(([ref, values]) => [componentRef(ref), values])),
    [probe],
  ));
  const steps: string[] = [];
  const service = new VerificationService({
    scan: async () => scan,
    changeSets: {
      async read() {
        if (changes === undefined) throw new Error("no change set in this test");
        return changes;
      },
    },
    providers: [provider],
    script: {
      async read() {
        return script.content === "missing" ? null : script.content === "stale" ? "#!/bin/sh\n" : current;
      },
      async step(_root, id) {
        steps.push(id);
        return { exitCode: script.exit?.(id) ?? 0, stdout: `output of ${id}`, stderr: "", timedOut: false };
      },
    },
  });
  return { service, steps };
}

async function loadCatalog(): Promise<CatalogSnapshot> {
  const result = await new FilesystemCatalog({
    catalogFile: resolve("railguard.yaml"),
    supportedLanguages: [languageId("go")],
  }).load();
  if (result.kind !== "ready") throw new Error(result.diagnostics[0]?.message);
  return result.catalog;
}

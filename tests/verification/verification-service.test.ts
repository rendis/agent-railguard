import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ScanResult } from "../../src/application/model.js";
import { VerificationService } from "../../src/application/verification-service.js";
import { FilesystemCatalog } from "../../src/catalog/filesystem-catalog.js";
import type { CatalogSnapshot } from "../../src/domain/catalog/model.js";
import { componentRef, languageId } from "../../src/domain/shared/types.js";
import type {
  ChangeSet,
  CheckOutcome,
  CheckProvider,
  CheckRequest,
} from "../../src/domain/verification/checks.js";

describe("VerificationService", () => {
  it("runs only check-stage checks for check and both stages for verify", async () => {
    const provider = recordingProvider(() => passed());
    const service = await serviceFor(provider, ["verification-profile:go-quality"]);

    const check = await service.run({ root: "/repo", stage: "check", changed: false });
    const verify = await service.run({ root: "/repo", stage: "verify", changed: false });

    expect(check.results.map((result) => result.check)).toEqual(["format", "vet", "test"]);
    expect(verify.results.map((result) => result.check)).toEqual(["format", "vet", "test", "race"]);
    expect(provider.requests.at(-1)?.params).toEqual({ race: true });
    expect(verify.verdict).toBe("passed");
  });

  it("merges selected inputs over catalog defaults", async () => {
    const provider = recordingProvider(() => passed());
    const service = await serviceFor(provider, ["verification-profile:go-assurance"], {
      "verification-profile:go-assurance": { core_packages: ["./domain/..."] },
    });

    await service.run({ root: "/repo", stage: "verify", changed: false });

    expect(provider.requests[0]?.inputs).toMatchObject({
      core_packages: ["./domain/..."],
      test_packages: ["./..."],
      tool_modfile: ["go.mod"],
    });
  });

  it("skips units without changes and hands the change set to providers", async () => {
    const provider = recordingProvider(() => passed());
    const changes: ChangeSet = {
      base: "a".repeat(40),
      baseRef: "main",
      files: new Map([["svc/b/main.go", "all"]]),
      deleted: [],
    };
    const service = await serviceFor(provider, ["verification-profile:go-quality"], {}, ["svc/a", "svc/b"], changes);

    const report = await service.run({ root: "/repo", stage: "check", changed: true });

    expect(report).toMatchObject({ mode: "changed", baseRef: "main" });
    expect(report.results.filter((result) => result.unit === "svc/a").every((result) => result.outcome.status === "skipped")).toBe(true);
    expect(provider.requests.every((request) => request.unitRoot === "svc/b" && request.changes === changes)).toBe(true);
  });

  it("runs a profile without languages once for the whole repository", async () => {
    const requests: CheckRequest[] = [];
    const provider: CheckProvider = {
      kinds: ["change-integrity", "change-size"],
      async run(_kind, request) {
        requests.push(request);
        return passed();
      },
    };
    const changes: ChangeSet = { base: "a".repeat(40), baseRef: "main", files: new Map([["svc/b/main.go", "all"]]), deleted: [] };
    const service = await serviceFor(provider, ["verification-profile:change-guard"], {}, ["svc/a", "svc/b"], changes);

    const report = await service.run({ root: "/repo", stage: "verify", changed: true });

    expect(report.results.map((result) => [result.check, result.unit])).toEqual([["integrity", "."], ["size", "."]]);
    expect(requests.map((request) => request.inputs.max_changed_lines)).toEqual([["400"], ["400"]]);
  });

  it("ranks failed above unavailable and never counts unavailable as passed", async () => {
    const unavailable = await (await serviceFor(
      recordingProvider((kind) => (kind === "go-vet" ? { status: "unavailable", summary: "no tool", details: [] } : passed())),
      ["verification-profile:go-quality"],
    )).run({ root: "/repo", stage: "check", changed: false });
    const failed = await (await serviceFor(
      recordingProvider((kind) =>
        kind === "go-vet"
          ? { status: "unavailable", summary: "no tool", details: [] }
          : kind === "go-test"
            ? { status: "failed", summary: "broken", details: [] }
            : passed(),
      ),
      ["verification-profile:go-quality"],
    )).run({ root: "/repo", stage: "check", changed: false });

    expect(unavailable.verdict).toBe("unavailable");
    expect(failed.verdict).toBe("failed");
  });

  it("reports a check kind without provider as unavailable", async () => {
    const service = await serviceFor({ kinds: [], async run() { return passed(); } }, ["verification-profile:go-quality"]);

    const report = await service.run({ root: "/repo", stage: "check", changed: false });

    expect(report.verdict).toBe("unavailable");
    expect(report.results[0]?.outcome.summary).toContain("no provider for go-format");
  });

  it("blocks an uninitialized repository instead of passing vacuously", async () => {
    const service = await serviceFor(recordingProvider(() => passed()), null);

    const report = await service.run({ root: "/repo", stage: "check", changed: false });

    expect(report.verdict).toBe("blocked");
    expect(report.diagnostics.map((entry) => entry.code)).toEqual(["verification.project.uninitialized"]);
  });
});

function passed(): CheckOutcome {
  return { status: "passed", summary: "ok", details: [] };
}

function recordingProvider(outcome: (kind: string) => CheckOutcome): CheckProvider & { requests: CheckRequest[] } {
  const requests: CheckRequest[] = [];
  return {
    requests,
    kinds: ["go-format", "go-vet", "go-test", "go-mod-verify", "golangci-lint", "go-coverage", "govulncheck"],
    async run(kind, request) {
      requests.push(request);
      return outcome(kind);
    },
  };
}

async function serviceFor(
  provider: CheckProvider,
  selections: readonly string[] | null,
  inputs: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {},
  units: readonly string[] = ["."],
  changes?: ChangeSet,
): Promise<VerificationService> {
  const catalog = await loadCatalog();
  const scan = {
    kind: "ready",
    snapshot: { realRoot: "/repo" },
    catalog,
    assessment: {
      projectUnits: units.map((root) => ({ id: root, root, languages: [languageId("go")] })),
    },
    desired: selections === null
      ? null
      : {
          state: {
            selections: selections.map((ref) => ({ ref: componentRef(ref), inputs: inputs[ref] ?? {} })),
          },
        },
    resolution: null,
  } as unknown as ScanResult;
  return new VerificationService({
    scan: async () => scan,
    changeSets: {
      async read() {
        if (changes === undefined) throw new Error("no change set in this test");
        return changes;
      },
    },
    providers: [provider],
  });
}

async function loadCatalog(): Promise<CatalogSnapshot> {
  const result = await new FilesystemCatalog({
    catalogFile: resolve("railguard.yaml"),
    supportedLanguages: [languageId("go")],
  }).load();
  if (result.kind !== "ready") throw new Error(result.diagnostics[0]?.message);
  return result.catalog;
}

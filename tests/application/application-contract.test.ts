import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createDefaultApplication } from "../../src/application/composition-root.js";
import type { ExecutableProbe } from "../../src/domain/harness/model.js";
import { componentRef, harnessTargetId } from "../../src/domain/shared/types.js";
import { createTempRepository } from "../helpers/temp-repository.js";

const execute = promisify(execFile);
const probe: ExecutableProbe = {
  async probe(command) {
    return { detected: true, path: `/test/bin/${command}`, version: "test", diagnostics: [] };
  },
};

describe("AiHarnessApplication public cases", () => {
  it("scans a new directory without Git and defers the mutation requirement", async () => {
    const repository = await createTempRepository({});
    const runtime = await createDefaultApplication({ executableProbe: probe });
    try {
      const scan = await runtime.application.scan(repository.root);

      expect(scan.kind).toBe("ready");
      if (scan.kind !== "ready") throw new Error("Expected a discoverable new project");
      expect(scan.snapshot.entries).toEqual([]);
      expect(scan.assessment.projectUnits).toEqual([]);
      expect(scan.recovery.kind).toBe("no-recovery");

      const preparation = await runtime.application.preparePlan(
        scan,
        [{ ref: componentRef("skill:tdd") }],
        [harnessTargetId("codex")],
        "reconcile",
      );
      expect(preparation.plan).toBeNull();
      expect(preparation.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        "repository.gate.git-uninitialized",
      );
    } finally {
      await Promise.all([runtime.dispose(), repository.cleanup()]);
    }
  });

  it("loads the configured content catalog without requiring a consumer repository", async () => {
    const runtime = await createDefaultApplication({ executableProbe: probe });
    try {
      const result = await runtime.application.catalog();
      expect(result.kind).toBe("ready");
      if (result.kind === "ready") {
        expect(result.catalog.components.map((component) => component.ref)).toContain(
          "mcp:context7",
        );
      }
    } finally {
      await runtime.dispose();
    }
  });

  it("plans typed inputs, syncs idempotently and repairs observed drift", async () => {
    const repository = await createTempRepository({
      "go.mod": "module example.com/application-contract\n\ngo 1.24\n",
    });
    await execute("git", ["init", "--quiet", repository.root]);
    const runtime = await createDefaultApplication({ executableProbe: probe });
    try {
      const baseline = await runtime.application.scan(repository.root);
      if (baseline.kind !== "ready") throw new Error("Expected ready scan");
      const preparation = await runtime.application.preparePlan(
        baseline,
        [
          {
            ref: componentRef("verification-profile:go-quality"),
            inputs: { test_packages: ["./cmd/...", "./internal/..."] },
          },
          { ref: componentRef("skill:tdd") },
        ],
        [harnessTargetId("codex")],
        "reconcile",
      );
      if (preparation.plan?.kind !== "ready") throw new Error("Expected ready plan");
      expect((await runtime.application.apply(preparation.plan)).kind).toBe("applied");
      expect(await readFile(`${repository.root}/Makefile`, "utf8")).toContain(
        "AI_HARNESS_GO_TEST_PACKAGES := ./cmd/... ./internal/...",
      );

      const managed = await runtime.application.scan(repository.root);
      if (managed.kind !== "ready") throw new Error("Expected managed scan");
      const sync = await runtime.application.prepareSync(managed);
      expect(sync.plan?.kind).toBe("ready");
      if (sync.plan?.kind === "ready") expect(sync.plan.operations).toEqual([]);

      await writeFile(
        `${repository.root}/AGENTS.md`,
        (await readFile(`${repository.root}/AGENTS.md`, "utf8")).replace(
          "## Skill routing",
          "## drifted managed skills",
        ),
      );
      const drifted = await runtime.application.scan(repository.root);
      if (drifted.kind !== "ready") throw new Error("Expected drift scan");
      expect(drifted.reconciliation.integrity).toBe("drifted");

      const repair = await runtime.application.prepareRepair(drifted);
      expect(repair.plan?.kind).toBe("ready");
      if (repair.plan?.kind !== "ready") throw new Error("Expected repair plan");
      expect(repair.plan.mode).toBe("repair");
      expect((await runtime.application.apply(repair.plan)).kind).toBe("applied");

      const doctor = await runtime.application.doctor(repository.root);
      expect(doctor.kind).toBe("ready");
      expect(doctor.checks).toContainEqual(
        expect.objectContaining({ id: "materialization", status: "passed" }),
      );
    } finally {
      await Promise.all([runtime.dispose(), repository.cleanup()]);
    }
  });

  it("reports operation contention instead of misclassifying the repository scope", async () => {
    const repository = await createTempRepository({
      "go.mod": "module example.com/contention\n\ngo 1.24\n",
    });
    await execute("git", ["init", "--quiet", repository.root]);
    const runtime = await createDefaultApplication({ executableProbe: probe });
    const lease = await runtime.transactionStore.acquire(repository.root);
    try {
      const scan = await runtime.application.scan(repository.root);
      expect(scan.kind).toBe("blocked");
      expect(scan.diagnostics.map((entry) => entry.code)).toContain(
        "recovery.operation-busy",
      );
      expect(scan.diagnostics.map((entry) => entry.code)).not.toContain(
        "recovery.repository-gate.failed",
      );
    } finally {
      await lease.release();
      await Promise.all([runtime.dispose(), repository.cleanup()]);
    }
  });
});

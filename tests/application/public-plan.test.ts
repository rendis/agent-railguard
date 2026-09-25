import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultApplication } from "../../src/application/composition-root.js";
import {
  decodePublicPlan,
  exportPublicPlan,
  rehydratePublicPlan,
} from "../../src/application/serialization/public-plan.js";
import { componentRef, harnessTargetId } from "../../src/domain/shared/types.js";
import { createTempRepository } from "../helpers/temp-repository.js";

const execute = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("public plan contract", () => {
  it("exports only reviewable intent and reconstructs the exact opaque plan", async () => {
    const repository = await goRepository();
    const runtime = await createDefaultApplication({ catalogFile: resolve("railguard.yaml") });
    cleanups.push(repository.cleanup, runtime.dispose);

    const scan = await runtime.application.scan(repository.root);
    if (scan.kind !== "ready") throw new Error("Expected a ready scan");
    const preparation = await runtime.application.preparePlan(
      scan,
      [
        {
          ref: componentRef("verification-profile:go-quality"),
          inputs: { test_packages: ["./cmd/...", "./internal/..."] },
        },
      ],
      [harnessTargetId("codex")],
      "reconcile",
    );
    if (preparation.plan?.kind !== "ready" || preparation.resolution.kind !== "ready") {
      throw new Error("Expected a ready plan");
    }

    const exported = exportPublicPlan({
      catalog: scan.catalog,
      resolution: preparation.resolution,
      plan: preparation.plan,
    });
    const encoded = JSON.stringify(exported);

    expect(exported).toMatchObject({
      schema: "railguard/plan/v1",
      plan_id: preparation.plan.id,
      mode: "reconcile",
      desired_after: {
        schema: "railguard/project/v1",
        targets: ["codex"],
        selections: [
          {
            ref: "verification-profile:go-quality",
            inputs: { test_packages: ["./cmd/...", "./internal/..."] },
          },
        ],
      },
    });
    expect(encoded).not.toContain(repository.root);
    expect(encoded).not.toContain("bytes");
    expect(encoded).not.toContain("preimage");
    expect(encoded).not.toContain("desiredBefore");

    const decoded = decodePublicPlan(`${encoded}\n`);
    const replay = await rehydratePublicPlan(runtime.application, repository.root, decoded);
    expect(replay.kind).toBe("ready");
    if (replay.kind === "ready") {
      expect(replay.plan.id).toBe(preparation.plan.id);
      expect(replay.plan.rootRealPath).toBe(scan.snapshot.realRoot);
    }
  });

  it("rejects unknown fields and stale repository evidence without producing a plan", async () => {
    expect(() =>
      decodePublicPlan({
        schema: "railguard/plan/v1",
        plan_id: `sha256:${"0".repeat(64)}`,
        mode: "remove",
        basis: {
          repository_fingerprint: `sha256:${"0".repeat(64)}`,
          catalog_digest: `sha256:${"0".repeat(64)}`,
          desired_before_digest: null,
          desired_after_digest: null,
          lock_before_digest: null,
          lock_after_digest: null,
        },
        desired_after: null,
        review: emptyReview(`sha256:${"0".repeat(64)}`),
        surprise: true,
      }),
    ).toThrow(/schema/i);

    const repository = await goRepository();
    const runtime = await createDefaultApplication({ catalogFile: resolve("railguard.yaml") });
    cleanups.push(repository.cleanup, runtime.dispose);
    const scan = await runtime.application.scan(repository.root);
    if (scan.kind !== "ready") throw new Error("Expected a ready scan");
    const preparation = await runtime.application.prepareInstall(
      scan,
      [componentRef("skill:tdd")],
      [harnessTargetId("codex")],
    );
    if (preparation.plan?.kind !== "ready" || preparation.resolution.kind !== "ready") {
      throw new Error("Expected a ready plan");
    }
    const exported = exportPublicPlan({
      catalog: scan.catalog,
      resolution: preparation.resolution,
      plan: preparation.plan,
    });

    await writeFile(resolve(repository.root, "README.md"), "changed after review\n", "utf8");
    const replay = await rehydratePublicPlan(runtime.application, repository.root, exported);
    expect(replay.kind).toBe("stale");
    expect(replay.diagnostics.map((entry) => entry.code)).toContain(
      "plan-import.repository-fingerprint-changed",
    );
  });
});

async function goRepository() {
  const repository = await createTempRepository({
    "go.mod": "module example.com/public-plan\n\ngo 1.24\n",
    "README.md": "# fixture\n",
  });
  await execute("git", ["init", "--quiet", repository.root]);
  return repository;
}

function emptyReview(planId: string) {
  return {
    plan_id: planId,
    mode: "remove",
    direct: [],
    required: [],
    changes: [],
    git_config: [],
    hooks: [],
    runtimes: [],
    prerequisites: [],
    apply_executes: [],
  };
}

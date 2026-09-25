import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createDefaultApplication } from "../../src/application/composition-root.js";
import { buildReviewModel } from "../../src/domain/review/review-model.js";
import type { ExecutableProbe } from "../../src/domain/harness/model.js";
import { componentRef, harnessTargetId } from "../../src/domain/shared/types.js";
import { createTempRepository } from "../helpers/temp-repository.js";

const execute = promisify(execFile);
const readyProbe: ExecutableProbe = {
  async probe(command) {
    return { detected: true, path: `/test/bin/${command}`, version: "test", diagnostics: [] };
  },
};

describe("buildReviewModel", () => {
  it("explains the exact closure and side effects before approval", async () => {
    const repository = await createTempRepository({
      "go.mod": "module example.com/review\n\ngo 1.24\n",
    });
    await execute("git", ["init", "--quiet", repository.root]);
    const runtime = await createDefaultApplication({ executableProbe: readyProbe });
    try {
      const scan = await runtime.application.scan(repository.root);
      if (scan.kind !== "ready") throw new Error("Expected ready scan");
      const preparation = await runtime.application.prepareInstall(
        scan,
        [componentRef("pack:go-service-foundation")],
        [harnessTargetId("codex")],
      );
      if (preparation.resolution.kind !== "ready" || preparation.plan?.kind !== "ready") {
        throw new Error("Expected a reviewable plan");
      }

      const review = buildReviewModel({
        catalog: scan.catalog,
        resolution: preparation.resolution,
        plan: preparation.plan,
      });

      expect(review.planId).toBe(preparation.plan.id);
      expect(review.direct.map((component) => component.ref)).toEqual([
        "pack:go-service-foundation",
      ]);
      expect(review.required.map((component) => component.ref)).toContain("mcp:context7");
      expect(review.required.find((component) => component.ref === "mcp:context7")?.causes).toContainEqual(
        expect.objectContaining({ from: "pack:go-service-foundation", kind: "includes" }),
      );
      expect(review.changes.some((change) => change.path === ".codex/config.toml")).toBe(true);
      expect(review.changes.some((change) => change.path === ".railguard/hooks/pre-commit")).toBe(true);
      expect(review.gitConfig).toContainEqual({
        key: "core.hooksPath",
        action: "set",
        value: ".railguard/hooks",
      });
      expect(review.hooks).toEqual([
        {
          component: "git-gate:pre-commit-check",
          event: "pre-commit",
          command: "railguard check --changed",
        },
        {
          component: "git-gate:pre-push-verify",
          event: "pre-push",
          command: "railguard verify --changed",
        },
      ]);
      expect(review.runtimes).toContainEqual({
        component: "mcp:context7",
        connection: {
          type: "stdio",
          command: ["npx", "-y", "@upstash/context7-mcp@4.0.0"],
        },
        timing: "harness-runtime",
        network: "runtime-required",
        auth: "none",
      });
      expect(review.applyExecutes).not.toContain("npx");
    } finally {
      await Promise.all([runtime.dispose(), repository.cleanup()]);
    }
  });
});

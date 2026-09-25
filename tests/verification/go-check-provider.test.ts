import { execFile, execFileSync } from "node:child_process";
import { appendFile, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NodeChangeSetReader } from "../../src/adapters/platform/git/node-change-set-reader.js";
import { NodeProcessRunner } from "../../src/adapters/platform/process/node-process-runner.js";
import { GoCheckProvider } from "../../src/adapters/stack/go/go-check-provider.js";
import type { ChangeSet, CheckRequest } from "../../src/domain/verification/checks.js";
import { createTempRepository } from "../helpers/temp-repository.js";

const execute = promisify(execFile);
const hasGo = (() => {
  try {
    execFileSync("go", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/**
 * A module with pre-existing debt (a failing test and an unformatted file in `internal/legacy`)
 * and a branch that changes only `internal/core/order`.
 */
describe.skipIf(!hasGo)("GoCheckProvider against a real module", () => {
  const process = new NodeProcessRunner();
  const provider = new GoCheckProvider(process);
  let root = "";
  let cleanup: () => Promise<void> = async () => undefined;
  let changes: ChangeSet;

  beforeAll(async () => {
    const created = await createTempRepository({
      "go.mod": "module example.com/svc\n\ngo 1.22\n",
      "internal/core/order/order.go": "package order\n\n// Total sums prices.\nfunc Total(prices []int) int {\n\tsum := 0\n\tfor _, price := range prices {\n\t\tsum += price\n\t}\n\treturn sum\n}\n",
      "internal/core/order/order_test.go": "package order\n\nimport \"testing\"\n\nfunc TestTotal(t *testing.T) {\n\tif Total([]int{1, 2}) != 3 {\n\t\tt.Fatal(\"total\")\n\t}\n}\n",
      "internal/legacy/legacy.go": "package legacy\n\nfunc Broken() int {   return 1 }\n",
      "internal/legacy/legacy_test.go": "package legacy\n\nimport \"testing\"\n\nfunc TestBroken(t *testing.T) { t.Fatal(\"pre-existing failure\") }\n",
    });
    cleanup = created.cleanup;
    root = await realpath(created.root);
    await git("init", "-q", "-b", "main");
    await git("add", "-A");
    await git("commit", "-qm", "legacy");
    await git("checkout", "-q", "-b", "feature");
    await appendFile(
      join(root, "internal/core/order/order.go"),
      "\n// Discount applies a percentage discount.\nfunc Discount(total, percent int) int {\n\tif percent > 100 {\n\t\treturn 0\n\t}\n\treturn total - total*percent/100\n}\n",
    );
    // Installed skills ship Go scripts under dot directories; Go and the checks ignore them.
    await mkdir(join(root, ".agents/skills/demo"), { recursive: true });
    await writeFile(join(root, ".agents/skills/demo/main.go"), "package main\nfunc main() {   }\n");
    changes = await new NodeChangeSetReader(process).read(root);
  }, 60_000);

  afterAll(async () => {
    await cleanup();
  });

  it("judges only the change: legacy formatting and failing tests do not block it", async () => {
    const format = await provider.run("go-format", request({ changes }));
    const test = await provider.run("go-test", request({ changes }));

    expect(format.status).toBe("passed");
    expect(test).toMatchObject({ status: "passed", summary: expect.stringContaining("./internal/core/order") });
  }, 120_000);

  it("still reports the pre-existing debt in full mode", async () => {
    const format = await provider.run("go-format", request({ changes: null }));
    const test = await provider.run("go-test", request({ changes: null }));

    expect(format).toMatchObject({ status: "failed", details: ["gofmt -w internal/legacy/legacy.go"] });
    expect(test.status).toBe("failed");
    expect(test.details.join("\n")).toContain("pre-existing failure");
  }, 120_000);

  it("requires coverage of changed lines and names the uncovered ones", async () => {
    const outcome = await provider.run("go-coverage", request({
      changes,
      params: { core_min: 100, changed_min: 80 },
      inputs: { core_packages: ["./internal/core/..."] },
    }));

    expect(outcome.status).toBe("failed");
    expect(outcome.details).toContain("internal/core/order/order.go: uncovered lines 13-17");

    await writeFile(
      join(root, "internal/core/order/discount_test.go"),
      "package order\n\nimport \"testing\"\n\nfunc TestDiscount(t *testing.T) {\n\tif Discount(200, 10) != 180 || Discount(200, 150) != 0 {\n\t\tt.Fatal(\"discount\")\n\t}\n}\n",
    );
    const covered = await provider.run("go-coverage", request({
      changes: await new NodeChangeSetReader(process).read(root),
      params: { core_min: 100, changed_min: 80 },
      inputs: { core_packages: ["./internal/core/..."] },
    }));
    expect(covered).toMatchObject({ status: "passed", summary: expect.stringContaining("core 100.0%") });
  }, 180_000);

  it("reports a missing lint configuration or tool as unavailable, never as a pass", async () => {
    const lint = await provider.run("golangci-lint", request({ changes }));
    const mutation = await provider.run("go-mutation", request({ changes, inputs: { packages: ["./..."] } }));

    expect(lint.status).toBe("unavailable");
    expect(mutation.status).toBe("unavailable");
  }, 120_000);

  function request(overrides: Partial<CheckRequest>): CheckRequest {
    return {
      repositoryRoot: root,
      unitRoot: ".",
      params: {},
      inputs: {},
      changes: null,
      ...overrides,
    };
  }

  async function git(...args: string[]): Promise<void> {
    await execute("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args], { cwd: root });
  }
});

import { execFile, execFileSync } from "node:child_process";
import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NodeChangeSetReader } from "../../src/adapters/platform/git/node-change-set-reader.js";
import { NodeProcessRunner } from "../../src/adapters/platform/process/node-process-runner.js";
import { GoCheckProvider, goImports } from "../../src/adapters/stack/go/go-check-provider.js";
import type { ChangeSet, CheckRequest } from "../../src/domain/verification/checks.js";
import { runFullCheck } from "../helpers/full-check.js";
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

describe("goImports", () => {
  it("reads grouped, single, aliased and dot imports but ignores comments", () => {
    const source = [
      "package core",
      "",
      "// import \"example.com/commented/out\"",
      "import \"fmt\"",
      "import alias \"example.com/single\"",
      "import (",
      "\t\"context\"",
      "\t. \"example.com/dot\"",
      "\t_ \"example.com/blank\" // side effect",
      "\t/* \"example.com/block/comment\" */",
      ")",
    ].join("\n");

    expect(goImports(source).sort()).toEqual([
      "context",
      "example.com/blank",
      "example.com/dot",
      "example.com/single",
      "fmt",
    ]);
  });
});

/** A legacy core that already imports an adapter, and a branch that adds a new forbidden import. */
describe.skipIf(!hasGo)("go-imports against a real module", () => {
  const process = new NodeProcessRunner();
  const provider = new GoCheckProvider(process);
  let root = "";
  let cleanup: () => Promise<void> = async () => undefined;
  const hexagonal = {
    core_packages: ["./internal/core/..."],
    core_allowed_imports: ["github.com/google/uuid"],
    core_denied_stdlib: ["database/sql", "net/http"],
  };

  beforeAll(async () => {
    const created = await createTempRepository({
      "go.mod": "module example.com/svc\n\ngo 1.22\n",
      "internal/adapters/db/db.go": "package db\n\n// Name is the driver name.\nconst Name = \"db\"\n",
      "internal/core/legacy/legacy.go": "package legacy\n\nimport \"example.com/svc/internal/adapters/db\"\n\n// Driver leaks an adapter into the core.\nconst Driver = db.Name\n",
      "internal/core/order/order.go": "package order\n\nimport \"strings\"\n\n// Name normalizes an order name.\nfunc Name(value string) string { return strings.TrimSpace(value) }\n",
    });
    cleanup = created.cleanup;
    root = await realpath(created.root);
    await git("init", "-q", "-b", "main");
    await git("add", "-A");
    await git("commit", "-qm", "legacy");
    await git("checkout", "-q", "-b", "feature");
    await writeFile(
      join(root, "internal/core/order/order.go"),
      "package order\n\nimport (\n\t\"net/http\"\n\t\"strings\"\n\n\t\"example.com/svc/internal/adapters/db\"\n)\n\n// Name normalizes an order name.\nfunc Name(value string) string { return strings.TrimSpace(value) + db.Name + http.MethodGet }\n",
    );
  }, 60_000);

  afterAll(async () => {
    await cleanup();
  });

  it("judges only the changed core file in delta mode", async () => {
    const outcome = await provider.run("go-imports", request({
      changes: await new NodeChangeSetReader(process).read(root),
      inputs: hexagonal,
    }));

    expect(outcome.status).toBe("failed");
    expect(outcome.details).toEqual([
      "internal/core/order/order.go: core imports net/http",
      "internal/core/order/order.go: core imports example.com/svc/internal/adapters/db",
    ]);
  });

  it("reports the legacy violation too through the verify script", async () => {
    const outcome = await runFullCheck(root, provider, "go-imports", { inputs: hexagonal });

    expect(outcome).toMatchObject({ code: 1 });
    const output = "output" in outcome ? outcome.output : "";
    expect(output).toContain("internal/core/legacy: core imports example.com/svc/internal/adapters/db");
    expect(output).toContain("internal/core/order: core imports net/http");
    expect(output).toContain("3 forbidden import(s)");
  });

  it("enforces custom layering rules", async () => {
    const outcome = await runFullCheck(root, provider, "go-imports", {
      inputs: { core_packages: ["disabled"], forbidden_imports: ["./internal/core/... -> ./internal/adapters/..."] },
    });

    expect(outcome).toMatchObject({ code: 1, output: expect.stringContaining("2 forbidden import(s)") });
    expect(outcome).toMatchObject({ output: expect.stringContaining('(forbidden by "./internal/core/... -> ./internal/adapters/...")') });
  });

  it("passes a clean core and skips when no dependency rule is configured", async () => {
    expect(await runFullCheck(root, provider, "go-imports", {
      inputs: { core_packages: ["./internal/core/order"], core_denied_stdlib: ["none"], forbidden_imports: ["./internal/core/order -> ./internal/core/legacy"] },
    })).toMatchObject({ code: 1, output: expect.stringContaining("core imports example.com/svc/internal/adapters/db") });
    expect(await runFullCheck(root, provider, "go-imports", { inputs: { core_packages: ["disabled"] } }))
      .toEqual({ skipped: "No dependency rule configured" });
  });

  function request(overrides: Partial<CheckRequest> & { changes: ChangeSet }): CheckRequest {
    return { repositoryRoot: root, unitRoot: ".", params: {}, inputs: {}, ...overrides };
  }

  async function git(...args: string[]): Promise<void> {
    await execute("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args], { cwd: root });
  }
});

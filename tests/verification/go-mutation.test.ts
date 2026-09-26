import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeProcessRunner } from "../../src/adapters/platform/process/node-process-runner.js";
import { GoCheckProvider } from "../../src/adapters/stack/go/go-check-provider.js";
import type { ChangeSet } from "../../src/domain/verification/checks.js";
import { runFullCheck } from "../helpers/full-check.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/**
 * A module whose `go` stands in for the toolchain: the gremlins tool is pinned, `go list` finds
 * one package, and gremlins exits with GREMLINS_EXIT without writing a report, as it does for a
 * package that only declares types.
 */
async function module(gremlinsExit: number) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "railguard-mutation-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, ".bin");
  await mkdir(join(root, "internal/port"), { recursive: true });
  await mkdir(bin);
  await writeFile(join(root, "go.mod"), "module example.com/svc\n\ngo 1.26\n");
  await writeFile(join(root, "internal/port/port.go"), "package port\n\n// Reader reads.\ntype Reader interface{ Read() }\n");
  await writeFile(join(bin, "go"), [
    "#!/bin/sh",
    'case "$*" in',
    '  "list -e -f {{.Dir}} "*) echo "$PWD/internal/port" ;;',
    `  *" unleash "*) echo "No results to report."; exit ${gremlinsExit} ;;`,
    "esac",
    "exit 0",
    "",
  ].join("\n"));
  await chmod(join(bin, "go"), 0o755);
  const changes: ChangeSet = { base: null, baseRef: null, files: new Map([["internal/port/port.go", "all"]]), deleted: [] };
  return { root, environment: { PATH: `${bin}:${process.env.PATH ?? ""}` }, changes };
}

describe("go-mutation on a package without statements", () => {
  it("passes in the verify script and on a change when gremlins succeeds without a report", async () => {
    const { root, environment, changes } = await module(0);
    const provider = new GoCheckProvider(new NodeProcessRunner());

    expect(await runFullCheck(root, provider, "go-mutation", { inputs: { packages: ["./internal/..."] } }, environment))
      .toMatchObject({ code: 0 });
    const previous = process.env.PATH;
    process.env.PATH = environment.PATH;
    try {
      const outcome = await provider.run("go-mutation", {
        repositoryRoot: root, unitRoot: ".", params: {}, inputs: { packages: ["./internal/..."] }, changes,
      });
      expect(outcome).toMatchObject({ status: "passed", summary: "0 mutant(s) killed on changed lines" });
    } finally {
      process.env.PATH = previous;
    }
  });

  it("fails when gremlins itself fails", async () => {
    const { root, environment } = await module(3);

    expect(await runFullCheck(root, new GoCheckProvider(new NodeProcessRunner()), "go-mutation", { inputs: { packages: ["./internal/..."] } }, environment))
      .toMatchObject({ code: 1, output: expect.stringContaining("Gremlins failed for ./internal/port") });
  });
});

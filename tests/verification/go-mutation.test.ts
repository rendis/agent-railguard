import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  const changes: ChangeSet = { base: null, baseRef: null, files: new Map([["internal/port/port.go", "all"]]), deleted: [], staged: false };
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

/** A report Gremlins v0.6.0 wrote for `calc/calc.go` below with `--test-cpu=0`. */
const gremlinsReport = resolve(import.meta.dirname, "../fixtures/gremlins/unleash-v0.6.0.json");

/**
 * A module whose `go` stands in for the toolchain: `go list` finds `calc`, and gremlins records
 * its arguments and writes the real v0.6.0 report wherever `-o` points.
 */
async function reportingModule() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "railguard-mutation-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, ".bin");
  await mkdir(join(root, "calc"), { recursive: true });
  await mkdir(bin);
  await writeFile(join(root, "go.mod"), "module example.com/svc\n\ngo 1.26\n");
  await writeFile(join(root, "calc/calc.go"), [
    "package calc", "", "// Max returns the larger value.", "func Max(a, b int) int {", "\tif a > b {", "\t\treturn a",
    "\t}", "\treturn b", "}", "", "// Neg negates a value.", "func Neg(a int) int {", "\treturn -a", "}", "",
  ].join("\n"));
  await writeFile(join(bin, "go"), [
    "#!/bin/sh",
    'case "$*" in',
    '  "list -e -f {{.Dir}} "*) echo "$PWD/calc"; exit 0 ;;',
    "  *\" unleash \"*)",
    `    printf '%s\\n' "$*" >> ${JSON.stringify(join(root, ".gremlins-args"))}`,
    '    while [ "$#" -gt 0 ]; do [ "$1" = "-o" ] && report=$2; shift; done',
    `    cp ${JSON.stringify(gremlinsReport)} "$report"; exit 0 ;;`,
    "esac",
    "exit 0",
    "",
  ].join("\n"));
  await chmod(join(bin, "go"), 0o755);
  const changes: ChangeSet = { base: null, baseRef: null, files: new Map([["calc/calc.go", "all"]]), deleted: [], staged: false };
  const args = async () => (await readFile(join(root, ".gremlins-args"), "utf8")).trim().split("\n");
  return { root, environment: { PATH: `${bin}:${process.env.PATH ?? ""}` }, changes, args };
}

describe("go-mutation on a real Gremlins report", () => {
  it("fails on lived and not covered mutants and runs every test with the default CPU count", async () => {
    const { root, environment, changes, args } = await reportingModule();
    const provider = new GoCheckProvider(new NodeProcessRunner());

    expect(await runFullCheck(root, provider, "go-mutation", {}, environment))
      .toMatchObject({ code: 1, output: expect.stringContaining("3 mutant(s) survived or were not covered") });
    const previous = process.env.PATH;
    process.env.PATH = environment.PATH;
    try {
      const outcome = await provider.run("go-mutation", { repositoryRoot: root, unitRoot: ".", params: {}, inputs: {}, changes });
      expect(outcome).toMatchObject({
        status: "failed",
        summary: "3 mutant(s) survived on changed lines",
        details: [
          "calc/calc.go:5:7 CONDITIONALS_BOUNDARY LIVED",
          "calc/calc.go:13:9 INVERT_NEGATIVES NOT COVERED",
          "calc/calc.go:13:9 ARITHMETIC_BASE NOT COVERED",
        ],
      });
    } finally {
      process.env.PATH = previous;
    }
    const runs = await args();
    expect(runs).toHaveLength(2);
    for (const run of runs) expect(run).toMatch(/ unleash --test-cpu=0 /u);
  });
});

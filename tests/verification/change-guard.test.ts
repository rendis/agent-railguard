import { execFile } from "node:child_process";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { NodeChangeSetReader } from "../../src/adapters/platform/git/node-change-set-reader.js";
import { NodeProcessRunner } from "../../src/adapters/platform/process/node-process-runner.js";
import { ChangeCheckProvider } from "../../src/adapters/verification/change-check-provider.js";
import {
  changedLineCount,
  globToRegExp,
  parseAllowances,
  removedTestFindings,
  suppressionFindings,
  testNames,
} from "../../src/domain/verification/change-guard.js";
import type { CheckRequest } from "../../src/domain/verification/checks.js";
import { createTempRepository } from "../helpers/temp-repository.js";

const execute = promisify(execFile);
const process = new NodeProcessRunner();
const changeSets = new NodeChangeSetReader(process);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("change guard rules", () => {
  it("matches globs by segment, across segments and by file name at any depth", () => {
    expect(globToRegExp("*.lock").test("web/yarn.lock")).toBe(true);
    expect(globToRegExp(".golangci.*").test(".golangci.yml")).toBe(true);
    expect(globToRegExp("vendor/**").test("vendor/a/b.go")).toBe(true);
    expect(globToRegExp("vendor/**").test("internal/vendor/a.go")).toBe(false);
    expect(globToRegExp("**/testdata/**").test("testdata/x.json")).toBe(true);
    expect(globToRegExp("docs/*.md").test("docs/a/b.md")).toBe(false);
  });

  it("reports suppressions only on changed lines of source files", () => {
    const source = ["package x", "func A() {} //nolint:gocyclo", "func B() { t.Skip(\"later\") }"].join("\n");

    expect(suppressionFindings("x.go", source, new Set([2]))).toEqual([
      "x.go:2: lint suppression: func A() {} //nolint:gocyclo",
    ]);
    expect(suppressionFindings("x.go", source, "all")).toHaveLength(2);
    expect(suppressionFindings("README.md", source, "all")).toEqual([]);
    expect(suppressionFindings("a.test.ts", "it.only('runs alone', () => {})", "all")[0]).toContain("focused test");
  });

  it("names the tests each kind of test file declares", () => {
    const go = [
      "func TestTotal(t *testing.T) {}",
      "func (s *OrdersSuite) TestRefund() {}",
      "func BenchmarkTotal(b *testing.B) {}",
      "func FuzzParse(f *testing.F) {}",
      "func ExampleTotal() {}",
      "func TestGeneric[T any](t *testing.T) {}",
      "func helper(t *testing.T) {}",
    ].join("\n");
    expect(testNames("orders_test.go", go)).toEqual(["TestTotal", "TestRefund", "BenchmarkTotal", "FuzzParse", "ExampleTotal", "TestGeneric"]);
    expect(testNames("a.test.ts", "describe('x', () => {\n  it(\"adds\", () => {})\n  test.only('it\\'s alone', () => {})\n  expect(/a/.test('a')).toBe(true)\n})"))
      .toEqual(["adds", "it\\'s alone"]);
    expect(testNames("tests/test_orders.py", "class TestOrders:\n    def test_total(self):\n        pass\nasync def test_refund():\n    pass\ndef helper():\n    pass"))
      .toEqual(["test_total", "test_refund"]);
    expect(testNames("OrdersTest.java", "@Test\nvoid total() {}\n@ParameterizedTest(name = \"{0}\")\n@ValueSource(ints = {1})\npublic void refund(int value) {}\nvoid helper() {}"))
      .toEqual(["total", "refund"]);
    expect(testNames("orders.feature", "Feature: Orders\n  Scenario: Total includes tax\n  Scenario Outline: Refund <amount>"))
      .toEqual(["Total includes tax", "Refund <amount>"]);
    expect(testNames("orders.go", go)).toEqual([]);
  });

  it("reports tests the change removes but not tests it moves between changed files", () => {
    expect(removedTestFindings([
      { path: "a_test.go", before: "func TestA(t *testing.T) {}\nfunc TestB(t *testing.T) {}", after: "func TestA(t *testing.T) {}" },
      { path: "b_test.go", before: "func TestC(t *testing.T) {}", after: "" },
      { path: "c_test.go", before: "", after: "func TestC(t *testing.T) {}" },
      { path: "d.test.ts", before: "it('twice', f)\nit('twice', f)", after: "it('twice', f)" },
    ])).toEqual(["a_test.go: test TestB removed", "d.test.ts: test twice removed"]);
  });

  it("counts new files by lines and accepts only allowances with a reason", () => {
    expect(changedLineCount("a\nb\n", "all")).toBe(2);
    expect(changedLineCount("", new Set([1, 2, 3]))).toBe(3);
    expect(parseAllowances("fix\n\nRailguard-Allow: change-size: generated client\nRailguard-Allow: change-integrity:")).toEqual(
      new Map([["change-size", "generated client"]]),
    );
  });
});

describe("ChangeCheckProvider", () => {
  it("fails a change that silences a check, deletes a test or edits protected configuration", async () => {
    const { root, git } = await repository({
      "a.go": "package a\n",
      "a_test.go": "package a\n",
      ".golangci.yml": "version: \"2\"\n",
    });
    await git("checkout", "-q", "-b", "feature");
    await writeFile(join(root, "a.go"), "package a\n\nfunc A() {} //nolint:all\n");
    await rm(join(root, "a_test.go"));
    await writeFile(join(root, ".golangci.yml"), "version: \"2\"\nlinters: {default: none}\n");

    const outcome = await provider().run("change-integrity", await request(root));

    expect(outcome.status).toBe("failed");
    expect(outcome.details.slice(0, 3)).toEqual([
      ".golangci.yml: protected quality configuration changed",
      "a.go:3: lint suppression: func A() {} //nolint:all",
      "a_test.go: test file deleted",
    ]);
  });

  it("judges only what the commit will hold when the change is staged", async () => {
    const { root, git } = await repository({ "a.go": "package a\n" });
    await git("checkout", "-q", "-b", "feature");
    await writeFile(join(root, "a.go"), "package a\n\nfunc A() {}\n");
    await git("add", "a.go");
    await mkdir(join(root, "tool"));
    await writeFile(join(root, "tool", "client.py"), "def request():  # pragma: no cover\n    pass\n");

    expect((await provider().run("change-integrity", await request(root))).status).toBe("failed");
    expect(await provider().run("change-integrity", await request(root, {}, true))).toMatchObject({ status: "passed" });

    await writeFile(join(root, "a.go"), "package a\n\nfunc A() {} //nolint:all\n");
    await git("add", "a.go");
    await writeFile(join(root, "a.go"), "package a\n\nfunc A() {}\n");
    const staged = await provider().run("change-integrity", await request(root, {}, true));
    expect(staged.status).toBe("failed");
    expect(staged.details[0]).toBe("a.go:3: lint suppression: func A() {} //nolint:all");
  });

  it("fails a change that removes a test from a test file it keeps", async () => {
    const { root, git } = await repository({
      "internal/orders/orders.go": "package orders\n",
      "internal/orders/orders_test.go": "package orders\n\nimport \"testing\"\n\nfunc TestTotal(t *testing.T) {}\n",
    });
    await git("checkout", "-q", "-b", "feature");
    await writeFile(join(root, "internal/orders/orders_test.go"), "package orders\n");
    await git("commit", "-qam", "drop test");

    const outcome = await provider().run("change-integrity", await request(root));

    expect(outcome.status).toBe("failed");
    expect(outcome.details[0]).toBe("internal/orders/orders_test.go: test TestTotal removed");
  });

  it("passes a change that moves a test to a new test file or adds tests", async () => {
    const { root, git } = await repository({
      "a_test.go": "package a\n\nfunc TestA(t *testing.T) {}\nfunc TestB(t *testing.T) {}\n",
    });
    await git("checkout", "-q", "-b", "feature");
    await writeFile(join(root, "a_test.go"), "package a\n\nfunc TestA(t *testing.T) {}\nfunc TestC(t *testing.T) {}\n");
    await writeFile(join(root, "b_test.go"), "package a\n\nfunc TestB(t *testing.T) {}\n");

    const outcome = await provider().run("change-integrity", await request(root));

    expect(outcome).toMatchObject({ status: "passed", summary: "No suppression, removed test or protected configuration change" });
  });

  it("accepts a removed test with a person's trailer and judges later removals", async () => {
    const { root, git } = await repository({
      "a_test.go": "package a\n\nfunc TestA(t *testing.T) {}\nfunc TestB(t *testing.T) {}\n",
    });
    await git("checkout", "-q", "-b", "feature");
    await writeFile(join(root, "a_test.go"), "package a\n\nfunc TestA(t *testing.T) {}\n");
    await git("commit", "-qam", "drop obsolete test\n\nRailguard-Allow: change-integrity: feature removed");

    expect((await provider().run("change-integrity", await request(root))).status).toBe("passed");

    await writeFile(join(root, "a_test.go"), "package a\n");
    const later = await provider().run("change-integrity", await request(root));
    expect(later.status).toBe("failed");
    expect(later.details[0]).toBe("a_test.go: test TestA removed");
  });

  it("accepts a protected configuration the change adds", async () => {
    const { root, git } = await repository({ "a.go": "package a\n" });
    await git("checkout", "-q", "-b", "feature");
    await mkdir(join(root, ".railguard"));
    await writeFile(join(root, ".railguard/project.yaml"), "schema: railguard/project/v1\n");

    const outcome = await provider().run("change-integrity", await request(root, { protected_paths: [".railguard/project.yaml"] }));

    expect(outcome.status).toBe("passed");
  });

  it("accepts what the branch held at a trailer commit and judges later changes", async () => {
    const { root, git } = await repository({ "a.go": "package a\n" });
    await git("checkout", "-q", "-b", "feature");
    await writeFile(join(root, "a.go"), "package a\n\nfunc A() {} //nolint:all\n");
    await git("commit", "-qam", "legacy lint\n\nRailguard-Allow: change-integrity: predates Railguard");

    const accepted = await provider().run("change-integrity", await request(root));
    expect(accepted.status).toBe("passed");
    expect(accepted.summary).toMatch(/^No suppression.* since [0-9a-f]{12} \(accepted: predates Railguard\)$/u);

    await writeFile(join(root, "b.go"), "package a\n\nfunc B() {} //nolint:all\n");
    const later = await provider().run("change-integrity", await request(root));
    expect(later.status).toBe("failed");
    expect(later.details[0]).toBe("b.go:3: lint suppression: func B() {} //nolint:all");
  });

  it("limits changed lines outside tests and excluded paths", async () => {
    const { root, git } = await repository({ "a.go": "package a\n" });
    await git("checkout", "-q", "-b", "feature");
    await writeFile(join(root, "b.go"), "x\n".repeat(5));
    await writeFile(join(root, "b_test.go"), "x\n".repeat(50));
    await writeFile(join(root, "go.sum"), "x\n".repeat(50));

    const within = await provider().run("change-size", await request(root, { max_changed_lines: ["5"] }));
    const over = await provider().run("change-size", await request(root, { max_changed_lines: ["4"] }));

    expect(within.status).toBe("passed");
    expect(over).toMatchObject({ status: "failed", details: ["b.go: 5", expect.stringContaining("Split the change")] });
  });

  it("counts every new text file however large and skips only binary files", async () => {
    const { root, git } = await repository({ "a.go": "package a\n" });
    await git("checkout", "-q", "-b", "feature");
    await writeFile(join(root, "large.go"), `${"x".repeat(1023)}\n`.repeat(3 * 1024));
    await writeFile(join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a, 0x0a]));
    await writeFile(join(root, "late-nul.go"), `package a\n${"// padding\n".repeat(1000)}\0\n`);

    const outcome = await provider().run("change-size", await request(root, { max_changed_lines: ["400"] }));

    expect(outcome).toMatchObject({ status: "failed", details: ["large.go: 3072", "late-nul.go: 1002", expect.any(String)] });
  });

  it("fails integrity for a text file too large to scan", async () => {
    const { root, git } = await repository({ "a.go": "package a\n" });
    await git("checkout", "-q", "-b", "feature");
    await writeFile(join(root, "huge.go"), `${"x".repeat(1023)}\n`.repeat(17 * 1024));

    const outcome = await provider().run("change-integrity", await request(root));

    expect(outcome).toMatchObject({ status: "failed", details: [expect.stringMatching(/^huge\.go: too large to scan/u), expect.any(String)] });
  });
});

function provider(): ChangeCheckProvider {
  return new ChangeCheckProvider(process, changeSets);
}

async function request(
  root: string,
  inputs: Record<string, readonly string[]> = {},
  staged = false,
): Promise<CheckRequest> {
  return {
    repositoryRoot: root,
    unitRoot: ".",
    params: {},
    inputs: { protected_paths: [".golangci.*"], size_excluded_paths: ["go.sum"], ...inputs },
    changes: await changeSets.read(root, undefined, { staged }),
  };
}

async function repository(files: Record<string, string>) {
  const temporary = await createTempRepository(files);
  cleanups.push(temporary.cleanup);
  const root = await realpath(temporary.root);
  const git = (...args: string[]) => execute("git", ["-C", root, ...args]);
  await git("init", "-q", "-b", "main");
  await git("-c", "user.email=a@b", "-c", "user.name=t", "add", ".");
  await git("-c", "user.email=a@b", "-c", "user.name=t", "commit", "-qm", "base");
  await git("config", "user.email", "a@b");
  await git("config", "user.name", "t");
  return { root, git };
}

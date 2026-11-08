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
  declaredSymbols,
  globToRegExp,
  parseAllowances,
  removedSymbols,
  suppressionFindings,
  testChanges,
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
    expect(testChanges([
      { path: "a_test.go", before: "func TestA(t *testing.T) {}\nfunc TestB(t *testing.T) {}", after: "func TestA(t *testing.T) {}" },
      { path: "b_test.go", before: "func TestC(t *testing.T) {}", after: "" },
      { path: "c_test.go", before: "", after: "func TestC(t *testing.T) {}" },
      { path: "d.test.ts", before: "it('twice', f)\nit('twice', f)", after: "it('twice', f)" },
    ])).toEqual({ deleted: [], removed: ["a_test.go: test TestB removed", "d.test.ts: test twice removed"], renamed: [], obsolete: [] });
  });

  it("tells a test renamed in place from one removed while another is added elsewhere", () => {
    const go = (...names: string[]) => names.map((name) => `func ${name}(t *testing.T) {}`).join("\n");
    const changes = (before: string[], after: string[]) => {
      const { removed, renamed } = testChanges([{ path: "a_test.go", before: go(...before), after: go(...after) }]);
      return { removed, renamed };
    };

    expect(changes(["TestA", "TestB", "TestC"], ["TestA", "TestTotal", "TestC"]))
      .toEqual({ removed: [], renamed: ["a_test.go: test TestB renamed to TestTotal"] });
    expect(changes(["TestA", "TestB"], ["TestNewA", "TestNewB"]))
      .toEqual({ removed: [], renamed: ["a_test.go: test TestA renamed to TestNewA", "a_test.go: test TestB renamed to TestNewB"] });
    // Reordering renames nothing; the surviving test it follows identifies the place.
    expect(changes(["TestA", "TestB", "TestC"], ["TestC", "TestA", "TestX"]))
      .toEqual({ removed: [], renamed: ["a_test.go: test TestB renamed to TestX"] });
    expect(changes(["TestA", "TestB", "TestC"], ["TestA", "TestC", "TestX"]))
      .toEqual({ removed: ["a_test.go: test TestB removed"], renamed: [] });
    // A place that loses more tests than it gains, or gains more than it loses, renames none.
    expect(changes(["TestA", "TestB", "TestC"], ["TestA", "TestX"]))
      .toEqual({ removed: ["a_test.go: test TestB removed", "a_test.go: test TestC removed"], renamed: [] });
    expect(changes(["TestMax"], ["TestMin", "TestClamp"]))
      .toEqual({ removed: ["a_test.go: test TestMax removed"], renamed: [] });
    // The same text under a new name is a rename, even next to a removal.
    const body = (name: string, call: string) => `func ${name}(t *testing.T) {\n\tif ${call} {\n\t\tt.Fatal("x")\n\t}\n}\n`;
    expect(testChanges([{
      path: "a_test.go",
      before: body("TestMax", "Max(2, 1) != 2") + body("TestMin", "Min(2, 1) != 1"),
      after: body("TestMinPicksTheSmaller", "Min(2, 1) != 1") + body("TestAbs", "Abs(-1) != 1"),
    }])).toMatchObject({ removed: ["a_test.go: test TestMax removed"], renamed: ["a_test.go: test TestMin renamed to TestMinPicksTheSmaller"] });
    // A test that went with its code does not keep a new name from taking the place of another.
    expect(testChanges([{
      path: "a_test.go",
      before: body("TestMax", "Max(2, 1) != 2") + body("TestMin", "Min(2, 1) != 1"),
      after: body("TestMinPicksTheSmaller", "Min(1, 2) != 1"),
    }], new Set(["Max"]))).toMatchObject({
      removed: [],
      renamed: ["a_test.go: test TestMin renamed to TestMinPicksTheSmaller"],
      obsolete: ["a_test.go: test TestMax removed with the code it tested"],
    });
    // A test that moves in from another file does not take the place of one that left.
    expect(testChanges([
      { path: "a_test.go", before: go("TestA", "TestB"), after: go("TestA", "TestC") },
      { path: "b_test.go", before: go("TestC"), after: "" },
    ])).toMatchObject({ removed: ["a_test.go: test TestB removed"], renamed: [] });
  });

  it("reads the functions, types and classes production code declares", () => {
    expect(declaredSymbols("orders.go", "package orders\n\ntype Order struct{}\n\nfunc Total() int { return 0 }\nfunc (o Order) Refund() {}\n"))
      .toEqual(["Order", "Total", "Refund"]);
    expect(declaredSymbols("src/orders.ts", "export function total() {}\nexport class Ledger {}\nexport const rate = 1\nconst local = 2\n"))
      .toEqual(["total", "Ledger", "rate"]);
    expect(declaredSymbols("orders.py", "class Ledger:\n    def total(self):\n        pass\n")).toEqual(["Ledger", "total"]);
    expect(declaredSymbols("Orders.java", "public class Orders {\n  public int total(int a) { return a; }\n}\n")).toEqual(["Orders", "total"]);
    expect(declaredSymbols("orders_test.go", "func TestTotal(t *testing.T) {}")).toEqual([]);
  });

  it("tells a test that went with the code it tested from a removed one", () => {
    const before = "func TestTotal(t *testing.T) { Total() }\nfunc TestRefund(t *testing.T) { Refund() }\nfunc TestTax(t *testing.T) { Tax() }\n";
    const after = "func TestTax(t *testing.T) { Tax() }\n";

    expect(testChanges([{ path: "a_test.go", before, after }], new Set(["Total", "Subtotal"]))).toEqual({
      deleted: [],
      removed: ["a_test.go: test TestRefund removed"],
      renamed: [],
      obsolete: ["a_test.go: test TestTotal removed with the code it tested"],
    });
    // The test's own name does not count as using the symbol.
    expect(testChanges([{ path: "a_test.go", before: "func TestTotal(t *testing.T) {}\n", after: "" }], new Set(["Total"])))
      .toMatchObject({ removed: ["a_test.go: test TestTotal removed"], obsolete: [] });
    expect(testChanges([
      { path: "a_test.go", before, after: "", deleted: true },
      { path: "b_test.go", before: "func TestTax(t *testing.T) { Tax() }\n", after: "", deleted: true },
      { path: "c_test.go", before: "package c\n", after: "", deleted: true },
    ], new Set(["Total", "Refund", "Tax"]))).toEqual({
      deleted: ["c_test.go: test file deleted"],
      removed: [],
      renamed: [],
      obsolete: ["a_test.go: test file deleted with the code it tested", "b_test.go: test file deleted with the code it tested"],
    });
    expect(testChanges([{ path: "a_test.go", before, after: "", deleted: true }], new Set(["Total", "Tax"])))
      .toMatchObject({ deleted: ["a_test.go: test file deleted"], obsolete: [] });
  });

  it("reads Go constants, variables and the members of grouped declarations", () => {
    const go = [
      "package features",
      "",
      "const FeedOutside = \"feed-outside\"",
      "var ErrClosed, ErrGone = errors.New(\"closed\"), errors.New(\"gone\")",
      "var _ = check()",
      "",
      "const (",
      "\t// Low is the floor.",
      "\tLow = iota",
      "\tHigh",
      ")",
      "",
      "var (",
      "\tdefaults = Options{",
      "\t\tLimit: 1,",
      "\t}",
      ")",
      "",
      "type (",
      "\tOrder struct {",
      "\t\tTotal int",
      "\t}",
      "\tID string",
      ")",
      "",
      "func Run() {",
      "\tconst local = 1",
      "}",
    ].join("\n");
    expect(declaredSymbols("features/flags.go", go))
      .toEqual(["FeedOutside", "ErrClosed", "ErrGone", "Low", "High", "defaults", "Order", "ID", "Run"]);
  });

  it("takes a constant that keeps its value under a new name for a rename, not a removal", () => {
    const go = (name: string) => `package features\n\nconst ${name} = "feed-outside"\n`;
    expect([...removedSymbols([{ path: "flags.go", before: go("FeedOutside"), after: go("FeedInside") }])]).toEqual([]);
    expect([...removedSymbols([{ path: "flags.go", before: go("FeedOutside"), after: "package features\n" }])]).toEqual(["FeedOutside"]);
    expect([...removedSymbols([{ path: "flags.ts", before: "export const FEED_OUTSIDE = \"feed-outside\";\n", after: "export const FEED_INSIDE = \"feed-outside\";\n" }])])
      .toEqual([]);
    // A function of one line still says too little to tell a rename.
    expect([...removedSymbols([{ path: "math.go", before: "package m\n\nfunc Max() int { return 1 }\n", after: "package m\n\nfunc Top() int { return 1 }\n" }])])
      .toEqual(["Max"]);
  });

  it("tells a test that went with its code through a helper the change removed from its file", () => {
    const before = [
      "describe(\"feed\", () => {",
      "  const flag = (on: boolean) => queryClient.setQueryData(key, { flags: { [FEED_OUTSIDE]: on } });",
      "  const user = makeUser();",
      "  it(\"renders the list\", () => {",
      "    render(<Feed user={user} />);",
      "  });",
      "  it(\"shows nothing while the flag is off\", () => {",
      "    flag(false);",
      "    const result = FEED_OUTSIDE;",
      "    expect(screen.queryByRole(\"list\")).toBeNull();",
      "  });",
      "  it(\"keeps the user\", () => {",
      "    expect(result).toBe(user);",
      "  });",
      "});",
      "",
    ].join("\n");
    const after = "describe(\"feed\", () => {\n  const user = makeUser();\n  it(\"renders the list\", () => {\n    render(<Feed user={user} />);\n  });\n});\n";
    const gone = new Set(["FEED_OUTSIDE"]);

    // A local of an obsolete test is no helper: the test that names `result` still blocks.
    expect(testChanges([{ path: "feed.test.tsx", before, after }], gone)).toEqual({
      deleted: [],
      removed: ["feed.test.tsx: test keeps the user removed"],
      renamed: [],
      obsolete: ["feed.test.tsx: test shows nothing while the flag is off removed with the code it tested"],
    });
    const throughHelper = before.replace("    const result = FEED_OUTSIDE;\n", "");
    expect(testChanges([{ path: "feed.test.tsx", before: throughHelper, after }], gone)).toMatchObject({
      obsolete: ["feed.test.tsx: test shows nothing while the flag is off removed with the code it tested (through helper flag)"],
    });
    // A helper the change keeps, one whose text names no removed code, or a mention in a string or a
    // comment keeps the test removed.
    const kept = after.replace("  const user", "  const flag = (on: boolean) => queryClient.setQueryData(key, { flags: { [FEED_OUTSIDE]: on } });\n  const user");
    expect(testChanges([{ path: "feed.test.tsx", before: throughHelper, after: kept }], gone))
      .toMatchObject({ obsolete: [], removed: expect.arrayContaining(["feed.test.tsx: test shows nothing while the flag is off removed"]) });
    expect(testChanges([{ path: "feed.test.tsx", before: throughHelper, after }], new Set(["Other"])))
      .toMatchObject({ obsolete: [], removed: expect.arrayContaining(["feed.test.tsx: test shows nothing while the flag is off removed"]) });
    const quoted = throughHelper.replace("    flag(false);", "    // the flag is off by default\n    expect(\"flag\").toBeTruthy();");
    expect(testChanges([{ path: "feed.test.tsx", before: quoted, after }], gone)).toMatchObject({ obsolete: [] });
  });

  it("keeps a test removed when the helper it used did more than the removed code", () => {
    const file = (helper: string) => [
      "describe(\"feed\", () => {",
      helper,
      "  it(\"renders the list\", () => {",
      "    renderFeed();",
      "    expect(screen.getByRole(\"list\")).toBeVisible();",
      "  });",
      "  it(\"renders the user\", () => {",
      "    renderFeed();",
      "    expect(screen.getByText(\"Ada\")).toBeVisible();",
      "  });",
      "});",
      "",
    ].join("\n");
    const gone = new Set(["FEED_OUTSIDE"]);
    const broad = "  const renderFeed = () => {\n    setFlags({ [FEED_OUTSIDE]: true });\n    render(<Feed user={ada} />);\n  };";
    const note = " (helper renderFeed also did more than the removed code, in \"render(<Feed user={ada} />);\": edit it and keep the tests that use it)";
    expect(testChanges([{ path: "feed.test.tsx", before: file(broad), after: "describe(\"feed\", () => {});\n" }], gone)).toEqual({
      deleted: [],
      removed: [`feed.test.tsx: test renders the list removed${note}`, `feed.test.tsx: test renders the user removed${note}`],
      renamed: [],
      obsolete: [],
    });
    expect(testChanges([{ path: "feed.test.tsx", before: file(broad), after: "", deleted: true }], gone))
      .toMatchObject({ deleted: [`feed.test.tsx: test file deleted${note}`], obsolete: [] });
    // A helper whose every statement uses the removed code went with it, block or expression.
    const narrow = "  function renderFeed() {\n    setFlags({ [FEED_OUTSIDE]: true });\n    return;\n  }";
    expect(testChanges([{ path: "feed.test.tsx", before: file(narrow), after: "", deleted: true }], gone))
      .toMatchObject({ obsolete: ["feed.test.tsx: test file deleted with the code it tested (through helper renderFeed)"] });
    const python = "def render_feed(client):\n    client.flags = {FEED_OUTSIDE: True}\n    client.render()\n\n\ndef test_list(client):\n    render_feed(client)\n";
    expect(testChanges([{ path: "tests/test_feed.py", before: python, after: "" }], gone))
      .toMatchObject({ obsolete: [], removed: [expect.stringContaining("test test_list removed (helper render_feed also did more")] });
  });

  it("follows a helper one level only", () => {
    const before = "FLAGS = {FEED_OUTSIDE: True}\n\n\ndef enable(client):\n    client.flags = FLAGS\n\n\ndef test_on(client):\n    enable(client)\n";
    expect(testChanges([{ path: "tests/test_flags.py", before, after: "" }], new Set(["FEED_OUTSIDE"])))
      .toMatchObject({ removed: ["tests/test_flags.py: test test_on removed"], obsolete: [] });
  });

  it("ends a test at its closing bracket, so a helper after it is not its text", () => {
    const before = "describe(\"feed\", () => {\n  it(\"renders the list\", () => {\n    render(x);\n  });\n  const flag = (on: boolean) => set({ [FEED_OUTSIDE]: on });\n  it(\"adds\", () => {\n    expect(sum(1, 2)).toBe(3);\n  });\n});\n";
    const after = "describe(\"feed\", () => {\n  it(\"adds\", () => {\n    expect(sum(1, 2)).toBe(3);\n  });\n});\n";
    expect(testChanges([{ path: "feed.test.tsx", before, after }], new Set(["FEED_OUTSIDE"])))
      .toMatchObject({ removed: ["feed.test.tsx: test renders the list removed"], obsolete: [] });
  });

  it.each([
    {
      stack: "Go",
      path: "flags_test.go",
      before: "package features\n\nfunc TestOn(t *testing.T) {\n\tenable(t)\n}\n\nfunc enable(t *testing.T) {\n\tt.Helper()\n\tt.Setenv(\"FLAG\", FeedOutside)\n}\n\nfunc TestKept(t *testing.T) {}\n",
      after: "package features\n\nfunc TestKept(t *testing.T) {}\n",
      test: "TestOn",
      helperName: "enable",
    },
    {
      stack: "Python",
      path: "tests/test_flags.py",
      before: "FLAGS = {FEED_OUTSIDE: True}\n\n\ndef test_on(client):\n    client.flags = FLAGS\n\n\ndef test_kept():\n    pass\n",
      after: "def test_kept():\n    pass\n",
      test: "test_on",
      helperName: "FLAGS",
    },
    {
      stack: "Java",
      path: "FlagsTest.java",
      before: "class FlagsTest {\n  private static final String FLAG = Flags.FEED_OUTSIDE;\n\n  @Test\n  void on() {\n    assertTrue(enabled(FLAG));\n  }\n\n  @Test\n  void kept() {}\n}\n",
      after: "class FlagsTest {\n  @Test\n  void kept() {}\n}\n",
      test: "on",
      helperName: "FLAG",
    },
  ])("follows a $stack helper one level to the code it used", ({ path, before, after, test, helperName }) => {
    const gone = new Set(["FeedOutside", "FEED_OUTSIDE"]);
    const helper = /through helper (\w+)/u;
    const { obsolete, removed } = testChanges([{ path, before, after }], gone);
    expect(removed).toEqual([]);
    expect(obsolete).toEqual([expect.stringMatching(new RegExp(`^${path}: test ${test} removed with the code it tested \\(through helper \\w+\\)$`, "u"))]);
    expect(helper.test(obsolete[0]!)).toBe(true);
    // A deleted test file goes with its code when every test it lost did, through helpers too.
    expect(testChanges([{ path, before: before.replace(/\n[^\n]*[Kk]ept[\s\S]*$/u, "\n"), after: "", deleted: true }], gone))
      .toMatchObject({ deleted: [], obsolete: [`${path}: test file deleted with the code it tested (through helper ${helperName})`] });
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

  it("reports a test renamed in place by default and blocks it when the policy says so", async () => {
    const { root, git } = await repository({
      "a.test.ts": "it('adds', f)\nit('rounds down', f)\nit('subtracts', f)\n",
    });
    await git("checkout", "-q", "-b", "feature");
    await writeFile(join(root, "a.test.ts"), "it('adds', f)\nit('rounds half up', f)\nit('subtracts', f)\n");

    expect(await provider().run("change-integrity", await request(root))).toMatchObject({
      status: "passed",
      summary: "1 change(s) reported, none blocking",
      details: ["a.test.ts: test rounds down renamed to rounds half up (reported: test-renamed=report)"],
    });
    // Relaxing another kind keeps the default of this one.
    expect(await provider().run("change-integrity", await request(root, { finding_policy: ["test-removed=report"] })))
      .toMatchObject({ status: "passed", summary: "1 change(s) reported, none blocking" });
    const blocked = await provider().run("change-integrity", await request(root, { finding_policy: ["test-renamed=block"] }));
    expect(blocked.status).toBe("failed");
    expect(blocked.details[0]).toBe("a.test.ts: test rounds down renamed to rounds half up");
  });

  it("reports the relaxed kinds of finding and still blocks a protected configuration", async () => {
    const { root, git } = await repository({
      ".golangci.yml": "version: \"2\"\n",
      "a.go": "package a\n",
      "a_test.go": "package a\n\nfunc TestA(t *testing.T) {}\nfunc TestB(t *testing.T) {}\n",
    });
    await git("checkout", "-q", "-b", "feature");
    await writeFile(join(root, "a.go"), "package a\n\nfunc A() {} //nolint:all\n");
    await writeFile(join(root, "a_test.go"), "package a\n\nfunc TestA(t *testing.T) {}\n");
    const relaxed = ["suppression=report", "test-removed=report"];

    expect(await provider().run("change-integrity", await request(root, { finding_policy: relaxed }))).toMatchObject({
      status: "passed",
      details: [
        "a.go:3: lint suppression: func A() {} //nolint:all (reported: suppression=report)",
        "a_test.go: test TestB removed (reported: test-removed=report)",
      ],
    });

    await writeFile(join(root, ".golangci.yml"), "version: \"2\"\nlinters: {default: none}\n");
    const protectedChange = await provider().run("change-integrity", await request(root, { finding_policy: [...relaxed, "protected-config=report"] }));
    expect(protectedChange.status).toBe("failed");
    expect(protectedChange.details[0]).toBe(".golangci.yml: protected quality configuration changed");
  });

  it("reports a test removed with code the change deleted from the repository and blocks one whose code survives", async () => {
    const { root, git } = await repository({
      "orders.go": "package orders\n\nfunc Total() int { return 1 }\n\nfunc Refund() int { return 2 }\n",
      "orders_test.go": "package orders\n\nfunc TestTotal(t *testing.T) { Total() }\nfunc TestRefund(t *testing.T) { Refund() }\n",
      "legacy.go": "package orders\n\nfunc Legacy() {}\n",
      "legacy_test.go": "package orders\n\nfunc TestLegacy(t *testing.T) { Legacy() }\n",
    });
    await git("checkout", "-q", "-b", "feature");
    await writeFile(join(root, "orders.go"), "package orders\n\nfunc Refund() int { return 2 }\n");
    await writeFile(join(root, "orders_test.go"), "package orders\n\nfunc TestRefund(t *testing.T) { Refund() }\n");
    await rm(join(root, "legacy.go"));
    await rm(join(root, "legacy_test.go"));

    expect(await provider().run("change-integrity", await request(root))).toMatchObject({
      status: "passed",
      details: [
        "legacy_test.go: test file deleted with the code it tested (reported: test-obsolete=report)",
        "orders_test.go: test TestTotal removed with the code it tested (reported: test-obsolete=report)",
      ],
    });

    // Another file still uses Total, so it was not removed from the repository.
    await writeFile(join(root, "report.go"), "package orders\n\nvar total = Total\n");
    const kept = await provider().run("change-integrity", await request(root));
    expect(kept.status).toBe("failed");
    expect(kept.details[0]).toBe("orders_test.go: test TestTotal removed");
  });

  it.each([
    {
      stack: "TypeScript",
      code: ["src/math.ts", "export function add(a: number, b: number) {\n  return a + b;\n}\n\nexport function sub(a: number, b: number) {\n  return a - b;\n}\n"],
      kept: "export function sub(a: number, b: number) {\n  return a - b;\n}\n",
      test: ["src/math.test.ts", "import { add, sub } from './math';\n\nit('adds', () => {\n  expect(add(1, 2)).toBe(3);\n});\n\nit('subtracts', () => {\n  expect(sub(2, 1)).toBe(1);\n});\n"],
      left: "import { sub } from './math';\n\nit('subtracts', () => {\n  expect(sub(2, 1)).toBe(1);\n});\n",
      removed: "src/math.test.ts: test adds removed with the code it tested",
    },
    {
      stack: "Python",
      code: ["shop/orders.py", "def order_total(items):\n    return sum(items)\n\n\ndef order_count(items):\n    return len(items)\n"],
      kept: "def order_count(items):\n    return len(items)\n",
      test: ["tests/test_orders.py", "from shop.orders import order_count, order_total\n\n\ndef test_order_total():\n    assert order_total([1, 2]) == 3\n\n\ndef test_order_count():\n    assert order_count([1, 2]) == 2\n"],
      left: "from shop.orders import order_count\n\n\ndef test_order_count():\n    assert order_count([1, 2]) == 2\n",
      removed: "tests/test_orders.py: test test_order_total removed with the code it tested",
    },
    {
      stack: "Java",
      code: ["src/main/java/shop/Orders.java", "package shop;\n\npublic class Orders {\n  public static int orderTotal(int a, int b) {\n    return a + b;\n  }\n\n  public static int orderCount(int a) {\n    return a;\n  }\n}\n"],
      kept: "package shop;\n\npublic class Orders {\n  public static int orderCount(int a) {\n    return a;\n  }\n}\n",
      test: ["src/test/java/shop/OrdersTest.java", "package shop;\n\nclass OrdersTest {\n  @Test\n  void totalsAnOrder() {\n    assertEquals(3, Orders.orderTotal(1, 2));\n  }\n\n  @Test\n  void countsAnOrder() {\n    assertEquals(1, Orders.orderCount(1));\n  }\n}\n"],
      left: "package shop;\n\nclass OrdersTest {\n  @Test\n  void countsAnOrder() {\n    assertEquals(1, Orders.orderCount(1));\n  }\n}\n",
      removed: "src/test/java/shop/OrdersTest.java: test totalsAnOrder removed with the code it tested",
    },
  ])("reports a $stack test removed with the code it tested and blocks it while the code stays", async ({ code, kept, test, left, removed }) => {
    const { root, git } = await repository({ [code[0]!]: code[1]!, [test[0]!]: test[1]! });
    await git("checkout", "-q", "-b", "feature");
    await writeFile(join(root, test[0]!), left);

    const blocked = await provider().run("change-integrity", await request(root));
    expect(blocked.status).toBe("failed");
    expect(blocked.details[0]).toBe(removed.replace(" with the code it tested", ""));

    await writeFile(join(root, code[0]!), kept);
    expect(await provider().run("change-integrity", await request(root))).toMatchObject({
      status: "passed",
      details: [`${removed} (reported: test-obsolete=report)`],
    });
  });

  it("blocks a test removed when its code only took a new name", async () => {
    const { root, git } = await repository({
      "orders.go": "package orders\n\n// Total adds the items.\nfunc Total(items []int) int {\n\tsum := 0\n\tfor _, item := range items {\n\t\tsum += item\n\t}\n\treturn sum\n}\n\n// Count counts the items.\nfunc Count(items []int) int {\n\treturn len(items)\n}\n",
      "orders_test.go": "package orders\n\nfunc TestTotal(t *testing.T) {\n\tif Total([]int{1, 2}) != 3 {\n\t\tt.Fatal(\"total\")\n\t}\n}\n",
    });
    await git("checkout", "-q", "-b", "feature");
    await writeFile(join(root, "orders.go"), "package orders\n\n// Sum adds the items.\nfunc Sum(items []int) int {\n\tsum := 0\n\tfor _, item := range items {\n\t\tsum += item\n\t}\n\treturn sum\n}\n\n// Count counts the items.\nfunc Count(items []int) int {\n\treturn len(items)\n}\n");
    await writeFile(join(root, "orders_test.go"), "package orders\n");

    const renamed = await provider().run("change-integrity", await request(root));
    expect(renamed.status).toBe("failed");
    expect(renamed.details[0]).toBe("orders_test.go: test TestTotal removed");

    // Code that changed as well as its name is gone from the repository, and so is its test.
    await writeFile(join(root, "orders.go"), "package orders\n\n// Sum adds the items.\nfunc Sum(items []int) int {\n\treturn 0\n}\n\n// Count counts the items.\nfunc Count(items []int) int {\n\treturn len(items)\n}\n");
    expect(await provider().run("change-integrity", await request(root)))
      .toMatchObject({ status: "passed", details: ["orders_test.go: test TestTotal removed with the code it tested (reported: test-obsolete=report)"] });
  });

  it("reports a test removed with a shipped flag and the helper that set it", async () => {
    const flagTest = (extra: string) => [
      "import { FEED_OUTSIDE } from './outside';",
      "",
      "describe('feed', () => {",
      "  const flag = (on: boolean) => queryClient.setQueryData(key, { flags: { [FEED_OUTSIDE]: on } });",
      "",
      "  it('renders the list', () => {",
      "    render(<Feed />);",
      "  });",
      extra,
      "});",
      "",
    ].join("\n");
    const offState = "\n  it('shows nothing while the flag is off', () => {\n    flag(false);\n    expect(screen.queryByRole('list')).toBeNull();\n  });";
    const { root, git } = await repository({
      "src/outside.ts": "export const FEED_OUTSIDE = \"feed-outside\";\nexport const FEED_INSIDE = \"feed-inside\";\n",
      "src/feed.test.tsx": flagTest(offState),
    });
    await git("checkout", "-q", "-b", "feature");
    await writeFile(join(root, "src/feed.test.tsx"), "describe('feed', () => {\n  it('renders the list', () => {\n    render(<Feed />);\n  });\n});\n");

    // The flag still ships: the test is removed.
    const blocked = await provider().run("change-integrity", await request(root));
    expect(blocked.status).toBe("failed");
    expect(blocked.details[0]).toBe("src/feed.test.tsx: test shows nothing while the flag is off removed");

    await writeFile(join(root, "src/outside.ts"), "export const FEED_INSIDE = \"feed-inside\";\n");
    expect(await provider().run("change-integrity", await request(root))).toMatchObject({
      status: "passed",
      details: ["src/feed.test.tsx: test shows nothing while the flag is off removed with the code it tested (through helper flag) (reported: test-obsolete=report)"],
    });

    // A flag that only took a new name, with its value, is not removed code.
    await writeFile(join(root, "src/outside.ts"), "export const FEED_ELSEWHERE = \"feed-outside\";\nexport const FEED_INSIDE = \"feed-inside\";\n");
    expect((await provider().run("change-integrity", await request(root))).status).toBe("failed");
  });

  it("reports a Go test removed with a flag constant from a grouped declaration", async () => {
    const { root, git } = await repository({
      "features/flags.go": "package features\n\nconst (\n\tFeedOutside = \"feed-outside\"\n\tFeedInside  = \"feed-inside\"\n)\n",
      "features/flags_test.go": "package features\n\nfunc TestFeedOutside(t *testing.T) {\n\tif FeedOutside == \"\" {\n\t\tt.Fatal(\"empty\")\n\t}\n}\n\nfunc TestFeedInside(t *testing.T) {\n\tif FeedInside == \"\" {\n\t\tt.Fatal(\"empty\")\n\t}\n}\n",
    });
    await git("checkout", "-q", "-b", "feature");
    await writeFile(join(root, "features/flags.go"), "package features\n\nconst (\n\tFeedInside = \"feed-inside\"\n)\n");
    await writeFile(join(root, "features/flags_test.go"), "package features\n\nfunc TestFeedInside(t *testing.T) {\n\tif FeedInside == \"\" {\n\t\tt.Fatal(\"empty\")\n\t}\n}\n");

    expect(await provider().run("change-integrity", await request(root))).toMatchObject({
      status: "passed",
      details: ["features/flags_test.go: test TestFeedOutside removed with the code it tested (reported: test-obsolete=report)"],
    });
  });

  it("does not take a test's own name for a use of the code it shares the name with", () => {
    const java = (body: string) => `class OrdersTest {\n  @Test\n  void orderTotal() {\n    ${body}\n  }\n}\n`;
    expect(testChanges([{ path: "OrdersTest.java", before: java("assertTrue(true);"), after: "class OrdersTest {}\n" }], new Set(["orderTotal"])))
      .toMatchObject({ removed: ["OrdersTest.java: test orderTotal removed"], obsolete: [] });
    expect(testChanges([{ path: "OrdersTest.java", before: java("assertEquals(3, Orders.orderTotal(1, 2));"), after: "class OrdersTest {}\n" }], new Set(["orderTotal"])))
      .toMatchObject({ removed: [], obsolete: ["OrdersTest.java: test orderTotal removed with the code it tested"] });
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
    expect(over).toMatchObject({ status: "failed", details: ["b.go: 5", expect.stringContaining("Split the change"), expect.stringContaining("Railguard-Request")] });
  });

  it("counts every new text file however large and skips only binary files", async () => {
    const { root, git } = await repository({ "a.go": "package a\n" });
    await git("checkout", "-q", "-b", "feature");
    await writeFile(join(root, "large.go"), `${"x".repeat(1023)}\n`.repeat(3 * 1024));
    await writeFile(join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a, 0x0a]));
    await writeFile(join(root, "late-nul.go"), `package a\n${"// padding\n".repeat(1000)}\0\n`);

    const outcome = await provider().run("change-size", await request(root, { max_changed_lines: ["400"] }));

    expect(outcome).toMatchObject({ status: "failed", details: ["large.go: 3072", "late-nul.go: 1002", expect.any(String), expect.any(String)] });
  });

  it("fails integrity for a text file too large to scan", async () => {
    const { root, git } = await repository({ "a.go": "package a\n" });
    await git("checkout", "-q", "-b", "feature");
    await writeFile(join(root, "huge.go"), `${"x".repeat(1023)}\n`.repeat(17 * 1024));

    const outcome = await provider().run("change-integrity", await request(root));

    expect(outcome).toMatchObject({ status: "failed", details: [expect.stringMatching(/^huge\.go: too large to scan/u), expect.any(String), expect.any(String)] });
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

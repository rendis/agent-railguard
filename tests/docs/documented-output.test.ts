import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTempRepository } from "../helpers/temp-repository.js";

// The visual guide and the README quote Railguard's real output. This replays the guide's session on a
// synthetic Go service with the built binary and fails when a quoted message no longer matches.

const execute = promisify(execFile);
const cliPath = resolve("dist/cli.js");
const guide = readFileSync(resolve("docs/guide/index.html"), "utf8");
const readme = readFileSync(resolve("README.md"), "utf8");

const git = { GIT_AUTHOR_NAME: "demo", GIT_AUTHOR_EMAIL: "demo@example.test", GIT_COMMITTER_NAME: "demo", GIT_COMMITTER_EMAIL: "demo@example.test" };

/** Whitespace-insensitive text: tags and entities removed, so a message wrapped or highlighted in a page still matches. */
function flat(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/\\n/g, " ")
    .replace(/\s+/g, " ");
}

const ORDERS = `package orders

import "errors"

// ErrNotPaid is returned when an order cannot be refunded yet.
var ErrNotPaid = errors.New("order not paid")

// Order is a customer order.
type Order struct {
\tID    string
\tTotal int
\tPaid  bool
}

// Total returns the sum of the order lines.
func Total(lines []int) int {
\tsum := 0
\tfor _, l := range lines {
\t\tsum += l
\t}
\treturn sum
}
`;
const ORDERS_TEST = `package orders

import "testing"

func TestTotal(t *testing.T) {
\tif got := Total([]int{2, 3}); got != 5 {
\t\tt.Fatalf("Total = %d, want 5", got)
\t}
}
`;
const refund = (body: string, suppression = "") => `package orders

// Refund returns the amount to give back for a paid order, minus a 10% restocking fee.
func Refund(o Order) (int, error) {${suppression}
\tif !o.Paid {
\t\treturn 0, ErrNotPaid
\t}
\treturn ${body}, nil
}
`;
const REFUND_TEST = `package orders

import (
\t"errors"
\t"testing"
)

func TestRefundUnpaid(t *testing.T) {
\tif _, err := Refund(Order{Total: 50}); !errors.Is(err, ErrNotPaid) {
\t\tt.Fatalf("err = %v, want ErrNotPaid", err)
\t}
}

func TestRefundPaid(t *testing.T) {
\tgot, _ := Refund(Order{Total: 50, Paid: true})
\tif got != 45 {
\t\tt.Fatalf("Refund = %d, want 45 (10%% restocking fee)", got)
\t}
}
`;

let root = "";
let cleanup = async () => {};
const output: Record<string, string> = {};

async function run(command: string, args: readonly string[], stdin = ""): Promise<string> {
  return await new Promise((done, fail) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...git, NO_COLOR: "1", RAILGUARD_NO_UPDATE_CHECK: "1", CLAUDE_PROJECT_DIR: root },
    });
    let text = "";
    child.stdout.on("data", (chunk: Buffer) => { text += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { text += chunk.toString(); });
    child.on("error", fail);
    child.on("close", () => done(text));
    child.stdin.end(stdin);
  });
}

const railguard = (args: readonly string[], stdin = "") => run(process.execPath, [cliPath, ...args], stdin);
const hook = (name: string, input: object) => railguard(["hook", name, "--harness", "claude-code"], JSON.stringify({ session_id: "guide", cwd: root, ...input }));
const commit = (message: string) => run("git", ["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", message]);

beforeAll(async () => {
  await execute(process.execPath, ["esbuild.config.mjs"], { cwd: resolve(".") });
  const repository = await createTempRepository({ "go.mod": "module example.com/orders\n\ngo 1.24\n", "main.go": "package main\n\nfunc main() {}\n" });
  root = repository.root;
  cleanup = repository.cleanup;
  await run("git", ["init", "--quiet", "--initial-branch=main"]);
  await run("git", ["add", "-A"]);
  await commit("init");
  output.init = await railguard(["init", "--add", "pack:go-service-foundation", "--harness", "claude-code", "--yes"]);
  await mkdir(join(root, "internal/orders"), { recursive: true });
  await writeFile(join(root, "internal/orders/orders.go"), ORDERS);
  await writeFile(join(root, "internal/orders/orders_test.go"), ORDERS_TEST);
  await run("git", ["add", "-A"]);
  await commit("feat: add orders");
  await run("git", ["checkout", "--quiet", "-b", "feat/refunds"]);

  // Before acting: the agent tries to skip the hooks.
  output.guard = await hook("guard", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: 'git commit --no-verify -m "chore: remove flaky test"' } });
  // On each edit: the agent silences the linter.
  const refundPath = join(root, "internal/orders/refund.go");
  await writeFile(refundPath, refund("o.Total", " //nolint:all"));
  output.edit = await hook("edit", { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: refundPath, content: "" }, tool_response: { success: true } });
  // When the turn ends: a broken test sends the turn back.
  await writeFile(refundPath, refund("o.Total"));
  await writeFile(join(root, "internal/orders/refund_test.go"), REFUND_TEST);
  output.stop = await hook("stop", { hook_event_name: "Stop", stop_hook_active: false });
  // The fix passes the same check.
  await writeFile(refundPath, refund("o.Total - o.Total/10"));
  output.check = await railguard(["check", "--changed"]);
  await run("git", ["add", "-A"]);
  await commit("feat: add refunds");
  // Commit: a deleted test file is what the pre-commit gate runs `check --changed` on.
  await run("git", ["rm", "--quiet", "internal/orders/orders_test.go"]);
  output.deletedTest = await railguard(["check", "--changed"]);
  await run("git", ["reset", "--quiet", "--hard"]);
  output.files = ["AGENTS.md", ".claude/settings.json", ".railguard/hooks/pre-commit", ".railguard/hooks/pre-push", ".railguard/agent-hooks/edit"]
    .map((file) => readFileSync(join(root, file), "utf8")).join("\n");
}, 240_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await cleanup();
});

const quoted: readonly { readonly from: string; readonly in: readonly ("guide" | "readme")[]; readonly text: string }[] = [
  { from: "guard", in: ["guide", "readme"], text: "Do not skip the Git hooks: they run the checks this repository requires. Fix what fails instead." },
  { from: "edit", in: ["guide", "readme"], text: "Railguard found problems in internal/orders/refund.go right after your edit. Fix the cause now instead of hiding it:" },
  { from: "edit", in: ["guide", "readme"], text: "FAIL change-guard/integrity 1 change(s) weaken what the checks can see" },
  { from: "edit", in: ["guide", "readme"], text: "internal/orders/refund.go:4: lint suppression" },
  { from: "edit", in: ["guide"], text: "ok secret-guard/secrets No secret in the change" },
  { from: "edit", in: ["guide"], text: "additionalContext" },
  { from: "stop", in: ["guide"], text: "Railguard `check --changed` failed for this change (attempt 1 of 3). Fix every failure below without weakening tests or checks, then finish again." },
  { from: "stop", in: ["guide"], text: "FAIL go-quality/test Tests failed for ./internal/orders" },
  { from: "stop", in: ["guide"], text: "refund_test.go:17: Refund = 50, want 45 (10% restocking fee)" },
  { from: "check", in: ["guide"], text: "ok change-guard/integrity No suppression, removed test" },
  { from: "check", in: ["guide"], text: "ok go-architecture/imports Dependency rules hold" },
  { from: "check", in: ["guide"], text: "ok go-quality/format 2 Go file(s) formatted" },
  { from: "check", in: ["guide"], text: "ok go-quality/vet go vet passed for ./internal/orders" },
  { from: "check", in: ["guide"], text: "ok go-quality/test Tests passed for ./internal/orders" },
  { from: "check", in: ["guide"], text: "Result: PASSED — 6 passed" },
  { from: "deletedTest", in: ["guide"], text: "internal/orders/orders_test.go: test file deleted" },
  { from: "deletedTest", in: ["guide"], text: "Never add a `Railguard-Allow` trailer yourself: only a person may accept what the branch holds so far" },
  { from: "files", in: ["guide"], text: "After you edit files, Railguard reports suppressions, weakened quality configuration or secrets in them; fix the cause in that edit instead of hiding it." },
  { from: "files", in: ["guide"], text: '"matcher": "Bash|Write|Edit|MultiEdit|NotebookEdit"' },
  { from: "files", in: ["guide"], text: '.railguard/bin/railguard hook edit --harness "$1"' },
  { from: "files", in: ["guide"], text: "railguard check --changed" },
  { from: "files", in: ["guide"], text: "railguard verify --changed" },
];

describe("output quoted in the visual guide and the README", () => {
  it("applies the pack the guide installs", () => {
    expect(output.init).toContain("SUCCEEDED");
  });

  it.each(quoted)("$from: $text", ({ from, in: documents, text }) => {
    expect(flat(output[from] ?? "")).toContain(text);
    for (const document of documents) expect(flat(document === "guide" ? guide : readme)).toContain(text);
  });
});

import { execFile } from "node:child_process";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { NodeChangeSetReader } from "../../src/adapters/platform/git/node-change-set-reader.js";
import { NodeProcessRunner } from "../../src/adapters/platform/process/node-process-runner.js";
import { ChangeCheckProvider, ChangeReview } from "../../src/adapters/verification/change-check-provider.js";
import { parseReviewInput } from "../../src/domain/verification/change-review.js";
import {
  changedLineCount,
  globToRegExp,
  parseAllowances,
  suppressionFindings,
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

  it("counts new files by lines and accepts only allowances with a reason", () => {
    expect(changedLineCount("a\nb\n", "all")).toBe(2);
    expect(changedLineCount("", new Set([1, 2, 3]))).toBe(3);
    expect(parseAllowances("fix\n\nRailguard-Allow: change-size: generated client\nRailguard-Allow: change-integrity:")).toEqual(
      new Map([["change-size", "generated client"]]),
    );
  });
});

describe("review input", () => {
  it("rejects a review that cannot be checked", () => {
    expect(parseReviewInput([])).toEqual({ errors: ["The review must be a JSON object with a criteria array."] });
    expect(parseReviewInput({ criteria: [] })).toEqual({ errors: ["criteria must be a non-empty array."] });
    expect(parseReviewInput({ criteria: [null, { status: "done" }, { handoff: "h", criterion: "c", status: "met" }, { handoff: "h", criterion: "c", status: "not_applicable" }] })).toEqual({
      errors: [
        "criteria[0] must be an object.",
        "criteria[1].handoff must name the handoff family or id.",
        "criteria[1].criterion must state the criterion.",
        "criteria[1].status must be met, not_met or not_applicable.",
        "criteria[2] is met but cites no evidence.",
        "criteria[3] is not_applicable but gives no note explaining why.",
      ],
    });
  });

  it("keeps notes and names an unspecified reviewer", () => {
    expect(parseReviewInput({ criteria: [{ handoff: "h", criterion: "c", status: "not_applicable", note: " out of scope " }] })).toEqual({
      reviewer: "unspecified",
      criteria: [{ handoff: "h", criterion: "c", status: "not_applicable", evidence: [], note: "out of scope" }],
    });
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

  it("accepts a protected configuration the change adds", async () => {
    const { root, git } = await repository({ "a.go": "package a\n" });
    await git("checkout", "-q", "-b", "feature");
    await mkdir(join(root, ".railguard"));
    await writeFile(join(root, ".railguard/project.yaml"), "schema: railguard/project/v1\n");

    const outcome = await provider().run("change-integrity", await request(root, { protected_paths: [".railguard/project.yaml"] }));

    expect(outcome.status).toBe("passed");
  });

  it("passes a finding a person accepted with a commit trailer", async () => {
    const { root, git } = await repository({ "a.go": "package a\n" });
    await git("checkout", "-q", "-b", "feature");
    await writeFile(join(root, "a.go"), "package a\n\nfunc A() {} //nolint:all\n");
    await git("commit", "-qam", "legacy lint\n\nRailguard-Allow: change-integrity: generated code");

    const outcome = await provider().run("change-integrity", await request(root));

    expect(outcome).toMatchObject({ status: "passed", summary: "Accepted by Railguard-Allow: generated code" });
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
});

describe("ChangeReview", () => {
  it("requires a current review of the change against every active handoff", async () => {
    const { root, git } = await repository({ "a.go": "package a\n", ".gitignore": ".knowledge-os-handoffs/\n" });
    await handoff(root, "work-1--svc", "v0001");
    await git("checkout", "-q", "-b", "feature");
    await writeFile(join(root, "a.go"), "package a\n\nfunc A() int { return 1 }\n");
    const review = new ChangeReview(process, changeSets);

    const missing = await review.evaluate(root, await changeSets.read(root));
    expect(missing.status).toBe("failed");
    expect(missing.details.join("\n")).toContain(".knowledge-os-handoffs/work-1--svc/scope.md");

    const invalid = await record(review, root, [{ handoff: "work-1--svc", criterion: "A returns 1", status: "met", evidence: ["a.go:99"] }]);
    expect(invalid).toEqual({ ok: false, message: 'Evidence a.go:99 for "A returns 1" does not exist.' });

    const unmet = await record(review, root, [
      { handoff: "work-1--svc", criterion: "A returns 1", status: "met", evidence: ["a.go:3"] },
      { handoff: "work-1--svc", criterion: "B exists", status: "not_met", evidence: [] },
    ]);
    expect(unmet.ok).toBe(false);
    expect((await review.evaluate(root, await changeSets.read(root))).summary).toBe("1 handoff criterion(s) not met");

    expect(await record(review, root, [
      { handoff: "work-1--svc", criterion: "A returns 1", status: "met", evidence: ["a.go:3"] },
    ])).toMatchObject({ ok: true });
    expect((await review.evaluate(root, await changeSets.read(root))).status).toBe("passed");

    await writeFile(join(root, "a.go"), "package a\n\nfunc A() int { return 2 }\n");
    expect((await review.evaluate(root, await changeSets.read(root))).details[0]).toBe(
      "The change was modified after the recorded review.",
    );

    await handoff(root, "work-1--svc", "v0002");
    expect((await review.evaluate(root, await changeSets.read(root))).details).toContain(
      "Handoff work-1--svc v0002 was not part of the recorded review.",
    );
  });

  it("briefs the reviewer and refuses to record without a handoff or a readable review", async () => {
    const { root, git } = await repository({ "a.go": "package a\n", ".gitignore": ".knowledge-os-handoffs/\n" });
    const review = new ChangeReview(process, changeSets);
    expect(await review.brief(root)).toContain("nothing to review");
    expect(await review.record(root, join(root, "missing.json"))).toEqual({ ok: false, message: "No active handoff to record a review for." });

    await handoff(root, "work-2--svc", "v0001");
    await git("checkout", "-q", "-b", "feature");
    await writeFile(join(root, "a.go"), "package a\n\nvar A = 1\n");
    expect(await review.brief(root)).toContain("Review status: failed — This change has no current review against its handoff");
    expect((await review.record(root, join(root, "missing.json"))).message).toMatch(/^Cannot read the review/u);
    expect(await provider().run("change-review", { ...(await request(root)), changes: null })).toMatchObject({ status: "skipped" });
  });

  it("skips a repository without an active handoff", async () => {
    const { root, git } = await repository({ "a.go": "package a\n" });
    await git("checkout", "-q", "-b", "feature");
    await writeFile(join(root, "a.go"), "package b\n");

    const outcome = await new ChangeReview(process, changeSets).evaluate(root, await changeSets.read(root));

    expect(outcome).toMatchObject({ status: "skipped", summary: "No active handoff to review against" });
  });
});

function provider(): ChangeCheckProvider {
  return new ChangeCheckProvider(process, new ChangeReview(process, changeSets));
}

async function request(root: string, inputs: Record<string, readonly string[]> = {}): Promise<CheckRequest> {
  return {
    repositoryRoot: root,
    unitRoot: ".",
    params: {},
    inputs: { protected_paths: [".golangci.*"], size_excluded_paths: ["go.sum"], ...inputs },
    changes: await changeSets.read(root),
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

async function handoff(root: string, family: string, revision: string): Promise<void> {
  const directory = join(root, ".knowledge-os-handoffs", family);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "scope.md"), "# Scope\n\n1. A returns 1.\n");
  await writeFile(join(root, ".knowledge-os-handoffs", "ACTIVE.yaml"), [
    "schema-version: 2",
    "handoffs:",
    `  - handoff-id: id-${family}`,
    `    family: ${family}`,
    `    revision: ${revision}`,
    `    manifest: ${family}/handoff.yaml`,
    "    state: active",
    "",
  ].join("\n"));
}

async function record(review: ChangeReview, root: string, criteria: readonly object[]) {
  const file = join(dirname(root), `${root.split("/").at(-1)}-review.json`);
  await writeFile(file, JSON.stringify({ reviewer: "subagent", criteria }));
  cleanups.push(() => rm(file, { force: true }));
  return await review.record(root, file);
}

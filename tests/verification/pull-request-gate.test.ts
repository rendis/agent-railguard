import { execFile } from "node:child_process";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { NodeChangeSetReader } from "../../src/adapters/platform/git/node-change-set-reader.js";
import { NodeRevisionCheckouts } from "../../src/adapters/platform/git/node-revision-checkouts.js";
import { NodeProcessRunner } from "../../src/adapters/platform/process/node-process-runner.js";
import { ChangeCheckProvider } from "../../src/adapters/verification/change-check-provider.js";
import type { ScanResult } from "../../src/application/model.js";
import { VerificationService } from "../../src/application/verification-service.js";
import { FilesystemCatalog } from "../../src/catalog/filesystem-catalog.js";
import { componentRef, languageId } from "../../src/domain/shared/types.js";
import type {
  PullRequestReader,
  PullRequestReview,
  PullRequestState,
} from "../../src/domain/verification/acceptance.js";
import { createTempRepository } from "../helpers/temp-repository.js";

const execute = promisify(execFile);
const runner = new NodeProcessRunner();
const changeSets = new NodeChangeSetReader(runner);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const project = (approvers: readonly string[]) => [
  "schema: railguard/project/v1",
  "targets:",
  "  - codex",
  "selections:",
  "  - ref: verification-profile:change-guard",
  ...(approvers.length === 0 ? [] : ["    inputs:", "      approvers:", ...approvers.map((login) => `        - ${login}`)]),
  "",
].join("\n");

const testFile = "package a\n\nimport \"testing\"\n\nfunc TestA(t *testing.T) {}\n";

describe("acceptance by pull request approval", () => {
  it("reports a requested finding as pending, which does not block locally", async () => {
    const { service } = await scenario({ request: true });

    const report = await service.run({ root: scenarioRoot(), stage: "check", changed: true });

    expect(report.verdict).toBe("pending");
    expect(report.results[0]?.outcome).toMatchObject({
      status: "pending",
      requested: "covered by the e2e suite",
      details: [
        "a_test.go: test file deleted (test-deleted: needs a justification)",
        expect.stringContaining("Railguard-Justify: test-deleted: <why this is right>"),
        "Fix the cause instead of weakening the checks.",
      ],
    });
  });

  it("fails a finding no commit asked a person to accept and tells the agent how to ask", async () => {
    const { service } = await scenario({ request: false });

    const report = await service.run({ root: scenarioRoot(), stage: "check", changed: true });

    expect(report.verdict).toBe("failed");
    expect(report.results[0]?.outcome.details.join("\n")).toContain("Railguard-Request: change-integrity:");
  });

  it("does not let a request for another kind cover the finding", async () => {
    const { service } = await scenario({ request: true, kind: "change-size" });

    const report = await service.run({ root: scenarioRoot(), stage: "check", changed: true });

    expect(report.verdict).toBe("failed");
  });

  it("passes a requested finding when a configured approver approved the head commit", async () => {
    const { service, head } = await scenario({ request: true, reviews: (head) => [approval("rendis", head)] });

    const report = await service.run({ root: scenarioRoot(), stage: "verify", changed: true, pullRequest: 7 });

    expect(report.verdict).toBe("passed");
    expect(report.results.map((result) => result.outcome.status)).toEqual(["passed", "passed"]);
    expect(report.results[0]?.outcome.summary).toContain(`accepted by the approval of rendis on ${head.slice(0, 12)} (requested: covered by the e2e suite)`);
    expect(report.pullRequest).toMatchObject({ number: 7, approvedBy: "rendis", approvers: ["rendis"], notes: [], requests: 1 });
  });

  it("fails while nobody has approved and names who is awaited", async () => {
    const { service } = await scenario({ request: true, reviews: () => [] });

    const report = await service.run({ root: scenarioRoot(), stage: "verify", changed: true, pullRequest: 7 });

    expect(report.verdict).toBe("failed");
    expect(report.results[0]?.outcome).toMatchObject({ status: "failed" });
    expect(report.results[0]?.outcome.summary).toContain("awaiting approval (requested: covered by the e2e suite)");
    expect(report.results[0]?.outcome.details.at(-1)).toContain("@rendis");
  });

  it("passes a justified finding without any approval, showing its reason", async () => {
    const { service } = await scenario({ request: false, justify: "test-deleted", reviews: () => [] });

    const local = await service.run({ root: scenarioRoot(), stage: "check", changed: true });
    const gate = await service.run({ root: scenarioRoot(), stage: "verify", changed: true, pullRequest: 7 });

    expect(local.verdict).toBe("passed");
    expect(gate.verdict).toBe("passed");
    expect(gate.results[0]?.outcome.details).toEqual(["a_test.go: test file deleted (justified: the feature went with its code)"]);
  });

  it("fails a justifiable finding without a justification and says how to give one", async () => {
    const { service } = await scenario({ request: false, reviews: () => [] });

    const gate = await service.run({ root: scenarioRoot(), stage: "verify", changed: true, pullRequest: 7 });

    expect(gate.verdict).toBe("failed");
    expect(gate.results[0]?.outcome.details.join("\n")).toContain('-m "Railguard-Justify: test-deleted: <why this is right>"');
  });

  it("does not let a justification of another kind cover the finding", async () => {
    const { service } = await scenario({ request: false, justify: "test-removed", reviews: () => [] });

    expect((await service.run({ root: scenarioRoot(), stage: "check", changed: true })).verdict).toBe("failed");
  });

  it("keeps an approval across a rebase that leaves the findings as they were", async () => {
    const { service, head, approved } = await scenario({
      request: true,
      reviews: (_head, approved) => [approval("rendis", approved)],
      afterApproval: async (git) => {
        await git("checkout", "-q", "main");
        await writeFile(join(scenarioRoot(), "b.go"), "package a\n\nfunc B() {}\n");
        await git("add", "b.go");
        await git("commit", "-qm", "feat: unrelated work on main");
        await git("checkout", "-q", "feature");
        await git("rebase", "-q", "main");
      },
    });

    const report = await service.run({ root: scenarioRoot(), stage: "verify", changed: true, pullRequest: 7 });

    expect(approved).not.toBe(head);
    expect(report.verdict).toBe("passed");
    expect(report.results[0]?.outcome.summary).toContain(`accepted by the approval of rendis on ${approved.slice(0, 12)}, whose findings include every finding of ${head.slice(0, 12)}`);
    expect(report.pullRequest).toMatchObject({ approvedBy: "rendis", notes: [] });
  });

  it("keeps an approval when a later commit removes a finding", async () => {
    const { service } = await scenario({
      request: true,
      extraTest: true,
      reviews: (_head, approved) => [approval("rendis", approved)],
      afterApproval: async (git) => {
        await writeFile(join(scenarioRoot(), "b_test.go"), testFile.replace("TestA", "TestB"));
        await git("add", "b_test.go");
        await git("commit", "-qm", "test: keep the second test");
      },
    });

    expect((await service.run({ root: scenarioRoot(), stage: "verify", changed: true, pullRequest: 7 })).verdict).toBe("passed");
  });

  it("needs a new approval for a finding the approved commit did not have", async () => {
    const { service, approved } = await scenario({
      request: true,
      reviews: (_head, approved) => [approval("rendis", approved)],
      afterApproval: async (git) => {
        await writeFile(join(scenarioRoot(), "a.go"), "package a\n\nfunc A() {} //nolint:all\n");
        await git("commit", "-qam", "fix: silence the linter");
      },
    });

    const report = await service.run({ root: scenarioRoot(), stage: "verify", changed: true, pullRequest: 7 });

    expect(report.verdict).toBe("failed");
    expect(report.pullRequest?.notes).toEqual([
      expect.stringContaining(`The approval of rendis on ${approved.slice(0, 12)} does not cover 1 finding(s) of integrity that ${approved.slice(0, 12)} did not have (suppression: a.go: lint suppression: func A() {} //nolint:all): approve again`),
    ]);
  });

  it("does not count an approval given before a later commit and says to approve again", async () => {
    const { service } = await scenario({ request: true, reviews: () => [approval("rendis", "c".repeat(40))] });

    const report = await service.run({ root: scenarioRoot(), stage: "verify", changed: true, pullRequest: 7 });

    expect(report.verdict).toBe("failed");
    expect(report.pullRequest?.notes).toEqual([expect.stringContaining("approve again")]);
  });

  it("never counts the author's approval or a bot's", async () => {
    const { service } = await scenario({
      request: true,
      author: "rendis",
      reviews: (head) => [approval("rendis", head), { ...approval("helper[bot]", head), accountType: "Bot" }],
    });

    const report = await service.run({ root: scenarioRoot(), stage: "verify", changed: true, pullRequest: 7 });

    expect(report.verdict).toBe("failed");
    expect(report.pullRequest?.approvedBy).toBeNull();
  });

  it("reads the approvers from the base, so the pull request cannot add its own", async () => {
    const { service } = await scenario({
      request: true,
      branchProject: project(["rendis", "mallory"]),
      reviews: (head) => [approval("mallory", head)],
    });

    const report = await service.run({ root: scenarioRoot(), stage: "verify", changed: true, pullRequest: 7 });

    expect(report.verdict).toBe("failed");
    expect(report.pullRequest?.approvers).toEqual(["rendis"]);
    expect(report.pullRequest?.notes).toEqual([expect.stringContaining("not one of the configured approvers")]);
  });

  it("accepts nothing when the base configures no approver", async () => {
    const { service } = await scenario({ request: true, baseProject: project([]), reviews: (head) => [approval("rendis", head)] });

    const report = await service.run({ root: scenarioRoot(), stage: "verify", changed: true, pullRequest: 7 });

    expect(report.verdict).toBe("failed");
    expect(report.results[0]?.outcome.details.at(-1)).toContain("No approver is configured");
  });

  it("still fails a finding that was never requested, even with an approval", async () => {
    const { service } = await scenario({ request: false, reviews: (head) => [approval("rendis", head)] });

    const report = await service.run({ root: scenarioRoot(), stage: "verify", changed: true, pullRequest: 7 });

    expect(report.verdict).toBe("failed");
    expect(report.results[0]?.outcome.status).toBe("failed");
  });

  it("keeps a person's trailer working in the gate", async () => {
    const { service } = await scenario({ request: false, allow: true, reviews: () => [] });

    const report = await service.run({ root: scenarioRoot(), stage: "verify", changed: true, pullRequest: 7 });

    expect(report.verdict).toBe("passed");
  });

  it("blocks when the checkout is not the head of the pull request", async () => {
    const { service } = await scenario({ request: true, checkedOut: "d".repeat(40) });

    const report = await service.run({ root: scenarioRoot(), stage: "verify", changed: true, pullRequest: 7 });

    expect(report.verdict).toBe("blocked");
    expect(report.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["verification.pull-request.head-mismatch"]);
  });

  it("blocks when the pull request cannot be read", async () => {
    const { service } = await scenario({ request: true, failure: "GitHub answered 403" });

    const report = await service.run({ root: scenarioRoot(), stage: "verify", changed: true, pullRequest: 7 });

    expect(report.verdict).toBe("blocked");
    expect(report.diagnostics[0]).toMatchObject({ code: "verification.pull-request.unavailable", evidence: ["GitHub answered 403"] });
  });

  it("blocks instead of passing when no profile judges an acceptable change", async () => {
    const { service } = await scenario({ request: true, selections: [] });

    const report = await service.run({ root: scenarioRoot(), stage: "verify", changed: true, pullRequest: 7 });

    expect(report.verdict).toBe("blocked");
    expect(report.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["verification.pull-request.no-profile"]);
  });
});

let currentRoot = "";
function scenarioRoot(): string {
  return currentRoot;
}

function approval(login: string, commit: string): PullRequestReview {
  return { login, accountType: "User", state: "APPROVED", commit };
}

interface ScenarioOptions {
  readonly request: boolean;
  /** Writes a `Railguard-Justify` trailer of this kind before the change. */
  readonly justify?: string;
  /** The base also holds b_test.go, which the change deletes too. */
  readonly extraTest?: boolean;
  /** Runs after the commit the reviews approve, which then is no longer the head. */
  readonly afterApproval?: (git: (...args: string[]) => Promise<unknown>) => Promise<void>;
  readonly kind?: string;
  readonly allow?: boolean;
  readonly reviews?: (head: string, approved: string) => readonly PullRequestReview[];
  readonly author?: string;
  readonly baseProject?: string;
  readonly branchProject?: string;
  readonly checkedOut?: string;
  readonly failure?: string;
  readonly selections?: readonly string[];
}

/** A branch that deletes a test file, optionally preceded by a request commit, judged as a pull request. */
async function scenario(options: ScenarioOptions): Promise<{ service: VerificationService; head: string; approved: string }> {
  const temporary = await createTempRepository({
    "a.go": "package a\n",
    "a_test.go": testFile,
    ...(options.extraTest === true ? { "b_test.go": testFile.replace("TestA", "TestB") } : {}),
    ".railguard/project.yaml": options.baseProject ?? project(["rendis"]),
  });
  cleanups.push(temporary.cleanup);
  const root = await realpath(temporary.root);
  currentRoot = root;
  const git = (...args: string[]) => execute("git", ["-C", root, ...args]);
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "a@b");
  await git("config", "user.name", "t");
  await git("add", ".");
  await git("commit", "-qm", "base");
  await git("checkout", "-q", "-b", "feature");
  if (options.request) {
    const kind = options.kind ?? "change-integrity";
    await git("commit", "-q", "--allow-empty", "-m", `chore: request acceptance\n\nRailguard-Request: ${kind}: covered by the e2e suite`);
  }
  if (options.justify !== undefined) {
    await git("commit", "-q", "--allow-empty", "-m", `chore: justify\n\nRailguard-Justify: ${options.justify}: the feature went with its code`);
  }
  await rm(join(root, "a_test.go"));
  if (options.extraTest === true) await rm(join(root, "b_test.go"));
  if (options.branchProject !== undefined) {
    await mkdir(join(root, ".railguard"), { recursive: true });
    await writeFile(join(root, ".railguard/project.yaml"), options.branchProject);
  }
  const trailer = options.allow === true ? "\n\nRailguard-Allow: change-integrity: a person accepted it" : "";
  await git("add", "-A");
  await git("commit", "-qm", `test: drop the unit test${trailer}`);
  const approved = (await git("rev-parse", "HEAD")).stdout.trim();
  await options.afterApproval?.(git);
  const head = (await git("rev-parse", "HEAD")).stdout.trim();

  const catalog = await loadCatalog();
  const selections = options.selections ?? ["verification-profile:change-guard"];
  const scan = {
    kind: "ready",
    snapshot: { realRoot: root },
    catalog,
    assessment: { projectUnits: [] },
    desired: { state: { selections: selections.map((ref) => ({ ref: componentRef(ref), inputs: {} })) } },
    resolution: null,
  } as unknown as ScanResult;
  const pullRequests: PullRequestReader = {
    async read(): Promise<PullRequestState> {
      if (options.failure !== undefined) throw new Error(options.failure);
      return {
        number: 7,
        author: options.author ?? "baby-team-agent[bot]",
        head,
        reviews: options.reviews?.(head, approved) ?? [],
        checkedOut: options.checkedOut ?? head,
      };
    },
  };
  const service = new VerificationService({
    scan: async () => scan,
    changeSets,
    providers: [new ChangeCheckProvider(runner, changeSets)],
    script: { read: async () => null, step: async () => { throw new Error("no script in this test"); } },
    pullRequests,
    revisions: new NodeRevisionCheckouts(runner),
  });
  return { service, head, approved };
}

async function loadCatalog() {
  const result = await new FilesystemCatalog({
    catalogFile: resolve("railguard.yaml"),
    supportedLanguages: [languageId("go")],
  }).load();
  if (result.kind !== "ready") throw new Error(result.diagnostics[0]?.message);
  return result.catalog;
}

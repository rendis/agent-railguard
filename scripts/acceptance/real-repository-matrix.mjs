import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createDefaultApplication } from "../../dist/index.js";

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const targets = Object.freeze(["codex", "claude-code", "cursor", "opencode", "vscode"]);
const mcpPaths = Object.freeze([
  ".codex/config.toml",
  ".cursor/mcp.json",
  ".mcp.json",
  ".vscode/mcp.json",
  "opencode.json",
]);
const profiles = Object.freeze([
  Object.freeze({
    id: "go",
    source: "example/example-org/repos/example-service",
    language: "go",
    selections: Object.freeze([
      "mcp:atlassian-rovo",
      "mcp:context7",
      "pack:go-service-foundation",
      "skill:tdd",
    ]),
    expectedRecommendation: "skill:develop-go-hexagonal-service",
    expectedDiagnostic: null,
    tui: "lifecycle",
    augmentMultiModule: true,
  }),
  Object.freeze({
    id: "java-gradle",
    source: "Easy/Live Plant/agilistik-easy-ms",
    language: "java",
    selections: Object.freeze(["mcp:atlassian-rovo", "mcp:context7", "skill:tdd"]),
    expectedRecommendation: null,
    expectedDiagnostic: null,
    tui: "not-run",
  }),
  Object.freeze({
    id: "typescript-react-vite",
    source: "Easy/Live Plant/agilistik-easy-live-plants",
    language: "typescript",
    selections: Object.freeze(["mcp:atlassian-rovo", "mcp:context7", "skill:tdd"]),
    expectedRecommendation: null,
    expectedDiagnostic: "stack.typescript.lockfiles-ambiguous",
    tui: "scan",
  }),
  Object.freeze({
    id: "typescript-angular-ionic",
    source: "example/example-org/repos/example-service",
    language: "typescript",
    selections: Object.freeze(["mcp:atlassian-rovo", "mcp:context7", "skill:tdd"]),
    expectedRecommendation: null,
    expectedDiagnostic: null,
    tui: "not-run",
  }),
  Object.freeze({
    id: "python",
    source: "example/example-org/repos/example-agent",
    language: "python",
    selections: Object.freeze(["mcp:atlassian-rovo", "mcp:context7", "skill:tdd"]),
    expectedRecommendation: null,
    expectedDiagnostic: null,
    tui: "scan",
  }),
]);

const options = parseArguments(process.argv.slice(2));
const allowedRoot = await realpath(options.allowedRoot);
const selectedProfiles = options.profile === null
  ? profiles
  : profiles.filter((profile) => profile.id === options.profile);
if (selectedProfiles.length === 0) {
  throw new Error(`Unknown --profile ${options.profile}`);
}

const receipts = [];
for (const profile of selectedProfiles) {
  receipts.push(await executeProfile(profile, allowedRoot));
}

process.stdout.write(`${JSON.stringify({
  schema: "ai-harness/real-repository-matrix/v1",
  verdict: "passed",
  profiles: receipts,
  consumerNetworkUsed: false,
  consumerCommandsExecuted: false,
}, null, 2)}\n`);

async function executeProfile(profile, allowedRoot) {
  const source = await realpath(join(allowedRoot, profile.source));
  assertInside(allowedRoot, source);
  const sourceRoot = (await gitText(["-C", source, "rev-parse", "--show-toplevel"])).trim();
  if ((await realpath(sourceRoot)) !== source) {
    throw new Error(`${profile.id}: allowlisted source is not a Git top-level`);
  }

  const sourceBefore = await sourceEvidence(source);
  const temporaryRoot = await mkdtemp(join(tmpdir(), `ai-harness-real-${profile.id}-`));
  await chmod(temporaryRoot, 0o700);
  const mirror = join(temporaryRoot, "mirror.git");
  const worktree = join(temporaryRoot, "worktree");
  let runtime = null;
  let success = false;

  try {
    await git([
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "submodule.recurse=false",
      "clone",
      "--shared",
      "--no-checkout",
      source,
      mirror,
    ]);
    await git([
      "-C",
      mirror,
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "submodule.recurse=false",
      "worktree",
      "add",
      "--detach",
      worktree,
      sourceBefore.head,
    ]);
    await assertSafeTrackedInput(worktree);
    if (profile.augmentMultiModule === true) {
      const moduleRoot = join(worktree, "e2e-secondary-module");
      await mkdir(moduleRoot, { recursive: true });
      await writeFile(
        join(moduleRoot, "go.mod"),
        "module example.com/ai-harness-e2e-secondary\n\ngo 1.24\n",
        "utf8",
      );
      await writeFile(join(moduleRoot, "main.go"), "package secondary\n", "utf8");
    }
    const atlExistedBefore = await pathExists(join(worktree, ".atl"));
    const worktreeStatusBefore = await gitBytes([
      "-C",
      worktree,
      "status",
      "--porcelain=v2",
      "-z",
    ]);

    const surfaceEvidence = await exerciseProductSurfaces(profile, worktree, temporaryRoot);

    runtime = await createDefaultApplication({
      sourcePath: projectRoot,
      stateBaseDirectory: temporaryRoot,
    });
    const baseline = await runtime.application.scan(worktree);
    assertReadyScan(baseline, profile.id);
    assertLanguage(baseline, profile);
    assertDiagnosticContract(baseline, profile);

    const recommendations = await runtime.application.recommendations(baseline);
    assertRecommendationContract(recommendations, profile);

    const prepared = await runtime.application.prepareInstall(
      baseline,
      profile.selections,
      targets,
    );
    const installPlan = requireReadyPlan(prepared.plan, "reconcile", profile.id);
    const installResult = await runtime.application.apply(installPlan);
    if (installResult.kind !== "applied") {
      throw new Error(`${profile.id}: install returned ${installResult.kind}`);
    }

    const status = await runtime.application.status(worktree, targets);
    if (status.scan.kind !== "ready" || status.verification?.materialization !== "verified") {
      throw new Error(`${profile.id}: installed materialization is not verified`);
    }
    await assertNativeMaterialization(status.scan, profile);

    const repeated = await runtime.application.prepareInstall(
      status.scan,
      profile.selections,
      targets,
    );
    const repeatedPlan = requireReadyPlan(repeated.plan, "reconcile", profile.id);
    if (repeatedPlan.operations.length !== 0) {
      throw new Error(`${profile.id}: second plan is not idempotent`);
    }
    const noOpResult = await runtime.application.apply(repeatedPlan);
    if (noOpResult.kind !== "no-changes") {
      throw new Error(`${profile.id}: idempotent apply returned ${noOpResult.kind}`);
    }

    const preparedRemoval = await runtime.application.prepareRemove(status.scan, { all: true });
    if (
      preparedRemoval.resolution.kind !== "ready" ||
      preparedRemoval.resolution.components.length !== 0
    ) {
      throw new Error(`${profile.id}: remove-all did not resolve an empty desired set`);
    }
    const removePlan = requireReadyPlan(preparedRemoval.plan, "remove", profile.id);
    const removeResult = await runtime.application.apply(removePlan);
    if (removeResult.kind !== "applied") {
      throw new Error(`${profile.id}: removal returned ${removeResult.kind}`);
    }

    const partialHookLifecycle = profile.language === "go"
      ? await exercisePartialHookLifecycle(runtime, worktree, profile.id)
      : "not-run";

    const restored = await runtime.application.scan(worktree);
    assertReadyScan(restored, profile.id);
    if (restored.snapshot.fingerprint !== baseline.snapshot.fingerprint) {
      throw new Error(`${profile.id}: worktree inventory did not return to baseline`);
    }
    if (!atlExistedBefore) {
      await rm(join(worktree, ".atl"), { recursive: true, force: true });
    }
    const worktreeStatusAfter = await gitBytes([
      "-C",
      worktree,
      "status",
      "--porcelain=v2",
      "-z",
    ]);
    if (!worktreeStatusAfter.equals(worktreeStatusBefore)) {
      throw new Error(`${profile.id}: detached worktree status differs after remove`);
    }

    await runtime.dispose();
    runtime = null;
    if (profile.augmentMultiModule === true) {
      await rm(join(worktree, "e2e-secondary-module"), { recursive: true, force: true });
    }
    await git(["-C", mirror, "worktree", "remove", worktree]);
    const sourceAfter = await sourceEvidence(source);
    if (JSON.stringify(sourceAfter) !== JSON.stringify(sourceBefore)) {
      throw new Error(`${profile.id}: source checkout evidence changed`);
    }

    success = true;
    return Object.freeze({
      id: profile.id,
      source: relative(allowedRoot, source),
      repository: basename(source),
      commit: sourceBefore.head,
      sourceEvidenceDigest: digest(JSON.stringify(sourceBefore)),
      baselineFingerprint: baseline.snapshot.fingerprint,
      catalogDigest: baseline.catalog.digest,
      installPlanId: installPlan.id,
      removePlanId: removePlan.id,
      desiredDigest: status.scan.desired?.digest ?? null,
      lockDigest: status.scan.lock?.digest ?? null,
      languages: [...new Set(
        baseline.assessment.projectUnits.flatMap((unit) => unit.languages),
      )].sort(),
      diagnostics: baseline.assessment.diagnostics.map((diagnostic) => diagnostic.code).sort(),
      targets: status.scan.lock?.state.targets.map((entry) => entry.id).sort() ?? [],
      resolvedComponents: prepared.resolution.kind === "ready"
        ? prepared.resolution.components.length
        : 0,
      installedArtifacts: installPlan.lockAfter?.state.artifacts.length ?? 0,
      materialization: status.verification.materialization,
      idempotentOperations: repeatedPlan.operations.length,
      partialHookLifecycle,
      surfaces: surfaceEvidence,
      worktreeRestored: true,
      sourceCheckoutUnchanged: true,
    });
  } finally {
    if (runtime !== null) {
      await runtime.dispose().catch(() => undefined);
    }
    if (success) {
      await rm(temporaryRoot, { recursive: true, force: true });
    } else {
      process.stderr.write(
        `${profile.id}: acceptance failed; quarantined temporary root: ${temporaryRoot}\n`,
      );
    }
  }
}

async function pathExists(path) {
  return stat(path).then(() => true, () => false);
}

async function exercisePartialHookLifecycle(runtime, worktree, profileId) {
  const baseline = await runtime.application.scan(worktree);
  assertReadyScan(baseline, profileId);
  const check = "git-gate:pre-commit-check";
  const verify = "git-gate:pre-commit-verify";
  const install = await runtime.application.prepareInstall(
    baseline,
    [check, verify],
    ["codex"],
  );
  const installPlan = requireReadyPlan(install.plan, "reconcile", profileId);
  if ((await runtime.application.apply(installPlan)).kind !== "applied") {
    throw new Error(`${profileId}: partial hook fixture could not be installed`);
  }
  const composed = await readFile(join(worktree, ".ai-harness/hooks/pre-commit"), "utf8");
  if (!composed.includes("make check") || !composed.includes("make verify")) {
    throw new Error(`${profileId}: same-event operations were not composed`);
  }

  const installed = await runtime.application.scan(worktree);
  const partial = await runtime.application.prepareRemove(installed, { components: [check] });
  const partialPlan = requireReadyPlan(partial.plan, "remove", profileId);
  if ((await runtime.application.apply(partialPlan)).kind !== "applied") {
    throw new Error(`${profileId}: one hook operation could not be removed`);
  }
  const retained = await readFile(join(worktree, ".ai-harness/hooks/pre-commit"), "utf8");
  if (retained.includes("make check") || !retained.includes("make verify")) {
    throw new Error(`${profileId}: partial removal did not retain only verify`);
  }

  const partiallyManaged = await runtime.application.scan(worktree);
  const cleanup = await runtime.application.prepareRemove(partiallyManaged, { all: true });
  const cleanupPlan = requireReadyPlan(cleanup.plan, "remove", profileId);
  if ((await runtime.application.apply(cleanupPlan)).kind !== "applied") {
    throw new Error(`${profileId}: partial hook fixture cleanup failed`);
  }
  return "passed";
}

async function exerciseProductSurfaces(profile, worktree, temporaryRoot) {
  const cli = join(projectRoot, "dist", "cli.js");
  const jsonExecution = await execFileAsync(process.execPath, [
    cli,
    "--source",
    projectRoot,
    "scan",
    "--cwd",
    worktree,
    "--format",
    "json",
  ], processOptions());
  const json = JSON.parse(jsonExecution.stdout);
  if (json.verdict !== "READY" || !json.repository?.languages?.includes(profile.language)) {
    throw new Error(`${profile.id}: CLI JSON scan did not expose ${profile.language}`);
  }

  const ndjsonExecution = await execFileAsync(process.execPath, [
    cli,
    "--source",
    projectRoot,
    "scan",
    "--cwd",
    worktree,
    "--format",
    "ndjson",
  ], processOptions());
  const ndjson = ndjsonExecution.stdout.trimEnd().split("\n").map((line) => JSON.parse(line));
  if (ndjson.length < 2 || ndjson.at(-1)?.type !== "result" || ndjson.at(-1)?.verdict !== "READY") {
    throw new Error(`${profile.id}: CLI NDJSON did not end in one ready result`);
  }

  const textExecution = await execFileAsync(process.execPath, [
    cli,
    "--source",
    projectRoot,
    "scan",
    "--cwd",
    worktree,
    "--plain",
  ], processOptions());
  if (!textExecution.stdout.includes("Verdict: READY") || !textExecution.stdout.includes(profile.language)) {
    throw new Error(`${profile.id}: CLI text scan omitted its verdict or stack`);
  }

  const lifecycle = await exerciseCliLifecycle(profile, worktree, temporaryRoot);
  if (profile.tui === "not-run") {
    return Object.freeze({
      cli_json: "passed",
      cli_ndjson: "passed",
      cli_text: "passed",
      cli_lifecycle: lifecycle,
      tui_pty: "not-run",
    });
  }
  const tui = await exerciseTui(profile, worktree, temporaryRoot);
  return Object.freeze({
    cli_json: "passed",
    cli_ndjson: "passed",
    cli_text: "passed",
    cli_lifecycle: lifecycle,
    tui_pty: tui,
  });
}

async function exerciseCliLifecycle(profile, worktree, temporaryRoot) {
  const planPath = join(temporaryRoot, `${profile.id}-cli-plan.json`);
  const planned = await executeCliJson([
    "plan",
    "--add",
    ...profile.selections,
    "--harness",
    ...targets,
    "--out",
    planPath,
    "--cwd",
    worktree,
    "--format",
    "json",
  ]);
  if (planned.verdict !== "PLAN_READY") {
    throw new Error(`${profile.id}: CLI lifecycle did not produce a reviewable plan`);
  }
  const exportedPlan = JSON.parse(await readFile(planPath, "utf8"));
  if (exportedPlan.plan_id !== planned.plan?.plan_id) {
    throw new Error(`${profile.id}: CLI result and exported plan identities differ`);
  }

  const applied = await executeCliJson([
    "apply",
    "--plan",
    planPath,
    "--yes",
    "--cwd",
    worktree,
    "--format",
    "json",
  ]);
  if (
    applied.verdict !== "SUCCEEDED" ||
    applied.receipt?.plan_id !== exportedPlan.plan_id ||
    applied.receipt?.materialization !== "committed"
  ) {
    throw new Error(`${profile.id}: CLI lifecycle apply did not commit the reviewed plan`);
  }

  const status = await executeCliJson([
    "status",
    "--cwd",
    worktree,
    "--format",
    "json",
  ]);
  if (
    status.verdict !== "READY" ||
    status.repository?.management !== "managed" ||
    status.repository?.integrity !== "clean" ||
    !targets.every((target) => status.repository.installed_targets.includes(target))
  ) {
    throw new Error(`${profile.id}: CLI status did not observe a clean multi-harness install`);
  }

  const synchronized = await executeCliJson([
    "sync",
    "--check",
    "--cwd",
    worktree,
    "--format",
    "json",
  ]);
  if (synchronized.verdict !== "NO_CHANGES") {
    throw new Error(`${profile.id}: CLI lifecycle is not idempotent`);
  }

  const mcpStatus = await executeCliJson([
    "mcp",
    "status",
    "mcp:atlassian-rovo",
    "--harness",
    ...targets,
    "--cwd",
    worktree,
    "--format",
    "json",
  ]);
  if (
    mcpStatus.verdict !== "READY" ||
    mcpStatus.data?.kind !== "mcp-session" ||
    mcpStatus.data.results.length !== targets.length ||
    mcpStatus.data.results.some((entry) => entry.state === "authenticated")
  ) {
    throw new Error(`${profile.id}: MCP status did not preserve honest per-target OAuth state`);
  }

  const removed = await executeCliJson([
    "remove",
    "--all",
    "--yes",
    "--cwd",
    worktree,
    "--format",
    "json",
  ]);
  if (
    removed.verdict !== "SUCCEEDED" ||
    removed.plan?.mode !== "remove" ||
    removed.plan?.desired_after !== null
  ) {
    throw new Error(`${profile.id}: CLI remove-all did not clear desired state`);
  }

  const restored = await executeCliJson([
    "scan",
    "--cwd",
    worktree,
    "--format",
    "json",
  ]);
  if (
    restored.verdict !== "READY" ||
    restored.repository?.management !== "uninitialized" ||
    !restored.repository?.languages?.includes(profile.language)
  ) {
    throw new Error(`${profile.id}: CLI lifecycle did not restore the uninitialized baseline`);
  }

  return Object.freeze({
    verdict: "passed",
    plan_id: exportedPlan.plan_id,
    desired_digest: exportedPlan.basis.desired_after_digest,
    lock_digest: exportedPlan.basis.lock_after_digest,
    changed_paths: applied.receipt.changed_paths.length,
    status: "clean",
    idempotence: "no-changes",
    mcp_status: "honest-unknown-or-required",
    removal: "restored",
  });
}

async function executeCliJson(args) {
  const execution = await execFileAsync(
    process.execPath,
    [join(projectRoot, "dist", "cli.js"), "--source", projectRoot, ...args],
    processOptions(),
  );
  return JSON.parse(execution.stdout);
}

async function exerciseTui(profile, worktree, temporaryRoot) {
  const viewport = join(temporaryRoot, "tui-viewport");
  await writeFile(viewport, "180x48\n", "utf8");
  const child = spawn("python3", [
    join(projectRoot, "scripts/verification/pty-runner.py"),
    "--columns", "180",
    "--rows", "48",
    "--resize-file", viewport,
    "--",
    process.execPath,
    join(projectRoot, "dist", "cli.js"),
    "--source", projectRoot,
    "--cwd", worktree,
  ], {
    cwd: projectRoot,
    env: { ...process.env, AI_HARNESS_ASCII: "1", NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let stage = "scan";
  let stageOutput = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const collect = (chunk) => {
    output += chunk;
    stageOutput += chunk;
    if (stage === "scan" && stageOutput.includes("SCAN COMPLETE") && stageOutput.toLowerCase().includes(profile.language)) {
      if (profile.tui === "scan") return advance("finished", "q");
      return advance("catalog", "\r");
    }
    if (stage === "catalog" && stageOutput.includes("COMPONENTS | RECOMMENDED")) {
      return advance("packs", "\u001b[B\u001b[B\u001b[C");
    }
    if (stage === "packs" && stageOutput.includes("COMPONENTS | PACKS")) {
      return advance("selected-pack", " ");
    }
    if (stage === "selected-pack" && /\[x\]\s+Go Service Foundation/.test(stageOutput)) {
      return advance("targets", "\r");
    }
    if (stage === "targets" && stageOutput.includes("TARGETS | SELECT")) {
      return advance("selected-target", " ");
    }
    if (stage === "selected-target" && stageOutput.includes("TARGETS | SELECT") && stageOutput.includes("[x]")) {
      return advance("review", "\r");
    }
    if (stage === "review" && stageOutput.includes("REVIEW EXACT PLAN")) {
      return advance("receipt", "\r");
    }
    if (stage === "receipt" && stageOutput.includes("Verdict: succeeded")) {
      return advance("remove-review", "m");
    }
    if (stage === "remove-review" && stageOutput.includes("Mode: remove")) {
      return advance("remove-receipt", "\r");
    }
    if (stage === "remove-receipt" && stageOutput.includes("Verdict: succeeded")) {
      return advance("finished", "q");
    }
  };
  const advance = (nextStage, input) => {
    stage = nextStage;
    stageOutput = "";
    child.stdin.write(input);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const exit = await waitForExit(child, 30_000);
  const expectedSummary = profile.tui === "lifecycle"
    ? "AI Harness: succeeded"
    : "AI Harness: session closed";
  if (
    exit.code !== 0 ||
    exit.signal !== null ||
    stage !== "finished" ||
    !output.includes(expectedSummary)
  ) {
    throw new Error(`${profile.id}: TUI PTY failed (${exit.code ?? exit.signal}): ${output.slice(-2000)}`);
  }
  return profile.tui === "lifecycle" ? "lifecycle-passed" : "scan-passed";
}

function waitForExit(child, timeout) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveExit, reject) => {
    const timeoutId = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("TUI PTY timed out"));
    }, timeout);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timeoutId);
      resolveExit({ code, signal });
    });
  });
}

function processOptions() {
  return {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      AI_HARNESS_ASCII: "1",
      NO_COLOR: "1",
    },
  };
}

function parseArguments(args) {
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
  let allowedRoot = process.env.AI_HARNESS_ACCEPTANCE_ROOT ?? null;
  let profile = null;
  for (let index = 0; index < normalizedArgs.length; index += 2) {
    const key = normalizedArgs[index];
    const value = normalizedArgs[index + 1];
    if (value === undefined) throw usageError();
    if (key === "--allowed-root") allowedRoot = value;
    else if (key === "--profile") profile = value;
    else throw usageError();
  }
  if (allowedRoot === null) throw usageError();
  return Object.freeze({ allowedRoot: resolve(allowedRoot), profile });
}

function usageError() {
  return new Error(
    "Usage: real-repository-matrix.mjs --allowed-root <Clients> [--profile <id>]",
  );
}

async function sourceEvidence(sourcePath) {
  const [head, status, worktrees, localConfig] = await Promise.all([
    gitText(["-C", sourcePath, "rev-parse", "HEAD"]),
    gitBytes(["-C", sourcePath, "status", "--porcelain=v2", "-z"]),
    gitBytes(["-C", sourcePath, "worktree", "list", "--porcelain", "-z"]),
    gitBytes(["-C", sourcePath, "config", "--local", "--null", "--list"]),
  ]);
  return Object.freeze({
    head: head.trim(),
    statusDigest: digest(status),
    worktreeListDigest: digest(worktrees),
    localConfigDigest: digest(localConfig),
  });
}

async function assertSafeTrackedInput(worktreePath) {
  const index = await gitText(["-C", worktreePath, "ls-files", "--stage"]);
  if (index.split("\n").some((line) => line.startsWith("160000 "))) {
    throw new Error("Submodules are not supported by the real acceptance profile");
  }
  const tracked = (await gitBytes(["-C", worktreePath, "ls-files", "-z"]))
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const secretCount = tracked.filter(isSecretPathName).length;
  if (secretCount > 0) {
    throw new Error(`Tracked secret-like paths block acceptance (${secretCount})`);
  }
}

function isSecretPathName(path) {
  const name = basename(path);
  if (name === ".env") return true;
  if (!name.startsWith(".env.")) return false;
  return ![".env.example", ".env.sample", ".env.template"].includes(name);
}

function assertReadyScan(scan, profileId) {
  if (scan.kind !== "ready") {
    throw new Error(`${profileId}: scan blocked (${scan.diagnostics.map((item) => item.code).join(", ")})`);
  }
}

function assertLanguage(scan, profile) {
  if (!scan.assessment.projectUnits.some((unit) => unit.languages.includes(profile.language))) {
    throw new Error(`${profile.id}: expected ${profile.language} was not detected`);
  }
}

function assertDiagnosticContract(scan, profile) {
  const codes = new Set(scan.assessment.diagnostics.map((diagnostic) => diagnostic.code));
  if (profile.expectedDiagnostic !== null && !codes.has(profile.expectedDiagnostic)) {
    throw new Error(`${profile.id}: expected diagnostic ${profile.expectedDiagnostic} is absent`);
  }
}

function assertRecommendationContract(recommendations, profile) {
  const refs = new Set(recommendations.candidates.map((candidate) => candidate.ref));
  if (profile.expectedRecommendation !== null && !refs.has(profile.expectedRecommendation)) {
    throw new Error(`${profile.id}: expected recommendation ${profile.expectedRecommendation} is absent`);
  }
  if (profile.expectedRecommendation === null && refs.size !== 0) {
    throw new Error(`${profile.id}: received unsupported language-specific recommendations`);
  }
}

async function assertNativeMaterialization(scan, profile) {
  const lock = scan.lock;
  if (lock === null) throw new Error(`${profile.id}: lock state is absent after install`);
  const installedTargets = lock.state.targets.map((entry) => entry.id).sort();
  const expectedTargets = [...targets, "project"].sort();
  if (JSON.stringify(installedTargets) !== JSON.stringify(expectedTargets)) {
    throw new Error(`${profile.id}: not every harness target was materialized`);
  }
  const paths = new Set(lock.state.artifacts.map((artifact) => artifact.path));
  for (const path of mcpPaths) {
    if (!paths.has(path)) throw new Error(`${profile.id}: missing native MCP surface ${path}`);
  }
  const mcpFiles = await Promise.all(mcpPaths.map((path) =>
    readFile(join(scan.snapshot.realRoot, path), "utf8"),
  ));
  if (mcpFiles.some((bytes) => !bytes.includes("context7"))) {
    throw new Error(`${profile.id}: Context7 is absent from a native MCP surface`);
  }
  if (mcpFiles.some((bytes) => !bytes.includes("atlassian-rovo") || !bytes.includes("https://mcp.atlassian.com/v1/mcp/authv2"))) {
    throw new Error(`${profile.id}: Atlassian remote OAuth endpoint is absent from a native MCP surface`);
  }
  if (![...paths].some((path) => path.startsWith(".agents/skills/tdd/"))) {
    throw new Error(`${profile.id}: shared TDD skill surface is absent`);
  }
  if (![...paths].some((path) => path.startsWith(".claude/skills/tdd/"))) {
    throw new Error(`${profile.id}: Claude skill surface is absent`);
  }
  if (profile.language === "go") {
    const required = [
      ".codex/agents/go-reviewer.toml",
      ".claude/agents/go-reviewer.md",
      ".cursor/agents/go-reviewer.md",
      ".github/agents/go-reviewer.agent.md",
      ".ai-harness/hooks/pre-commit",
      ".ai-harness/hooks/pre-push",
      ".opencode/agents/go-reviewer.md",
      "Makefile",
    ];
    for (const path of required) {
      if (!paths.has(path)) throw new Error(`${profile.id}: missing Go foundation surface ${path}`);
    }
    const hookEffect = lock.state.local_effects.find((effect) => effect.key === "core.hooksPath");
    if (hookEffect?.expected_value !== ".ai-harness/hooks") {
      throw new Error(`${profile.id}: managed Git hook path is absent`);
    }
    const makefile = await readFile(join(scan.snapshot.realRoot, "Makefile"), "utf8");
    if (!makefile.includes("e2e-secondary-module") || !makefile.includes("check: ai-harness-go-check")) {
      throw new Error(`${profile.id}: root Make facade does not aggregate the temporary Go module`);
    }
    const preCommit = await readFile(
      join(scan.snapshot.realRoot, ".ai-harness/hooks/pre-commit"),
      "utf8",
    );
    const prePush = await readFile(
      join(scan.snapshot.realRoot, ".ai-harness/hooks/pre-push"),
      "utf8",
    );
    if (!preCommit.includes("make check") || !prePush.includes("make verify")) {
      throw new Error(`${profile.id}: Git hook events do not contain their selected operations`);
    }
  }
}

function requireReadyPlan(plan, mode, profileId) {
  if (plan?.kind !== "ready" || plan.mode !== mode) {
    const diagnostics = plan?.diagnostics?.map((item) => item.code).join(", ") ?? "unavailable";
    throw new Error(`${profileId}: ${mode} plan is not ready (${diagnostics})`);
  }
  return plan;
}

async function git(args) {
  await execFileAsync("git", args, gitOptions("utf8"));
}

async function gitText(args) {
  const result = await execFileAsync("git", args, gitOptions("utf8"));
  return result.stdout;
}

async function gitBytes(args) {
  const result = await execFileAsync("git", args, gitOptions("buffer"));
  return Buffer.from(result.stdout);
}

function gitOptions(encoding) {
  return {
    encoding,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_LFS_SKIP_SMUDGE: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
    },
  };
}

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function assertInside(root, candidate) {
  const difference = relative(root, candidate);
  if (
    difference === "" ||
    difference === ".." ||
    difference.startsWith(`..${sep}`) ||
    isAbsolute(difference)
  ) {
    throw new Error("Every source repository must be a child of --allowed-root");
  }
}

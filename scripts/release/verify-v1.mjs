import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import verdictSchema from "../../schemas/release-verdict.v1.schema.json" with { type: "json" };
import { writeJson } from "./release-lib.mjs";

const projectRoot = resolve(new URL("../..", import.meta.url).pathname);
const options = parseArguments(process.argv.slice(2));
const evidenceRoot = resolve(options.output);
const verdictPath = join(evidenceRoot, "release-verdict.json");
const releaseRoot = join(evidenceRoot, "release");
const gates = [];
let currentGate = "environment";
let securityAudit = null;
let release = null;
let installUpdate = null;
let linuxInstaller = null;
let repositoryMatrix = null;
let failure = null;

class GateFailure extends Error {
  constructor(gate, message) {
    super(message);
    this.name = "GateFailure";
    this.gate = gate;
  }
}

await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
await rm(releaseRoot, { recursive: true, force: true });

const nodeVersion = process.versions.node;
let pnpmVersion = "unknown";
try {
  if (!/^24\.(?:19|[2-9]\d)\./.test(nodeVersion)) {
    throw new Error(`Release verification requires Node >=24.19.0 <25.0.0, received ${nodeVersion}`);
  }
  pnpmVersion = (await runGate("pnpm-version", "pnpm", ["--version"], { capture: true })).trim();
  if (pnpmVersion !== "11.21.0") {
    throw new Error(`Release verification requires pnpm 11.21.0, received ${pnpmVersion}`);
  }

  await runGate("frozen-install", "pnpm", ["install", "--frozen-lockfile", "--offline", "--ignore-scripts"]);
  await runGate("typecheck", "pnpm", ["run", "typecheck"]);
  await runGate("test-coverage", "pnpm", ["run", "test:coverage"]);
  await runGate("architecture", "pnpm", ["run", "check:boundaries"]);
  await runGate("bundle-build", "pnpm", ["run", "build"]);
  await runGate("bundle-smoke", "pnpm", ["run", "check:bundle"]);
  await runGate("licenses", "node", ["scripts/release/check-licenses.mjs"]);
  const auditOutput = await runGate(
    "production-audit",
    "pnpm",
    ["audit", "--prod", "--audit-level", "high", "--json"],
    { capture: true },
  );
  securityAudit = JSON.parse(auditOutput);
  await writeJson(join(evidenceRoot, "production-audit.json"), securityAudit);

  const releaseOutput = await runGate(
    "release-reproducibility",
    "node",
    ["scripts/release/build-release.mjs", "--out", releaseRoot, "--version", "0.1.0"],
    { capture: true },
  );
  release = JSON.parse(releaseOutput);
  const manifest = JSON.parse(await readFile(join(releaseRoot, "release-manifest.json"), "utf8"));
  release = Object.freeze({ ...release, manifest });

  linuxInstaller = JSON.parse(await runGate(
    "linux-installer-acceptance",
    "node",
    [
      "scripts/acceptance/linux-installer.mjs",
      "--release-root",
      releaseRoot,
      "--image",
      options.linuxImage,
    ],
    { capture: true },
  ));

  installUpdate = JSON.parse(await runGate(
    "install-update-acceptance",
    "node",
    ["scripts/acceptance/install-update.mjs"],
    { capture: true },
  ));
  repositoryMatrix = JSON.parse(await runGate(
    "real-repository-matrix",
    "node",
    [
      "scripts/acceptance/real-repository-matrix.mjs",
      "--allowed-root",
      await realpath(options.acceptanceRoot),
    ],
    { capture: true },
  ));
} catch (error) {
  failure = Object.freeze({
    gate: error instanceof GateFailure ? error.gate : currentGate,
    message: errorMessage(error),
  });
}

const verdict = Object.freeze({
  schema: "ai-harness/release-verdict/v1",
  version: "0.1.0",
  verdict: failure === null ? "passed" : "failed",
  toolchain: Object.freeze({ node: nodeVersion, pnpm: pnpmVersion }),
  gates: Object.freeze(gates),
  security_audit: securityAudit,
  release,
  acceptance: Object.freeze({
    install_update: installUpdate,
    linux_installer: linuxInstaller,
    real_repository_matrix: repositoryMatrix,
  }),
  failure,
});

const validate = new Ajv2020({ allErrors: true, strict: true }).compile(verdictSchema);
if (!validate(verdict)) {
  throw new Error(`Release verdict violates its schema: ${JSON.stringify(validate.errors)}`);
}
await writeJson(verdictPath, verdict);
process.stdout.write(`\nRelease verdict: ${verdict.verdict.toUpperCase()}\nEvidence: ${verdictPath}\n`);
if (failure !== null) {
  process.stderr.write(`Gate ${failure.gate} failed: ${failure.message}\n`);
  process.exitCode = 1;
}

async function runGate(id, executable, args, options = {}) {
  currentGate = id;
  const command = [executable, ...args].join(" ");
  process.stdout.write(`\n[${gates.length + 1}] START ${id}: ${command}\n`);
  const output = await execute(executable, args, {
    cwd: projectRoot,
    capture: options.capture === true,
  }).catch((error) => {
    throw new GateFailure(id, errorMessage(error));
  });
  const gate = {
    id,
    status: "passed",
    command,
    ...(options.capture === true ? { evidence_sha256: sha256(output) } : {}),
  };
  gates.push(Object.freeze(gate));
  process.stdout.write(`[${gates.length}] PASS ${id}\n`);
  return output;
}

function execute(executable, args, options) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    const stdout = [];
    const stderr = [];
    child.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk) => {
      stderr.push(Buffer.from(chunk));
      process.stderr.write(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      const output = Buffer.concat(stdout).toString("utf8");
      if (code === 0) resolveRun(output);
      else reject(new Error(
        `${executable} exited ${code ?? signal ?? "unknown"}: ${Buffer.concat(stderr).toString("utf8").slice(-4000)}`,
      ));
    });
  });
}

function parseArguments(args) {
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
  let output = "artifacts/evidence";
  let acceptanceRoot = process.env.AI_HARNESS_ACCEPTANCE_ROOT ?? null;
  let linuxImage = process.env.AI_HARNESS_LINUX_IMAGE ?? "node:24.19.0-bookworm";
  for (let index = 0; index < normalizedArgs.length; index += 2) {
    const key = normalizedArgs[index];
    const value = normalizedArgs[index + 1];
    if (value === undefined) throw usageError();
    if (key === "--out") output = value;
    else if (key === "--acceptance-root") acceptanceRoot = value;
    else if (key === "--linux-image") linuxImage = value;
    else throw usageError();
  }
  if (acceptanceRoot === null) throw usageError();
  return Object.freeze({ output, acceptanceRoot, linuxImage });
}

function usageError() {
  return new Error(
    "Usage: verify-v1.mjs [--out EVIDENCE_DIRECTORY] --acceptance-root CLIENTS_DIRECTORY [--linux-image IMAGE]",
  );
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

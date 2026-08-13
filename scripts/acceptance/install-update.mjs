import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const projectRoot = resolve(new URL("../..", import.meta.url).pathname);
const operationRoot = await mkdtemp(join(tmpdir(), "ai-harness-install-update-"));
const initialRelease = join(operationRoot, "release-0.1.0");
const updateRelease = join(operationRoot, "release-0.2.0");
const home = join(operationRoot, "home");
const pnpmHome = join(operationRoot, "pnpm-home");
const store = join(operationRoot, "store");

try {
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(join(pnpmHome, "bin"), { recursive: true }),
    mkdir(store, { recursive: true }),
  ]);
  await run(process.execPath, ["scripts/release/build-release.mjs", "--out", initialRelease, "--version", "0.1.0"], {
    cwd: projectRoot,
    timeout: 60_000,
  });
  await run(process.execPath, ["scripts/release/build-release.mjs", "--out", updateRelease, "--version", "0.2.0"], {
    cwd: projectRoot,
    timeout: 60_000,
  });

  const environment = {
    ...process.env,
    HOME: home,
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    PNPM_HOME: pnpmHome,
    PATH: `${join(pnpmHome, "bin")}${delimiter}${process.env.PATH ?? ""}`,
    pnpm_config_store_dir: store,
    COREPACK_HOME:
      process.env.COREPACK_HOME ?? join(process.env.HOME ?? home, ".cache", "node", "corepack"),
    COREPACK_ENABLE_NETWORK: "0",
    AI_HARNESS_ALLOW_FILE_RELEASES: "1",
    AI_HARNESS_ALLOW_FILE_CONTENT: "1",
  };
  const initialManifest = join(initialRelease, "release-manifest.json");
  await run("bash", [join(projectRoot, "install.sh")], {
    cwd: operationRoot,
    env: {
      ...environment,
      AI_HARNESS_RELEASE_MANIFEST_URL: new URL(`file://${initialManifest}`).href,
    },
    timeout: 30_000,
  });
  const executable = join(pnpmHome, "bin", "ai-harness");
  const before = (await run(executable, ["--version"], { env: environment })).stdout.trim();
  if (before !== "0.1.0") throw new Error(`Initial smoke returned ${before}`);

  const initialChannelEnvironment = {
    ...environment,
    AI_HARNESS_RELEASE_MANIFEST_URL: new URL(`file://${initialManifest}`).href,
  };
  const tuiRepository = join(operationRoot, "tui-repository");
  await mkdir(tuiRepository);
  await writeFile(join(tuiRepository, "go.mod"), "module example.com/installed-tui\n\ngo 1.24\n", "utf8");
  await run("git", ["init", "--quiet", tuiRepository], { env: initialChannelEnvironment });
  const scanned = JSON.parse((await run(executable, [
    "scan",
    "--cwd",
    tuiRepository,
    "--format",
    "json",
  ], { env: initialChannelEnvironment, timeout: 20_000 })).stdout);
  if (scanned.verdict !== "READY" || !scanned.repository?.languages?.includes("go")) {
    throw new Error(`Installed CLI JSON scan failed: ${JSON.stringify(scanned)}`);
  }
  await runInstalledTuiSmoke(executable, tuiRepository, initialChannelEnvironment, operationRoot);

  const updateManifest = join(updateRelease, "release-manifest.json");
  const updateEnvironment = {
    ...environment,
    AI_HARNESS_RELEASE_MANIFEST_URL: new URL(`file://${updateManifest}`).href,
  };
  const checked = await runAllowingExit(executable, ["update", "--check", "--format", "json"], {
    env: updateEnvironment,
    timeout: 20_000,
  });
  const checkResult = JSON.parse(checked.stdout);
  if (
    checked.code !== 6 ||
    checkResult.verdict !== "CHANGES_AVAILABLE" ||
    checkResult.data?.latest_version !== "0.2.0"
  ) {
    throw new Error(`Update check did not expose 0.2.0: ${checked.stdout}`);
  }

  const applied = await runAllowingExit(executable, ["update", "--yes", "--format", "json"], {
    env: updateEnvironment,
    timeout: 40_000,
  });
  const applyResult = JSON.parse(applied.stdout);
  if (applied.code !== 0 || applyResult.verdict !== "SUCCEEDED") {
    throw new Error(`Update apply failed: ${applied.stdout}\n${applied.stderr}`);
  }
  const after = (await run(executable, ["--version"], { env: environment })).stdout.trim();
  if (after !== "0.2.0") throw new Error(`Updated smoke returned ${after}`);
  const engineConfig = JSON.parse(await readFile(join(home, ".config", "ai-harness", "engine.json"), "utf8"));
  const expectedContentManifest = new URL(`file://${join(initialRelease, "content-manifest.json")}`).href;
  if (
    engineConfig.schema !== "ai-harness/engine-config/v1" ||
    engineConfig.content_manifest_url !== expectedContentManifest
  ) {
    throw new Error(`Engine update changed the independent content channel: ${JSON.stringify(engineConfig)}`);
  }
  const contentManifest = JSON.parse(await readFile(join(initialRelease, "content-manifest.json"), "utf8"));
  if (contentManifest.revision !== "0.1.0") {
    throw new Error(`Content revision unexpectedly followed engine version: ${contentManifest.revision}`);
  }
  const manifest = JSON.parse(await readFile(updateManifest, "utf8"));
  const sbom = JSON.parse(await readFile(join(updateRelease, manifest.release.sbom.path), "utf8"));
  if (sbom.metadata?.component?.version !== "0.2.0") {
    throw new Error(`Updated SBOM identifies ${sbom.metadata?.component?.version ?? "unknown"}`);
  }
  process.stdout.write(`${JSON.stringify({
    schema: "ai-harness/install-update-acceptance/v1",
    initial_version: before,
    available_version: checkResult.data.latest_version,
    installed_version: after,
    content_version: contentManifest.revision,
    content_channel: "preserved",
    check_verdict: checkResult.verdict,
    apply_verdict: applyResult.verdict,
    artifact_sha256: manifest.release.artifact.sha256,
    cli_json_scan: "passed",
    tui_pty: "passed",
    sbom_version: sbom.metadata.component.version,
    network: "disabled",
  })}\n`);
} finally {
  await rm(operationRoot, { recursive: true, force: true });
}

async function runInstalledTuiSmoke(executable, repository, environment, root) {
  const resizeFile = join(root, "installed-tui-viewport");
  await writeFile(resizeFile, "120x30\n", "utf8");
  return await new Promise((resolveRun, reject) => {
    const child = spawn("python3", [
      join(projectRoot, "scripts/verification/pty-runner.py"),
      "--columns", "120",
      "--rows", "30",
      "--resize-file", resizeFile,
      "--",
      executable,
      "--cwd", repository,
    ], {
      cwd: projectRoot,
      env: { ...environment, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let quitSent = false;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Installed TUI PTY timed out:\n${output.slice(-4000)}`));
    }, 30_000);
    const collect = (chunk) => {
      output += chunk.toString("utf8");
      if (!quitSent && output.includes("SCAN COMPLETE") && output.includes("[Enter] Configure components")) {
        quitSent = true;
        child.stdin.write("q");
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (
        code !== 0 ||
        signal !== null ||
        !output.includes("\u001B[?1049h\u001B[?25l") ||
        !output.includes("\u001B[?25h\u001B[?1049l") ||
        !output.includes("AI Harness: session closed")
      ) {
        reject(new Error(`Installed TUI PTY failed (${code ?? signal}):\n${output.slice(-4000)}`));
      } else {
        resolveRun();
      }
    });
  });
}

function run(executable, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    execFile(executable, args, {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      ...options,
    }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`${executable} ${args.join(" ")} failed:\n${stdout}\n${stderr}`, { cause: error }));
      } else {
        resolveRun({ stdout, stderr });
      }
    });
  });
}

function runAllowingExit(executable, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    execFile(executable, args, {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      ...options,
    }, (error, stdout, stderr) => {
      if (error === null) {
        resolveRun({ code: 0, stdout, stderr });
        return;
      }
      if (typeof error.code === "number") {
        resolveRun({ code: error.code, stdout, stderr });
      } else {
        reject(error);
      }
    });
  });
}

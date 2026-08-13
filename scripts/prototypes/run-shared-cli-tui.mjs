import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const buildRoot = await mkdtemp(join(tmpdir(), "ai-harness-prototype-build-"));

try {
  const buildCode = await run(process.execPath, [
    resolve("esbuild.config.mjs"),
    "--prototype-only",
    buildRoot,
  ]);
  if (buildCode !== 0) {
    process.exitCode = buildCode;
  } else {
    process.exitCode = await run(process.execPath, [
      join(buildRoot, "prototype-interaction.js"),
      ...process.argv.slice(2),
    ]);
  }
} finally {
  await rm(buildRoot, { recursive: true, force: true });
}

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: "inherit" });
    const keepParentAlive = () => {};
    process.on("SIGHUP", keepParentAlive);
    process.on("SIGINT", keepParentAlive);
    process.on("SIGTERM", keepParentAlive);
    const cleanupSignalHandlers = () => {
      process.off("SIGHUP", keepParentAlive);
      process.off("SIGINT", keepParentAlive);
      process.off("SIGTERM", keepParentAlive);
    };
    child.once("error", (cause) => {
      cleanupSignalHandlers();
      rejectRun(cause);
    });
    child.once("close", (code, signal) => {
      cleanupSignalHandlers();
      if (code !== null) {
        resolveRun(code);
        return;
      }
      resolveRun(signalExitCode(signal));
    });
  });
}

function signalExitCode(signal) {
  if (signal === "SIGHUP") {
    return 129;
  }
  if (signal === "SIGINT") {
    return 130;
  }
  if (signal === "SIGTERM") {
    return 143;
  }
  return 1;
}

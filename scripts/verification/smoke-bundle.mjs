import { execFile } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repository = await mkdtemp(join(tmpdir(), "railguard-bundle-smoke-"));

try {
  await cp(resolve("tests/fixtures/go-new"), repository, { recursive: true });
  await execute("git", ["init", "--quiet", repository]);
  const { stdout } = await execute(process.execPath, [
    resolve("dist/cli.js"), "scan", "--cwd", repository, "--format", "json",
  ], { env: { ...process.env, RAILGUARD_NO_UPDATE_CHECK: "1" } });
  const result = JSON.parse(stdout);
  if (result.verdict !== "READY" || !result.repository?.languages?.includes("go")) {
    throw new Error(`Bundled CLI failed its Go project scan smoke test: ${stdout}`);
  }
} finally {
  await rm(repository, { recursive: true, force: true });
}

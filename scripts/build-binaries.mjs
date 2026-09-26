// Builds standalone railguard executables (engine + embedded project content) with Bun.
//   node scripts/build-binaries.mjs            -> every release target
//   node scripts/build-binaries.mjs --current  -> only this machine's platform
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const targets = [
  { os: "darwin", arch: "arm64" },
  { os: "darwin", arch: "x64" },
  { os: "linux", arch: "arm64" },
  { os: "linux", arch: "x64" },
];
const current = { os: process.platform, arch: process.arch };
const selected = process.argv.includes("--current")
  ? targets.filter((target) => target.os === current.os && target.arch === current.arch)
  : targets;
if (selected.length === 0) {
  throw new Error(`Unsupported build platform: ${current.os}-${current.arch}`);
}

const version = JSON.parse(await readFile("package.json", "utf8")).version;
const tag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined;
if (tag !== undefined && tag !== `v${version}`) {
  throw new Error(`Release tag ${tag} does not match package.json version v${version}`);
}

execFileSync("node", ["esbuild.config.mjs"], { stdio: "inherit" });

const outdir = resolve("dist", "bin");
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
// bun build --compile leaves a copy of its runtime (.*.bun-build) in the working directory.
const scratch = await mkdtemp(join(tmpdir(), "railguard-bun-build-"));
const checksums = [];
try {
  for (const { os, arch } of selected) {
    const name = `railguard-${os}-${arch}`;
    const outfile = join(outdir, name);
    execFileSync(
      "bun",
      ["build", "--compile", `--target=bun-${os}-${arch}`, resolve("dist/cli.js"), "--outfile", outfile],
      { stdio: "inherit", cwd: scratch },
    );
    const digest = createHash("sha256").update(await readFile(outfile)).digest("hex");
    checksums.push(`${digest}  ${name}`);
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
await writeFile(join(outdir, "SHA256SUMS"), `${checksums.join("\n")}\n`);
process.stdout.write(`Built railguard ${version}: ${selected.map((t) => `${t.os}-${t.arch}`).join(", ")}\n`);

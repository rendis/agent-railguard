import { createHash } from "node:crypto";
import { builtinModules } from "node:module";
import { chmod, lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";

const outdir = process.argv[2] === "--outdir" ? process.argv[3] : "dist";
if (outdir === undefined || outdir.length === 0) {
  throw new TypeError("--outdir requires a directory");
}

await mkdir(outdir, { recursive: true });
const sourcePackage = JSON.parse(await readFile("package.json", "utf8"));
const buildVersion = process.env.RAILGUARD_BUILD_VERSION ?? sourcePackage.version;
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(buildVersion)) {
  throw new TypeError(`RAILGUARD_BUILD_VERSION must be stable SemVer: ${buildVersion}`);
}
const embeddedContent = await contentSnapshot(["railguard.yaml", "skills"]);
const nativeModules = new Set(builtinModules.map((moduleName) => moduleName.replace(/^node:/, "")));

const result = await build({
  entryPoints: {
    cli: "src/cli.ts",
  },
  outdir,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  define: {
    "process.env.DEV": '"false"',
    __RAILGUARD_VERSION__: JSON.stringify(buildVersion),
    __RAILGUARD_CONTENT__: JSON.stringify(embeddedContent),
  },
  banner: {
    js: 'import { createRequire as __railguardCreateRequire } from "node:module"; const require = __railguardCreateRequire(import.meta.url);',
  },
  legalComments: "none",
  metafile: true,
  sourcemap: false,
  external: [...nativeModules].map((moduleName) => `node:${moduleName}`),
  plugins: [
    {
      name: "prefix-node-builtins",
      setup(context) {
        context.onResolve({ filter: /^[A-Za-z0-9_/-]+$/ }, (args) =>
          nativeModules.has(args.path)
            ? { path: `node:${args.path}`, external: true }
            : undefined,
        );
      },
    },
  ],
});

const invalidExternalImports = Object.values(result.metafile.outputs)
  .flatMap((output) => output.imports)
  .filter((entry) => entry.external && !entry.path.startsWith("node:"));

if (invalidExternalImports.length > 0) {
  throw new Error(
    `Bundle contains non-native external imports: ${invalidExternalImports
      .map((entry) => entry.path)
      .join(", ")}`,
  );
}

await writeFile(join(outdir, "meta.json"), `${JSON.stringify(result.metafile, null, 2)}\n`);
const cliPath = join(outdir, "cli.js");
const cliSource = await readFile(cliPath, "utf8");
await writeFile(cliPath, `#!/usr/bin/env node\n${cliSource}`);
await chmod(cliPath, 0o755);

/** Project content compiled into the build so a release binary needs no content channel. */
async function contentSnapshot(roots) {
  const paths = [];
  for (const root of roots) await collect(root, paths);
  paths.sort();
  const hash = createHash("sha256");
  const files = [];
  for (const path of paths) {
    const bytes = await readFile(path);
    const mode = (await lstat(path)).mode & 0o111 ? 0o755 : 0o644;
    hash.update(`${path}\0${mode}\0`).update(bytes).update("\0");
    files.push({ path, mode, base64: bytes.toString("base64") });
  }
  return { digest: `sha256:${hash.digest("hex")}`, files };
}

async function collect(path, output) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) throw new Error(`Project content must not contain symlinks: ${path}`);
  if (metadata.isFile()) {
    output.push(path);
    return;
  }
  for (const entry of await readdir(path)) {
    if (entry === ".DS_Store") continue;
    await collect(join(path, entry), output);
  }
}

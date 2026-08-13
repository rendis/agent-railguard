import { builtinModules } from "node:module";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";

const prototypeOnly = process.argv[2] === "--prototype-only";
const releaseOutdir = process.argv[2] === "--outdir" ? process.argv[3] : undefined;
const outdir = prototypeOnly ? process.argv[3] : releaseOutdir ?? "dist";
if (outdir === undefined || outdir.length === 0) {
  throw new TypeError("Prototype builds require an explicit temporary output directory");
}

await mkdir(outdir, { recursive: true });
const sourcePackage = JSON.parse(await readFile("package.json", "utf8"));
const buildVersion = process.env.AI_HARNESS_BUILD_VERSION ?? sourcePackage.version;
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(buildVersion)) {
  throw new TypeError(`AI_HARNESS_BUILD_VERSION must be stable SemVer: ${buildVersion}`);
}
const nativeModules = new Set(builtinModules.map((moduleName) => moduleName.replace(/^node:/, "")));

const result = await build({
  entryPoints: prototypeOnly
    ? { "prototype-interaction": "prototypes/shared-cli-tui-contract/main.tsx" }
    : {
        cli: "src/cli.ts",
        index: "src/index.ts",
      },
  outdir,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  define: {
    "process.env.DEV": '"false"',
    __AI_HARNESS_VERSION__: JSON.stringify(buildVersion),
  },
  banner: {
    js: 'import { createRequire as __aiHarnessCreateRequire } from "node:module"; const require = __aiHarnessCreateRequire(import.meta.url);',
  },
  legalComments: "none",
  metafile: true,
  sourcemap: false,
  external: [...nativeModules].map((moduleName) => `node:${moduleName}`),
  plugins: [
    {
      name: "stub-optional-ink-devtools",
      setup(context) {
        context.onResolve({ filter: /^react-devtools-core$/ }, () => ({
          path: "react-devtools-core",
          namespace: "optional-ink-devtools",
        }));
        context.onLoad(
          { filter: /.*/, namespace: "optional-ink-devtools" },
          () => ({
            contents:
              "export default { initialize() {}, connectToDevTools() {} };",
            loader: "js",
          }),
        );
      },
    },
    {
      name: "stub-optional-ws-native-accelerators",
      setup(context) {
        context.onResolve({ filter: /^(bufferutil|utf-8-validate)$/ }, (args) => ({
          path: args.path,
          namespace: "optional-ws-native-accelerator",
        }));
        context.onLoad(
          { filter: /.*/, namespace: "optional-ws-native-accelerator" },
          () => ({
            contents: 'throw new Error("Optional WebSocket native accelerator disabled");',
            loader: "js",
          }),
        );
      },
    },
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

if (!prototypeOnly) {
  await writeFile(join(outdir, "meta.json"), `${JSON.stringify(result.metafile, null, 2)}\n`);
  const cliPath = join(outdir, "cli.js");
  const cliSource = await readFile(cliPath, "utf8");
  await writeFile(cliPath, `#!/usr/bin/env node\n${cliSource}`);
  await chmod(cliPath, 0o755);
}

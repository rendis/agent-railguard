import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { generateNotices } from "./check-licenses.mjs";
import { generateSbom } from "./generate-sbom.mjs";
import {
  copyFileDeterministic,
  copyTree,
  digestInputs,
  execute,
  gitIdentity,
  inventory,
  sha256,
  writeJson,
} from "./release-lib.mjs";

const projectRoot = resolve(new URL("../..", import.meta.url).pathname);
const releaseOptions = argumentsFrom(process.argv.slice(2));
const outputRoot = releaseOptions.output;
const version = releaseOptions.version;
const artifactName = `ai-harness-${version}.tgz`;
const engineSourceInputs = [
  "package.json",
  "pnpm-lock.yaml",
  "esbuild.config.mjs",
  "install.sh",
  "scripts/release",
  "tsconfig.json",
  "schemas",
  "src",
];
const contentSourceInputs = ["ai-harness.yaml", "skills"];

await mkdir(outputRoot, { recursive: true, mode: 0o755 });
const operation = await mkdtemp(join(tmpdir(), "ai-harness-release-"));
try {
  const engineInputDigest = await digestInputs(projectRoot, engineSourceInputs);
  const source = await gitIdentity(projectRoot, engineInputDigest);
  const contentInputDigest = await digestInputs(projectRoot, contentSourceInputs);
  const contentSource = await gitIdentity(projectRoot, contentInputDigest);
  const contentRoot = join(outputRoot, "content");
  await rm(contentRoot, { recursive: true, force: true });
  await mkdir(contentRoot, { recursive: true, mode: 0o755 });
  await copyFileDeterministic(join(projectRoot, "ai-harness.yaml"), join(contentRoot, "ai-harness.yaml"));
  await copyTree(join(projectRoot, "skills"), join(contentRoot, "skills"));
  const contentInventory = await inventory(contentRoot);
  const authoring = parseYaml(await readFile(join(projectRoot, "ai-harness.yaml"), "utf8"));
  if (
    authoring?.schema !== "ai-harness/v1" ||
    typeof authoring.version !== "string" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(authoring.version)
  ) {
    throw new Error("ai-harness.yaml must declare schema ai-harness/v1 and a stable content version");
  }
  const contentManifest = {
    schema: "ai-harness/content-manifest/v1",
    revision: authoring.version,
    source: contentSource,
    files: contentInventory,
    authentication: {
      kind: "external-https-channel",
      manifest_authentication: "Authenticate this sidecar through the configured corporate HTTPS channel.",
    },
  };
  await writeJson(join(outputRoot, "content-manifest.json"), contentManifest);
  const contentManifestIdentity = await fileIdentity(outputRoot, "content-manifest.json");
  const candidates = [];
  for (const name of ["first", "second"]) {
    const candidate = join(operation, name);
    const buildDirectory = join(candidate, "build");
    const staging = join(candidate, "staging");
    await mkdir(staging, { recursive: true, mode: 0o755 });
    await execute(process.execPath, ["esbuild.config.mjs", "--outdir", buildDirectory], {
      cwd: projectRoot,
      env: {
        ...process.env,
        SOURCE_DATE_EPOCH: "0",
        AI_HARNESS_BUILD_VERSION: version,
      },
      maxBuffer: 16 * 1024 * 1024,
    });
    await mkdir(join(staging, "dist"), { recursive: true, mode: 0o755 });
    await copyFileDeterministic(join(buildDirectory, "cli.js"), join(staging, "dist", "cli.js"), 0o755);
    await copyFileDeterministic(join(buildDirectory, "index.js"), join(staging, "dist", "index.js"));
    await writeFile(join(staging, "LICENSE"), "Copyright the Agent Railguard authors.\n", { mode: 0o644 });
    const notices = await generateNotices(projectRoot);
    await writeFile(join(staging, "THIRD_PARTY_NOTICES.md"), notices, { mode: 0o644 });
    await generateSbom(projectRoot, join(staging, "sbom.cdx.json"), version);
    const buildInfo = {
      schema: "ai-harness/build-info/v1",
      name: "@example/ai-harness",
      version,
      source,
      toolchain: { node: "24.19.0", pnpm: "11.21.0", esbuild: "0.28.2" },
      inputs: {
        lockfile: sha256(await readFile(join(projectRoot, "pnpm-lock.yaml"))),
        engine: engineInputDigest,
      },
      bundles: {
        cli: sha256(await readFile(join(staging, "dist", "cli.js"))),
        index: sha256(await readFile(join(staging, "dist", "index.js"))),
      },
    };
    await writeJson(join(staging, "build-info.json"), buildInfo);
    const packageManifest = {
      name: "@example/ai-harness",
      version,
      description: "Project-scoped AI harness configuration CLI",
      type: "module",
      bin: { "ai-harness": "dist/cli.js" },
      exports: { ".": "./dist/index.js" },
      engines: { node: ">=24.19.0 <25.0.0" },
      files: [
        "dist/",
        "build-info.json",
        "sbom.cdx.json",
        "THIRD_PARTY_NOTICES.md",
        "LICENSE"
      ],
      license: "UNLICENSED",
    };
    await writeJson(join(staging, "package.json"), packageManifest);
    await execute("pnpm", ["pack", "--out", join(candidate, artifactName), "--skip-manifest-obfuscation"], {
      cwd: staging,
      env: { ...process.env, npm_config_ignore_scripts: "true", SOURCE_DATE_EPOCH: "0" },
      maxBuffer: 16 * 1024 * 1024,
    });
    candidates.push({ candidate, staging, tarball: join(candidate, artifactName), buildInfo });
  }

  const [first, second] = candidates;
  const firstBytes = await readFile(first.tarball);
  const secondBytes = await readFile(second.tarball);
  if (!firstBytes.equals(secondBytes)) {
    throw new Error(`Release tarballs are not reproducible: ${sha256(firstBytes)} != ${sha256(secondBytes)}`);
  }
  const firstInventory = await inventory(first.staging);
  const secondInventory = await inventory(second.staging);
  if (JSON.stringify(firstInventory) !== JSON.stringify(secondInventory)) {
    throw new Error("Release staging inventories are not reproducible");
  }

  const outputArtifact = join(outputRoot, artifactName);
  await writeFile(outputArtifact, firstBytes, { mode: 0o644 });
  await chmod(outputArtifact, 0o644);
  for (const file of ["build-info.json", "sbom.cdx.json", "THIRD_PARTY_NOTICES.md"]) {
    await copyFileDeterministic(join(first.staging, file), join(outputRoot, file));
  }
  const releaseManifest = {
    schema: "ai-harness/release-manifest/v1",
    channel: "stable",
    source,
    release: {
      name: "@example/ai-harness",
      version,
      runtime: { node: ">=24.19.0 <25.0.0", pnpm: ">=11.21.0 <12.0.0" },
      artifact: { path: basename(outputArtifact), sha256: sha256(firstBytes), size: firstBytes.byteLength },
      sbom: fileIdentity(outputRoot, "sbom.cdx.json"),
      notices: fileIdentity(outputRoot, "THIRD_PARTY_NOTICES.md"),
      notes: ["Initial project-scoped AI Harness release."],
    },
    authentication: {
      kind: "external-https-channel",
      manifest_authentication: "Authenticate this sidecar through the configured corporate HTTPS channel.",
    },
    content: { manifest: { path: "content-manifest.json" } },
  };
  releaseManifest.release.sbom = await releaseManifest.release.sbom;
  releaseManifest.release.notices = await releaseManifest.release.notices;
  await writeJson(join(outputRoot, "release-manifest.json"), releaseManifest);
  process.stdout.write(`${JSON.stringify({
    artifact: outputArtifact,
    sha256: sha256(firstBytes),
    content: {
      revision: contentManifest.revision,
      manifest: contentManifestIdentity,
    },
  })}\n`);
} finally {
  await rm(operation, { recursive: true, force: true });
}

async function fileIdentity(root, name) {
  const bytes = await readFile(join(root, name));
  return { path: name, sha256: sha256(bytes), size: bytes.byteLength };
}

function argumentsFrom(args) {
  const outputIndex = args.indexOf("--out");
  const versionIndex = args.indexOf("--version");
  const output = outputIndex === -1 ? undefined : args[outputIndex + 1];
  const candidateVersion = versionIndex === -1 ? "0.1.0" : args[versionIndex + 1];
  const expectedLength = versionIndex === -1 ? 2 : 4;
  if (
    output === undefined ||
    candidateVersion === undefined ||
    args.length !== expectedLength ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(candidateVersion)
  ) {
    throw new Error("Usage: build-release.mjs --out OUTPUT_DIRECTORY [--version X.Y.Z]");
  }
  return { output: resolve(output), version: candidateVersion };
}

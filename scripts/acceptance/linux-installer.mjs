import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const projectRoot = resolve(new URL("../..", import.meta.url).pathname);
const options = parseArguments(process.argv.slice(2));
const releaseRoot = await realpath(options.releaseRoot);
const manifest = join(releaseRoot, "release-manifest.json");
const installScript = join(projectRoot, "install.sh");
const ptyRunner = join(projectRoot, "scripts/verification/pty-runner.py");

const inspected = await execute("docker", [
  "image",
  "inspect",
  options.image,
  "--format",
  "{\"digests\":{{json .RepoDigests}},\"os\":\"{{.Os}}\",\"architecture\":\"{{.Architecture}}\"}",
], { cwd: projectRoot, timeout: 15_000 });
const imageIdentity = JSON.parse(inspected.stdout);

const linuxScript = String.raw`
set -eu
export HOME=/tmp/ai-harness-home
export COREPACK_HOME=/tmp/ai-harness-corepack
mkdir -p "$HOME" "$COREPACK_HOME"
corepack enable
corepack prepare pnpm@11.21.0 --activate >/dev/null
export PNPM_HOME=/tmp/ai-harness-pnpm
export PATH="$PNPM_HOME/bin:$PATH"
export pnpm_config_store_dir=/tmp/ai-harness-store
export COREPACK_ENABLE_NETWORK=0
export AI_HARNESS_ALLOW_FILE_RELEASES=1
export AI_HARNESS_ALLOW_FILE_CONTENT=1
export AI_HARNESS_RELEASE_MANIFEST_URL=file:///release/release-manifest.json
mkdir -p "$HOME" "$PNPM_HOME/bin" "$pnpm_config_store_dir" /tmp/consumer
bash /contract/install.sh
test "$(ai-harness --version)" = "0.1.0"
ai-harness --help | grep -q 'Configure an AI-assisted development environment'
git init --quiet /tmp/consumer
printf 'module example.com/linux-acceptance\n\ngo 1.24\n' > /tmp/consumer/go.mod
ai-harness scan --cwd /tmp/consumer --format json > /tmp/scan.json
node -e "const r=require('/tmp/scan.json');if(r.verdict!=='READY'||!r.repository.languages.includes('go'))process.exit(1)"
printf '120x30\n' > /tmp/viewport
(sleep 3; printf q) | python3 /contract/pty-runner.py --columns 120 --rows 30 --resize-file /tmp/viewport -- ai-harness --cwd /tmp/consumer > /tmp/tui.out
node -e "const s=require('node:fs').readFileSync('/tmp/tui.out','utf8');for(const n of ['SCAN COMPLETE','PROJECT CONFIGURATOR','AI Harness: session closed'])if(!s.includes(n))throw new Error('missing '+n)"
printf 'AI_HARNESS_LINUX_ACCEPTANCE=passed\n'
`;

const execution = await execute("docker", [
  "run",
  "--rm",
  "--mount", `type=bind,source=${releaseRoot},target=/release,readonly`,
  "--mount", `type=bind,source=${installScript},target=/contract/install.sh,readonly`,
  "--mount", `type=bind,source=${ptyRunner},target=/contract/pty-runner.py,readonly`,
  options.image,
  "bash",
  "-lc",
  linuxScript,
], {
  cwd: projectRoot,
  timeout: 120_000,
  maxBuffer: 32 * 1024 * 1024,
}).catch((error) => {
  const failure = error;
  throw new Error(
    `Linux container command failed:\n${failure.stdout ?? ""}\n${failure.stderr ?? ""}`,
    { cause: error },
  );
});

if (!execution.stdout.includes("AI_HARNESS_LINUX_ACCEPTANCE=passed")) {
  throw new Error(`Linux acceptance did not emit its verdict:\n${execution.stdout}\n${execution.stderr}`);
}

process.stdout.write(`${JSON.stringify({
  schema: "ai-harness/linux-installer-acceptance/v1",
  verdict: "passed",
  image: options.image,
  image_digests: imageIdentity.digests,
  platform: `${imageIdentity.os}/${imageIdentity.architecture}`,
  installed_version: "0.1.0",
  cli_json_scan: "passed",
  tui_pty: "passed",
  ai_harness_registry_queries: 0,
})}\n`);

function parseArguments(args) {
  let releaseRoot = null;
  let image = "node:24.19.0-bookworm";
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (value === undefined) throw usageError();
    if (key === "--release-root") releaseRoot = resolve(value);
    else if (key === "--image") image = value;
    else throw usageError();
  }
  if (releaseRoot === null) throw usageError();
  return Object.freeze({ releaseRoot, image });
}

function usageError() {
  return new Error("Usage: linux-installer.mjs --release-root DIRECTORY [--image IMAGE]");
}

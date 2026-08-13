import { execFile } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createDefaultApplication } from "../../dist/index.js";

const execute = promisify(execFile);
const repository = await mkdtemp(join(tmpdir(), "ai-harness-bundle-smoke-"));
await cp(resolve("tests/fixtures/go-new"), repository, { recursive: true });
await execute("git", ["init", "--quiet", repository]);

const runtime = await createDefaultApplication({
  executableProbe: {
    async probe() {
      return {
        detected: true,
        path: "/verification/codex",
        version: "bundle-smoke",
        diagnostics: [],
      };
    },
  },
});

try {
  const scan = await runtime.application.scan(repository);
  if (
    scan.kind !== "ready" ||
    !scan.assessment.projectUnits.some((unit) => unit.languages.includes("go"))
  ) {
    throw new Error("Bundled application failed its Go project scan smoke test");
  }
} finally {
  await runtime.dispose();
  await rm(repository, { recursive: true, force: true });
}

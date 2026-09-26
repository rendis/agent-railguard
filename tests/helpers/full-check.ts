import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CheckProvider, FullCheckRequest } from "../../src/domain/verification/checks.js";
import { componentRef } from "../../src/domain/shared/types.js";
import { renderVerifyScript, verifyScriptPath } from "../../src/domain/verification/verify-script.js";

export interface FullCheckRun {
  readonly code: number;
  readonly output: string;
}

/** Runs one check through a verify script generated for it, as CI and full runs do. */
export async function runFullCheck(
  root: string,
  provider: CheckProvider,
  kind: string,
  request: Partial<FullCheckRequest> = {},
  environment: Readonly<Record<string, string>> = {},
): Promise<FullCheckRun | { readonly skipped: string }> {
  const full = provider.full(kind, { params: {}, inputs: {}, ...request });
  if (full.kind === "skipped") return { skipped: full.reason };
  const id = `profile/${kind}@.`;
  const script = renderVerifyScript([{
    id,
    profile: componentRef("verification-profile:profile"),
    check: kind,
    kind,
    stage: "verify",
    unit: ".",
    full,
  }]);
  await mkdir(join(root, ".railguard"), { recursive: true });
  await writeFile(join(root, verifyScriptPath), script ?? "", { mode: 0o755 });
  try {
    return await new Promise((resolve) => {
      execFile("sh", [verifyScriptPath, "--step", id], { cwd: root, env: { ...process.env, ...environment } }, (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolve({ code, output: `${stdout}${stderr}` });
      });
    });
  } finally {
    await rm(join(root, ".railguard"), { recursive: true, force: true });
  }
}

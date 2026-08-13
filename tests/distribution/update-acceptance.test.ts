import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);

describe("installed CLI update acceptance", () => {
  it("moves from 0.1.0 to 0.2.0 through a verified offline channel", async () => {
    const execution = await execute(process.execPath, ["scripts/acceptance/install-update.mjs"], {
      cwd: resolve("."),
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    expect(JSON.parse(execution.stdout)).toMatchObject({
      schema: "ai-harness/install-update-acceptance/v1",
      initial_version: "0.1.0",
      available_version: "0.2.0",
      installed_version: "0.2.0",
      content_version: "0.1.0",
      content_channel: "preserved",
      check_verdict: "CHANGES_AVAILABLE",
      apply_verdict: "SUCCEEDED",
      cli_json_scan: "passed",
      tui_pty: "passed",
      sbom_version: "0.2.0",
      network: "disabled",
    });
  }, 130_000);
});

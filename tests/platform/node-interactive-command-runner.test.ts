import { describe, expect, it } from "vitest";
import { NodeInteractiveCommandRunner } from "../../src/adapters/platform/process/node-interactive-command-runner.js";

describe("NodeInteractiveCommandRunner", () => {
  it("executes structured arguments without a shell and redacts sensitive output", async () => {
    const chunks: string[] = [];
    const runner = new NodeInteractiveCommandRunner();
    const result = await runner.run({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write('Authorization: Bearer SYNTHETIC_SECRET_123\\ncallback?code=SYNTHETIC_CODE_456\\nSet-Cookie: session=SYNTHETIC_COOKIE_789\\n{\\\"refresh_token\\\":\\\"SYNTHETIC_REFRESH_012\\\"}\\nhttps://user:SYNTHETIC_PASSWORD_345@example.test/callback')",
      ],
      cwd: process.cwd(),
      onOutput: (chunk) => chunks.push(chunk.text),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("SYNTHETIC_SECRET_123");
    expect(result.stdout).not.toContain("SYNTHETIC_CODE_456");
    expect(result.stdout).not.toContain("SYNTHETIC_COOKIE_789");
    expect(result.stdout).not.toContain("SYNTHETIC_REFRESH_012");
    expect(result.stdout).not.toContain("SYNTHETIC_PASSWORD_345");
    expect(chunks.join("")).not.toContain("SYNTHETIC_SECRET_123");
    expect(result.stdout).toContain("Authorization: [REDACTED]");
    expect(result.stdout).toContain("code=[REDACTED]");
    expect(result.stdout).toContain("Set-Cookie: [REDACTED]");
    expect(result.stdout).toContain('"refresh_token":"[REDACTED]"');
    expect(result.stdout).toContain("https://[REDACTED]@example.test/callback");
  });

  it("cancels the native process at the explicit signal boundary", async () => {
    const controller = new AbortController();
    const runner = new NodeInteractiveCommandRunner();
    const pending = runner.run({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).resolves.toMatchObject({ exitCode: 130 });
  });

  it("does not start an unbounded session from an already-cancelled request", async () => {
    const controller = new AbortController();
    controller.abort();
    const runner = new NodeInteractiveCommandRunner();
    await expect(runner.run({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      signal: controller.signal,
    })).resolves.toMatchObject({ exitCode: 130 });
  });
});

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { activateDeclaredGitGates } from "../../src/cli/git-gate-activation.js";
import type { GitConfigPort, GitConfigValue } from "../../src/domain/planning/model.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function repository(lock: unknown, hooks = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "railguard-activation-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".railguard", hooks ? "hooks" : "other"), { recursive: true });
  if (lock !== undefined) await writeFile(join(root, ".railguard", "lock.json"), JSON.stringify(lock));
  return root;
}

function gitConfig(initial: GitConfigValue, failure?: Error) {
  const writes: (string | null)[] = [];
  const port: GitConfigPort = {
    async get() {
      if (failure !== undefined) throw failure;
      return initial;
    },
    async set(_root, _key, value) {
      writes.push(value);
    },
  };
  return { port, writes };
}

const noHooks = { async executableDefaultHooks() { return []; } };

const declared = { local_effects: [{ kind: "git-config", key: "core.hooksPath", expected_value: ".railguard/hooks" }] };

describe("activateDeclaredGitGates", () => {
  it("sets the declared hooks path in a clone without one and says so", async () => {
    const { port, writes } = gitConfig({ kind: "absent" });
    const messages: string[] = [];

    await activateDeclaredGitGates(await repository(declared), port, (message) => messages.push(message), noHooks);

    expect(writes).toEqual([".railguard/hooks"]);
    expect(messages).toEqual(["railguard: activated this repository's Git hooks (core.hooksPath=.railguard/hooks)\n"]);
  });

  it("leaves an existing value, an undeclared gate or missing hooks untouched", async () => {
    for (const [lock, hooks, value] of [
      [declared, true, { kind: "value", value: ".husky" }],
      [{ local_effects: [] }, true, { kind: "absent" }],
      [undefined, true, { kind: "absent" }],
      [declared, false, { kind: "absent" }],
    ] as const) {
      const { port, writes } = gitConfig(value);
      await activateDeclaredGitGates(await repository(lock, hooks), port, () => undefined, noHooks);
      expect(writes).toEqual([]);
    }
  });

  it("does not hide executable hooks the developer keeps in .git/hooks", async () => {
    const { port, writes } = gitConfig({ kind: "absent" });
    const messages: string[] = [];

    await activateDeclaredGitGates(await repository(declared), port, (message) => messages.push(message), {
      async executableDefaultHooks() { return ["pre-commit"]; },
    });

    expect(writes).toEqual([]);
    expect(messages[0]).toContain("stay inactive because .git/hooks has your own (pre-commit)");
  });

  it("reports a Git failure without failing the command", async () => {
    const { port } = gitConfig({ kind: "absent" }, new Error("not a git repository"));
    const messages: string[] = [];

    await activateDeclaredGitGates(await repository(declared), port, (message) => messages.push(message), noHooks);

    expect(messages).toEqual(["railguard: could not activate this repository's Git hooks: not a git repository\n"]);
  });
});

import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runProductCommand } from "../../src/cli/command-runner.js";
import type { ExecutableProbe } from "../../src/domain/harness/model.js";
import { harnessTargetId } from "../../src/domain/shared/types.js";
import { createInteractionRuntime } from "../../src/interaction/interaction-session.js";
import { runWizard, type Choice, type WizardUi } from "../../src/tui/wizard.js";
import { createTempRepository } from "../helpers/temp-repository.js";

const execute = promisify(execFile);
const probe: ExecutableProbe = {
  async probe(command) {
    return { detected: command === "codex", path: `/test/bin/${command}`, version: "test", diagnostics: [] };
  },
};

type Answer =
  | { readonly select: string | ((values: readonly unknown[]) => unknown) }
  | { readonly pick: readonly string[] }
  | { readonly confirm: boolean }
  | "cancel";

/** A UI that answers prompts from a script and records everything shown. */
function scriptedUi(answers: Answer[]) {
  const shown: string[] = [];
  const prompts: string[] = [];
  const next = (message: string): Answer => {
    prompts.push(message);
    const answer = answers.shift();
    if (answer === undefined) throw new Error(`No scripted answer for: ${message}`);
    return answer;
  };
  const choose = <Value>(message: string, options: readonly Choice<Value>[]): Value | null => {
    const answer = next(message);
    if (answer === "cancel") return null;
    if (!("select" in answer)) throw new Error(`Expected a select answer for: ${message}`);
    const values = options.map((option) => option.value);
    if (typeof answer.select === "function") return answer.select(values) as Value;
    const match = values.find((value) => value === answer.select);
    if (match === undefined) throw new Error(`"${answer.select}" is not offered by: ${message} (${JSON.stringify(values)})`);
    return match;
  };
  const pick = <Value>(message: string): Value[] | null => {
    const answer = next(message);
    if (answer === "cancel") return null;
    if (!("pick" in answer)) throw new Error(`Expected a pick answer for: ${message}`);
    return [...answer.pick] as Value[];
  };
  const ui: WizardUi = {
    intro: (title) => shown.push(title),
    outro: (message) => shown.push(message),
    note: (message, title) => shown.push(`${title ?? ""}\n${message}`),
    warn: (message) => shown.push(`WARN ${message}`),
    error: (message) => shown.push(`ERROR ${message}`),
    select: async (message, options) => choose(message, options),
    multiselect: async (message) => pick(message),
    groupMultiselect: async (message, groups) => {
      shown.push(`GROUPS ${Object.keys(groups).join(",")}`);
      return pick(message);
    },
    searchMultiselect: async (message) => pick(message),
    confirm: async (message) => {
      const answer = next(message);
      return answer === "cancel" ? null : "confirm" in answer ? answer.confirm : null;
    },
    progress: () => ({ update: () => undefined, stop: (message) => shown.push(message) }),
    onInterrupt: () => () => undefined,
  };
  return { ui, shown, prompts };
}

describe("interactive wizard", () => {
  it("configures, reviews, applies and removes through the shared interaction session", async () => {
    const repository = await createTempRepository({ "go.mod": "module example.com/wizard\n\ngo 1.24\n" });
    await execute("git", ["init", "--quiet", repository.root]);
    const runtime = await createInteractionRuntime({ executableProbe: probe });
    const script = scriptedUi([
      { select: "configure" },
      { pick: ["skill:tdd"] },
      { select: "info" },
      { select: "skill:design-tests" },
      { select: "targets" },
      { pick: ["codex"] },
      { select: "apply" },
      { select: "remove-all" },
      { select: "apply" },
      { select: "quit" },
    ]);
    try {
      const final = await runWizard(runtime.session, repository.root, script.ui, "test");

      const text = script.shown.join("\n");
      expect(text).toContain("GROUPS Packs,Skills,MCP,Agents,Quality,Git hooks,Agent hooks");
      expect(text).toContain("+ skill:design-tests");
      expect(text).toMatch(/File changes \(\d+\)/);
      expect(text).toContain("Result   succeeded");
      expect(text).toContain("Removal plan");
      expect(final.repository?.management).toBe("uninitialized");
      await expect(stat(join(repository.root, ".agents/skills/tdd/SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await Promise.all([runtime.dispose(), repository.cleanup()]);
    }
  }, 60_000);

  it("applies nothing when the plan is not confirmed and goes back on cancel", async () => {
    const repository = await createTempRepository({ "go.mod": "module example.com/wizard\n\ngo 1.24\n" });
    await execute("git", ["init", "--quiet", repository.root]);
    const runtime = await createInteractionRuntime({ executableProbe: probe });
    const script = scriptedUi([
      { select: "configure" },
      { pick: ["skill:tdd"] },
      { select: "targets" },
      { pick: ["codex"] },
      { select: "cancel" },
      "cancel",
    ]);
    try {
      const final = await runWizard(runtime.session, repository.root, script.ui, "test");

      expect(final.receipt).toBeNull();
      expect(script.shown.at(-1)).toBe("No repository changes applied.");
      await expect(readFile(join(repository.root, "AGENTS.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await Promise.all([runtime.dispose(), repository.cleanup()]);
    }
  }, 60_000);

  it("builds and applies exactly the plan the CLI builds for the same request", async () => {
    const headlessRepository = await goRepository();
    const wizardRepository = await goRepository();
    const everything: ExecutableProbe = {
      async probe(command) {
        return { detected: true, path: `/test/bin/${command}`, version: "test", diagnostics: [] };
      },
    };
    const headlessRuntime = await createInteractionRuntime({ executableProbe: everything });
    const wizardRuntime = await createInteractionRuntime({ executableProbe: everything });
    try {
      const headless = await runProductCommand(headlessRuntime, {
        command: "init",
        root: headlessRepository.root,
        recommended: true,
        add: [],
        targets: [harnessTargetId("codex")],
        setInputs: [],
        approve: false,
      });
      const script = scriptedUi([
        { select: "configure" },
        { pick: headless.result.direct_selections },
        { select: "targets" },
        { pick: ["codex"] },
        { select: "apply" },
        { select: "quit" },
      ]);
      const approved: string[] = [];
      const session = wizardRuntime.session;
      const dispatch = session.dispatch.bind(session);
      session.dispatch = async (action) => {
        if (action.type === "approve-plan") approved.push(action.planId);
        return await dispatch(action);
      };
      await runWizard(session, wizardRepository.root, script.ui, "test");

      expect(headless.result.direct_selections.length).toBeGreaterThan(0);
      expect(approved).toEqual([headless.result.plan?.plan_id]);
      expect(script.shown.join("\n")).toContain("Result   succeeded");
    } finally {
      await Promise.all([
        headlessRuntime.dispose(),
        wizardRuntime.dispose(),
        headlessRepository.cleanup(),
        wizardRepository.cleanup(),
      ]);
    }
  }, 90_000);

  it("scans an empty non-Git directory without blocking or writing anything", async () => {
    const repository = await createTempRepository({});
    const runtime = await createInteractionRuntime({ executableProbe: probe });
    const script = scriptedUi([{ select: "quit" }]);
    try {
      await runWizard(runtime.session, repository.root, script.ui, "test");

      expect(script.shown.join("\n")).toContain("Stack        none detected");
      expect(script.prompts).toEqual(["What do you want to do?"]);
      expect(await readdir(repository.root)).toEqual([]);
    } finally {
      await Promise.all([runtime.dispose(), repository.cleanup()]);
    }
  });

  it("offers harness targets with detected ones first", async () => {
    const repository = await createTempRepository({ "go.mod": "module example.com/wizard\n\ngo 1.24\n" });
    await execute("git", ["init", "--quiet", repository.root]);
    const runtime = await createInteractionRuntime({ executableProbe: probe });
    let offered: readonly unknown[] = [];
    const script = scriptedUi([
      { select: "configure" },
      { pick: ["skill:tdd"] },
      { select: "targets" },
      "cancel",
      { select: "back" },
      { select: "quit" },
    ]);
    const multiselect = script.ui.multiselect;
    script.ui.multiselect = async (message, options, initial) => {
      offered = options.map((option) => option.value);
      return await multiselect(message, options, initial);
    };
    try {
      await runWizard(runtime.session, repository.root, script.ui, "test");
      expect(offered[0]).toBe("codex");
    } finally {
      await Promise.all([runtime.dispose(), repository.cleanup()]);
    }
  }, 60_000);
});

async function goRepository() {
  const repository = await createTempRepository({ "go.mod": "module example.com/wizard\n\ngo 1.24\n" });
  await execute("git", ["init", "--quiet", repository.root]);
  return repository;
}

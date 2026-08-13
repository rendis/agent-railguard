import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import React from "react";
import { Command, Option } from "commander";
import { render } from "ink";
import type { ExecutableProbe } from "../../src/domain/harness/model.js";
import {
  componentRef,
  harnessTargetId,
} from "../../src/domain/shared/types.js";
import {
  runHeadless,
  serializeHeadlessRun,
  type HeadlessRun,
} from "../../src/cli/headless.js";
import { createInteractionRuntime } from "../../src/interaction/interaction-session.js";
import { AiHarnessTui } from "../../src/tui/app.js";

const executableProbe: ExecutableProbe = {
  async probe() {
    return {
      detected: true,
      path: "/prototype/bin/codex",
      version: "codex prototype fixture",
      diagnostics: [],
    };
  },
};

const program = new Command()
  .name("ai-harness-interaction-prototype")
  .description("Isolated shared CLI/TUI contract prototype; never mutates the current repository")
  .version("0.1.0-prototype")
  .action(async () => {
    await withDemoRepository(async (root) => {
      const runtime = await createRuntime();
      try {
        const instance = render(
          <AiHarnessTui session={runtime.session} root={root} />,
          { exitOnCtrlC: true },
        );
        await instance.waitUntilExit();
      } finally {
        await runtime.dispose();
      }
    });
  });

program
  .command("scan")
  .description("Run the real scan against an isolated Go demo repository")
  .addOption(formatOption())
  .action(async (options: { readonly format: "json" | "ndjson" }) => {
    await withDemoRepository(async (root) => {
      const runtime = await createRuntime();
      try {
        const run = await runHeadless(runtime.session, { command: "scan", root });
        writeStructured(run, options.format);
      } finally {
        await runtime.dispose();
      }
    });
  });

program
  .command("init")
  .description("Plan or apply the Go + Codex setup in an isolated demo repository")
  .option("--recommended", "Select every recommendation returned by the real scan")
  .option("--skill <ref>", "Add one direct skill selection", collect, [])
  .option("--harness <id>", "Select one harness target", collect, [])
  .option("--yes", "Approve the exact generated plan")
  .addOption(formatOption())
  .action(
    async (options: {
      readonly recommended?: boolean;
      readonly skill: readonly string[];
      readonly harness: readonly string[];
      readonly yes?: boolean;
      readonly format: "json" | "ndjson";
    }) => {
      await withDemoRepository(async (root) => {
        const runtime = await createRuntime();
        try {
          const run = await runHeadless(runtime.session, {
            command: "init",
            root,
            recommended: options.recommended === true,
            directSelections: options.skill.map(componentRef),
            targets: options.harness.map(harnessTargetId),
            approve: options.yes === true,
          });
          writeStructured(run, options.format);
        } finally {
          await runtime.dispose();
        }
      });
    },
  );

await program.parseAsync(process.argv);

async function createRuntime() {
  return await createInteractionRuntime({
    catalogFile: resolve(process.cwd(), "ai-harness.yaml"),
    executableProbe,
  });
}

function formatOption(): Option {
  return new Option("--format <format>", "Structured stdout format")
    .choices(["json", "ndjson"])
    .default("json");
}

function collect(value: string, previous: readonly string[]): readonly string[] {
  return [...previous, value];
}

function writeStructured(run: HeadlessRun, format: "json" | "ndjson"): void {
  process.stdout.write(serializeHeadlessRun(run, format));
  process.exitCode = run.result.exit_code;
}

async function withDemoRepository<T>(operation: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "ai-harness-interaction-prototype-"));
  try {
    await Promise.all([
      writeFile(join(root, "go.mod"), "module example.com/interaction-prototype\n\ngo 1.24\n"),
      writeFile(join(root, "README.md"), "# AI Harness interaction prototype\n"),
    ]);
    return await operation(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

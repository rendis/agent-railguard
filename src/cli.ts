import { readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import React from "react";
import { Command, CommanderError } from "commander";
import { render } from "ink";
import {
  decodePublicPlan,
  encodePublicPlan,
  PublicPlanValidationError,
} from "./application/serialization/public-plan.js";
import {
  encodePublicEvent,
  encodePublicResult,
} from "./application/serialization/public-contracts.js";
import {
  CommandInputError,
  runProductCommand,
  type InputAssignment,
  type ProductCommandRequest,
} from "./cli/command-runner.js";
import type { HeadlessRun } from "./cli/headless.js";
import {
  internalErrorRun,
  invalidInputRun,
  renderProgress,
  renderRun,
  type OutputFormat,
} from "./cli/output.js";
import { createInteractionRuntime } from "./interaction/interaction-session.js";
import { toPublicEvent, type CommandName } from "./interaction/public-output.js";
import {
  componentRef,
  harnessTargetId,
  type ComponentRef,
  type HarnessTargetId,
} from "./domain/shared/types.js";
import type { CatalogComponent } from "./domain/catalog/model.js";
import { AiHarnessTui } from "./tui/app.js";
import {
  beginTuiTerminal,
  renderTuiExitSummary,
} from "./tui/terminal.js";
import { createUpdateServiceFromEnvironment } from "./update/composition-root.js";

declare const __AI_HARNESS_VERSION__: string;
const version = __AI_HARNESS_VERSION__;

const program = new Command()
  .name("ai-harness")
  .description("Configure an AI-assisted development environment for this repository")
  .version(version)
  .option("--cwd <path>", "repository root", process.cwd())
  .option("--source <path>", "use this local AI Harness checkout for project content")
  .option("--plain", "render human output without terminal styling", false)
  .showHelpAfterError()
  .exitOverride();

addReadOptions(program.command("scan").description("Inspect this repository without changing it"))
  .action(async (_options, command) => {
    await invoke("scan", command, (options) => ({
      command: "scan",
      root: rootFrom(options),
    }));
  });

addReadOptions(program.command("status").description("Report durable managed state and drift"))
  .action(async (_options, command) => {
    await invoke("status", command, (options) => ({
      command: "status",
      root: rootFrom(options),
    }));
  });

addFormat(
  program
    .command("init")
    .description("Initialize project-managed AI Harness configuration")
    .option("--recommended", "include all recommendations from the current scan", false)
    .option("--add <components...>", "direct component references")
    .requiredOption("--harness <harnesses...>", "explicit harness targets")
    .option("--set <assignments...>", "component input assignment COMPONENT.INPUT=JSON")
    .option("--plan-only", "review without applying", false)
    .option("--yes", "approve and apply the exact generated plan", false),
).action(async (_options, command) => {
  await invoke("init", command, (options) => {
    const recommended = Boolean(options.recommended);
    const add = parseRefs(options.add);
    if (!recommended && add.length === 0) {
      throw new CommandInputError("init requires --recommended, --add, or both");
    }
    return {
      command: "init",
      root: rootFrom(options),
      recommended,
      add,
      targets: parseTargets(options.harness),
      setInputs: parseAssignments(options.set),
      approve: mutationApproval(options),
    };
  });
});

addFormat(
  program
    .command("plan")
    .description("Review changes to the current desired project state")
    .option("--add <components...>", "direct components to add")
    .option("--remove <components...>", "direct components to remove")
    .option("--harness <harnesses...>", "replace explicit harness targets")
    .option("--set <assignments...>", "component input assignment COMPONENT.INPUT=JSON")
    .option("--out <file>", "write the reviewed public plan without overwriting"),
).action(async (_options, command) => {
  await invoke(
    "plan",
    command,
    (options) => ({
      command: "plan",
      root: rootFrom(options),
      add: parseRefs(options.add),
      remove: parseRefs(options.remove),
      targets: options.harness === undefined ? null : parseTargets(options.harness),
      setInputs: parseAssignments(options.set),
    }),
    (options) => optionalString(options.out),
  );
});

addFormat(
  program
    .command("apply")
    .description("Apply an exported plan after deterministic reconstruction")
    .requiredOption("--plan <file>", "reviewed public plan JSON")
    .requiredOption("--yes", "approve the exact imported plan"),
).action(async (_options, command) => {
  await invoke("apply", command, async (options) => ({
    command: "apply",
    root: rootFrom(options),
    plan: decodePublicPlan(await readFile(requiredString(options.plan, "--plan"), "utf8")),
  }));
});

addFormat(
  program
    .command("remove")
    .description("Remove direct selections or all managed project configuration")
    .argument("[components...]", "direct component references")
    .option("--all", "remove all directly selected components", false)
    .option("--plan-only", "review without applying", false)
    .option("--yes", "approve and apply the exact generated plan", false),
).action(async (components: string[], _options, command) => {
  await invoke("remove", command, (options) => {
    const refs = parseRefs(components);
    const all = Boolean(options.all);
    if (all === (refs.length > 0)) {
      throw new CommandInputError("remove requires exactly one of COMPONENT... or --all");
    }
    return {
      command: "remove",
      root: rootFrom(options),
      all,
      components: refs,
      approve: mutationApproval(options),
    };
  });
});

addReadOptions(
  program
    .command("sync")
    .description("Check, review or apply project content updates from the current source")
    .option("--check", "report whether changes are available", false)
    .option("--plan-only", "review without applying", false)
    .option("--yes", "approve and apply the exact generated plan", false),
).action(async (_options, command) => {
  await invoke("sync", command, (options) => ({
    command: "sync",
    root: rootFrom(options),
    action: syncAction(options),
  }));
});

addFormat(
  program
    .command("repair")
    .description("Restore drifted AI Harness-owned project materialization")
    .option("--plan-only", "review without applying", false)
    .option("--yes", "approve and apply the exact generated plan", false),
).action(async (_options, command) => {
  await invoke("repair", command, (options) => ({
    command: "repair",
    root: rootFrom(options),
    approve: mutationApproval(options),
  }));
});

const catalog = program.command("catalog").description("Inspect the current project-content catalog");
addFormat(
  catalog
    .command("list")
    .description("List catalog components")
    .option("--type <type>", "filter by component type"),
  ["text", "json"],
).action(async (_options, command) => {
  await invoke("catalog-list", command, (options) => ({
    command: "catalog-list",
    kind: options.type === undefined ? null : parseCatalogKind(String(options.type)),
  }));
});
addFormat(
  catalog
    .command("show")
    .description("Show one catalog component")
    .argument("<component>", "typed component reference"),
  ["text", "json"],
).action(async (component: string, _options, command) => {
  await invoke("catalog-show", command, () => ({
    command: "catalog-show",
    ref: componentRef(component),
  }));
});

addFormat(program.command("doctor").description("Run read-only project diagnostics"))
  .action(async (_options, command) => {
    await invoke("doctor", command, (options) => ({
      command: "doctor",
      root: rootFrom(options),
    }));
  });

const mcp = program.command("mcp").description("Inspect and manage harness-native MCP authentication");
addFormat(
  mcp
    .command("status")
    .description("Inspect authentication for one configured MCP without changing it")
    .argument("<component>", "MCP component reference, for example mcp:atlassian-rovo")
    .requiredOption("--harness <harnesses...>", "configured harness targets"),
).action(async (component: string, _options, command) => {
  await invoke("mcp-status", command, (options) => ({
    command: "mcp-status",
    root: rootFrom(options),
    component: componentRef(component),
    targets: parseTargets(options.harness),
    approve: false,
  }));
});
addFormat(
  mcp
    .command("login")
    .description("Start native OAuth or return the exact guided action for one configured MCP")
    .argument("<component>", "MCP component reference, for example mcp:atlassian-rovo")
    .requiredOption("--harness <harnesses...>", "configured harness targets")
    .option("--yes", "approve starting native interactive login commands", false),
).action(async (component: string, _options, command) => {
  await invoke("mcp-login", command, (options) => ({
    command: "mcp-login",
    root: rootFrom(options),
    component: componentRef(component),
    targets: parseTargets(options.harness),
    approve: Boolean(options.yes),
  }));
});
addFormat(
  mcp
    .command("logout")
    .description("Remove a harness-native local OAuth session without uninstalling the MCP")
    .argument("<component>", "MCP component reference, for example mcp:atlassian-rovo")
    .requiredOption("--harness <harnesses...>", "configured harness targets")
    .requiredOption("--yes", "confirm native logout"),
).action(async (component: string, _options, command) => {
  await invoke("mcp-logout", command, (options) => ({
    command: "mcp-logout",
    root: rootFrom(options),
    component: componentRef(component),
    targets: parseTargets(options.harness),
    approve: true,
  }));
});

addFormat(
  program
    .command("update")
    .description("Check or replace the verified global engine")
    .option("--check", "check without changing the installed CLI", false)
    .option("--yes", "apply an available verified update", false),
).action(async (_options, command) => {
  await invoke("update", command, (options) => {
    const check = Boolean(options.check);
    const yes = Boolean(options.yes);
    if (check === yes) {
      throw new CommandInputError("update requires exactly one of --check or --yes");
    }
    return {
      command: "update",
      action: check ? "check" : "apply",
      currentVersion: version,
    };
  });
});

addDetailedHelp(program, catalog, mcp);

program.action(async () => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      "ai-harness requires a subcommand when stdin/stdout are not TTYs. Run ai-harness --help.\n",
    );
    process.exitCode = 2;
    return;
  }
  const root = resolve(String(program.opts().cwd ?? process.cwd()));
  const sourcePath = sourceFrom(program.opts());
  const runtime = await createInteractionRuntime({
    ...(sourcePath === undefined ? {} : { sourcePath }),
  });
  const terminal = beginTuiTerminal(process.stdout);
  try {
    const instance = render(React.createElement(AiHarnessTui, {
      session: runtime.session,
      root,
      currentVersion: version,
      updateService: createUpdateServiceFromEnvironment(),
    }));
    await instance.waitUntilExit();
  } finally {
    try {
      await runtime.dispose();
    } finally {
      terminal.restore();
      process.stdout.write(renderTuiExitSummary(runtime.session.snapshot));
    }
  }
});

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError) {
    if (error.code === "commander.helpDisplayed" || error.code === "commander.version") {
      process.exitCode = 0;
    } else {
      process.exitCode = error.exitCode === 0 ? 2 : error.exitCode;
    }
  } else {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 70;
  }
}

function addFormat(
  command: Command,
  supported: readonly OutputFormat[] = ["text", "json", "ndjson"],
): Command {
  return command.option(
    "--format <format>",
    `output format (${supported.join("|")})`,
    supported[0],
  );
}

function addReadOptions(command: Command): Command {
  return addFormat(command);
}

async function invoke(
  commandName: CommandName,
  command: Command,
  request: (
    options: Readonly<Record<string, unknown>>,
  ) => ProductCommandRequest | Promise<ProductCommandRequest>,
  planOut: (options: Readonly<Record<string, unknown>>) => string | null = () => null,
): Promise<void> {
  const options = command.optsWithGlobals() as Readonly<Record<string, unknown>>;
  let format: OutputFormat = "text";
  try {
    format = outputFormat(options);
    const productRequest = await request(options);
    await executeProduct(productRequest, format, planOut(options), sourceFrom(options));
  } catch (error) {
    const known = isInputError(error);
    const run = known
      ? invalidInputRun(commandName, errorMessage(error))
      : internalErrorRun(commandName, errorMessage(error));
    writeRun(run, format);
  }
}

async function executeProduct(
  request: ProductCommandRequest,
  format: OutputFormat,
  outputFile: string | null,
  sourcePath: string | undefined,
): Promise<void> {
  await assertPlanOutputOutsideRepository(request, outputFile);
  const runtime = await createInteractionRuntime({
    ...(sourcePath === undefined ? {} : { sourcePath }),
  });
  const unsubscribe = runtime.session.subscribe(({ event }) => {
    const publicEvent = toPublicEvent(event);
    if (format === "ndjson") {
      process.stdout.write(encodePublicEvent(publicEvent));
    } else if (format === "text") {
      const progress = renderProgress(publicEvent);
      if (progress !== null) process.stderr.write(progress);
    }
  });
  try {
    const run = await runProductCommand(runtime, request);
    if (outputFile !== null) {
      if (run.result.plan === null) {
        throw new CommandInputError("The command did not produce an exportable ready plan");
      }
      await writeFile(resolve(outputFile), encodePublicPlan(run.result.plan), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    }
    if (format === "ndjson") {
      process.stdout.write(encodePublicResult(run.result));
    } else {
      process.stdout.write(renderRun(run, format));
    }
    process.exitCode = run.result.exit_code;
  } finally {
    unsubscribe();
    await runtime.dispose();
  }
}

async function assertPlanOutputOutsideRepository(
  request: ProductCommandRequest,
  outputFile: string | null,
): Promise<void> {
  if (outputFile === null || !("root" in request)) return;
  let repositoryRoot: string;
  let outputParent: string;
  try {
    [repositoryRoot, outputParent] = await Promise.all([
      realpath(request.root),
      realpath(dirname(resolve(outputFile))),
    ]);
  } catch (error) {
    throw new CommandInputError(
      `Plan output path is not ready: ${errorMessage(error)}`,
    );
  }
  const destination = join(outputParent, basename(resolve(outputFile)));
  const difference = relative(repositoryRoot, destination);
  const isInside =
    difference === "" ||
    (!isAbsolute(difference) && difference !== ".." && !difference.startsWith(`..${sep}`));
  if (isInside) {
    throw new CommandInputError(
      "--out must be outside the target repository so exporting a plan cannot make that plan stale",
    );
  }
}

function writeRun(run: HeadlessRun, format: OutputFormat): void {
  if (format === "ndjson") {
    process.stdout.write(encodePublicResult(run.result));
  } else {
    process.stdout.write(renderRun(run, format));
  }
  process.exitCode = run.result.exit_code;
}

function outputFormat(options: Readonly<Record<string, unknown>>): OutputFormat {
  if (options.plain === true) return "text";
  const value = String(options.format ?? "text");
  if (value !== "text" && value !== "json" && value !== "ndjson") {
    throw new CommandInputError(`Unsupported output format: ${value}`);
  }
  return value;
}

function rootFrom(options: Readonly<Record<string, unknown>>): string {
  return resolve(String(options.cwd ?? process.cwd()));
}

function sourceFrom(options: Readonly<Record<string, unknown>>): string | undefined {
  if (options.source === undefined) return undefined;
  return resolve(requiredString(options.source, "--source"));
}

function mutationApproval(options: Readonly<Record<string, unknown>>): boolean {
  const planOnly = Boolean(options.planOnly);
  const yes = Boolean(options.yes);
  if (planOnly === yes) {
    throw new CommandInputError("Specify exactly one of --plan-only or --yes");
  }
  return yes;
}

function syncAction(
  options: Readonly<Record<string, unknown>>,
): "check" | "plan" | "apply" {
  const selected = [Boolean(options.check), Boolean(options.planOnly), Boolean(options.yes)];
  if (selected.filter(Boolean).length !== 1) {
    throw new CommandInputError("sync requires exactly one of --check, --plan-only or --yes");
  }
  return selected[0] ? "check" : selected[1] ? "plan" : "apply";
}

function parseRefs(value: unknown): readonly ComponentRef[] {
  return canonicalStrings(asStringArray(value).map(componentRef));
}

function parseTargets(value: unknown): readonly HarnessTargetId[] {
  const targets = canonicalStrings(asStringArray(value).map(harnessTargetId));
  if (targets.length === 0) throw new CommandInputError("At least one harness target is required");
  return targets;
}

function parseAssignments(value: unknown): readonly InputAssignment[] {
  const assignments = asStringArray(value).map((source) => {
    const equals = source.indexOf("=");
    const dot = source.lastIndexOf(".", equals);
    if (equals <= 0 || dot <= 0 || dot >= equals - 1) {
      throw new CommandInputError(
        `Invalid --set assignment ${source}; expected COMPONENT.INPUT=JSON`,
      );
    }
    const ref = componentRef(source.slice(0, dot));
    const input = source.slice(dot + 1, equals);
    if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(input)) {
      throw new CommandInputError(`Invalid component input ID: ${input}`);
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(source.slice(equals + 1)) as unknown;
    } catch {
      throw new CommandInputError(`Input ${ref}.${input} must contain valid JSON`);
    }
    if (
      !Array.isArray(decoded) ||
      decoded.length === 0 ||
      decoded.some((entry) => typeof entry !== "string")
    ) {
      throw new CommandInputError(`Input ${ref}.${input} must be a non-empty JSON string array`);
    }
    return Object.freeze({ ref, input, values: Object.freeze([...decoded] as string[]) });
  });
  const keys = assignments.map((entry) => `${entry.ref}.${entry.input}`);
  if (new Set(keys).size !== keys.length) {
    throw new CommandInputError("Each component input may be assigned only once");
  }
  return Object.freeze(assignments);
}

function parseCatalogKind(value: string): CatalogComponent["kind"] {
  const aliases: Readonly<Record<string, CatalogComponent["kind"]>> = {
    skill: "skill",
    skills: "skill",
    mcp: "mcp-integration",
    "mcp-integration": "mcp-integration",
    quality: "verification-profile",
    "verification-profile": "verification-profile",
    automation: "git-gate",
    "git-gate": "git-gate",
    pack: "pack",
    packs: "pack",
    agent: "agent",
    agents: "agent",
  };
  const kind = aliases[value];
  if (kind === undefined) throw new CommandInputError(`Unknown catalog type: ${value}`);
  return kind;
}

function asStringArray(value: unknown): string[] {
  if (value === undefined) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return [...value] as string[];
  }
  throw new CommandInputError("Expected one or more string values");
}

function canonicalStrings<Value extends string>(values: readonly Value[]): readonly Value[] {
  return Object.freeze([...new Set(values)].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
  ));
}

function requiredString(value: unknown, option: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CommandInputError(`${option} requires a non-empty path`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return value === undefined ? null : requiredString(value, "--out");
}

function isInputError(error: unknown): boolean {
  if (error instanceof CommandInputError || error instanceof PublicPlanValidationError) {
    return true;
  }
  if (error !== null && typeof error === "object" && "code" in error) {
    return ["ENOENT", "EEXIST", "EISDIR", "ENOTDIR"].includes(String(error.code));
  }
  return false;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function addDetailedHelp(root: Command, catalogCommand: Command, mcpCommand: Command): void {
  root.addHelpText("after", `
Interactive use:
  ai-harness [--cwd REPOSITORY] [--source LOCAL_CHECKOUT]
  With a TTY and no subcommand, opens the TUI and scans before enabling actions.

Machine-readable operation:
  Every subcommand is non-interactive. Use --format json for one result or ndjson for
  ordered progress events plus the final result. Mutations require --plan-only or --yes;
  no prompt is opened and stdout remains parseable.

Content source precedence:
  1. --source <path> for this invocation
  2. AI_HARNESS_CONTENT_MANIFEST_URL operational override
  3. this local authoring checkout during development
  4. the installed engine content source configured by install.sh (local checkout or remote channel)

Component references:
  skill:NAME | mcp:NAME | verification-profile:NAME | git-gate:NAME |
  pack:NAME | agent:NAME
Harness targets:
  codex | claude-code | opencode | cursor | vscode

Project content update:
  ai-harness sync --check|--plan-only|--yes fetches the current content manifest and
  reconciles skills, configurations, managed sections and hooks in the repository.
Engine update:
  ai-harness update --check|--yes verifies or replaces only the global CLI engine.

Exit codes:
  0 ready/succeeded/no changes; 2 invalid input; 3 invalid scope; 4 readiness blocked;
  5 blocked/rejected; 6 changes available; 7 failed/rolled back/recovery required;
  8 verification failed; 70 internal error; 130 cancelled.

Run ai-harness COMMAND --help for exact effects and examples.`);

  command(root, "scan").addHelpText("after", commonReadHelp(`
Examples:
  ai-harness scan --cwd . --format json
  ai-harness --source ../ai-harness-marketplace scan --cwd . --format ndjson

Effect: fetches and verifies current project content, then observes the real repository.
No repository mutation is attempted.`));
  command(root, "status").addHelpText("after", commonReadHelp(`
Examples:
  ai-harness status --cwd . --format json

Effect: compares Desired, Lock and real managed artifacts against current content.
No repository mutation is attempted.`));
  command(root, "init").addHelpText("after", mutationHelp(`
Component references use TYPE:NAME. Harness targets are codex, claude-code, opencode,
cursor and vscode. --set uses COMPONENT.INPUT=JSON_STRING_ARRAY.

Examples:
  ai-harness init --recommended --harness codex --plan-only --format json
  ai-harness init --add skill:tdd mcp:context7 --harness codex claude-code --yes

Effect: initializes an uninitialized repository from direct selections plus dependencies.
No prompt is opened; use --plan-only for Review or --yes for the exact approved plan.`));
  command(root, "plan").addHelpText("after", commonReadHelp(`
Examples:
  ai-harness plan --add skill:tdd --harness codex --format json
  ai-harness plan --remove mcp:context7 --out /tmp/ai-harness-plan.json

Effect: creates a reviewable plan from current content and real repository state. --out
must be outside the target repository and never overwrites an existing file.`));
  command(root, "apply").addHelpText("after", mutationHelp(`
Examples:
  ai-harness apply --plan /tmp/ai-harness-plan.json --yes --cwd . --format json

Effect: reconstructs the exported plan, rejects stale inputs and applies it transactionally.`));
  command(root, "remove").addHelpText("after", mutationHelp(`
Examples:
  ai-harness remove skill:tdd --plan-only --format json
  ai-harness remove --all --yes --format json

Effect: removes direct selections and only managed materialization no longer required.
Choose exactly one of COMPONENT... or --all.`));
  command(root, "sync").addHelpText("after", commonReadHelp(`
Project content update only; this command never replaces the global engine.

Examples:
  ai-harness sync --check --format json
  ai-harness sync --plan-only --format json
  ai-harness sync --yes --format ndjson

Effect: fetches current project content, resolves installed selections, then checks,
reviews or transactionally applies the resulting repository changes.`));
  command(root, "repair").addHelpText("after", mutationHelp(`
Examples:
  ai-harness repair --plan-only --format json
  ai-harness repair --yes --format ndjson

Effect: restores only drifted AI Harness-owned files, blocks and managed sections.`));
  command(root, "doctor").addHelpText("after", commonReadHelp(`
Examples:
  ai-harness doctor --cwd . --format json

Effect: diagnoses content, recovery, repository and materialization without mutation.`));
  command(root, "update").addHelpText("after", `
Global engine update only; this command does not load or modify project content.

Examples:
  ai-harness update --check --format json
  ai-harness update --yes --format ndjson

Effect: verifies the corporate engine release manifest; --yes installs, smokes and
switches the candidate or restores the previous global engine.

Output: --format text|json|ndjson. --cwd and --source do not affect this engine-only
operation; --plain only changes human rendering.`);
  catalogCommand.addHelpText("after", `
Reads the current verified project-content source. Use --source <path> globally to
inspect a local authoring checkout.

Examples:
  ai-harness catalog list --format json
  ai-harness catalog show skill:tdd --format json`);
  command(catalogCommand, "list").addHelpText("after", commonReadHelp(`
Types: skill, mcp, verification-profile, git-gate, pack, agent.

Examples:
  ai-harness catalog list --type skill --format json`));
  command(catalogCommand, "show").addHelpText("after", commonReadHelp(`
Examples:
  ai-harness catalog show mcp:context7 --format json

Effect: returns version, trust, applicability and declared relations for one component.`));
  mcpCommand.addHelpText("after", `
Authentication is user-scoped and owned by each harness. These commands never read or
persist OAuth credentials and never change project materialization.

Examples:
  ai-harness mcp status mcp:atlassian-rovo --harness codex --format json
  ai-harness mcp login mcp:atlassian-rovo --harness codex claude-code --yes --format ndjson
  ai-harness mcp logout mcp:atlassian-rovo --harness codex --yes --format json`);
  command(mcpCommand, "status").addHelpText("after", commonReadHelp(`
Examples:
  ai-harness mcp status mcp:atlassian-rovo --harness codex opencode --format json

Effect: checks the configured project MCP through each harness adapter. If the harness
does not expose a stable read-only status command, returns authentication-unknown with
an exact native action instead of inferring success from project state.`));
  command(mcpCommand, "login").addHelpText("after", commonReadHelp(`
Examples:
  ai-harness mcp login mcp:atlassian-rovo --harness codex --yes --format ndjson
  ai-harness mcp login mcp:atlassian-rovo --harness claude-code --format json

Effect: without --yes, reports what would be required. With --yes, runs only documented
native CLI activation where available (Codex, Claude Code, OpenCode and Cursor Agent when
installed). UI-owned flows remain action_required; AI Harness never automates harness UI.`));
  command(mcpCommand, "logout").addHelpText("after", commonReadHelp(`
Examples:
  ai-harness mcp logout mcp:atlassian-rovo --harness codex opencode --yes --format json

Effect: invokes or describes explicit harness-native logout. It does not uninstall the
MCP, edit project files or claim that Atlassian organization consent was revoked.`));
}

function command(parent: Command, name: string): Command {
  const child = parent.commands.find((candidate) => candidate.name() === name);
  if (child === undefined) throw new TypeError(`Missing CLI command: ${name}`);
  return child;
}

function commonReadHelp(body: string): string {
  return `${body}\n\nOutput: --format text|json|ndjson. Global --cwd, --source and --plain apply.`;
}

function mutationHelp(body: string): string {
  return `${body}\n\nMutations run preflight before writing and rollback automatically on failure.\nGlobal --cwd, --source and --plain apply.`;
}

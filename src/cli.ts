import { readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Argument, Command, CommanderError } from "commander";
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
import type { CommandRun } from "./cli/command-result.js";
import {
  delegateToPinnedEngine,
  printUpdateNotice,
  repositoryPinnedVersion,
  runRefreshLatest,
  runUpdate,
} from "./cli/engine-updates.js";
import {
  internalErrorRun,
  invalidInputRun,
  renderProgress,
  renderRun,
  type OutputFormat,
} from "./cli/output.js";
import { draftContext, draftFindings, renderDraftFindings } from "./cli/issue-draft-check.js";
import { issueKinds, issueReport, type IssueKind } from "./cli/issue-report.js";
import { runStopHook } from "./application/agent-stop-hook.js";
import { createDefaultApplication } from "./application/composition-root.js";
import { engineVersion, releaseRepository } from "./application/engine-release.js";
import {
  encodeVerificationReport,
  label,
  renderVerificationReport,
  verificationExitCodes,
} from "./cli/verification-output.js";
import { createInteractionRuntime } from "./interaction/interaction-session.js";
import { toPublicEvent, type CommandName } from "./interaction/public-output.js";
import {
  componentRef,
  harnessTargetId,
  type ComponentRef,
  type HarnessTargetId,
} from "./domain/shared/types.js";
import type { CatalogComponent } from "./domain/catalog/model.js";
import { clackUi } from "./tui/clack-ui.js";
import { runWizard } from "./tui/wizard.js";

const version = engineVersion;
const reviewRecordExitCodes = Object.freeze({ recorded: 0, invalid: 2, blocked: 5, "not-met": 8 });

const program = new Command()
  .name("railguard")
  .description("Configure an AI-assisted development environment for this repository")
  .version(version)
  .option("--cwd <path>", "repository root", process.cwd())
  .option("--source <path>", "use this local Railguard checkout for project content")
  .option("--plain", "render human output without terminal styling", false)
  .showHelpAfterError()
  .exitOverride();

// A global railguard runs every command with the engine version the repository pins; an issue
// report comes from the engine at hand, which names the pinned version itself.
const commandsWithoutDelegation = new Set(["refresh-latest", "issue"]);
program.hook("preAction", (_program, actionCommand) => {
  if (commandsWithoutDelegation.has(actionCommand.name())) return;
  const options = actionCommand.optsWithGlobals() as Readonly<Record<string, unknown>>;
  const status = delegateToPinnedEngine(rootFrom(options), process.argv.slice(2));
  if (status !== null) process.exit(status);
});

const commandsWithoutUpdateNotice = new Set(["stop", "refresh-latest", "update"]);
program.hook("postAction", async (_program, actionCommand) => {
  if (!commandsWithoutUpdateNotice.has(actionCommand.name())) await printUpdateNotice();
});

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
    .description("Initialize project-managed Railguard configuration")
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
    .description("Restore drifted Railguard-owned project materialization")
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

for (const stage of ["check", "verify"] as const) {
  addFormat(
    program
      .command(stage)
      .description(
        stage === "check"
          ? "Run the fast checks of every selected verification profile"
          : "Run every check of the selected verification profiles",
      )
      .option("--changed", "judge only what changed relative to the base branch", false)
      .option("--base <ref>", "branch or commit to compare with; default: merge-base with the default branch"),
    ["text", "json"],
  ).action(async (_options, command: Command) => {
    await direct(() => runVerification(stage, command));
  });
}

const review = program
  .command("review")
  .description("Show what a review of this change against its active handoff needs")
  .option("--base <ref>", "branch or commit to compare with; default: merge-base with the default branch")
  .action(async (_options, command: Command) => {
    await direct(async () => {
      const options = command.optsWithGlobals() as Readonly<Record<string, unknown>>;
      const root = rootFrom(options);
      const base = baseFrom(options);
      const runtime = await createDefaultApplication();
      try {
        process.stdout.write(await runtime.review.brief(root, base));
      } finally {
        await runtime.dispose();
      }
    });
  });

review
  .command("record")
  .description("Record a reviewer's criteria JSON for the current change content")
  .argument("<file>", "JSON file with the reviewed criteria")
  .action(async (file: string, _options, command: Command) => {
    await direct(async () => {
      const options = command.optsWithGlobals() as Readonly<Record<string, unknown>>;
      const root = rootFrom(options);
      const base = baseFrom(options);
      const runtime = await createDefaultApplication();
      try {
        const result = await runtime.review.record(root, file, base);
        process.stdout.write(`${result.message}\n`);
        process.exitCode = reviewRecordExitCodes[result.outcome];
      } finally {
        await runtime.dispose();
      }
    });
  });

program
  .command("hook", { hidden: true })
  .description("Entry points called by managed agent hooks")
  .command("stop")
  .description("Block a coding agent from finishing while its change fails verification")
  .requiredOption("--harness <harness>", "claude-code, codex or cursor")
  .option("--operation <operation>", "check or verify", "check")
  .action(async (_options, command: Command) => {
    await direct(async () => {
      const options = command.optsWithGlobals() as Readonly<Record<string, unknown>>;
      const harness = String(options.harness);
      const stage = String(options.operation);
      if (harness !== "claude-code" && harness !== "codex" && harness !== "cursor") {
        throw new CommandInputError(`Unsupported hook harness: ${harness}`);
      }
      if (stage !== "check" && stage !== "verify") {
        throw new CommandInputError(`Unsupported hook operation: ${stage}`);
      }
      const input = process.stdin.isTTY ? "" : await readStream(process.stdin);
      const runtime = await createDefaultApplication();
      try {
        const response = await runStopHook(
          {
            harness,
            root: rootFrom(options),
            stage,
            input,
            stateDirectory: join(tmpdir(), "railguard-stop-hooks"),
          },
          runtime.verification,
          (report) => renderVerificationReport(report, true),
        );
        process.stdout.write(response.stdout);
        process.stderr.write(response.stderr);
      } finally {
        await runtime.dispose();
      }
    });
  });

addFormat(
  program
    .command("update")
    .description("Move this repository to the latest Railguard release")
    .option("--check", "report whether a newer release exists", false)
    .option("--plan-only", "review the update without applying it", false)
    .option("--yes", "pin the new version and apply its content", false)
    .option("--to <version>", "pin this exact release instead of the latest, also to go back"),
  ["text", "json"],
).action(async (_options, command: Command) => {
  await direct(async () => {
    const options = command.optsWithGlobals() as Readonly<Record<string, unknown>>;
    const selected = [Boolean(options.check), Boolean(options.planOnly), Boolean(options.yes)];
    if (selected.filter(Boolean).length !== 1) {
      throw new CommandInputError("update requires exactly one of --check, --plan-only or --yes");
    }
    const to = options.to === undefined ? undefined : String(options.to);
    if (to !== undefined && !/^\d+\.\d+\.\d+$/u.test(to)) {
      throw new CommandInputError(`--to requires a release version such as 0.2.0, not ${to}`);
    }
    process.exitCode = await runUpdate({
      root: rootFrom(options),
      action: selected[0] ? "check" : selected[1] ? "plan" : "apply",
      to,
      format: outputFormat(options, ["text", "json"]) === "json" ? "json" : "text",
    });
  });
});

program
  .command("refresh-latest", { hidden: true })
  .description("Record the latest release for the update notice")
  .action(async () => {
    await runRefreshLatest();
  });

program
  .command("issue")
  .description("Print the guide and template to report a bug or suggest an improvement")
  .addArgument(new Argument("[kind]", "what to report").choices(issueKinds))
  .option("--check <draft>", "find project, personal and secret data in an issue draft")
  .action(async (kind: IssueKind | undefined, _options, command: Command) => {
    await direct(async () => {
      const options = command.optsWithGlobals() as Readonly<Record<string, unknown>>;
      const draft = options.check === undefined ? undefined : requiredString(options.check, "--check");
      if ((kind === undefined) === (draft === undefined)) {
        throw new CommandInputError("issue requires either a kind (bug or improvement) or --check <draft>");
      }
      const root = rootFrom(options);
      if (draft !== undefined) {
        const findings = draftFindings(await readFile(resolve(draft), "utf8"), draftContext(root), releaseRepository);
        process.stdout.write(renderDraftFindings(draft, findings));
        process.exitCode = findings.length === 0 ? 0 : 8;
        return;
      }
      process.stdout.write(issueReport(kind as IssueKind, {
        engineVersion,
        pinnedVersion: repositoryPinnedVersion(root),
        platform: `${process.platform}-${process.arch}`,
      }, releaseRepository));
    });
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

addDetailedHelp(program, catalog, mcp);

program.action(async () => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      "railguard requires a subcommand when stdin/stdout are not TTYs. Run railguard --help.\n",
    );
    process.exitCode = 2;
    return;
  }
  const root = resolve(String(program.opts().cwd ?? process.cwd()));
  const sourcePath = sourceFrom(program.opts());
  const runtime = await createInteractionRuntime({
    ...(sourcePath === undefined ? {} : { sourcePath }),
  });
  try {
    await runWizard(runtime.session, root, clackUi(), version);
  } finally {
    await runtime.dispose();
  }
});

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError) {
    if (error.code === "commander.helpDisplayed" || error.code === "commander.version") {
      process.exitCode = 0;
    } else {
      // Commander reports every usage error with 1; the contract reserves 2 for invalid input.
      process.exitCode = 2;
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

/**
 * Runs a command that writes its own report instead of a command-result envelope. Invalid input
 * still exits 2 like every other command; anything else reaches the internal-error handler.
 */
async function direct(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (!isInputError(error)) throw error;
    process.stderr.write(
      `${errorMessage(error)}\nRun railguard --help or the command-specific --help and correct the input.\n`,
    );
    process.exitCode = 2;
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

function writeRun(run: CommandRun, format: OutputFormat): void {
  if (format === "ndjson") {
    process.stdout.write(encodePublicResult(run.result));
  } else {
    process.stdout.write(renderRun(run, format));
  }
  process.exitCode = run.result.exit_code;
}

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

async function runVerification(stage: "check" | "verify", command: Command): Promise<void> {
  const options = command.optsWithGlobals() as Readonly<Record<string, unknown>>;
  const format = outputFormat(options, ["text", "json"]);
  const plain = options.plain === true || !process.stdout.isTTY;
  const sourcePath = sourceFrom(options);
  const root = rootFrom(options);
  const base = baseFrom(options);
  const runtime = await createDefaultApplication({
    ...(sourcePath === undefined ? {} : { sourcePath }),
  });
  try {
    const report = await runtime.verification.run(
      {
        root,
        stage,
        changed: options.changed === true,
        ...(base === undefined ? {} : { base }),
      },
      (event) => {
        if (format !== "text" || !process.stderr.isTTY) return;
        if (event.type === "started") process.stderr.write(`› ${label(event)}\n`);
      },
    );
    process.stdout.write(
      format === "text" ? renderVerificationReport(report, plain) : encodeVerificationReport(report),
    );
    process.exitCode = verificationExitCodes[report.verdict];
  } finally {
    await runtime.dispose();
  }
}

function outputFormat(
  options: Readonly<Record<string, unknown>>,
  supported: readonly OutputFormat[] = ["text", "json", "ndjson"],
): OutputFormat {
  if (options.plain === true) return "text";
  const value = String(options.format ?? "text");
  if (!(supported as readonly string[]).includes(value)) {
    throw new CommandInputError(`Unsupported output format: ${value}`);
  }
  return value as OutputFormat;
}

function baseFrom(options: Readonly<Record<string, unknown>>): string | undefined {
  return options.base === undefined ? undefined : requiredString(options.base, "--base");
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
    "agent-hook": "agent-hook",
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
  railguard [--cwd REPOSITORY] [--source LOCAL_CHECKOUT]
  With a TTY and no subcommand, opens the TUI and scans before enabling actions.

Machine-readable operation:
  Every subcommand is non-interactive. Use --format json for one result or ndjson for
  ordered progress events plus the final result. Mutations require --plan-only or --yes;
  no prompt is opened and stdout remains parseable.

Content source precedence:
  1. --source <path> for this invocation
  2. this local authoring checkout during development
  3. the content embedded in this railguard release

Component references:
  skill:NAME | mcp:NAME | verification-profile:NAME | git-gate:NAME |
  agent-hook:NAME | pack:NAME | agent:NAME
Harness targets:
  codex | claude-code | opencode | cursor | vscode

Project content update:
  railguard sync --check|--plan-only|--yes reconciles skills, configurations, managed
  sections and hooks in the repository with the current content.
Engine update:
  Each configured repository pins its engine in .railguard/bin/railguard, and a global
  railguard runs commands with that pinned version. railguard update --check|--plan-only|--yes
  moves the repository to the latest release; re-run the install script to update the
  global command itself. A notice on stderr reports a newer release, checked once a day in
  the background (disabled in CI or with RAILGUARD_NO_UPDATE_CHECK=1).

Reporting:
  railguard issue bug|improvement prints the guide and template for a GitHub issue that
  describes Railguard without any project, company or personal data; railguard issue
  --check DRAFT finds the data a machine can recognize before it is published.

Exit codes:
  0 ready/succeeded/no changes; 2 invalid input; 3 invalid scope; 4 readiness blocked;
  5 blocked/rejected; 6 changes available; 7 failed/rolled back/partial rollback;
  8 verification failed; 70 internal error; 130 cancelled.

Run railguard COMMAND --help for exact effects and examples.`);

  command(root, "scan").addHelpText("after", commonReadHelp(`
Examples:
  railguard scan --cwd . --format json
  railguard --source ../agent-railguard scan --cwd . --format ndjson

Effect: loads current project content, then observes the real repository.
No repository mutation is attempted.`));
  command(root, "status").addHelpText("after", commonReadHelp(`
Examples:
  railguard status --cwd . --format json

Effect: compares Desired, Lock and real managed artifacts against current content.
No repository mutation is attempted.`));
  command(root, "init").addHelpText("after", mutationHelp(`
Component references use TYPE:NAME. Harness targets are codex, claude-code, opencode,
cursor and vscode. --set uses COMPONENT.INPUT=JSON_STRING_ARRAY.

Examples:
  railguard init --recommended --harness codex --plan-only --format json
  railguard init --add skill:tdd mcp:context7 --harness codex claude-code --yes

Effect: initializes an uninitialized repository from direct selections plus dependencies.
No prompt is opened; use --plan-only for Review or --yes for the exact approved plan.`));
  command(root, "plan").addHelpText("after", commonReadHelp(`
Examples:
  railguard plan --add skill:tdd --harness codex --format json
  railguard plan --remove mcp:context7 --out /tmp/railguard-plan.json

Effect: creates a reviewable plan from current content and real repository state. --out
must be outside the target repository and never overwrites an existing file.`));
  command(root, "apply").addHelpText("after", mutationHelp(`
Examples:
  railguard apply --plan /tmp/railguard-plan.json --yes --cwd . --format json

Effect: reconstructs the exported plan, rejects stale inputs and applies it transactionally.`));
  command(root, "remove").addHelpText("after", mutationHelp(`
Examples:
  railguard remove skill:tdd --plan-only --format json
  railguard remove --all --yes --format json

Effect: removes direct selections and only managed materialization no longer required.
Choose exactly one of COMPONENT... or --all.`));
  command(root, "sync").addHelpText("after", commonReadHelp(`
Examples:
  railguard sync --check --format json
  railguard sync --plan-only --format json
  railguard sync --yes --format ndjson

Effect: loads current project content, resolves installed selections, then checks,
reviews or transactionally applies the resulting repository changes.`));
  command(root, "repair").addHelpText("after", mutationHelp(`
Examples:
  railguard repair --plan-only --format json
  railguard repair --yes --format ndjson

Effect: restores only drifted Railguard-owned files, blocks and managed sections.`));
  command(root, "update").addHelpText("after", `
Examples:
  railguard update --check
  railguard update --plan-only
  railguard update --yes
  railguard update --yes --to 0.1.0

Effect: the target release, downloaded and verified like the launcher does, runs sync; it
rewrites .railguard/bin/railguard with its version and applies the content it ships as one
reviewable change of the repository. Exit codes: 0 applied or already current; 2 invalid
input; 4 release unavailable; 6 a newer release exists (--check).
Output: --format text|json.`);
  command(root, "issue").addHelpText("after", `
Examples:
  railguard issue bug
  railguard issue improvement
  railguard issue --check /tmp/issue.md

Effect: with a kind, prints the reporting guide, the GitHub issue template of that kind and
the Railguard version and platform. The issue must hold no company, project, person, path or
secret, and an agent publishes it only after a person approves the draft.
--check finds in a draft the repository's and the person's names known to Git, emails,
absolute paths, internal URLs, IP addresses, secrets and commits of the repository. It
cannot recognize every company or project name, so a person still reads the draft.
Nothing is sent anywhere.

Exit codes: 0 no finding; 2 invalid input or unreadable draft; 8 findings.`);
  command(root, "doctor").addHelpText("after", commonReadHelp(`
Examples:
  railguard doctor --cwd . --format json

Effect: diagnoses content, repository and materialization without mutation.`));
  for (const stage of ["check", "verify"] as const) {
    command(root, stage).addHelpText("after", `
Examples:
  railguard ${stage} --changed
  railguard ${stage} --changed --base origin/release --format json
  railguard ${stage}

Effect: runs the ${stage === "check" ? "fast checks" : "checks of both stages"} of every selected verification profile.
With --changed each check judges only what changed since the merge-base with the default
branch (or --base); a repository with commits but no resolvable base is blocked. Without
--changed every project unit is judged completely. No repository mutation is attempted.

Exit codes: 0 passed; 2 invalid input; 4 a check could not run; 5 blocked; 8 a check failed.
Output: --format text|json (railguard/verification-report/v1).`);
  }
  const reviewCommand = command(root, "review");
  reviewCommand.addHelpText("after", `
Examples:
  railguard review
  railguard review --base origin/release

Effect: prints the review status of this change against its active handoffs and what a
reviewer needs. No repository mutation is attempted.`);
  command(reviewCommand, "record").addHelpText("after", `
Examples:
  railguard review record /tmp/review.json

Effect: stores the reviewed criteria for the exact current change content inside the
Git directory, never in versioned files.

Exit codes: 0 recorded; 2 unreadable or incomplete review; 5 no active handoff;
8 recorded with an unmet criterion.`);
  catalogCommand.addHelpText("after", `
Reads the current verified project-content source. Use --source <path> globally to
inspect a local authoring checkout.

Examples:
  railguard catalog list --format json
  railguard catalog show skill:tdd --format json`);
  command(catalogCommand, "list").addHelpText("after", commonReadHelp(`
Types: skill, mcp, verification-profile, git-gate, agent-hook, pack, agent.

Examples:
  railguard catalog list --type skill --format json`));
  command(catalogCommand, "show").addHelpText("after", commonReadHelp(`
Examples:
  railguard catalog show mcp:context7 --format json

Effect: returns version, trust, applicability and declared relations for one component.`));
  mcpCommand.addHelpText("after", `
Authentication is user-scoped and owned by each harness. These commands never read or
persist OAuth credentials and never change project materialization.

Examples:
  railguard mcp status mcp:atlassian-rovo --harness codex --format json
  railguard mcp login mcp:atlassian-rovo --harness codex claude-code --yes --format ndjson
  railguard mcp logout mcp:atlassian-rovo --harness codex --yes --format json`);
  command(mcpCommand, "status").addHelpText("after", commonReadHelp(`
Examples:
  railguard mcp status mcp:atlassian-rovo --harness codex opencode --format json

Effect: checks the configured project MCP through each harness adapter. If the harness
does not expose a stable read-only status command, returns authentication-unknown with
an exact native action instead of inferring success from project state.`));
  command(mcpCommand, "login").addHelpText("after", commonReadHelp(`
Examples:
  railguard mcp login mcp:atlassian-rovo --harness codex --yes --format ndjson
  railguard mcp login mcp:atlassian-rovo --harness claude-code --format json

Effect: without --yes, reports what would be required. With --yes, runs only documented
native CLI activation where available (Codex, Claude Code, OpenCode and Cursor Agent when
installed). UI-owned flows remain action_required; Railguard never automates harness UI.`));
  command(mcpCommand, "logout").addHelpText("after", commonReadHelp(`
Examples:
  railguard mcp logout mcp:atlassian-rovo --harness codex opencode --yes --format json

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

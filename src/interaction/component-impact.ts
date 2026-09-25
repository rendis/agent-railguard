import type { CatalogComponent } from "../domain/catalog/model.js";
import type { CatalogItemView } from "./model.js";

export function componentImpact(component: CatalogComponent): CatalogItemView["impact"] {
  switch (component.kind) {
    case "skill":
      return Object.freeze({
        changes: `Installs ${component.payload.files.length} managed skill file(s) in each selected harness project directory.`,
        workflow: "Makes procedural guidance available to agents on demand; it does not run checks or Git hooks by itself.",
      });
    case "mcp-integration":
      return Object.freeze({
        changes: component.connection.type === "stdio"
          ? `Writes project-scoped MCP configuration for selected targets using ${component.connection.command} ${component.connection.args.join(" ")}.`
          : `Writes project-scoped remote MCP configuration for selected targets using ${component.connection.url}.`,
        workflow: `Lets agents call ${component.tools.join(", ")} at runtime; network access is required and authentication is ${component.auth.type}.`,
      });
    case "verification-profile": {
      const stages = [...new Set(component.checks.map((check) => check.stage))]
        .map((stage) => `railguard ${stage}`)
        .join(" and ");
      return Object.freeze({
        changes: `Writes no file; records ${component.checks.length} check(s) in the project selection that ${stages} run.`,
        workflow: "Gives developers, agent hooks, Git gates and CI one deterministic verification contract that judges only the change with --changed.",
      });
    }
    case "git-gate": {
      const provider = component.relations.find(
        (relation) => relation.kind === "requires",
      )?.target;
      return Object.freeze({
        changes: `Creates or updates the managed ${component.event} hook, activates the repository hooks path and runs railguard ${component.operation} --changed.`,
        workflow: `Blocks ${component.event === "pre-commit" ? "commits" : "pushes"} when the operation fails${provider === undefined ? "." : `; includes ${provider} as its provider.`}`,
      });
    }
    case "agent-hook":
      return Object.freeze({
        changes: `Adds a ${component.event} hook to the configuration of each selected harness (Claude Code, Codex, Cursor) and a managed script under .railguard/agent-hooks.`,
        workflow: `When an agent tries to finish, runs railguard ${component.operation} --changed and sends failures back to the agent, at most three times per session.`,
      });
    case "instruction-fragment":
      return Object.freeze({
        changes: `Updates only the Railguard-managed ${component.section} section in the project instruction files used by selected targets.`,
        workflow: "Changes agent guidance and discovery; it does not execute commands or modify application code.",
      });
    case "pack": {
      const included = component.relations.filter(
        (relation) => relation.kind === "includes" || relation.kind === "requires",
      ).length;
      return Object.freeze({
        changes: `Writes no pack file; expands this selection to ${included} declared component(s), whose exact effects appear in Review.`,
        workflow: "Selects a coordinated setup in one action while every included component remains independently traceable.",
      });
    }
    case "agent":
      return Object.freeze({
        changes: "Writes the project-scoped native agent definition for each selected target and updates its managed agent mapping when required.",
        workflow: "Adds a specialized agent that can be invoked by the harness; it does not run automatically or change application code.",
      });
  }
}

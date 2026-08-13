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
      const operations = Object.keys(component.make.operations)
        .map((operation) => `make ${operation}`)
        .join(" and ");
      return Object.freeze({
        changes: `Creates or updates AI Harness-managed sections in the root Makefile and exposes ${operations}.`,
        workflow: "Gives developers, skills and optional Git hooks one deterministic verification contract; it does not enable a hook by itself.",
      });
    }
    case "git-gate": {
      const provider = component.relations.find(
        (relation) => relation.kind === "requires",
      )?.target;
      return Object.freeze({
        changes: `Creates or updates the managed ${component.event} hook, activates the repository hooks path and runs make ${component.operation}.`,
        workflow: `Blocks ${component.event === "pre-commit" ? "commits" : "pushes"} when the operation fails${provider === undefined ? "." : `; includes ${provider} as its provider.`}`,
      });
    }
    case "instruction-fragment":
      return Object.freeze({
        changes: `Updates only the AI Harness-managed ${component.section} section in the project instruction files used by selected targets.`,
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

import type {
  CatalogComponent,
  CatalogInstructionFragmentComponent,
  CatalogSnapshot,
} from "../../../domain/catalog/model.js";
import type {
  ProjectArtifactProjector,
  ProjectProjection,
  ProjectSelectionInputs,
} from "../../../domain/project/model.js";
import type { RepositorySnapshot } from "../../../domain/repository/model.js";
import type { RepositoryAssessmentResult } from "../../../domain/repository/model.js";
import type { ReadyResolution } from "../../../domain/resolution/model.js";
import {
  capabilityId,
  compareUtf8,
  harnessTargetId,
  relativePosixPath,
  semVer,
  type ComponentRef,
  type HarnessTargetId,
} from "../../../domain/shared/types.js";
import {
  projectProjectionTargetId,
  type ProjectedUnit,
} from "../../../domain/projection/model.js";
import { resolveInstructionTopology } from "./instruction-topology.js";
import { skillInstallationRoots } from "../skills/skill-installation-roots.js";

export class InstructionProjector implements ProjectArtifactProjector {
  public async project(
    resolution: ReadyResolution,
    catalog: CatalogSnapshot,
    snapshot: RepositorySnapshot,
    _assessment: RepositoryAssessmentResult,
    targets: readonly HarnessTargetId[],
    _selectionInputs: ProjectSelectionInputs,
  ): Promise<ProjectProjection> {
    const byRef = new Map(catalog.components.map((component) => [component.ref, component]));
    const resolved = resolution.components
      .map((entry) => requireComponent(byRef, entry.ref))
      .sort((left, right) => compareUtf8(left.ref, right.ref));
    const resolvedRefs = new Set(resolved.map((component) => component.ref));
    const fragments = catalog.components
      .filter(
        (component): component is CatalogInstructionFragmentComponent =>
          component.kind === "instruction-fragment" &&
          (resolvedRefs.has(component.ref) || activatesIndex(component, resolved)),
      )
      .sort((left, right) => compareUtf8(left.section, right.section));

    const topology = await resolveInstructionTopology(snapshot, targets);
    if (topology.kind === "blocked") {
      return Object.freeze({
        identity: instructionProjectionIdentity(),
        units: Object.freeze([]),
        diagnostics: topology.diagnostics,
      });
    }

    const units = fragments.map<ProjectedUnit>((fragment) => {
      const indexed = indexedComponents(fragment, resolved);
      const sources = [
        ...(resolvedRefs.has(fragment.ref) ? [fragment.ref] : []),
        ...indexed.map((component) => component.ref),
      ].sort(compareUtf8);
      return Object.freeze({
        kind: "artifact",
        ownershipId: `project.instructions.${fragment.section}`,
        sources: Object.freeze([...new Set<ComponentRef>(sources)]),
        intent: Object.freeze({
          kind: "managed-section",
          owner: fragment.ref,
          path: topology.instructionPath,
          sectionId: fragment.section,
          body: renderFragment(fragment, indexed, targets),
          mode: 0o644,
          markerStyle: "markdown",
        }),
      });
    });
    if (topology.claudeImport === "managed" && units.length > 0) {
      const sources = [...new Set(units.flatMap((unit) => unit.sources))].sort(compareUtf8);
      units.push(
        Object.freeze({
          kind: "artifact",
          ownershipId: "project.instructions.claude.agents-import",
          sources: Object.freeze(sources),
          intent: Object.freeze({
            kind: "managed-section",
            owner: "project:claude-agents-import",
            path: relativePosixPath("CLAUDE.md"),
            sectionId: "claude.agents-import",
            body: "@AGENTS.md",
            mode: 0o644,
            markerStyle: "markdown",
          }),
        }),
      );
    }
    units.sort((left, right) => compareUtf8(left.ownershipId, right.ownershipId));

    return Object.freeze({
      identity: instructionProjectionIdentity(),
      units: Object.freeze(units),
      diagnostics: topology.diagnostics,
    });
  }
}

function instructionProjectionIdentity() {
  return Object.freeze({
    target: projectProjectionTargetId,
    adapter: Object.freeze({
      id: harnessTargetId("instructions"),
      version: semVer("0.1.0"),
    }),
    capabilities: Object.freeze([capabilityId("project.instructions")]),
  });
}

function activatesIndex(
  fragment: CatalogInstructionFragmentComponent,
  resolved: readonly CatalogComponent[],
): boolean {
  if (fragment.content.kind !== "catalog-index") return false;
  const { group } = fragment.content;
  return resolved.some((component) => belongsToGroup(component, group));
}

function indexedComponents(
  fragment: CatalogInstructionFragmentComponent,
  resolved: readonly CatalogComponent[],
): readonly CatalogComponent[] {
  if (fragment.content.kind !== "catalog-index") return Object.freeze([]);
  const { group } = fragment.content;
  return Object.freeze(
    resolved
      .filter((component) => belongsToGroup(component, group))
      .sort((left, right) => compareUtf8(left.ref, right.ref)),
  );
}

function renderFragment(
  fragment: CatalogInstructionFragmentComponent,
  indexed: readonly CatalogComponent[],
  targets: readonly HarnessTargetId[],
): string {
  const group = fragment.content.group;
  const label = groupLabel(group);
  const lines = indexed.length === 0
    ? ["- No entries apply."]
    : indexed.map(
        (component) =>
          `- \`${component.ref.slice(component.ref.indexOf(":") + 1)}\`: ${mappingGuidance(component, targets)}`,
      );
  return [`## ${label}`, "", groupInstruction(group), "", ...lines, ""].join("\n");
}

function belongsToGroup(
  component: CatalogComponent,
  group: Extract<CatalogInstructionFragmentComponent["content"], { readonly kind: "catalog-index" }>["group"],
): boolean {
  switch (group) {
    case "skills": return component.kind === "skill";
    case "mcps": return component.kind === "mcp-integration";
    case "agents": return component.kind === "agent";
    case "automation": return component.kind === "git-gate" || component.kind === "agent-hook";
    case "quality": return component.kind === "verification-profile";
  }
}

function groupLabel(
  group: Extract<CatalogInstructionFragmentComponent["content"], { readonly kind: "catalog-index" }>["group"],
): string {
  switch (group) {
    case "skills": return "Skill routing";
    case "mcps": return "External tools";
    case "agents": return "Delegation";
    case "automation": return "Git automation";
    case "quality": return "Verification";
  }
}

function groupInstruction(
  group: Extract<CatalogInstructionFragmentComponent["content"], { readonly kind: "catalog-index" }>["group"],
): string {
  switch (group) {
    case "skills":
      return "Load only the skills relevant to the task, and read each referenced `SKILL.md` before following its workflow.";
    case "mcps":
      return "Prefer repository evidence. Use an external tool only when its criterion below is met.";
    case "agents":
      return "Delegate bounded work only when a specialist below matches the task.";
    case "automation":
      return "Treat hook failures as local feedback. Reproduce a failure with the same canonical command and fix its cause; local hooks do not replace CI.";
    case "quality":
      return "Use the canonical project commands below; their exit status is the mechanical verdict. `.railguard/verify.sh` holds the complete checks that CI runs: never edit it; change `.railguard/project.yaml` and run `.railguard/bin/railguard sync --yes`. Run Railguard as `.railguard/bin/railguard`, which uses the version this repository pins; `railguard` in skills and descriptions means that launcher. When Railguard reports a newer release, tell the user and ask whether you should run `.railguard/bin/railguard update --yes` or they prefer to do it; never update without asking.";
  }
}

function mappingGuidance(
  component: CatalogComponent,
  targets: readonly HarnessTargetId[],
): string {
  switch (component.kind) {
    case "skill": {
      const id = component.ref.slice("skill:".length);
      const root = skillInstallationRoots(targets)[0];
      const pointer = root === undefined ? "its `SKILL.md`" : `\`${root.path}/${id}/SKILL.md\``;
      return `${component.details} Read ${pointer} before following this workflow.`;
    }
    case "agent": {
      const requiredSkills = component.relations
        .filter((relation) => relation.kind === "requires" && relation.target.startsWith("skill:"))
        .map((relation) => `\`${relation.target.slice("skill:".length)}\``)
        .sort(compareUtf8);
      const requirement = requiredSkills.length === 0
        ? ""
        : ` Load ${joinNatural(requiredSkills)} before starting the review.`;
      return `Delegate when you need to ${lowercaseFirst(withoutFinalPeriod(component.description))}.${requirement}`;
    }
    case "mcp-integration": {
      const auth = component.auth.type === "oauth"
        ? " Network access and harness-native OAuth are required. Keep native approvals in force for write actions."
        : " Network access is required; no authentication is needed.";
      return `${component.description}${auth}`;
    }
    case "verification-profile":
      return component.description;
    case "git-gate": {
      const timing = component.event === "pre-commit" ? "Before committing" : "Before pushing";
      return `${timing}, \`.railguard/bin/railguard ${component.operation} --changed\` runs automatically; run it yourself to reproduce a failure.`;
    }
    case "agent-hook":
      return `When you finish a turn, \`.railguard/bin/railguard ${component.operation} --changed\` runs and any failure comes back to you; fix it instead of weakening tests or checks.`;
    default:
      return component.description;
  }
}

function withoutFinalPeriod(value: string): string {
  return value.endsWith(".") ? value.slice(0, -1) : value;
}

function lowercaseFirst(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toLowerCase()}${value.slice(1)}`;
}

function joinNatural(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

function requireComponent(
  byRef: ReadonlyMap<ComponentRef, CatalogComponent>,
  ref: ComponentRef,
): CatalogComponent {
  const component = byRef.get(ref);
  if (component === undefined) {
    throw new TypeError(`Resolution/catalog mismatch for component: ${ref}`);
  }
  return component;
}

import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexAdapter } from "../../src/adapters/harness/codex/codex-adapter.js";
import { InstructionProjector } from "../../src/adapters/project/instructions/instruction-projector.js";
import { SharedSkillProjector } from "../../src/adapters/project/skills/shared-skill-projector.js";
import { NodeRepositoryInventory } from "../../src/adapters/platform/repository-inventory/node-repository-inventory.js";
import { FilesystemCatalog } from "../../src/catalog/filesystem-catalog.js";
import type { ExecutableProbe } from "../../src/domain/harness/model.js";
import { DefaultProjectProjectionCoordinator } from "../../src/domain/harness/projection-coordinator.js";
import type { GitConfigPort } from "../../src/domain/planning/model.js";
import { DefaultResolver } from "../../src/domain/resolution/resolver.js";
import {
  capabilityId,
  componentRef,
  harnessTargetId,
  languageId,
} from "../../src/domain/shared/types.js";
import { DurableProjectPlanner } from "../../src/domain/transaction/project-planner.js";
import { DesiredStateModule } from "../../src/project-state/desired-state.js";
import { createTempRepository } from "../helpers/temp-repository.js";
import { repositoryAssessment } from "../helpers/repository-assessment.js";

const probe: ExecutableProbe = {
  async probe() {
    return { detected: true, path: "/test/codex", version: "test", diagnostics: [] };
  },
};

const gitConfig: GitConfigPort = {
  async get() {
    return { kind: "absent" };
  },
  async set() {
    throw new Error("planning must be read-only");
  },
};

describe("DurableProjectPlanner", () => {
  it("plans portable Desired + Lock and preserves external instruction bytes", async () => {
    const repository = await createTempRepository({
      "AGENTS.md": "# User-owned instructions",
    });
    try {
      const catalog = await loadCatalog();
      const snapshot = await new NodeRepositoryInventory().snapshot(repository.root);
      const resolution = new DefaultResolver().resolve({
        catalog,
        directSelections: [componentRef("skill:tdd")],
        projectUnits: [],
        targets: [
          {
            target: harnessTargetId("codex"),
            capabilities: [
              capabilityId("project.instructions"),
              capabilityId("project.skills"),
            ],
          },
        ],
      });
      expect(resolution.kind).toBe("ready");
      if (resolution.kind !== "ready") return;
      const projection = new CodexAdapter(probe).project(resolution, catalog);
      const instructions = await new InstructionProjector().project(
        resolution,
        catalog,
        snapshot,
        repositoryAssessment(snapshot),
        [harnessTargetId("codex")],
        new Map(),
      );
      const project = new DefaultProjectProjectionCoordinator().coordinate([instructions]);
      const desired = new DesiredStateModule().evaluate(
        {
          kind: "draft",
          targets: ["codex"],
          selections: [{ ref: "skill:tdd" }],
        },
        catalog,
      );
      expect(desired.kind).toBe("ready");
      if (desired.kind !== "ready") return;

      const plan = await new DurableProjectPlanner(gitConfig).plan({
        mode: "reconcile",
        snapshot,
        catalog,
        resolution,
        projections: [project, projection],
        desiredBefore: null,
        lockBefore: null,
        desiredAfter: desired,
      });

      expect(plan.kind).toBe("ready");
      if (plan.kind !== "ready") return;
      const agentsWrite = plan.operations.find(
        (operation) => operation.kind === "write-file" && operation.path === "AGENTS.md",
      );
      expect(agentsWrite?.kind).toBe("write-file");
      if (agentsWrite?.kind === "write-file") {
        expect(agentsWrite.bytes.toString()).toMatch(
          /^# User-owned instructions\n<!-- railguard:managed:start id="skills.mapping" -->\n## Skill routing\n/u,
        );
        expect(agentsWrite.bytes.toString()).toContain("- `design-tests`:");
        expect(agentsWrite.bytes.toString()).toContain("- `tdd`:");
        expect(agentsWrite.bytes.toString()).toMatch(
          /<!-- railguard:managed:end id="skills.mapping" -->\n$/u,
        );
      }
      expect(plan.lockAfter?.state.artifacts.find((artifact) => artifact.kind === "managed-section")).toMatchObject({
        ownership_id: "project.instructions.skills.mapping",
        placement: "append",
        marker_style: "markdown",
      });
      expect(plan.operations.map((operation) => operation.unitId)).toContain("state.desired");
      expect(plan.operations.map((operation) => operation.unitId)).toContain("state.lock");
    } finally {
      await repository.cleanup();
    }
  });

  it("blocks rather than adopting an unowned matching marker", async () => {
    const repository = await createTempRepository({
      "AGENTS.md": '<!-- railguard:managed:start id="skills.mapping" -->\nforeign\n<!-- railguard:managed:end id="skills.mapping" -->\n',
    });
    try {
      const catalog = await loadCatalog();
      const snapshot = await new NodeRepositoryInventory().snapshot(repository.root);
      const resolution = new DefaultResolver().resolve({
        catalog,
        directSelections: [componentRef("skill:tdd")],
        projectUnits: [],
        targets: [
          {
            target: harnessTargetId("codex"),
            capabilities: [
              capabilityId("project.instructions"),
              capabilityId("project.skills"),
            ],
          },
        ],
      });
      if (resolution.kind !== "ready") throw new Error("Expected ready resolution");
      const desired = new DesiredStateModule().evaluate(
        { kind: "draft", targets: ["codex"], selections: [{ ref: "skill:tdd" }] },
        catalog,
      );
      if (desired.kind !== "ready") throw new Error("Expected ready desired state");

      const instructions = await new InstructionProjector().project(
        resolution,
        catalog,
        snapshot,
        repositoryAssessment(snapshot),
        [harnessTargetId("codex")],
        new Map(),
      );
      const project = new DefaultProjectProjectionCoordinator().coordinate([instructions]);
      const plan = await new DurableProjectPlanner(gitConfig).plan({
        mode: "reconcile",
        snapshot,
        catalog,
        resolution,
        projections: [project, new CodexAdapter(probe).project(resolution, catalog)],
        desiredBefore: null,
        lockBefore: null,
        desiredAfter: desired,
      });

      expect(plan.kind).toBe("blocked");
      if (plan.kind === "blocked") {
        expect(plan.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
          "planning.managed-section.foreign",
        );
      }
    } finally {
      await repository.cleanup();
    }
  });

  it("blocks a whole-file ownership handoff at the same path", async () => {
    const repository = await createTempRepository({});
    try {
      const catalog = await loadCatalog();
      const snapshot = await new NodeRepositoryInventory().snapshot(repository.root);
      const resolution = new DefaultResolver().resolve({
        catalog,
        directSelections: [componentRef("skill:tdd")],
        projectUnits: [],
        targets: [{ target: harnessTargetId("codex"), capabilities: [capabilityId("project.skills")] }],
      });
      if (resolution.kind !== "ready") throw new Error("Expected ready resolution");
      const desired = new DesiredStateModule().evaluate(
        { kind: "draft", targets: ["codex"], selections: [{ ref: "skill:tdd" }] },
        catalog,
      );
      if (desired.kind !== "ready") throw new Error("Expected ready desired state");
      const originalProjection = await new SharedSkillProjector().project(
        resolution,
        catalog,
        snapshot,
        repositoryAssessment(snapshot),
        [harnessTargetId("codex")],
        new Map(),
      );
      const first = await new DurableProjectPlanner(gitConfig).plan({
        mode: "reconcile",
        snapshot,
        catalog,
        resolution,
        projections: [originalProjection],
        desiredBefore: null,
        lockBefore: null,
        desiredAfter: desired,
      });
      if (first.kind !== "ready" || first.lockAfter === null) throw new Error("Expected first lock");
      const changedProjection = Object.freeze({
        ...originalProjection,
        units: Object.freeze(
          originalProjection.units.map((unit, index) =>
            index === 0 ? Object.freeze({ ...unit, ownershipId: "codex.skill.handoff" }) : unit,
          ),
        ),
      });

      const handoff = await new DurableProjectPlanner(gitConfig).plan({
        mode: "reconcile",
        snapshot,
        catalog,
        resolution,
        projections: [changedProjection],
        desiredBefore: desired,
        lockBefore: first.lockAfter,
        desiredAfter: desired,
      });

      expect(handoff.kind).toBe("blocked");
      if (handoff.kind === "blocked") {
        expect(handoff.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
          "planning.file.ownership-handoff",
        );
      }
    } finally {
      await repository.cleanup();
    }
  });
});

async function loadCatalog() {
  const result = await new FilesystemCatalog({
    catalogFile: resolve("railguard.yaml"),
    supportedLanguages: [languageId("go")],
  }).load();
  if (result.kind !== "ready") throw new Error("Expected ready catalog");
  return result.catalog;
}

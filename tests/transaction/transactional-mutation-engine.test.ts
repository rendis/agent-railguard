import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { CodexAdapter } from "../../src/adapters/harness/codex/codex-adapter.js";
import { InstructionProjector } from "../../src/adapters/project/instructions/instruction-projector.js";
import { NodeRepositoryInventory } from "../../src/adapters/platform/repository-inventory/node-repository-inventory.js";
import { NodeProjectStateStore } from "../../src/adapters/platform/state/project-state-store.js";
import { NodeTransactionStore } from "../../src/adapters/platform/transaction/node-transaction-store.js";
import { NodeTransactionalMutationEngine } from "../../src/adapters/platform/transaction/node-transactional-mutation-engine.js";
import { FilesystemCatalog } from "../../src/catalog/filesystem-catalog.js";
import type { ExecutableProbe } from "../../src/domain/harness/model.js";
import type { GitConfigPort, GitConfigValue } from "../../src/domain/planning/model.js";
import type { ManagedProjection } from "../../src/domain/projection/model.js";
import { DefaultResolver } from "../../src/domain/resolution/resolver.js";
import { DefaultProjectProjectionCoordinator } from "../../src/domain/harness/projection-coordinator.js";
import {
  capabilityId,
  componentRef,
  harnessTargetId,
  languageId,
  relativePosixPath,
} from "../../src/domain/shared/types.js";
import { DurableProjectPlanner } from "../../src/domain/transaction/project-planner.js";
import { DesiredStateModule } from "../../src/project-state/desired-state.js";
import { createTempRepository } from "../helpers/temp-repository.js";
import { repositoryAssessment } from "../helpers/repository-assessment.js";

const execute = promisify(execFile);
const probe: ExecutableProbe = {
  async probe() {
    return { detected: true, path: "/test/codex", version: "test", diagnostics: [] };
  },
};

describe("NodeTransactionalMutationEngine", () => {
  it("commits durable project state, restarts as a no-op, and leaves clean observed ownership", async () => {
    const repository = await gitRepository({ "AGENTS.md": "# User\n" });
    const gitConfig = memoryGitConfig();
    const store = new NodeTransactionStore();
    try {
      const prepared = await prepare(repository.root, gitConfig);
      const engine = new NodeTransactionalMutationEngine(store, gitConfig);

      const applied = await engine.apply(prepared.plan);

      expect(applied.kind).toBe("applied");
      expect(applied.receiptPath).not.toBeNull();
      if (prepared.plan.desiredAfter === null || prepared.plan.lockAfter === null) {
        throw new Error("Expected installed durable state");
      }
      expect(await readFile(join(repository.root, ".ai-harness/project.yaml"), "utf8")).toBe(
        prepared.plan.desiredAfter.bytes.toString(),
      );
      expect(await readFile(join(repository.root, ".ai-harness/lock.json"), "utf8")).toBe(
        prepared.plan.lockAfter.bytes.toString(),
      );
      expect(await readFile(join(repository.root, "AGENTS.md"), "utf8")).toContain(
        '<!-- ai-harness:managed:start id="skills.mapping" -->',
      );

      const state = new NodeProjectStateStore();
      const desired = await state.loadDesired(repository.root, prepared.catalog);
      expect(desired.kind).toBe("ready");
      if (desired.kind !== "ready") return;
      const lock = await state.loadLock(repository.root, {
        desiredDigest: desired.digest,
        catalog: prepared.catalog,
      });
      expect(lock.kind).toBe("ready");
      if (lock.kind !== "ready") return;
      const snapshot = await new NodeRepositoryInventory().snapshot(repository.root);
      const noOp = await new DurableProjectPlanner(gitConfig).plan({
        mode: "reconcile",
        snapshot,
        catalog: prepared.catalog,
        resolution: prepared.resolution,
        projections: prepared.projections,
        desiredBefore: desired,
        lockBefore: lock,
        desiredAfter: desired,
      });
      expect(noOp.kind).toBe("ready");
      if (noOp.kind !== "ready") return;
      expect(noOp.operations).toEqual([]);
      expect((await engine.apply(noOp)).kind).toBe("no-changes");
      expect(await store.readJournal(await store.discover(repository.root))).toBeNull();
    } finally {
      await repository.cleanup();
    }
  });

  it("rejects the entire plan when the repository changes after review", async () => {
    const repository = await gitRepository({ "AGENTS.md": "# User\n" });
    const gitConfig = memoryGitConfig();
    try {
      const prepared = await prepare(repository.root, gitConfig);
      await writeFile(join(repository.root, "AGENTS.md"), "# changed after review\n");

      const result = await new NodeTransactionalMutationEngine(
        new NodeTransactionStore(),
        gitConfig,
      ).apply(prepared.plan);

      expect(result.kind).toBe("rejected");
      expect(result.changedPaths).toEqual([]);
      expect(await readFile(join(repository.root, "AGENTS.md"), "utf8")).toBe(
        "# changed after review\n",
      );
      await expect(readFile(join(repository.root, ".ai-harness/project.yaml"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await repository.cleanup();
    }
  });

  it("uses the durable journal to roll back every prior unit when a late Git effect fails", async () => {
    const repository = await gitRepository({ "AGENTS.md": "# User\n" });
    let value: GitConfigValue = Object.freeze({ kind: "absent" });
    const gitConfig: GitConfigPort = {
      async get() {
        return value;
      },
      async set(_root, _key, next) {
        if (next !== null) throw new Error("simulated Git config failure");
        value = Object.freeze({ kind: "absent" });
      },
    };
    try {
      const prepared = await prepare(repository.root, gitConfig, true);
      const baseline = await new NodeRepositoryInventory().snapshot(repository.root);

      const result = await new NodeTransactionalMutationEngine(
        new NodeTransactionStore(),
        gitConfig,
      ).apply(prepared.plan);

      expect(result.kind).toBe("rolled-back");
      expect((await new NodeRepositoryInventory().snapshot(repository.root)).fingerprint).toBe(
        baseline.fingerprint,
      );
      expect(value).toEqual({ kind: "absent" });
      expect(await readFile(join(repository.root, "AGENTS.md"), "utf8")).toBe("# User\n");
    } finally {
      await repository.cleanup();
    }
  });
});

async function prepare(root: string, gitConfig: GitConfigPort, withGitEffect = false) {
  const catalogResult = await new FilesystemCatalog({
    catalogFile: resolve("ai-harness.yaml"),
    supportedLanguages: [languageId("go")],
  }).load();
  if (catalogResult.kind !== "ready") throw new Error("Expected catalog");
  const catalog = catalogResult.catalog;
  const resolution = new DefaultResolver().resolve({
    catalog,
    directSelections: [componentRef("skill:tdd")],
    projectUnits: [],
    targets: [
      { target: harnessTargetId("codex"), capabilities: [capabilityId("project.skills")] },
    ],
  });
  if (resolution.kind !== "ready") throw new Error("Expected resolution");
  const snapshot = await new NodeRepositoryInventory().snapshot(root);
  const projectProjection = new DefaultProjectProjectionCoordinator().coordinate([
    await new InstructionProjector().project(
      resolution,
      catalog,
      snapshot,
      repositoryAssessment(snapshot),
      [harnessTargetId("codex")],
      new Map(),
    ),
  ]);
  const baseProjection = new CodexAdapter(probe).project(resolution, catalog);
  const harnessProjection: ManagedProjection = withGitEffect
    ? Object.freeze({
        ...baseProjection,
        units: Object.freeze([
          ...baseProjection.units,
          Object.freeze({
            kind: "local-effect" as const,
            ownershipId: "codex.test.activation",
            sources: Object.freeze([componentRef("skill:tdd")]),
            intent: Object.freeze({
              kind: "git-config" as const,
              owner: "codex:test.activation",
              path: relativePosixPath(".git/config"),
              key: "core.hooksPath" as const,
              value: ".ai-harness/hooks",
            }),
          }),
        ]),
      })
    : baseProjection;
  const desired = new DesiredStateModule().evaluate(
    { kind: "draft", targets: ["codex"], selections: [{ ref: "skill:tdd" }] },
    catalog,
  );
  if (desired.kind !== "ready") throw new Error("Expected desired state");
  const projections = Object.freeze([projectProjection, harnessProjection]);
  const plan = await new DurableProjectPlanner(gitConfig).plan({
    mode: "reconcile",
    snapshot,
    catalog,
    resolution,
    projections,
    desiredBefore: null,
    lockBefore: null,
    desiredAfter: desired,
  });
  if (plan.kind !== "ready") throw new Error(`Expected ready plan: ${plan.diagnostics[0]?.code}`);
  return { catalog, resolution, projections, plan };
}

function memoryGitConfig(): GitConfigPort {
  let value: GitConfigValue = Object.freeze({ kind: "absent" });
  return {
    async get() {
      return value;
    },
    async set(_root, _key, next) {
      value = next === null
        ? Object.freeze({ kind: "absent" })
        : Object.freeze({ kind: "value", value: next });
    },
  };
}

async function gitRepository(files: Readonly<Record<string, string>>) {
  const repository = await createTempRepository(files);
  await execute("git", ["init", "--quiet", repository.root]);
  return repository;
}

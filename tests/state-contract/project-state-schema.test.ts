import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import projectStateSchema from "../../schemas/project-state.v1.schema.json" with {
  type: "json",
};

const digest = `sha256:${"a".repeat(64)}`;
const otherDigest = `sha256:${"b".repeat(64)}`;
const operationId = "123e4567-e89b-42d3-a456-426614174000";

const project = {
  schema: "ai-harness/project/v1",
  targets: ["codex"],
  selections: [
    { ref: "skill:tdd" },
    {
      ref: "verification-profile:go-quality",
      inputs: { test_packages: ["./...", "./internal/..."] },
    },
  ],
};

const lock = {
  schema: "ai-harness/lock/v1",
  desired_digest: digest,
  catalog: { revision: "release-0.1.0", digest },
  targets: [
    {
      id: "codex",
      adapter: { id: "codex", version: "0.1.0" },
      capabilities: ["project.skills"],
    },
  ],
  components: [
    {
      ref: "skill:tdd",
      version: "0.1.0",
      digest,
      direct: true,
      causes: [],
    },
  ],
  directories: [
    {
      ownership_id: "directory.agents-skills-tdd",
      path: ".agents/skills/tdd",
      sources: ["skill:tdd"],
    },
  ],
  artifacts: [
    {
      kind: "file",
      ownership_id: "codex.skill.tdd",
      target: "codex",
      adapter: "codex",
      path: ".agents/skills/tdd/SKILL.md",
      sources: ["skill:tdd"],
      content_digest: digest,
      portable_mode: "regular",
    },
    {
      kind: "managed-section",
      ownership_id: "codex.skills.mapping",
      target: "codex",
      adapter: "codex",
      path: "AGENTS.md",
      section_id: "skills.mapping",
      placement: "append",
      marker_style: "markdown",
      sources: ["skill:tdd"],
      content_digest: otherDigest,
    },
  ],
  local_effects: [],
};

const plan = {
  schema: "ai-harness/plan/v1",
  plan_id: digest,
  mode: "reconcile",
  basis: {
    repository_fingerprint: digest,
    desired_before_digest: null,
    desired_after_digest: digest,
    lock_before_digest: null,
    catalog_digest: digest,
  },
  preconditions: [
    {
      kind: "file",
      path: ".agents/skills/tdd/SKILL.md",
      observed: { kind: "absent" },
    },
  ],
  changes: [
    {
      unit_id: "codex.skill.tdd",
      owner: "codex.skill.tdd",
      action: "create",
      target: { kind: "file", path: ".agents/skills/tdd/SKILL.md" },
      before: { kind: "absent" },
      after: { kind: "present", digest },
    },
  ],
  local_effects: [],
  verification: [
    { id: "codex.skill.tdd.materialization", kind: "materialization", required: true },
  ],
};

const journal = {
  schema: "ai-harness/journal/v1",
  operation_id: operationId,
  plan_id: digest,
  phase: "applying",
  worktree_identity: digest,
  root_real_path: "/workspace/service",
  started_at: "2026-08-10T18:00:00Z",
  updated_at: "2026-08-10T18:00:01Z",
  units: [
    {
      kind: "filesystem",
      unit_id: "codex.skill.tdd",
      state: "applied",
      target: { kind: "file", path: ".agents/skills/tdd/SKILL.md" },
      container_path: ".agents/skills/tdd/SKILL.md",
      before: { kind: "absent" },
      after: { kind: "present", digest, mode: 420 },
    },
  ],
};

const receipt = {
  schema: "ai-harness/receipt/v1",
  operation_id: operationId,
  plan_id: digest,
  command: "sync",
  started_at: "2026-08-10T18:00:00Z",
  completed_at: "2026-08-10T18:00:02Z",
  result: "succeeded",
  materialization: "committed",
  certification: "verified",
  preflight: [{ id: "filesystem.permissions", verdict: "passed" }],
  changes: [
    {
      unit_id: "codex.skill.tdd",
      target: { kind: "file", path: ".agents/skills/tdd/SKILL.md" },
      action: "create",
      outcome: "applied",
      before_digest: null,
      after_digest: digest,
    },
  ],
  verification: [
    {
      id: "codex.skill.tdd.materialization",
      kind: "materialization",
      verdict: "passed",
      evidence: [digest],
    },
  ],
  diagnostics: [],
};

describe("project state v1 schema", () => {
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(projectStateSchema);

  it.each([
    ["desired state", project],
    ["portable lock", lock],
    ["plan", plan],
    ["journal", journal],
    ["receipt", receipt],
  ])("accepts a representative %s envelope", (_name, value) => {
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
  });

  it("rejects unknown project fields", () => {
    expect(validate({ ...project, installed: true })).toBe(false);
  });

  it("rejects absolute artifact paths", () => {
    const invalid = structuredClone(lock);
    invalid.artifacts[0]!.path = "/tmp/SKILL.md";

    expect(validate(invalid)).toBe(false);
  });

  it("rejects traversal artifact paths", () => {
    const invalid = structuredClone(lock);
    invalid.artifacts[0]!.path = ".agents/../outside/SKILL.md";

    expect(validate(invalid)).toBe(false);
  });

  it("rejects an unmanage plan mode", () => {
    expect(validate({ ...plan, mode: "unmanage" })).toBe(false);
  });
});

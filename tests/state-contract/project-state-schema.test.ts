import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import projectStateSchema from "../../schemas/project-state.v1.schema.json" with {
  type: "json",
};

const digest = `sha256:${"a".repeat(64)}`;
const otherDigest = `sha256:${"b".repeat(64)}`;

const project = {
  schema: "railguard/project/v1",
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
  schema: "railguard/lock/v1",
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
  schema: "railguard/plan/v1",
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

describe("project state v1 schema", () => {
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(projectStateSchema);

  it.each([
    ["desired state", project],
    ["portable lock", lock],
    ["plan", plan],
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

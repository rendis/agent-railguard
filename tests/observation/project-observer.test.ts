import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeRepositoryInventory } from "../../src/adapters/platform/repository-inventory/node-repository-inventory.js";
import type { GitConfigPort } from "../../src/domain/planning/model.js";
import { DefaultProjectObserver } from "../../src/domain/observation/observer.js";
import type { LockState } from "../../src/project-state/lock-state.js";
import {
  capabilityId,
  componentRef,
  harnessTargetId,
  relativePosixPath,
  semVer,
  sha256,
} from "../../src/domain/shared/types.js";
import { createTempRepository } from "../helpers/temp-repository.js";

const section = `# railguard:managed:start id="verification.go-quality"
check:
	@true
# railguard:managed:end id="verification.go-quality"
`;
const appendedSection = `\n${section}`;
const hook = "#!/bin/sh\nmake check\n";

describe("DefaultProjectObserver", () => {
  it("observes owned units from repository evidence and ignores content outside a section", async () => {
    const repository = await createTempRepository({
      Makefile: `custom:\n\t@echo user-owned\n${appendedSection}`,
      ".railguard/hooks/pre-commit": hook,
    });
    await chmod(join(repository.root, ".railguard/hooks/pre-commit"), 0o755);
    const gitConfig: GitConfigPort = {
      async get() {
        return { kind: "value", value: ".railguard/hooks" };
      },
      async set() {
        throw new Error("observer must not mutate Git config");
      },
    };
    try {
      const snapshot = await new NodeRepositoryInventory().snapshot(repository.root);
      const result = await new DefaultProjectObserver(gitConfig).observe(snapshot, lock());

      expect(result.units).toEqual([
        {
          ownershipId: "project.git-gate.pre-commit",
          kind: "file",
          status: "clean",
          expectedDigest: sha256(hook),
          observedDigest: sha256(hook),
        },
        {
          ownershipId: "project.git-gates.activation",
          kind: "git-config",
          status: "clean",
          expectedDigest: sha256(".railguard/hooks"),
          observedDigest: sha256(".railguard/hooks"),
        },
        {
          ownershipId: "project.verification.go-quality",
          kind: "managed-section",
          status: "clean",
          expectedDigest: sha256(appendedSection),
          observedDigest: sha256(appendedSection),
        },
      ]);
      expect(result.diagnostics).toEqual([]);
    } finally {
      await repository.cleanup();
    }
  });

  it("classifies missing and drifted units from current evidence", async () => {
    const changedSection = appendedSection.replace("@true", "@false");
    const repository = await createTempRepository({ Makefile: `custom:\n${changedSection}` });
    const gitConfig: GitConfigPort = {
      async get() {
        return { kind: "absent" };
      },
      async set() {
        throw new Error("observer must not mutate Git config");
      },
    };
    try {
      const snapshot = await new NodeRepositoryInventory().snapshot(repository.root);
      const result = await new DefaultProjectObserver(gitConfig).observe(snapshot, lock());

      expect(result.units.map(({ ownershipId, status }) => ({ ownershipId, status }))).toEqual([
        { ownershipId: "project.git-gate.pre-commit", status: "missing" },
        { ownershipId: "project.git-gates.activation", status: "missing" },
        { ownershipId: "project.verification.go-quality", status: "drifted" },
      ]);
      expect(result.diagnostics).toEqual([]);
    } finally {
      await repository.cleanup();
    }
  });

  it("returns unknown rather than guessing when managed markers are ambiguous", async () => {
    const repository = await createTempRepository({ Makefile: `${section}${section}` });
    const gitConfig: GitConfigPort = {
      async get() {
        return { kind: "value", value: ".railguard/hooks" };
      },
      async set() {
        throw new Error("observer must not mutate Git config");
      },
    };
    try {
      const snapshot = await new NodeRepositoryInventory().snapshot(repository.root);
      const result = await new DefaultProjectObserver(gitConfig).observe(snapshot, lock());

      expect(
        result.units.find((unit) => unit.ownershipId === "project.verification.go-quality"),
      ).toMatchObject({ status: "unknown", observedDigest: null });
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        "observation.managed-section.invalid",
      );
    } finally {
      await repository.cleanup();
    }
  });
});

function lock(): LockState {
  return Object.freeze({
    schema: "railguard/lock/v1",
    desired_digest: sha256("desired"),
    catalog: Object.freeze({ revision: semVer("0.1.0"), digest: sha256("catalog") }),
    targets: Object.freeze([
      Object.freeze({
        id: harnessTargetId("project"),
        adapter: Object.freeze({ id: harnessTargetId("quality"), version: semVer("0.1.0") }),
        capabilities: Object.freeze([capabilityId("project.quality")]),
      }),
    ]),
    components: Object.freeze([]),
    directories: Object.freeze([]),
    artifacts: Object.freeze([
      Object.freeze({
        kind: "managed-section",
        ownership_id: "project.verification.go-quality",
        target: harnessTargetId("project"),
        adapter: harnessTargetId("quality"),
        path: relativePosixPath("Makefile"),
        section_id: "verification.go-quality",
        placement: "append",
        marker_style: "hash",
        sources: Object.freeze([componentRef("verification-profile:go-quality")]),
        content_digest: sha256(appendedSection),
      }),
      Object.freeze({
        kind: "file",
        ownership_id: "project.git-gate.pre-commit",
        target: harnessTargetId("project"),
        adapter: harnessTargetId("quality"),
        path: relativePosixPath(".railguard/hooks/pre-commit"),
        sources: Object.freeze([componentRef("git-gate:pre-commit-check")]),
        content_digest: sha256(hook),
        portable_mode: "executable",
      }),
    ]),
    local_effects: Object.freeze([
      Object.freeze({
        kind: "git-config",
        effect_id: "project.git-gates.activation",
        sources: Object.freeze([componentRef("git-gate:pre-commit-check")]),
        key: "core.hooksPath",
        expected_value: ".railguard/hooks",
      }),
    ]),
  });
}

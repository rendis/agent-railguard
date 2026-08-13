import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeRepositoryInventory } from "../../src/adapters/platform/repository-inventory/node-repository-inventory.js";
import { resolveInstructionTopology } from "../../src/adapters/project/instructions/instruction-topology.js";
import { harnessTargetId } from "../../src/domain/shared/types.js";
import { createTempRepository } from "../helpers/temp-repository.js";

describe("resolveInstructionTopology", () => {
  it("uses AGENTS.md and requests a managed Claude import when both files are absent", async () => {
    const repository = await createTempRepository({});
    try {
      const snapshot = await new NodeRepositoryInventory().snapshot(repository.root);
      await expect(
        resolveInstructionTopology(snapshot, [harnessTargetId("codex"), harnessTargetId("claude-code")]),
      ).resolves.toEqual({
        kind: "ready",
        instructionPath: "AGENTS.md",
        claudeImport: "managed",
        diagnostics: [],
      });
    } finally {
      await repository.cleanup();
    }
  });

  it("does not duplicate an existing external @AGENTS.md import", async () => {
    const repository = await createTempRepository({
      "CLAUDE.md": "# Claude\n\n@AGENTS.md\n",
    });
    try {
      const snapshot = await new NodeRepositoryInventory().snapshot(repository.root);
      const result = await resolveInstructionTopology(snapshot, [harnessTargetId("claude-code")]);
      expect(result).toMatchObject({
        kind: "ready",
        instructionPath: "AGENTS.md",
        claudeImport: "existing",
      });
    } finally {
      await repository.cleanup();
    }
  });

  it("keeps a managed import in the desired topology instead of mistaking it for external content", async () => {
    const repository = await createTempRepository({
      "CLAUDE.md": [
        '<!-- ai-harness:managed:start id="claude.agents-import" -->',
        "@AGENTS.md",
        '<!-- ai-harness:managed:end id="claude.agents-import" -->',
        "",
      ].join("\n"),
    });
    try {
      const snapshot = await new NodeRepositoryInventory().snapshot(repository.root);
      const result = await resolveInstructionTopology(snapshot, [harnessTargetId("claude-code")]);
      expect(result).toMatchObject({ kind: "ready", claudeImport: "managed" });
    } finally {
      await repository.cleanup();
    }
  });

  it("writes the physical CLAUDE.md once when AGENTS.md is a healthy alias", async () => {
    const repository = await createTempRepository({ "CLAUDE.md": "# Shared\n" });
    try {
      await symlink("CLAUDE.md", join(repository.root, "AGENTS.md"));
      const snapshot = await new NodeRepositoryInventory().snapshot(repository.root);
      const result = await resolveInstructionTopology(snapshot, [harnessTargetId("codex"), harnessTargetId("claude-code")]);
      expect(result).toMatchObject({
        kind: "ready",
        instructionPath: "CLAUDE.md",
        claudeImport: "alias",
      });
    } finally {
      await repository.cleanup();
    }
  });

  it("uses AGENTS.md once when CLAUDE.md is a healthy alias", async () => {
    const repository = await createTempRepository({ "AGENTS.md": "# Shared\n" });
    try {
      await symlink("AGENTS.md", join(repository.root, "CLAUDE.md"));
      const snapshot = await new NodeRepositoryInventory().snapshot(repository.root);
      const result = await resolveInstructionTopology(snapshot, [harnessTargetId("claude-code")]);
      expect(result).toMatchObject({
        kind: "ready",
        instructionPath: "AGENTS.md",
        claudeImport: "alias",
      });
    } finally {
      await repository.cleanup();
    }
  });

  it("blocks broken and escaping canonical instruction symlinks", async () => {
    const broken = await createTempRepository({});
    const escaping = await createTempRepository({});
    const outside = await createTempRepository({ "instructions.md": "outside\n" });
    try {
      await symlink("missing.md", join(broken.root, "AGENTS.md"));
      await symlink(join(outside.root, "instructions.md"), join(escaping.root, "CLAUDE.md"));
      const [brokenSnapshot, escapingSnapshot] = await Promise.all([
        new NodeRepositoryInventory().snapshot(broken.root),
        new NodeRepositoryInventory().snapshot(escaping.root),
      ]);

      const [brokenResult, escapingResult] = await Promise.all([
        resolveInstructionTopology(brokenSnapshot, [harnessTargetId("codex")]),
        resolveInstructionTopology(escapingSnapshot, [harnessTargetId("claude-code")]),
      ]);
      expect(brokenResult.kind).toBe("blocked");
      expect(escapingResult.kind).toBe("blocked");
      expect(brokenResult.diagnostics[0]?.code).toBe("project.instructions.topology-unsafe");
      expect(escapingResult.diagnostics[0]?.code).toBe("project.instructions.topology-unsafe");
    } finally {
      await Promise.all([broken.cleanup(), escaping.cleanup(), outside.cleanup()]);
    }
  });

  it("blocks a non-canonical internal symlink target", async () => {
    const repository = await createTempRepository({ "docs/instructions.md": "internal\n" });
    try {
      await mkdir(join(repository.root, "docs"), { recursive: true });
      await symlink("docs/instructions.md", join(repository.root, "AGENTS.md"));
      const snapshot = await new NodeRepositoryInventory().snapshot(repository.root);
      const result = await resolveInstructionTopology(snapshot, [harnessTargetId("codex")]);
      expect(result.kind).toBe("blocked");
    } finally {
      await repository.cleanup();
    }
  });
});

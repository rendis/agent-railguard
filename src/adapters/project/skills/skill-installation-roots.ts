import {
  harnessTargetId,
  relativePosixPath,
  type HarnessTargetId,
  type RelativePosixPath,
} from "../../../domain/shared/types.js";

const sharedSkillTargets = new Set(["codex", "cursor", "opencode", "vscode"]);

export interface SkillInstallationRoot {
  readonly id: "shared" | "claude";
  readonly path: RelativePosixPath;
}

export function skillInstallationRoots(
  targets: readonly HarnessTargetId[],
): readonly SkillInstallationRoot[] {
  return Object.freeze([
    ...(targets.some((target) => sharedSkillTargets.has(target))
      ? [{ id: "shared" as const, path: relativePosixPath(".agents/skills") }]
      : []),
    ...(targets.includes(harnessTargetId("claude-code"))
      ? [{ id: "claude" as const, path: relativePosixPath(".claude/skills") }]
      : []),
  ]);
}

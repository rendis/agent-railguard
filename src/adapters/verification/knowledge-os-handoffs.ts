import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import type { ActiveHandoff } from "../../domain/verification/change-review.js";
import { parseSafeYaml } from "../../shared/safe-yaml.js";

const handoffRoot = ".knowledge-os-handoffs";

/**
 * Active work-item handoffs registered by knowledge-os in `.knowledge-os-handoffs/ACTIVE.yaml`.
 * A repository without that file has no handoff; a file that cannot be read as the expected
 * registry is an error, so a broken registry never passes as "nothing to review".
 */
export async function readActiveHandoffs(root: string): Promise<readonly ActiveHandoff[]> {
  let source: string;
  try {
    source = await readFile(join(root, handoffRoot, "ACTIVE.yaml"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const parsed = parseSafeYaml(source);
  if (parsed.kind === "invalid") throw new Error(`${handoffRoot}/ACTIVE.yaml: ${parsed.errors.join("; ")}`);
  const entries = parsed.value.handoffs;
  if (!Array.isArray(entries)) throw new Error(`${handoffRoot}/ACTIVE.yaml has no handoffs list`);
  const active: ActiveHandoff[] = [];
  for (const entry of entries as readonly Record<string, unknown>[]) {
    if (entry.state !== "active") continue;
    const id = entry["handoff-id"];
    const family = entry.family;
    const revision = entry.revision;
    const manifest = entry.manifest;
    if (typeof id !== "string" || typeof family !== "string" || typeof revision !== "string" || typeof manifest !== "string") {
      throw new Error(`${handoffRoot}/ACTIVE.yaml has an active handoff without id, family, revision or manifest`);
    }
    active.push(Object.freeze({
      id,
      family: family.trim(),
      revision,
      directory: posix.join(handoffRoot, posix.dirname(manifest.trim())),
    }));
  }
  return Object.freeze(active);
}

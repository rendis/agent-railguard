import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NodeGitConfig } from "../adapters/platform/git/node-git-config.js";
import { NodeGitHookInventory } from "../adapters/platform/git/node-git-hook-inventory.js";
import type { GitConfigPort } from "../domain/planning/model.js";
import type { GitHookInventory } from "../domain/project/model.js";

/**
 * Git never activates the hooks a repository ships, so every clone starts without the gates the
 * repository declares. Any Railguard command activates them, including the stop hook agents run on
 * their own: when the lock declares core.hooksPath and the clone has none, it is set. A different
 * value, or executable hooks in .git/hooks that the new path would hide, belong to the developer
 * and stay; `railguard status` reports the gates as inactive.
 */
export async function activateDeclaredGitGates(
  root: string,
  gitConfig: GitConfigPort = new NodeGitConfig(),
  notify: (message: string) => void = (message) => process.stderr.write(message),
  hooks: GitHookInventory = new NodeGitHookInventory(),
): Promise<void> {
  const hooksPath = await declaredHooksPath(root);
  if (hooksPath === null || !existsSync(join(root, hooksPath))) return;
  try {
    if ((await gitConfig.get(root, "core.hooksPath")).kind === "value") return;
    const own = await hooks.executableDefaultHooks(root);
    if (own.length > 0) {
      notify(`railguard: this repository's Git hooks stay inactive because .git/hooks has your own (${own.join(", ")}); see railguard status\n`);
      return;
    }
    await gitConfig.set(root, "core.hooksPath", hooksPath);
    notify(`railguard: activated this repository's Git hooks (core.hooksPath=${hooksPath})\n`);
  } catch (error) {
    notify(`railguard: could not activate this repository's Git hooks: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

async function declaredHooksPath(root: string): Promise<string | null> {
  let lock: unknown;
  try {
    lock = JSON.parse(await readFile(join(root, ".railguard", "lock.json"), "utf8"));
  } catch {
    return null;
  }
  const effects = (lock as { local_effects?: unknown }).local_effects;
  if (!Array.isArray(effects)) return null;
  const effect = effects.find((candidate: unknown): candidate is { expected_value: string } =>
    typeof candidate === "object" && candidate !== null &&
    (candidate as Record<string, unknown>).kind === "git-config" &&
    (candidate as Record<string, unknown>).key === "core.hooksPath" &&
    typeof (candidate as Record<string, unknown>).expected_value === "string");
  return effect?.expected_value ?? null;
}

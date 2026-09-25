import { parseSafeJson } from "../../shared/safe-json.js";
import { canonicalJson, sha256, type Sha256Digest } from "../shared/types.js";

/**
 * Ownership of one member of a JSON configuration file, addressed by object keys, so Railguard
 * can manage its own entry (for example `hooks.Stop` in `.claude/settings.json`) while leaving
 * every other member of that shared file untouched.
 */
export type JsonObject = { readonly [key: string]: unknown };

export type JsonContainerResult =
  | { readonly kind: "ready"; readonly value: JsonObject }
  | { readonly kind: "invalid"; readonly evidence: readonly string[] };

/** An absent or empty file is an empty object; anything but a JSON object is invalid. */
export function parseJsonContainer(source: string): JsonContainerResult {
  if (source.trim().length === 0) return { kind: "ready", value: {} };
  const parsed = parseSafeJson(source);
  return parsed.kind === "ready"
    ? { kind: "ready", value: parsed.value }
    : { kind: "invalid", evidence: parsed.errors };
}

export function renderJsonContainer(value: JsonObject): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function jsonMemberDigest(pointer: readonly string[], value: unknown): Sha256Digest {
  return sha256(canonicalJson({ pointer, value }));
}

export function getJsonMember(root: JsonObject, pointer: readonly string[]): unknown {
  let current: unknown = root;
  for (const key of pointer) {
    if (!isObject(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

/** Sets a member, creating missing parent objects. Fails when a parent exists but is not an object. */
export function setJsonMember(
  root: JsonObject,
  pointer: readonly string[],
  value: unknown,
): JsonContainerResult {
  const [key, ...rest] = pointer;
  if (key === undefined) return { kind: "invalid", evidence: ["empty JSON member pointer"] };
  if (rest.length === 0) return { kind: "ready", value: { ...root, [key]: value } };
  const child = Object.hasOwn(root, key) ? root[key] : {};
  if (!isObject(child)) {
    return { kind: "invalid", evidence: [`${key} is not a JSON object`] };
  }
  const updated = setJsonMember(child, rest, value);
  return updated.kind === "ready" ? { kind: "ready", value: { ...root, [key]: updated.value } } : updated;
}

/** Removes a member and every parent object that becomes empty along its pointer. */
export function removeJsonMember(root: JsonObject, pointer: readonly string[]): JsonObject {
  const [key, ...rest] = pointer;
  if (key === undefined || !Object.hasOwn(root, key)) return root;
  if (rest.length === 0) {
    const { [key]: _removed, ...remaining } = root;
    return remaining;
  }
  const child = root[key];
  if (!isObject(child)) return root;
  const updated = removeJsonMember(child, rest);
  if (Object.keys(updated).length === 0) {
    const { [key]: _removed, ...remaining } = root;
    return remaining;
  }
  return { ...root, [key]: updated };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

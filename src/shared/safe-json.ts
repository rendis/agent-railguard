import { parseDocument } from "yaml";
import { compareUtf8 } from "../domain/shared/types.js";

export type SafeJsonResult =
  | { readonly kind: "ready"; readonly value: Readonly<Record<string, unknown>> }
  | { readonly kind: "invalid"; readonly errors: readonly string[] };

export function parseSafeJson(source: string): SafeJsonResult {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    return {
      kind: "invalid",
      errors: Object.freeze([error instanceof Error ? error.message : String(error)]),
    };
  }

  const document = parseDocument(source, {
    schema: "json",
    uniqueKeys: true,
    merge: false,
  });
  const duplicateKeyErrors = document.errors.map((error) => error.message);
  if (duplicateKeyErrors.length > 0) {
    return {
      kind: "invalid",
      errors: Object.freeze(duplicateKeyErrors.sort(compareUtf8)),
    };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { kind: "invalid", errors: Object.freeze(["JSON document must be an object"]) };
  }
  return { kind: "ready", value: value as Readonly<Record<string, unknown>> };
}

import { isAlias, parseDocument, visit } from "yaml";
import { compareUtf8 } from "../domain/shared/types.js";

export type SafeYamlResult =
  | { readonly kind: "ready"; readonly value: Readonly<Record<string, unknown>> }
  | { readonly kind: "invalid"; readonly errors: readonly string[] };

export function parseSafeYaml(source: string): SafeYamlResult {
  const document = parseDocument(source, {
    schema: "core",
    uniqueKeys: true,
    merge: false,
  });
  const errors = [...document.errors.map((error) => error.message)];
  visit(document, {
    Alias(_key, node) {
      if (isAlias(node)) errors.push("YAML aliases are forbidden");
    },
    Node(_key, node) {
      if ("anchor" in node && node.anchor !== undefined) {
        errors.push("YAML anchors are forbidden");
      }
      if ("tag" in node && node.tag !== undefined) {
        errors.push("Explicit YAML tags are forbidden");
      }
    },
  });
  if (errors.length > 0) {
    return { kind: "invalid", errors: Object.freeze(errors.sort(compareUtf8)) };
  }
  const value = document.toJS({ maxAliasCount: 0 }) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { kind: "invalid", errors: Object.freeze(["YAML document must be a mapping"]) };
  }
  return { kind: "ready", value: value as Readonly<Record<string, unknown>> };
}

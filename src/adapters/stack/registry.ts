import type { StackAdapter } from "../../domain/repository/model.js";
import { compareUtf8 } from "../../domain/shared/types.js";
import { GoStackAdapter } from "./go/go-stack-adapter.js";
import { JavaStackAdapter } from "./java/java-stack-adapter.js";
import { PythonStackAdapter } from "./python/python-stack-adapter.js";
import { TypeScriptStackAdapter } from "./typescript/typescript-stack-adapter.js";

export function registeredStackAdapters(): readonly StackAdapter[] {
  const adapters: StackAdapter[] = [
    new GoStackAdapter(),
    new JavaStackAdapter(),
    new PythonStackAdapter(),
    new TypeScriptStackAdapter(),
  ];
  adapters.sort((left, right) => compareUtf8(left.id, right.id));
  if (new Set(adapters.map((adapter) => adapter.id)).size !== adapters.length) {
    throw new TypeError("Registered stack adapter IDs must be unique");
  }
  return Object.freeze(adapters);
}

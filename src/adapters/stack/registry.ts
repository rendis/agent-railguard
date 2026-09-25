import type { StackAdapter } from "../../domain/repository/model.js";
import { compareUtf8 } from "../../domain/shared/types.js";
import type { CheckProvider, ProcessRunner } from "../../domain/verification/checks.js";
import { GoCheckProvider } from "./go/go-check-provider.js";
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

export function registeredCheckProviders(process: ProcessRunner): readonly CheckProvider[] {
  const providers: CheckProvider[] = [new GoCheckProvider(process)];
  const kinds = providers.flatMap((provider) => provider.kinds);
  if (new Set(kinds).size !== kinds.length) {
    throw new TypeError("Registered check kinds must be unique");
  }
  return Object.freeze(providers);
}

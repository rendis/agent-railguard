import { posix } from "node:path";
import type {
  RepositoryFileEntry,
  RepositorySnapshot,
  StackAdapter,
  StackAssessment,
} from "../../../domain/repository/model.js";
import {
  compareDiagnostics,
  compareUtf8,
  languageId,
  relativePosixPath,
  type Diagnostic,
  type RelativePosixPath,
} from "../../../domain/shared/types.js";
import { parseSafeJson } from "../../../shared/safe-json.js";

const typescript = languageId("typescript");
const decoder = new TextDecoder("utf-8", { fatal: true });
const tsconfigPattern = /^tsconfig(?:\.[A-Za-z0-9_-]+)?\.json$/u;
const lockfileNames = new Set([
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

export class TypeScriptStackAdapter implements StackAdapter {
  public readonly id = typescript;

  public async assess(snapshot: RepositorySnapshot): Promise<StackAssessment> {
    const files = snapshot.entries.filter(
      (entry): entry is RepositoryFileEntry => entry.kind === "file",
    );
    const packages = files
      .filter((entry) => posix.basename(entry.path) === "package.json")
      .sort((left, right) => compareUtf8(left.path, right.path));
    const diagnostics: Diagnostic[] = [];
    const contributions: StackAssessment["contributions"][number][] = [];

    for (const packageFile of packages) {
      const root = rootOf(packageFile.path);
      const atRoot = files.filter((entry) => rootOf(entry.path) === root);
      const tsconfigs = atRoot
        .filter((entry) => tsconfigPattern.test(posix.basename(entry.path)))
        .map((entry) => entry.path)
        .sort(compareUtf8);
      let packageValue: Readonly<Record<string, unknown>> | null = null;
      try {
        const source = decoder.decode((await snapshot.read(packageFile.path, 2 * 1024 * 1024)).bytes.copy());
        const parsed = parseSafeJson(source);
        if (parsed.kind === "ready") packageValue = parsed.value;
        else diagnostics.push(invalidPackage(packageFile.path, parsed.errors));
      } catch (error) {
        diagnostics.push(invalidPackage(packageFile.path, [error instanceof Error ? error.message : String(error)]));
      }
      if (tsconfigs.length === 0 && !declaresTypeScript(packageValue)) continue;

      const lockfiles = atRoot
        .filter((entry) => lockfileNames.has(posix.basename(entry.path)))
        .map((entry) => entry.path)
        .sort(compareUtf8);
      if (lockfiles.length > 1) diagnostics.push(ambiguousLockfiles(packageFile.path, lockfiles));
      const manifests = [packageFile.path, ...tsconfigs, ...lockfiles].sort(compareUtf8);
      contributions.push(
        Object.freeze({
          root,
          language: typescript,
          manifests: Object.freeze(manifests),
          evidence: Object.freeze([
            Object.freeze({
              kind: "manifest" as const,
              path: packageFile.path,
              detail: tsconfigs.length > 0
                ? `TypeScript configuration (${tsconfigs.length})`
                : "TypeScript dependency",
            }),
            ...lockfiles.map((path) =>
              Object.freeze({
                kind: "manifest" as const,
                path,
                detail: "package-manager lockfile",
              }),
            ),
          ]),
          nativeTasks: Object.freeze([]),
        }),
      );
    }

    return Object.freeze({
      contributions: Object.freeze(contributions),
      diagnostics: Object.freeze(diagnostics.sort(compareDiagnostics)),
    });
  }
}

function declaresTypeScript(value: Readonly<Record<string, unknown>> | null): boolean {
  if (value === null) return false;
  return [value.dependencies, value.devDependencies, value.peerDependencies].some(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      !Array.isArray(candidate) &&
      Object.hasOwn(candidate, "typescript"),
  );
}

function rootOf(path: RelativePosixPath): RelativePosixPath {
  const root = posix.dirname(path);
  return relativePosixPath(root, { allowRoot: root === "." });
}

function invalidPackage(path: RelativePosixPath, evidence: readonly string[]): Diagnostic {
  return Object.freeze({
    code: "stack.typescript.package-invalid",
    severity: "warning",
    phase: "assessment",
    subjects: Object.freeze([]),
    location: Object.freeze({ path }),
    message: "A package.json marker could not be parsed as a bounded unique-key JSON object.",
    evidence: Object.freeze([...evidence].sort(compareUtf8)),
    impact: "TypeScript is detected only when an adjacent tsconfig supplies independent evidence.",
    action: "Correct package.json to enable complete TypeScript evidence for this root.",
  });
}

function ambiguousLockfiles(
  path: RelativePosixPath,
  lockfiles: readonly RelativePosixPath[],
): Diagnostic {
  return Object.freeze({
    code: "stack.typescript.lockfiles-ambiguous",
    severity: "info",
    phase: "assessment",
    subjects: Object.freeze([]),
    location: Object.freeze({ path }),
    message: "More than one package-manager lockfile is present at this TypeScript root.",
    evidence: Object.freeze([...lockfiles]),
    impact: "Railguard reports the ambiguity and does not select or run a package manager.",
    action: "Choose the intended package manager in the project if deterministic verification later requires it.",
  });
}

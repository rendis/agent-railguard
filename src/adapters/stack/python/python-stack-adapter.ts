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

const python = languageId("python");
const decoder = new TextDecoder("utf-8", { fatal: true });
const requirementsPattern = /^requirements(?:[-_.][A-Za-z0-9._-]+)?\.txt$/u;

export class PythonStackAdapter implements StackAdapter {
  public readonly id = python;

  public async assess(snapshot: RepositorySnapshot): Promise<StackAssessment> {
    const files = snapshot.entries.filter(
      (entry): entry is RepositoryFileEntry => entry.kind === "file",
    );
    const pyprojects = files.filter((entry) => posix.basename(entry.path) === "pyproject.toml");
    const requirementFiles = files.filter((entry) => requirementsPattern.test(posix.basename(entry.path)));
    const roots = new Set<RelativePosixPath>();
    for (const entry of pyprojects) roots.add(rootOf(entry.path));
    for (const entry of requirementFiles) roots.add(rootOf(entry.path));

    const diagnostics: Diagnostic[] = [];
    const contributions: StackAssessment["contributions"][number][] = [];
    for (const root of [...roots].sort(compareUtf8)) {
      const pyproject = pyprojects.find((entry) => rootOf(entry.path) === root);
      if (pyproject !== undefined) {
        try {
          const source = decoder.decode((await snapshot.read(pyproject.path, 1024 * 1024)).bytes.copy());
          if (source.trim().length === 0) throw new Error("pyproject.toml is empty");
        } catch (error) {
          diagnostics.push(invalidMarker(pyproject.path, error));
          continue;
        }
      }
      const manifests = files
        .filter((entry) => {
          if (rootOf(entry.path) !== root) return false;
          const name = posix.basename(entry.path);
          return name === "pyproject.toml" || name === "uv.lock" || requirementsPattern.test(name);
        })
        .map((entry) => entry.path)
        .sort(compareUtf8);
      if (manifests.length === 0) continue;
      contributions.push(
        Object.freeze({
          root,
          language: python,
          manifests: Object.freeze(manifests),
          evidence: Object.freeze(
            manifests.map((path) =>
              Object.freeze({
                kind: "manifest" as const,
                path,
                detail: pythonEvidence(posix.basename(path)),
              }),
            ),
          ),
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

function rootOf(path: RelativePosixPath): RelativePosixPath {
  const root = posix.dirname(path);
  return relativePosixPath(root, { allowRoot: root === "." });
}

function pythonEvidence(name: string): string {
  if (name === "pyproject.toml") return "pyproject metadata";
  if (name === "uv.lock") return "uv lockfile";
  return "requirements manifest";
}

function invalidMarker(path: RelativePosixPath, error: unknown): Diagnostic {
  return Object.freeze({
    code: "stack.python.pyproject-invalid",
    severity: "warning",
    phase: "assessment",
    subjects: Object.freeze([]),
    location: Object.freeze({ path }),
    message: "A pyproject.toml marker could not be read as bounded UTF-8.",
    evidence: Object.freeze([error instanceof Error ? error.message : String(error)]),
    impact: "That Python root is omitted from recommendations; manual selection remains available.",
    action: "Correct the project marker to enable Python recommendations for this root.",
  });
}

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

const java = languageId("java");
const buildMarkers = new Set(["build.gradle", "build.gradle.kts", "pom.xml"]);

export class JavaStackAdapter implements StackAdapter {
  public readonly id = java;

  public async assess(snapshot: RepositorySnapshot): Promise<StackAssessment> {
    const files = snapshot.entries.filter(
      (entry): entry is RepositoryFileEntry => entry.kind === "file",
    );
    const roots = new Set(
      files
        .filter((entry) => buildMarkers.has(posix.basename(entry.path)))
        .map((entry) => rootOf(entry.path)),
    );
    const diagnostics: Diagnostic[] = [];
    const contributions: StackAssessment["contributions"][number][] = [];
    for (const root of [...roots].sort(compareUtf8)) {
      const atRoot = files.filter((entry) => rootOf(entry.path) === root);
      const manifests = atRoot
        .filter((entry) => buildMarkers.has(posix.basename(entry.path)))
        .map((entry) => entry.path)
        .sort(compareUtf8);
      const systems = new Set(
        manifests.map((path) => (posix.basename(path) === "pom.xml" ? "maven" : "gradle")),
      );
      if (systems.size > 1) diagnostics.push(ambiguousBuild(manifests));
      const wrappers = atRoot
        .filter((entry) => ["gradlew", "mvnw"].includes(posix.basename(entry.path)))
        .map((entry) => entry.path)
        .sort(compareUtf8);
      contributions.push(
        Object.freeze({
          root,
          language: java,
          manifests: Object.freeze(manifests),
          evidence: Object.freeze([
            ...manifests.map((path) =>
              Object.freeze({
                kind: "manifest" as const,
                path,
                detail: posix.basename(path) === "pom.xml" ? "Maven build" : "Gradle build",
              }),
            ),
            ...wrappers.map((path) =>
              Object.freeze({
                kind: "manifest" as const,
                path,
                detail: "build wrapper",
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

function rootOf(path: RelativePosixPath): RelativePosixPath {
  const root = posix.dirname(path);
  return relativePosixPath(root, { allowRoot: root === "." });
}

function ambiguousBuild(manifests: readonly RelativePosixPath[]): Diagnostic {
  return Object.freeze({
    code: "stack.java.build-systems-ambiguous",
    severity: "warning",
    phase: "assessment",
    subjects: Object.freeze([]),
    location: Object.freeze({ path: manifests[0] ?? relativePosixPath("pom.xml") }),
    message: "Maven and Gradle markers coexist at the same Java root.",
    evidence: Object.freeze([...manifests]),
    impact: "Railguard reports both build systems and does not execute or choose either one.",
    action: "Select the intended project verification profile explicitly when one is available.",
  });
}

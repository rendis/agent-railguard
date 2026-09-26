import { posix } from "node:path";
import type {
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

const go = languageId("go");
const decoder = new TextDecoder("utf-8", { fatal: true });

export class GoStackAdapter implements StackAdapter {
  public readonly id = go;

  public async assess(snapshot: RepositorySnapshot): Promise<StackAssessment> {
    const moduleFiles = snapshot.entries
      .filter(
        (entry): entry is Extract<(typeof snapshot.entries)[number], { readonly kind: "file" }> =>
          entry.kind === "file" && posix.basename(entry.path) === "go.mod",
      )
      .map((entry) => entry.path)
      .sort(compareUtf8);

    if (moduleFiles.length === 0) {
      return Object.freeze({ contributions: Object.freeze([]), diagnostics: Object.freeze([]) });
    }
    const moduleRoots = moduleFiles.map((manifest) => posix.dirname(manifest));
    const goFiles = snapshot.entries
      .filter((entry) => entry.kind === "file" && entry.path.endsWith(".go"))
      .map((entry) => entry.path as string);
    const diagnostics: Diagnostic[] = [];
    const contributions: StackAssessment["contributions"][number][] = [];
    for (const manifest of moduleFiles) {
      let source: string;
      try {
        const read = await snapshot.read(manifest, 256 * 1024);
        source = decoder.decode(read.bytes.copy());
      } catch (error) {
        diagnostics.push(invalidModuleDiagnostic(manifest, [error instanceof Error ? error.message : String(error)]));
        continue;
      }

      const modules = [...source.matchAll(/^\s*module\s+(?:"([^"]+)"|(\S+))\s*(?:\/\/.*)?$/gm)]
        .map((match) => match[1] ?? match[2])
        .filter((value): value is string => value !== undefined && value.length > 0);
      const moduleName = modules[0];
      if (modules.length !== 1 || moduleName === undefined || /[\s\0]/.test(moduleName)) {
        diagnostics.push(invalidModuleDiagnostic(manifest, [`module-directives:${modules.length}`]));
        continue;
      }

      const rootValue = posix.dirname(manifest);
      // A module that only pins tools (`tool` directives, no Go source) has nothing to judge.
      if (/^\s*tool\s/mu.test(source) && !goFiles.some((file) => ownerRoot(file, moduleRoots) === rootValue)) continue;
      contributions.push(
        Object.freeze({
          root: relativePosixPath(rootValue, { allowRoot: rootValue === "." }),
          language: go,
          manifests: Object.freeze([manifest]),
          evidence: Object.freeze([
            Object.freeze({ kind: "manifest" as const, path: manifest, detail: `module ${moduleName}` }),
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

/** The innermost module root that owns a file, or null when the Go tool ignores its directory. */
function ownerRoot(file: string, roots: readonly string[]): string | null {
  const directories = posix.dirname(file).split("/");
  if (directories.some((segment) => segment === "vendor" || segment === "testdata" || /^[._]./u.test(segment))) {
    return null;
  }
  return roots
    .filter((root) => root === "." || file.startsWith(`${root}/`))
    .sort((left, right) => right.length - left.length)[0] ?? null;
}

function invalidModuleDiagnostic(
  path: RelativePosixPath,
  evidence: readonly string[],
): Diagnostic {
  return Object.freeze({
    code: "stack.go.module-invalid",
    severity: "warning",
    phase: "assessment",
    subjects: Object.freeze([]),
    location: Object.freeze({ path }),
    message: "A go.mod marker could not be classified as a valid Go module.",
    evidence: Object.freeze([...evidence]),
    impact: "That module root is omitted from recommendations; other roots and manual selection remain available.",
    action: "Correct the module directive to enable Go recommendations for this root.",
  });
}

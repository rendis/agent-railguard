import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  RepositoryGate,
  RepositoryGateResult,
} from "../../../domain/repository/gate.js";
import {
  compareDiagnostics,
  compareUtf8,
  relativePosixPath,
  type Diagnostic,
  type RelativePosixPath,
} from "../../../domain/shared/types.js";

const execute = promisify(execFile);
const gitLockNames = Object.freeze(["HEAD.lock", "config.lock", "index.lock", "packed-refs.lock"]);
const safeEnvironmentTemplates = new Set([".env.example", ".env.sample", ".env.template"]);

export class NodeRepositoryGate implements RepositoryGate {
  public async check(root: string): Promise<RepositoryGateResult> {
    let rootRealPath: string;
    try {
      rootRealPath = await realpath(root);
    } catch (error) {
      return blocked(resolve(root), null, null, [invalidWorktreeDiagnostic(error)]);
    }

    let inside: string;
    let bare: string;
    let topLevel: string;
    let commonValue: string;
    let gitValue: string;
    try {
      [inside, bare, topLevel, commonValue, gitValue] = await Promise.all([
        runGit(rootRealPath, ["rev-parse", "--is-inside-work-tree"]),
        runGit(rootRealPath, ["rev-parse", "--is-bare-repository"]),
        runGit(rootRealPath, ["rev-parse", "--path-format=absolute", "--show-toplevel"]),
        runGit(rootRealPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
        runGit(rootRealPath, ["rev-parse", "--path-format=absolute", "--git-dir"]),
      ]);
    } catch (error) {
      return blocked(rootRealPath, null, null, [
        isNotGitRepository(error)
          ? gitUninitializedDiagnostic()
          : invalidWorktreeDiagnostic(error),
      ]);
    }

    if (inside !== "true" || bare !== "false") {
      return blocked(rootRealPath, null, null, [invalidWorktreeDiagnostic("not a non-bare worktree")]);
    }

    const [topLevelRealPath, gitCommonDirectory, gitDirectory] = await Promise.all([
      realpath(topLevel),
      realpath(commonValue),
      realpath(gitValue),
    ]);
    if (rootRealPath !== topLevelRealPath) {
      return blocked(rootRealPath, gitCommonDirectory, gitDirectory, [
        notTopLevelDiagnostic(topLevelRealPath),
      ]);
    }

    const diagnostics: Diagnostic[] = [];
    const writableLocations = [
      [rootRealPath, relativePosixPath(".", { allowRoot: true })],
      [gitCommonDirectory, relativePosixPath(".git")],
      [gitDirectory, relativePosixPath(".git")],
    ] as const;
    for (const [path, location] of writableLocations) {
      try {
        await access(path, constants.W_OK | constants.X_OK);
      } catch {
        diagnostics.push(notWritableDiagnostic(location));
      }
    }

    const lockPaths = [...new Set(
      [gitCommonDirectory, gitDirectory].flatMap((directory) =>
        gitLockNames.map((name) => resolve(directory, name)),
      ),
    )].sort(compareUtf8);
    for (const path of lockPaths) {
      if (await exists(path)) diagnostics.push(gitLockDiagnostic(basename(path)));
    }

    let tracked: readonly string[] = [];
    try {
      tracked = splitNull(await runGit(rootRealPath, ["ls-files", "-z"]));
      const sensitive = tracked.filter(isSensitivePath).sort(compareUtf8);
      if (sensitive.length > 0) diagnostics.push(sensitivePathDiagnostic(sensitive));

      const staged = splitNull(await runGit(rootRealPath, ["ls-files", "--stage", "-z"]));
      const submodules = staged
        .filter((record) => record.startsWith("160000 "))
        .map((record) => record.slice(record.indexOf("\t") + 1))
        .sort(compareUtf8);
      if (submodules.length > 0) diagnostics.push(submoduleDiagnostic(submodules));

      const attributeFiles = tracked
        .filter((path) => basename(path) === ".gitattributes")
        .sort(compareUtf8);
      const lfsPolicies: string[] = [];
      for (const path of attributeFiles) {
        const source = await runGit(rootRealPath, ["show", `:${path}`], false);
        if (/(?:^|\s)filter=lfs(?:\s|$)/mu.test(source)) lfsPolicies.push(path);
      }
      if (lfsPolicies.length > 0) diagnostics.push(lfsDiagnostic(lfsPolicies));
    } catch (error) {
      diagnostics.push(inventoryDiagnostic(error));
    }

    diagnostics.sort(compareDiagnostics);
    return Object.freeze({
      kind: diagnostics.some((diagnostic) => diagnostic.severity === "blocked")
        ? "blocked"
        : "ready",
      rootRealPath,
      gitCommonDirectory,
      gitDirectory,
      diagnostics: Object.freeze(diagnostics),
    });
  }
}

async function runGit(root: string, args: readonly string[], trim = true): Promise<string> {
  const result = await execute("git", ["-C", root, "--no-optional-locks", ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LANG: "C", LC_ALL: "C" },
  });
  return trim ? result.stdout.trim() : result.stdout;
}

function splitNull(value: string): readonly string[] {
  return Object.freeze(value.split("\0").filter((entry) => entry.length > 0));
}

function isSensitivePath(path: string): boolean {
  const name = basename(path).toLowerCase();
  if (safeEnvironmentTemplates.has(name)) return false;
  return name === ".env" ||
    name === ".env.local" ||
    name === ".env-local" ||
    name === ".env.development" ||
    name === ".env.production" ||
    name === ".env.test" ||
    name === ".npmrc" ||
    name === ".pypirc" ||
    name === "id_rsa" ||
    name === "id_ed25519" ||
    /\.(?:key|p12|pem|pfx)$/u.test(name);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

function blocked(
  rootRealPath: string,
  gitCommonDirectory: string | null,
  gitDirectory: string | null,
  diagnostics: readonly Diagnostic[],
): RepositoryGateResult {
  return Object.freeze({
    kind: "blocked",
    rootRealPath,
    gitCommonDirectory,
    gitDirectory,
    diagnostics: Object.freeze([...diagnostics].sort(compareDiagnostics)),
  });
}

function diagnostic(input: {
  readonly code: string;
  readonly path: RelativePosixPath;
  readonly message: string;
  readonly evidence: readonly string[];
  readonly impact: string;
  readonly action: string;
}): Diagnostic {
  return Object.freeze({
    code: input.code,
    severity: "blocked",
    phase: "repository-gate",
    subjects: Object.freeze([]),
    location: Object.freeze({ path: input.path }),
    message: input.message,
    evidence: Object.freeze([...input.evidence].sort(compareUtf8)),
    impact: input.impact,
    action: input.action,
  });
}

function invalidWorktreeDiagnostic(error: unknown): Diagnostic {
  return diagnostic({
    code: "repository.gate.invalid-worktree",
    path: relativePosixPath(".git"),
    message: "A writable non-bare Git worktree is required.",
    evidence: [error instanceof Error ? error.message : String(error)],
    impact: "AI Harness cannot establish a reversible project transaction.",
    action: "Run from the top-level directory of a non-bare Git worktree.",
  });
}

function gitUninitializedDiagnostic(): Diagnostic {
  return diagnostic({
    code: "repository.gate.git-uninitialized",
    path: relativePosixPath(".git"),
    message: "Git is not initialized for this project.",
    evidence: ["No Git worktree was found at the project root."],
    impact: "AI Harness can browse and compose a draft, but cannot start a reversible mutation yet.",
    action: "Run `git init` in this project directory, then review the draft again.",
  });
}

function notTopLevelDiagnostic(topLevel: string): Diagnostic {
  return diagnostic({
    code: "repository.gate.not-top-level",
    path: relativePosixPath(".git"),
    message: "AI Harness was not invoked from the Git worktree root.",
    evidence: [topLevel],
    impact: "Project-scoped paths would be ambiguous or incomplete.",
    action: `Run AI Harness from ${topLevel}.`,
  });
}

function notWritableDiagnostic(path: RelativePosixPath): Diagnostic {
  return diagnostic({
    code: "repository.gate.not-writable",
    path,
    message: "A required transaction location is not writable.",
    evidence: [path],
    impact: "Apply and automatic rollback cannot be guaranteed.",
    action: "Grant the current user write and traversal permission, then scan again.",
  });
}

function gitLockDiagnostic(name: string): Diagnostic {
  return diagnostic({
    code: "repository.gate.git-lock-present",
    path: relativePosixPath(".git"),
    message: "Git has an active lock file.",
    evidence: [name],
    impact: "AI Harness could race or interfere with another Git operation.",
    action: "Finish the active Git operation and retry; remove a stale lock only after verifying no Git process owns it.",
  });
}

function sensitivePathDiagnostic(paths: readonly string[]): Diagnostic {
  return diagnostic({
    code: "repository.gate.sensitive-path",
    path: relativePosixPath(paths[0] ?? ".git"),
    message: "The repository tracks a path commonly used for credentials or private keys.",
    evidence: paths,
    impact: "Automated evaluation could expose sensitive material even without reading file contents.",
    action: "Remove the sensitive file from version control or explicitly remediate the repository before using AI Harness.",
  });
}

function submoduleDiagnostic(paths: readonly string[]): Diagnostic {
  return diagnostic({
    code: "repository.gate.submodule-unsupported",
    path: relativePosixPath(paths[0] ?? ".git"),
    message: "The repository contains Git submodules that v0.1.0 has not certified.",
    evidence: paths,
    impact: "Path ownership and rollback cannot yet be proven across nested Git identities.",
    action: "Run AI Harness in a repository without submodules or wait for certified submodule support.",
  });
}

function lfsDiagnostic(paths: readonly string[]): Diagnostic {
  return diagnostic({
    code: "repository.gate.lfs-unsupported",
    path: relativePosixPath(paths[0] ?? ".gitattributes"),
    message: "The repository declares Git LFS filters that v0.1.0 has not certified.",
    evidence: paths,
    impact: "The worktree may contain pointer files instead of the bytes a plan would review.",
    action: "Materialize and certify LFS objects in an explicit evaluation profile before using AI Harness.",
  });
}

function inventoryDiagnostic(error: unknown): Diagnostic {
  return diagnostic({
    code: "repository.gate.git-inventory-failed",
    path: relativePosixPath(".git"),
    message: "Git metadata could not be inspected safely.",
    evidence: [error instanceof Error ? error.message : String(error)],
    impact: "AI Harness cannot prove that the repository is safe to mutate.",
    action: "Resolve the Git error and retry the repository gate.",
  });
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function isNotGitRepository(error: unknown): boolean {
  if (!(error instanceof Error) || !("stderr" in error)) return false;
  return /not a git repository/u.test(String(error.stderr));
}

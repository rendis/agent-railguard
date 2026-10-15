import type { ReadonlyBytes, RelativePosixPath } from "../shared/types.js";

export type ArtifactOwner = string;

export type ArtifactIntent =
  | {
      readonly kind: "file";
      readonly owner: ArtifactOwner;
      readonly scopeRoot: RelativePosixPath;
      readonly path: RelativePosixPath;
      readonly bytes: ReadonlyBytes;
      readonly mode: number;
    }
  | {
      readonly kind: "managed-section";
      readonly owner: ArtifactOwner;
      readonly path: RelativePosixPath;
      readonly sectionId: string;
      readonly body: string;
      readonly mode: number;
      readonly markerStyle?: "markdown" | "hash";
    }
  | {
      /** One member of a JSON object file, addressed by object keys; the rest of the file stays foreign. */
      readonly kind: "json-member";
      readonly owner: ArtifactOwner;
      readonly path: RelativePosixPath;
      readonly pointer: readonly string[];
      readonly value: unknown;
      readonly mode: number;
    }
  | {
      readonly kind: "symlink";
      readonly owner: ArtifactOwner;
      readonly scopeRoot: RelativePosixPath;
      readonly path: RelativePosixPath;
      readonly target: string;
    }
  | {
      readonly kind: "git-config";
      readonly owner: ArtifactOwner;
      readonly path: RelativePosixPath;
      readonly key: "core.hooksPath";
      readonly value: string;
    };

export type GitConfigValue =
  | { readonly kind: "absent" }
  | {
      readonly kind: "value";
      readonly value: string;
      /**
       * For an absolute path into a worktree of this repository: the same path relative to that
       * worktree, which is how one shared setting names every worktree's own directory.
       */
      readonly worktreeRelative?: string;
      /** The checkout is a linked worktree, so the setting is shared with every other worktree. */
      readonly linkedWorktree?: true;
    };

/** Whether the setting names `expected`, either as is or as an absolute path into a worktree. */
export function hooksPathHolds(current: GitConfigValue, expected: string): boolean {
  return current.kind === "value" && (current.value === expected || current.worktreeRelative === expected);
}

export interface GitConfigPort {
  get(rootRealPath: string, key: "core.hooksPath"): Promise<GitConfigValue>;
  set(rootRealPath: string, key: "core.hooksPath", value: string | null): Promise<void>;
}

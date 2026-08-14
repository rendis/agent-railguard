import type { ReadonlyBytes, RelativePosixPath } from "../shared/types.js";

export type ArtifactOwner = string;

export interface ExactTextEdit {
  readonly start: number;
  readonly end: number;
  readonly expected: string;
  readonly replacement: string;
}

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
      readonly containerEdits?: readonly ExactTextEdit[];
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
  | { readonly kind: "value"; readonly value: string };

export interface GitConfigPort {
  get(rootRealPath: string, key: "core.hooksPath"): Promise<GitConfigValue>;
  set(rootRealPath: string, key: "core.hooksPath", value: string | null): Promise<void>;
}

import { lstat, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type {
  ContentSource,
  ContentSourceProgressSink,
  ResolvedContentSource,
} from "./content-source.js";

export interface LocalContentSourceOptions {
  readonly root: string;
  readonly progress?: ContentSourceProgressSink;
}

export class LocalContentSource implements ContentSource {
  readonly #root: string;
  readonly #progress: ContentSourceProgressSink;

  public constructor(options: LocalContentSourceOptions) {
    this.#root = resolve(options.root);
    this.#progress = options.progress ?? (() => undefined);
  }

  public async resolve(_signal?: AbortSignal): Promise<ResolvedContentSource> {
    this.#progress({
      phase: "local",
      status: "started",
      message: `Validating local content source ${this.#root}`,
    });
    try {
      const root = await realpath(this.#root);
      const rootMetadata = await lstat(root);
      if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
        throw new TypeError(`Local content source is not a regular directory: ${this.#root}`);
      }
      const catalogFile = join(root, "ai-harness.yaml");
      const catalogMetadata = await lstat(catalogFile);
      if (!catalogMetadata.isFile() || catalogMetadata.isSymbolicLink()) {
        throw new TypeError(`Local content source must contain a regular ai-harness.yaml: ${root}`);
      }
      const realCatalog = await realpath(catalogFile);
      if (!isWithin(root, realCatalog)) {
        throw new TypeError(`Local content catalog escapes its source root: ${realCatalog}`);
      }
      this.#progress({
        phase: "local",
        status: "completed",
        message: `Local content source ready: ${root}`,
      });
      return Object.freeze({
        kind: "local" as const,
        root,
        catalogFile: realCatalog,
        revision: null,
        identity: `local:${root}`,
        location: root,
      });
    } catch (error) {
      this.#progress({
        phase: "local",
        status: "failed",
        message: `Local content source failed: ${errorMessage(error)}`,
      });
      throw error;
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isWithin(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return difference === "" || (
    difference !== ".." &&
    !difference.startsWith(`..${sep}`) &&
    !difference.startsWith(sep)
  );
}

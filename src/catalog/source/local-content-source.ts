import { lstat, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type {
  ContentSource,
  ContentSourceKind,
  ContentSourceProgressSink,
  ResolvedContentSource,
} from "./content-source.js";

export interface LocalContentSourceOptions {
  readonly root: string;
  readonly progress?: ContentSourceProgressSink;
  /** The source reported in progress; the embedded source validates its materialized copy here. */
  readonly kind?: ContentSourceKind;
}

export class LocalContentSource implements ContentSource {
  readonly #root: string;
  readonly #progress: ContentSourceProgressSink;
  readonly #kind: ContentSourceKind;

  public constructor(options: LocalContentSourceOptions) {
    this.#root = resolve(options.root);
    this.#progress = options.progress ?? (() => undefined);
    this.#kind = options.kind ?? "local";
  }

  public async resolve(_signal?: AbortSignal): Promise<ResolvedContentSource> {
    this.#progress({
      phase: this.#kind,
      status: "started",
      message: `Validating the ${this.#kind} content source`,
    });
    try {
      const root = await realpath(this.#root);
      const rootMetadata = await lstat(root);
      if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
        throw new TypeError(`Local content source is not a regular directory: ${this.#root}`);
      }
      const catalogFile = join(root, "railguard.yaml");
      const catalogMetadata = await lstat(catalogFile);
      if (!catalogMetadata.isFile() || catalogMetadata.isSymbolicLink()) {
        throw new TypeError(`Local content source must contain a regular railguard.yaml: ${root}`);
      }
      const realCatalog = await realpath(catalogFile);
      if (!isWithin(root, realCatalog)) {
        throw new TypeError(`Local content catalog escapes its source root: ${realCatalog}`);
      }
      this.#progress({
        phase: this.#kind,
        status: "completed",
        message: `${label(this.#kind)} content source ready`,
      });
      return Object.freeze({
        kind: "local" as const,
        root,
        catalogFile: realCatalog,
        identity: `local:${root}`,
        location: root,
      });
    } catch (error) {
      this.#progress({
        phase: this.#kind,
        status: "failed",
        message: `${label(this.#kind)} content source failed: ${errorMessage(error)}`,
      });
      throw error;
    }
  }
}

function label(kind: ContentSourceKind): string {
  return kind === "local" ? "Local" : "Embedded";
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

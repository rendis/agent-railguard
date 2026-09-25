import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { lstat } from "node:fs/promises";
import type {
  ContentSource,
  ContentSourceProgressSink,
  ResolvedContentSource,
} from "./content-source.js";
import { EmbeddedContentSource, type EmbeddedContent } from "./embedded-content-source.js";
import { LocalContentSource } from "./local-content-source.js";

declare const __RAILGUARD_CONTENT__: EmbeddedContent | undefined;

export interface DefaultContentSourceOptions {
  readonly sourcePath?: string;
  readonly catalogFile?: string;
  readonly developmentCatalogFile: string;
  readonly embeddedContent?: EmbeddedContent;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly cacheRoot?: string;
  readonly progress?: ContentSourceProgressSink;
}

/**
 * Selects project content in priority order: an explicit `--source` checkout, the authoring
 * checkout this engine runs from, then the content embedded in a release build.
 */
export function createDefaultContentSource(
  options: DefaultContentSourceOptions,
): ContentSource {
  return new SelectedContentSource(options);
}

class SelectedContentSource implements ContentSource {
  readonly #options: DefaultContentSourceOptions;

  public constructor(options: DefaultContentSourceOptions) {
    this.#options = options;
  }

  public async resolve(signal?: AbortSignal): Promise<ResolvedContentSource> {
    const progress = this.#options.progress === undefined ? {} : { progress: this.#options.progress };
    if (this.#options.sourcePath !== undefined) {
      return await new LocalContentSource({ root: this.#options.sourcePath, ...progress }).resolve(signal);
    }
    if (this.#options.catalogFile !== undefined) {
      const catalogFile = resolve(this.#options.catalogFile);
      if (basename(catalogFile) !== "railguard.yaml") {
        throw new TypeError("catalogFile must name railguard.yaml");
      }
      return await new LocalContentSource({ root: dirname(catalogFile), ...progress }).resolve(signal);
    }
    if (await isRegularFile(this.#options.developmentCatalogFile)) {
      return await new LocalContentSource({
        root: dirname(this.#options.developmentCatalogFile),
        ...progress,
      }).resolve(signal);
    }
    const content = this.#options.embeddedContent ?? builtInContent();
    if (content === undefined) {
      throw new TypeError(
        "This railguard build has no embedded project content. Run with --source <checkout>.",
      );
    }
    return await new EmbeddedContentSource({
      content,
      cacheRoot: this.#options.cacheRoot ?? contentCacheRoot(this.#options.environment ?? process.env),
      ...progress,
    }).resolve(signal);
  }
}

function builtInContent(): EmbeddedContent | undefined {
  return typeof __RAILGUARD_CONTENT__ === "undefined" ? undefined : __RAILGUARD_CONTENT__;
}

function contentCacheRoot(environment: Readonly<NodeJS.ProcessEnv>): string {
  const explicit = environment.RAILGUARD_CONTENT_CACHE?.trim();
  if (explicit !== undefined && explicit.length > 0) return resolve(explicit);
  const base = environment.XDG_CACHE_HOME?.trim();
  const home = environment.HOME?.trim() || homedir();
  return join(base === undefined || base.length === 0 ? join(home, ".cache") : base, "railguard", "content");
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

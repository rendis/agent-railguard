import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { lstat, readFile } from "node:fs/promises";
import type {
  ContentSource,
  ContentSourceProgressSink,
  ResolvedContentSource,
} from "./content-source.js";
import { ContentManifestClient } from "./content-manifest-client.js";
import { LocalContentSource } from "./local-content-source.js";
import { RemoteContentSource } from "./remote-content-source.js";

export interface DefaultContentSourceOptions {
  readonly sourcePath?: string;
  readonly catalogFile?: string;
  readonly developmentCatalogFile: string;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly cacheRoot?: string;
  readonly progress?: ContentSourceProgressSink;
}

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
    const environment = this.#options.environment ?? process.env;
    if (this.#options.sourcePath !== undefined) {
      return await new LocalContentSource({
        root: this.#options.sourcePath,
        ...(this.#options.progress === undefined ? {} : { progress: this.#options.progress }),
      }).resolve(signal);
    }
    if (this.#options.catalogFile !== undefined) {
      const catalogFile = resolve(this.#options.catalogFile);
      if (basename(catalogFile) !== "ai-harness.yaml") {
        throw new TypeError("catalogFile must name ai-harness.yaml");
      }
      return await new LocalContentSource({
        root: dirname(catalogFile),
        ...(this.#options.progress === undefined ? {} : { progress: this.#options.progress }),
      }).resolve(signal);
    }
    const environmentManifest = environment.AI_HARNESS_CONTENT_MANIFEST_URL?.trim();
    if (environmentManifest !== undefined && environmentManifest.length > 0) {
      return await this.#remote(environmentManifest, environment).resolve(signal);
    }
    if (await isRegularFile(this.#options.developmentCatalogFile)) {
      return await new LocalContentSource({
        root: dirname(this.#options.developmentCatalogFile),
        ...(this.#options.progress === undefined ? {} : { progress: this.#options.progress }),
      }).resolve(signal);
    }
    const engineConfig = await readEngineConfig(engineConfigPath(environment));
    if ("content_source_path" in engineConfig) {
      return await new LocalContentSource({
        root: engineConfig.content_source_path,
        ...(this.#options.progress === undefined ? {} : { progress: this.#options.progress }),
      }).resolve(signal);
    }
    return await this.#remote(engineConfig.content_manifest_url, environment).resolve(signal);
  }

  #remote(
    manifestUrl: string,
    environment: Readonly<NodeJS.ProcessEnv>,
  ): RemoteContentSource {
    return new RemoteContentSource({
      client: new ContentManifestClient({
        manifestUrl,
        timeoutMs: parseTimeout(environment.AI_HARNESS_CONTENT_TIMEOUT_MS),
        allowFileUrl: environment.AI_HARNESS_ALLOW_FILE_CONTENT === "1",
        allowInsecureLoopback: environment.AI_HARNESS_ALLOW_LOOPBACK_CONTENT === "1",
      }),
      cacheRoot: this.#options.cacheRoot ?? contentCacheRoot(environment),
      ...(this.#options.progress === undefined ? {} : { progress: this.#options.progress }),
    });
  }
}

interface RemoteEngineConfig {
  readonly schema: "ai-harness/engine-config/v1";
  readonly content_manifest_url: string;
}

interface LocalEngineConfig {
  readonly schema: "ai-harness/engine-config/v1";
  readonly content_source_path: string;
}

type EngineConfig = RemoteEngineConfig | LocalEngineConfig;

async function readEngineConfig(path: string): Promise<EngineConfig> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new TypeError(
      `No installed project-content channel is available at ${path}: ${errorMessage(error)}`,
    );
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Installed engine configuration is invalid: ${path}`);
  }
  const record = value as Record<string, unknown>;
  if (record.schema !== "ai-harness/engine-config/v1") {
    throw new TypeError(`Installed engine configuration is invalid: ${path}`);
  }
  const keys = Object.keys(record).sort().join("\0");
  if (
    keys === "content_manifest_url\0schema" &&
    typeof record.content_manifest_url === "string" &&
    record.content_manifest_url.trim().length > 0
  ) {
    return Object.freeze({
      schema: "ai-harness/engine-config/v1",
      content_manifest_url: record.content_manifest_url,
    });
  }
  if (
    keys === "content_source_path\0schema" &&
    typeof record.content_source_path === "string" &&
    record.content_source_path.trim().length > 0 &&
    isAbsolute(record.content_source_path)
  ) {
    return Object.freeze({
      schema: "ai-harness/engine-config/v1",
      content_source_path: record.content_source_path,
    });
  }
  throw new TypeError(`Installed engine configuration is invalid: ${path}`);
}

function engineConfigPath(environment: Readonly<NodeJS.ProcessEnv>): string {
  const explicit = environment.AI_HARNESS_ENGINE_CONFIG?.trim();
  if (explicit !== undefined && explicit.length > 0) return resolve(explicit);
  return join(configHome(environment), "ai-harness", "engine.json");
}

function contentCacheRoot(environment: Readonly<NodeJS.ProcessEnv>): string {
  const explicit = environment.AI_HARNESS_CONTENT_CACHE?.trim();
  if (explicit !== undefined && explicit.length > 0) return resolve(explicit);
  const base = environment.XDG_CACHE_HOME?.trim();
  return join(base === undefined || base.length === 0 ? join(home(environment), ".cache") : base, "ai-harness", "content");
}

function configHome(environment: Readonly<NodeJS.ProcessEnv>): string {
  const base = environment.XDG_CONFIG_HOME?.trim();
  return base === undefined || base.length === 0 ? join(home(environment), ".config") : base;
}

function home(environment: Readonly<NodeJS.ProcessEnv>): string {
  const configured = environment.HOME?.trim();
  return configured === undefined || configured.length === 0 ? homedir() : configured;
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

function parseTimeout(value: string | undefined): number {
  if (value === undefined || value.length === 0) return 5_000;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new TypeError("AI_HARNESS_CONTENT_TIMEOUT_MS must be a positive integer");
  }
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout > 60_000) {
    throw new TypeError("AI_HARNESS_CONTENT_TIMEOUT_MS must not exceed 60000");
  }
  return timeout;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

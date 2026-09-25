import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type {
  ContentSource,
  ContentSourceProgressSink,
  ResolvedContentSource,
} from "./content-source.js";
import { LocalContentSource } from "./local-content-source.js";

/** Project content compiled into a release build: `railguard.yaml` plus `skills/`. */
export interface EmbeddedContent {
  readonly digest: string;
  readonly files: readonly EmbeddedContentFile[];
}

export interface EmbeddedContentFile {
  readonly path: string;
  readonly mode: number;
  readonly base64: string;
}

export interface EmbeddedContentSourceOptions {
  readonly content: EmbeddedContent;
  readonly cacheRoot: string;
  readonly progress?: ContentSourceProgressSink;
}

const completeMarker = ".railguard-content";

/**
 * Materializes the embedded snapshot once per digest under the cache root and then serves it as a
 * local source, so the catalog always reads a regular directory.
 */
export class EmbeddedContentSource implements ContentSource {
  readonly #options: EmbeddedContentSourceOptions;

  public constructor(options: EmbeddedContentSourceOptions) {
    this.#options = options;
  }

  public async resolve(signal?: AbortSignal): Promise<ResolvedContentSource> {
    const { content, cacheRoot } = this.#options;
    if (!/^sha256:[0-9a-f]{64}$/.test(content.digest)) {
      throw new TypeError(`Embedded content digest is invalid: ${content.digest}`);
    }
    const root = join(resolve(cacheRoot), content.digest.slice("sha256:".length));
    if (!(await isComplete(root, content.digest))) {
      await materialize(root, content);
    }
    const local = await new LocalContentSource({
      root,
      ...(this.#options.progress === undefined ? {} : { progress: this.#options.progress }),
    }).resolve(signal);
    return Object.freeze({
      ...local,
      kind: "embedded" as const,
      identity: `embedded:${content.digest}`,
    });
  }
}

async function isComplete(root: string, digest: string): Promise<boolean> {
  try {
    return (await readFile(join(root, completeMarker), "utf8")) === digest;
  } catch {
    return false;
  }
}

async function materialize(root: string, content: EmbeddedContent): Promise<void> {
  const parent = dirname(root);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(parent, ".staging-"));
  try {
    for (const file of content.files) {
      const destination = resolve(staging, file.path);
      if (!isWithin(staging, destination) || destination === staging) {
        throw new TypeError(`Embedded content path escapes its root: ${file.path}`);
      }
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, Buffer.from(file.base64, "base64"));
      await chmod(destination, file.mode);
    }
    await writeFile(join(staging, completeMarker), content.digest);
    await rm(root, { recursive: true, force: true });
    try {
      await rename(staging, root);
    } catch (error) {
      // A concurrent process may have published the same digest first.
      if (!(await isComplete(root, content.digest))) throw error;
      await rm(staging, { recursive: true, force: true });
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return difference === "" || (
    difference !== ".." &&
    !difference.startsWith(`..${sep}`) &&
    !difference.startsWith(sep)
  );
}

import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { compareUtf8, sha256 } from "../../domain/shared/types.js";
import type {
  ContentSource,
  ContentSourceProgressSink,
  ResolvedContentSource,
} from "./content-source.js";
import {
  ContentManifestClient,
  type ResolvedContentFile,
  type ResolvedContentManifest,
} from "./content-manifest-client.js";

export interface RemoteContentSourceOptions {
  readonly client: ContentManifestClient;
  readonly cacheRoot: string;
  readonly progress?: ContentSourceProgressSink;
}

export class RemoteContentSource implements ContentSource {
  readonly #client: ContentManifestClient;
  readonly #cacheRoot: string;
  readonly #progress: ContentSourceProgressSink;

  public constructor(options: RemoteContentSourceOptions) {
    this.#client = options.client;
    this.#cacheRoot = options.cacheRoot;
    this.#progress = options.progress ?? (() => undefined);
  }

  public async resolve(signal?: AbortSignal): Promise<ResolvedContentSource> {
    this.#progress({
      phase: "manifest",
      status: "started",
      message: "Fetching the current project-content manifest",
    });
    let manifest: ResolvedContentManifest;
    try {
      manifest = await this.#client.fetchManifest(signal);
    } catch (error) {
      this.#progress({
        phase: "manifest",
        status: "failed",
        message: `Project-content manifest failed: ${errorMessage(error)}`,
      });
      throw error;
    }
    this.#progress({
      phase: "manifest",
      status: "completed",
      message: `Content manifest ${manifest.manifest.revision} verified`,
    });
    this.#progress({
      phase: "cache",
      status: "started",
      message: "Preparing and verifying cached project content",
    });
    try {
      await this.#prepareCacheRoot();
    } catch (error) {
      this.#progress({
        phase: "cache",
        status: "failed",
        message: `Content cache is unavailable: ${errorMessage(error)}`,
      });
      throw error;
    }
    const snapshotRoot = join(this.#cacheRoot, manifest.digest.slice("sha256:".length));
    const cached = await verifiedCachedFiles(snapshotRoot, manifest.files);
    if (cached.size === manifest.files.length && await hasExactInventory(snapshotRoot, manifest.files)) {
      this.#progress({
        phase: "cache",
        status: "completed",
        message: `Verified cache reused for content ${manifest.manifest.revision}`,
      });
      return resolvedSource(snapshotRoot, manifest);
    }
    this.#progress({
      phase: "cache",
      status: "completed",
      message: "Content cache requires reconstruction",
    });
    const staging = await mkdtemp(join(this.#cacheRoot, ".staging-"));
    try {
      await this.#materialize(staging, manifest, cached, signal);
      await replaceSnapshot(staging, snapshotRoot);
    } catch (error) {
      this.#progress({
        phase: "files",
        status: "failed",
        message: `Verified content materialization failed: ${errorMessage(error)}`,
      });
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
    return resolvedSource(snapshotRoot, manifest);
  }

  async #prepareCacheRoot(): Promise<void> {
    await mkdir(this.#cacheRoot, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.#cacheRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new TypeError(`Content cache root is not a regular directory: ${this.#cacheRoot}`);
    }
    if ((metadata.mode & 0o077) !== 0) {
      throw new TypeError(`Content cache root must not be group/world accessible: ${this.#cacheRoot}`);
    }
  }

  async #materialize(
    staging: string,
    manifest: ResolvedContentManifest,
    cached: ReadonlyMap<string, Uint8Array>,
    signal?: AbortSignal,
  ): Promise<void> {
    this.#progress({
      phase: "files",
      status: "started",
      message: "Materializing verified project content",
      current: 0,
      total: manifest.files.length,
    });
    for (const [index, file] of manifest.files.entries()) {
      const content = cached.get(file.path) ?? await this.#client.fetchFile(file, signal);
      const destination = join(staging, ...file.path.split("/"));
      await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
      await writeFile(destination, content, { mode: file.mode === "100755" ? 0o755 : 0o644 });
      await chmod(destination, file.mode === "100755" ? 0o755 : 0o644);
      this.#progress({
        phase: "files",
        status: "started",
        message: `${cached.has(file.path) ? "Reused" : "Fetched"} ${file.path}`,
        current: index + 1,
        total: manifest.files.length,
      });
    }
    this.#progress({
      phase: "files",
      status: "completed",
      message: `${manifest.files.length} verified content file(s) ready`,
      current: manifest.files.length,
      total: manifest.files.length,
    });
  }
}

function resolvedSource(
  root: string,
  manifest: ResolvedContentManifest,
): ResolvedContentSource {
  return Object.freeze({
    kind: "remote" as const,
    root,
    catalogFile: join(root, "ai-harness.yaml"),
    revision: manifest.manifest.revision,
    identity: manifest.digest,
    location: manifest.manifestUrl.href,
  });
}

async function verifiedCachedFiles(
  root: string,
  files: readonly ResolvedContentFile[],
): Promise<ReadonlyMap<string, Uint8Array>> {
  try {
    const metadata = await lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return new Map();
  } catch {
    return new Map();
  }
  const realRoot = await realpath(root);
  const verified = new Map<string, Uint8Array>();
  for (const file of files) {
    const path = join(root, ...file.path.split("/"));
    try {
      const [metadata, realFile] = await Promise.all([lstat(path), realpath(path)]);
      if (!metadata.isFile() || metadata.isSymbolicLink() || !isWithin(realRoot, realFile)) continue;
      const expectedMode = file.mode === "100755" ? 0o755 : 0o644;
      if ((metadata.mode & 0o777) !== expectedMode || metadata.size !== file.size) continue;
      const bytes = new Uint8Array(await readFile(realFile));
      if (sha256(bytes) !== file.sha256) continue;
      verified.set(file.path, bytes);
    } catch {
      // An incomplete or altered cache entry is replaced from the verified channel.
    }
  }
  return verified;
}

async function hasExactInventory(
  root: string,
  files: readonly ResolvedContentFile[],
): Promise<boolean> {
  try {
    const observed: string[] = [];
    await walkFiles(root, root, observed);
    const expected = files.map((file) => file.path);
    return observed.length === expected.length && observed.every((path, index) => path === expected[index]);
  } catch {
    return false;
  }
}

async function walkFiles(root: string, directory: string, output: string[]): Promise<void> {
  const handle = await opendir(directory);
  const entries = [];
  for await (const entry of handle) entries.push(entry);
  entries.sort((left, right) => compareUtf8(left.name, right.name));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new TypeError(`Content cache contains a symlink: ${path}`);
    if (metadata.isDirectory()) {
      await walkFiles(root, path, output);
    } else if (metadata.isFile()) {
      output.push(relative(root, path).split(sep).join("/"));
    } else {
      throw new TypeError(`Content cache contains a special file: ${path}`);
    }
  }
  output.sort(compareUtf8);
}

async function replaceSnapshot(staging: string, destination: string): Promise<void> {
  const quarantine = join(dirname(destination), `.invalid-${basename(destination)}-${randomUUID()}`);
  let quarantined = false;
  try {
    await rename(destination, quarantine);
    quarantined = true;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  try {
    await rename(staging, destination);
  } catch (error) {
    if (quarantined) await rename(quarantine, destination);
    throw error;
  }
  if (quarantined) await rm(quarantine, { recursive: true, force: true });
}

function isWithin(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return difference === "" || (
    difference !== ".." &&
    !difference.startsWith(`..${sep}`) &&
    !difference.startsWith(sep)
  );
}

function isMissing(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

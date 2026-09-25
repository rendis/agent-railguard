import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, opendir, readlink, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type {
  RepositoryDirectoryEntry,
  RepositoryEntry,
  RepositoryFileEntry,
  RepositoryInventory,
  RepositorySnapshot,
  RepositorySymlinkEntry,
  SnapshotRead,
} from "../../../domain/repository/model.js";
import {
  ReadonlyBytes,
  compareUtf8,
  relativePosixPath,
  sha256,
  type RelativePosixPath,
} from "../../../domain/shared/types.js";

export interface RepositoryInventoryOptions {
  readonly maxEntries?: number;
  readonly maxDepth?: number;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly excludedDirectories?: readonly string[];
}

const defaultExcludedDirectories = Object.freeze([
  ".git",
  ".next",
  ".pnpm-store",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
]);

const execute = promisify(execFile);

interface InventoryBudget {
  entries: number;
  bytes: number;
}

class CapturedRepositorySnapshot implements RepositorySnapshot {
  readonly #files: ReadonlyMap<RelativePosixPath, { readonly bytes: ReadonlyBytes; readonly mode: number }>;

  public constructor(
    public readonly logicalRoot: string,
    public readonly realRoot: string,
    public readonly fingerprint: ReturnType<typeof sha256>,
    public readonly entries: readonly RepositoryEntry[],
    files: ReadonlyMap<RelativePosixPath, { readonly bytes: ReadonlyBytes; readonly mode: number }>,
  ) {
    this.#files = files;
  }

  public async read(path: RelativePosixPath, maxBytes: number): Promise<SnapshotRead> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new TypeError("Read limit must be a non-negative safe integer");
    }
    const file = this.#files.get(path);
    if (file === undefined) {
      throw new Error(`Snapshot path is not a regular file: ${path}`);
    }
    if (file.bytes.byteLength > maxBytes) {
      throw new Error(`Snapshot path exceeds read limit: ${path}`);
    }
    return Object.freeze({
      path,
      mode: file.mode,
      digest: file.bytes.digest(),
      bytes: new ReadonlyBytes(file.bytes.copy()),
    });
  }
}

export class NodeRepositoryInventory implements RepositoryInventory {
  readonly #maxEntries: number;
  readonly #maxDepth: number;
  readonly #maxFileBytes: number;
  readonly #maxTotalBytes: number;
  readonly #excludedDirectories: ReadonlySet<string>;

  public constructor(options: RepositoryInventoryOptions = {}) {
    this.#maxEntries = options.maxEntries ?? 50_000;
    this.#maxDepth = options.maxDepth ?? 64;
    this.#maxFileBytes = options.maxFileBytes ?? 32 * 1024 * 1024;
    this.#maxTotalBytes = options.maxTotalBytes ?? 512 * 1024 * 1024;
    this.#excludedDirectories = new Set(
      options.excludedDirectories ?? defaultExcludedDirectories,
    );

    for (const [name, value] of [
      ["maxEntries", this.#maxEntries],
      ["maxDepth", this.#maxDepth],
      ["maxFileBytes", this.#maxFileBytes],
      ["maxTotalBytes", this.#maxTotalBytes],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new TypeError(`${name} must be a positive safe integer`);
      }
    }
  }

  public async snapshot(root: string): Promise<RepositorySnapshot> {
    const logicalRoot = resolve(root);
    const rootStat = await stat(logicalRoot);
    if (!rootStat.isDirectory()) {
      throw new Error(`Repository root is not a directory: ${logicalRoot}`);
    }
    const rootRealPath = await realpath(logicalRoot);
    const entries: RepositoryEntry[] = [];
    const files = new Map<RelativePosixPath, { readonly bytes: ReadonlyBytes; readonly mode: number }>();
    const budget: InventoryBudget = { entries: 0, bytes: 0 };
    const ignoredDirectories = await ignoredOutputDirectories(logicalRoot);

    await this.#walk({
      absoluteDirectory: logicalRoot,
      relativeDirectory: "",
      depth: 0,
      rootRealPath,
      ignoredDirectories,
      entries,
      files,
      budget,
    });

    entries.sort((left, right) => compareUtf8(left.path, right.path));
    const records = entries.map((entry) => {
      if (entry.kind === "file") {
        return `F\0${entry.path}\0${entry.mode.toString(8)}\0${entry.size}\0${entry.digest}\n`;
      }
      if (entry.kind === "directory") {
        return `D\0${entry.path}\0${entry.mode.toString(8)}\n`;
      }
      return `L\0${entry.path}\0${entry.target}\0${entry.escapesRoot ? "escape" : "contained"}\n`;
    });

    return new CapturedRepositorySnapshot(
      logicalRoot,
      rootRealPath,
      sha256(records.join("")),
      Object.freeze(entries.map((entry) => Object.freeze(entry))),
      files,
    );
  }

  async #walk(input: {
    readonly absoluteDirectory: string;
    readonly relativeDirectory: string;
    readonly depth: number;
    readonly rootRealPath: string;
    readonly ignoredDirectories: ReadonlySet<string>;
    readonly entries: RepositoryEntry[];
    readonly files: Map<RelativePosixPath, { readonly bytes: ReadonlyBytes; readonly mode: number }>;
    readonly budget: InventoryBudget;
  }): Promise<void> {
    if (input.depth > this.#maxDepth) {
      throw new Error(`Repository inventory exceeded depth limit ${this.#maxDepth}`);
    }

    const directory = await opendir(input.absoluteDirectory);
    const directoryEntries = [];
    for await (const entry of directory) {
      directoryEntries.push(entry);
    }
    directoryEntries.sort((left, right) => compareUtf8(left.name, right.name));

    for (const directoryEntry of directoryEntries) {
      const relativeValue =
        input.relativeDirectory.length === 0
          ? directoryEntry.name
          : `${input.relativeDirectory}/${directoryEntry.name}`;
      if (
        directoryEntry.name === ".git" ||
        (directoryEntry.isDirectory() &&
          (this.#excludedDirectories.has(directoryEntry.name) ||
            input.ignoredDirectories.has(relativeValue)))
      ) {
        continue;
      }
      input.budget.entries += 1;
      if (input.budget.entries > this.#maxEntries) {
        throw new Error(`Repository inventory exceeded entry limit ${this.#maxEntries}`);
      }

      const path = relativePosixPath(relativeValue);
      const absolutePath = resolve(input.absoluteDirectory, directoryEntry.name);
      const pathStat = await lstat(absolutePath);

      if (pathStat.isSymbolicLink()) {
        const target = await readlink(absolutePath);
        let resolvedPath: string | null = null;
        try {
          resolvedPath = await realpath(absolutePath);
        } catch {
          resolvedPath = null;
        }
        const entry: RepositorySymlinkEntry = Object.freeze({
          kind: "symlink",
          path,
          target,
          resolvedPath,
          escapesRoot:
            resolvedPath === null ? false : !isInsideRoot(input.rootRealPath, resolvedPath),
        });
        input.entries.push(entry);
        continue;
      }

      if (pathStat.isDirectory()) {
        const resolvedDirectory = await realpath(absolutePath);
        if (!isInsideRoot(input.rootRealPath, resolvedDirectory)) {
          throw new Error(`Repository directory escapes root: ${path}`);
        }
        const entry: RepositoryDirectoryEntry = Object.freeze({
          kind: "directory",
          path,
          mode: pathStat.mode & 0o777,
        });
        input.entries.push(entry);
        await this.#walk({
          ...input,
          absoluteDirectory: absolutePath,
          relativeDirectory: relativeValue,
          depth: input.depth + 1,
        });
        continue;
      }

      if (!pathStat.isFile()) {
        throw new Error(`Repository contains unsupported entry type: ${path}`);
      }
      if (pathStat.size > this.#maxFileBytes) {
        throw new Error(`Repository file exceeds file byte limit: ${path}`);
      }
      input.budget.bytes += pathStat.size;
      if (input.budget.bytes > this.#maxTotalBytes) {
        throw new Error(`Repository inventory exceeded total byte limit ${this.#maxTotalBytes}`);
      }

      const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
      const handle = await open(absolutePath, constants.O_RDONLY | noFollow);
      let bytes: Uint8Array;
      let fileMode: number;
      try {
        const openedStat = await handle.stat();
        if (!openedStat.isFile() || openedStat.size !== pathStat.size) {
          throw new Error(`Repository file changed during inventory: ${path}`);
        }
        bytes = await handle.readFile();
        fileMode = openedStat.mode & 0o777;
      } finally {
        await handle.close();
      }
      const resolvedFile = await realpath(absolutePath);
      if (!isInsideRoot(input.rootRealPath, resolvedFile)) {
        throw new Error(`Repository file escapes root: ${path}`);
      }
      const readonlyBytes = new ReadonlyBytes(bytes);
      const entry: RepositoryFileEntry = Object.freeze({
        kind: "file",
        path,
        mode: fileMode,
        size: readonlyBytes.byteLength,
        digest: readonlyBytes.digest(),
      });
      input.entries.push(entry);
      input.files.set(path, { bytes: readonlyBytes, mode: fileMode });
    }
  }
}

/**
 * Git-ignored directories outside hidden configuration directories hold build output and caches
 * (`tmp/`, `bin/`, `out/`); nothing is ever projected there. Hidden directories such as `.claude`
 * stay inventoried even when ignored because harness configuration lives in them.
 */
async function ignoredOutputDirectories(root: string): Promise<ReadonlySet<string>> {
  try {
    const { stdout } = await execute(
      "git",
      ["-C", root, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    return new Set(
      stdout
        .split("\0")
        .filter((path) => path.endsWith("/") && !path.startsWith(".") && !path.includes("/."))
        .map((path) => path.slice(0, -1)),
    );
  } catch {
    return new Set();
  }
}

function isInsideRoot(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return (
    difference === "" ||
    (!difference.startsWith(`..${sep}`) && difference !== ".." && !isAbsolute(difference))
  );
}

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, opendir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

export const execute = promisify(execFile);

export function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
}

export async function copyFileDeterministic(source, destination, mode = 0o644) {
  const bytes = await readFile(source);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes, { mode });
  await chmod(destination, mode);
}

export async function copyTree(source, destination) {
  await mkdir(destination, { recursive: true, mode: 0o755 });
  const directory = await opendir(source);
  const entries = [];
  for await (const entry of directory) entries.push(entry);
  entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    const metadata = await lstat(sourcePath);
    if (metadata.isSymbolicLink()) throw new Error(`Release input must not be a symlink: ${sourcePath}`);
    if (metadata.isDirectory()) await copyTree(sourcePath, destinationPath);
    else if (metadata.isFile()) await copyFileDeterministic(sourcePath, destinationPath, metadata.mode & 0o111 ? 0o755 : 0o644);
    else throw new Error(`Unsupported release input: ${sourcePath}`);
  }
}

export async function inventory(root) {
  const files = [];
  await walk(root, root, files);
  files.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  return files;
}

async function walk(root, directory, files) {
  const handle = await opendir(directory);
  const entries = [];
  for await (const entry of handle) entries.push(entry);
  entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new Error(`Inventory refuses symlink: ${path}`);
    if (metadata.isDirectory()) {
      await walk(root, path, files);
      continue;
    }
    if (!metadata.isFile()) throw new Error(`Inventory refuses non-file: ${path}`);
    const bytes = await readFile(path);
    files.push({
      path: relative(root, path).split(sep).join("/"),
      mode: metadata.mode & 0o111 ? "100755" : "100644",
      size: bytes.byteLength,
      sha256: sha256(bytes),
    });
  }
}

export async function digestInputs(projectRoot, paths) {
  const records = [];
  for (const source of [...paths].sort()) {
    const absolute = resolve(projectRoot, source);
    const metadata = await lstat(absolute);
    if (metadata.isDirectory()) {
      for (const entry of await inventory(absolute)) {
        records.push(`${source}/${entry.path}\0${entry.mode}\0${entry.sha256}\n`);
      }
    } else {
      const bytes = await readFile(absolute);
      records.push(`${source}\0${metadata.mode & 0o111 ? "100755" : "100644"}\0${sha256(bytes)}\n`);
    }
  }
  return sha256(Buffer.from(records.join(""), "utf8"));
}

export async function gitIdentity(projectRoot, inputDigest) {
  try {
    const [{ stdout: commit }, { stdout: tree }] = await Promise.all([
      execute("git", ["rev-parse", "HEAD"], { cwd: projectRoot }),
      execute("git", ["rev-parse", "HEAD^{tree}"], { cwd: projectRoot }),
    ]);
    return { commit: commit.trim(), tree: tree.trim(), input_digest: inputDigest };
  } catch {
    return { commit: "uncommitted", tree: inputDigest, input_digest: inputDigest };
  }
}

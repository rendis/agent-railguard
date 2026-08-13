import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function createTempRepository(
  files: Readonly<Record<string, string | Uint8Array>>,
): Promise<{ readonly root: string; cleanup(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "ai-harness-test-"));
  await chmod(root, 0o700);

  for (const [path, content] of Object.entries(files)) {
    const absolutePath = join(root, ...path.split("/"));
    await mkdir(join(absolutePath, ".."), { recursive: true });
    await writeFile(absolutePath, content);
  }

  return {
    root,
    async cleanup(): Promise<void> {
      await rm(root, { recursive: true, force: true });
    },
  };
}

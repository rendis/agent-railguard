import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { sameFileMode } from "../../src/adapters/platform/file-mode/file-mode.js";
import { recordExecutableBits } from "../../src/adapters/platform/git/executable-bits.js";
import { posixScript, posixShell } from "../../src/adapters/platform/process/posix-shell.js";
import { executableManifest, sourceModes } from "../../src/catalog/source-modes.js";
import { relativePosixPath } from "../../src/domain/shared/types.js";
import { GoCheckProvider } from "../../src/adapters/stack/go/go-check-provider.js";
import { NodeProcessRunner } from "../../src/adapters/platform/process/node-process-runner.js";
import { runFullCheck } from "../helpers/full-check.js";

const execute = promisify(execFile);
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function directory(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "railguard-windows-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function git(root: string, ...args: string[]): Promise<string> {
  return (await execute("git", ["-C", root, "-c", "user.email=t@t", "-c", "user.name=t", ...args])).stdout;
}

describe("Windows support", () => {
  it("compares file modes only where the file system carries permission bits", () => {
    expect(sameFileMode(0o644, 0o755, true)).toBe(false);
    expect(sameFileMode(0o755, 0o755, true)).toBe(true);
    expect(sameFileMode(0o666, 0o755, false)).toBe(true);
  });

  it("reads content modes from the permission bits, or on Windows from the manifest or the Git index", async () => {
    const root = await directory();
    const script = join(root, "skills", "demo", "run.sh");
    const label = relativePosixPath("skills/demo/run.sh");

    const posix = await sourceModes(root, "darwin");
    expect(posix(script, 0o100755, label)).toBe("100755");
    expect(() => posix(script, 0o100666, label)).toThrow("Source file mode is unsafe");

    await writeFile(join(root, executableManifest), "skills/demo/run.sh\n");
    const fromManifest = await sourceModes(root, "win32");
    expect(fromManifest(script, 0o100666, label)).toBe("100755");
    expect(fromManifest(join(root, "railguard.yaml"), 0o100666, relativePosixPath("railguard.yaml"))).toBe("100644");

    await rm(join(root, executableManifest));
    await expect(sourceModes(root, "win32")).rejects.toThrow("must be a Git checkout");
    await git(root, "init", "-q");
    await writeFile(join(root, "tool.sh"), "#!/bin/sh\n");
    await git(root, "add", "--chmod=+x", "tool.sh");
    const fromIndex = await sourceModes(root, "win32");
    expect(fromIndex(join(root, "tool.sh"), 0o100666, relativePosixPath("tool.sh"))).toBe("100755");
  });

  it("ignores the directories Go ignores in gofmt output with Windows separators", async () => {
    const root = await directory();
    const bin = join(root, ".bin");
    await mkdir(bin);
    await writeFile(join(bin, "gofmt"), '#!/bin/sh\nprintf "%s\\n" "vendor\\\\lib\\\\a.go" ".agents\\\\skill\\\\b.go" "internal\\\\core\\\\c.go"\n');
    await chmod(join(bin, "gofmt"), 0o755);

    const result = await runFullCheck(root, new GoCheckProvider(new NodeProcessRunner()), "go-format", {}, {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    });

    expect(result).toMatchObject({ code: 1, output: "Go files need gofmt -w:\ninternal/core/c.go\n" });
  });

  it("runs POSIX scripts directly, or on Windows through a shell", () => {
    expect(posixScript("/repo/.railguard/bin/railguard", "linux")).toEqual({ command: "/repo/.railguard/bin/railguard", args: [] });
    expect(posixShell("darwin")).toBe("sh");
    const shell = posixShell("win32");
    expect(posixScript("C:/repo/.railguard/bin/railguard", "win32")).toEqual({ command: shell, args: ["C:/repo/.railguard/bin/railguard"] });
  });

  it("records the executable bit in the Git index for tracked and untracked files", async () => {
    const root = await directory();
    await git(root, "init", "-q");
    await writeFile(join(root, "tracked.sh"), "#!/bin/sh\n");
    await git(root, "add", "tracked.sh");
    await git(root, "commit", "-qm", "tracked");
    await writeFile(join(root, "new.sh"), "#!/bin/sh\n");

    const recorded = await recordExecutableBits(root, ["tracked.sh", "new.sh"]);

    expect(recorded).toEqual(["tracked.sh", "new.sh"]);
    expect(await git(root, "ls-files", "--stage")).toMatch(/^100755 \S+ 0\tnew\.sh\n100755 \S+ 0\ttracked\.sh\n$/u);
    expect(await recordExecutableBits(root, ["tracked.sh", "new.sh"])).toEqual([]);
    const outside = await directory();
    expect(await recordExecutableBits(outside, ["file.sh"])).toEqual([]);
  });
});

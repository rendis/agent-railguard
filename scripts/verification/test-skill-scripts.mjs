// Runs the Go tests of every skill script; each script is a standalone main package without a module.
import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const files = (await readdir("skills", { recursive: true })).map((path) => join("skills", path));
const directories = [...new Set(files.filter((path) => path.endsWith("_test.go")).map(dirname))].sort();
if (directories.length === 0) throw new Error("No skill script tests found");
for (const directory of directories) {
  const sources = files.filter((path) => dirname(path) === directory && path.endsWith(".go")).map((path) => path.slice(directory.length + 1));
  process.stdout.write(`${directory}\n`);
  execFileSync("go", ["test", ...sources], { cwd: directory, stdio: "inherit", env: { ...process.env, GOFLAGS: "-count=1" } });
}

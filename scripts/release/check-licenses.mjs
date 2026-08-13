import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const allowed = new Set(["MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "BlueOak-1.0.0"]);

export async function generateNotices(projectRoot) {
  const rootPackage = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8"));
  const entries = [];
  for (const [name, version] of Object.entries(rootPackage.dependencies ?? {}).sort(([left], [right]) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  )) {
    const manifest = JSON.parse(await readFile(resolve(projectRoot, "node_modules", name, "package.json"), "utf8"));
    const license = typeof manifest.license === "string" ? manifest.license : "UNKNOWN";
    if (!allowed.has(license)) throw new Error(`Runtime dependency ${name} uses unapproved license ${license}`);
    entries.push({ name, version, license, homepage: manifest.homepage ?? manifest.repository?.url ?? null });
  }
  const lines = [
    "# Third-party notices",
    "",
    "AI Harness bundles the following runtime libraries into its ESM artifact:",
    "",
    ...entries.flatMap((entry) => [
      `## ${entry.name} ${entry.version}`,
      "",
      `License: ${entry.license}`,
      ...(entry.homepage === null ? [] : [`Source: ${String(entry.homepage).replace(/^git\+/, "")}`]),
      "",
    ]),
  ];
  return `${lines.join("\n")}\n`;
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  process.stdout.write(await generateNotices(resolve(".")));
}

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";
import { sha256, writeJson } from "./release-lib.mjs";

export async function generateSbom(projectRoot, outputFile, version = "0.1.0") {
  const lockBytes = await readFile(resolve(projectRoot, "pnpm-lock.yaml"));
  const lock = parse(lockBytes.toString("utf8"));
  const packages = Object.keys(lock.packages ?? {}).sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  );
  const components = packages.map((key) => {
    const separator = key.lastIndexOf("@");
    const name = key.slice(0, separator);
    const version = key.slice(separator + 1);
    return {
      type: "library",
      "bom-ref": `pkg:npm/${encodeURIComponent(name)}@${version}`,
      name,
      version,
      purl: `pkg:npm/${encodeURIComponent(name)}@${version}`,
    };
  });
  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber: `urn:uuid:${stableUuid(sha256(lockBytes))}`,
    version: 1,
    metadata: {
      component: {
        type: "application",
        name: "@example/ai-harness",
        version,
      },
      properties: [
        { name: "example:lockfile:sha256", value: sha256(lockBytes) },
      ],
    },
    components,
  };
  await writeJson(outputFile, sbom);
  return sbom;
}

function stableUuid(digest) {
  const hex = digest.slice("sha256:".length, "sha256:".length + 32).split("");
  hex[12] = "4";
  hex[16] = ["8", "9", "a", "b"][Number.parseInt(hex[16], 16) % 4];
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  const output = process.argv[2];
  if (output === undefined) throw new Error("Usage: generate-sbom.mjs OUTPUT");
  await generateSbom(resolve("."), resolve(output));
}

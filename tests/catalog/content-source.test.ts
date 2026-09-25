import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultContentSource } from "../../src/catalog/source/content-source-composition.js";
import type { EmbeddedContent } from "../../src/catalog/source/embedded-content-source.js";
import { LocalContentSource } from "../../src/catalog/source/local-content-source.js";
import { SourcedCatalog } from "../../src/catalog/source/sourced-catalog.js";
import { languageId } from "../../src/domain/shared/types.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("content sources", () => {
  it("loads a local checkout without copying it and reports its origin", async () => {
    const root = await temporaryRoot("railguard-local-source-");
    await writeFile(join(root, "railguard.yaml"), minimalCatalog("0.1.0"), "utf8");
    const source = new LocalContentSource({ root });
    const realRoot = await realpath(root);

    const resolved = await source.resolve();
    const loaded = await new SourcedCatalog({ source, supportedLanguages: [languageId("go")] }).load();

    expect(resolved).toMatchObject({ kind: "local", root: realRoot, catalogFile: join(realRoot, "railguard.yaml") });
    expect(loaded.kind).toBe("ready");
    if (loaded.kind === "ready") {
      expect(loaded.catalog.revision).toBe("0.1.0");
      expect(loaded.diagnostics.some((entry) => entry.code === "catalog.source.local")).toBe(true);
    }
  });

  it("rejects a local source whose catalog is absent or not a regular file", async () => {
    const root = await temporaryRoot("railguard-invalid-local-");
    const absent = await new SourcedCatalog({
      source: new LocalContentSource({ root }),
      supportedLanguages: [languageId("go")],
    }).load();
    expect(absent.kind).toBe("invalid");

    await mkdir(join(root, "railguard.yaml"));
    const directory = await new SourcedCatalog({
      source: new LocalContentSource({ root }),
      supportedLanguages: [languageId("go")],
    }).load();
    expect(directory.kind).toBe("invalid");
  });

  it("gives an explicit --source checkout priority over the authoring checkout and embedded content", async () => {
    const explicit = await temporaryRoot("railguard-explicit-");
    await writeFile(join(explicit, "railguard.yaml"), minimalCatalog("0.2.0"), "utf8");
    const authoring = await temporaryRoot("railguard-authoring-");
    await writeFile(join(authoring, "railguard.yaml"), minimalCatalog("0.1.0"), "utf8");

    const resolved = await createDefaultContentSource({
      sourcePath: explicit,
      developmentCatalogFile: join(authoring, "railguard.yaml"),
      embeddedContent: embedded(minimalCatalog("0.3.0")),
    }).resolve();

    expect(resolved).toMatchObject({ kind: "local", root: await realpath(explicit) });
  });

  it("uses the authoring checkout the engine runs from before embedded content", async () => {
    const authoring = await temporaryRoot("railguard-authoring-");
    await writeFile(join(authoring, "railguard.yaml"), minimalCatalog("0.1.0"), "utf8");

    const resolved = await createDefaultContentSource({
      developmentCatalogFile: join(authoring, "railguard.yaml"),
      embeddedContent: embedded(minimalCatalog("0.3.0")),
    }).resolve();

    expect(resolved).toMatchObject({ kind: "local", root: await realpath(authoring) });
  });

  it("materializes embedded content once per digest and preserves executable modes", async () => {
    const cacheRoot = await temporaryRoot("railguard-content-cache-");
    const content = embedded(minimalCatalog("0.3.0"), {
      path: "skills/demo/scripts/run.sh",
      mode: 0o755,
      text: "#!/bin/sh\necho ok\n",
    });
    const options = {
      developmentCatalogFile: join(cacheRoot, "missing", "railguard.yaml"),
      embeddedContent: content,
      cacheRoot,
    };

    const first = await createDefaultContentSource(options).resolve();
    const script = join(first.root, "skills/demo/scripts/run.sh");
    const firstIdentity = (await lstat(script)).ino;
    const second = await createDefaultContentSource(options).resolve();
    const catalog = await new SourcedCatalog({
      source: createDefaultContentSource(options),
      supportedLanguages: [languageId("go")],
    }).load();

    expect(first).toMatchObject({ kind: "embedded", identity: `embedded:${content.digest}` });
    expect(second.root).toBe(first.root);
    expect((await lstat(script)).ino).toBe(firstIdentity);
    expect((await lstat(script)).mode & 0o777).toBe(0o755);
    expect(await readFile(first.catalogFile, "utf8")).toBe(minimalCatalog("0.3.0"));
    expect(catalog.kind).toBe("ready");
    if (catalog.kind === "ready") {
      expect(catalog.diagnostics.some((entry) => entry.code === "catalog.source.embedded")).toBe(true);
    }
  });

  it("rejects embedded content whose paths escape the materialized root", async () => {
    const cacheRoot = await temporaryRoot("railguard-content-cache-");
    const content = embedded(minimalCatalog("0.3.0"), { path: "../escape.txt", mode: 0o644, text: "x" });

    await expect(createDefaultContentSource({
      developmentCatalogFile: join(cacheRoot, "missing", "railguard.yaml"),
      embeddedContent: content,
      cacheRoot,
    }).resolve()).rejects.toThrow(/escapes its root/);
  });
});

function embedded(
  catalog: string,
  ...extra: readonly { readonly path: string; readonly mode: number; readonly text: string }[]
): EmbeddedContent {
  const files = [{ path: "railguard.yaml", mode: 0o644, text: catalog }, ...extra];
  const digest = `sha256:${Buffer.from(files.map((file) => file.path + file.text).join("|")).toString("hex").padEnd(64, "0").slice(0, 64)}`;
  return {
    digest,
    files: files.map((file) => ({
      path: file.path,
      mode: file.mode,
      base64: Buffer.from(file.text).toString("base64"),
    })),
  };
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function minimalCatalog(revision: string): string {
  return [
    "schema: railguard/v1",
    `version: ${revision}`,
    "catalog:",
    "  skills: {}",
    "  mcps: {}",
    "  verification-profiles: {}",
    "  git-gates: {}",
    "  instruction-fragments: {}",
    "  packs: {}",
    "  agents: {}",
    "",
  ].join("\n");
}

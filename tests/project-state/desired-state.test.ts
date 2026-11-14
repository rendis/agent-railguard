import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FilesystemCatalog } from "../../src/catalog/filesystem-catalog.js";
import { DesiredStateModule } from "../../src/project-state/desired-state.js";
import { languageId } from "../../src/domain/shared/types.js";

const catalogFile = fileURLToPath(new URL("../../railguard.yaml", import.meta.url));

describe("DesiredStateModule", () => {
  it("normalizes equivalent draft and YAML input to identical portable state", async () => {
    const loaded = await new FilesystemCatalog({
      catalogFile,
      supportedLanguages: [languageId("go")],
    }).load();
    expect(loaded.kind).toBe("ready");
    if (loaded.kind !== "ready") return;

    const module = new DesiredStateModule();
    const fromDraft = module.evaluate(
      {
        kind: "draft",
        targets: ["codex"],
        selections: [
          {
            ref: "verification-profile:go-quality",
            inputs: {
              test_packages: ["./internal/...", "./..."],
            },
          },
        ],
      },
      loaded.catalog,
    );
    const fromYaml = module.evaluate(
      {
        kind: "yaml",
        source: `schema: railguard/project/v1
targets: [codex]
selections:
  - inputs:
      test_packages: [./internal/..., ./...]
    ref: verification-profile:go-quality
`,
      },
      loaded.catalog,
    );

    expect(fromDraft.kind).toBe("ready");
    expect(fromYaml.kind).toBe("ready");
    if (fromDraft.kind !== "ready" || fromYaml.kind !== "ready") return;

    expect(fromDraft.state).toEqual(fromYaml.state);
    expect(fromDraft.digest).toBe(fromYaml.digest);
    expect(fromDraft.bytes.toString()).toBe(`schema: railguard/project/v1
targets:
  - codex
selections:
  - ref: verification-profile:go-quality
    inputs:
      test_packages:
        - "./..."
        - "./internal/..."
`);
  });

  it("keeps a disabled selection without inputs and rejects one that has inputs", async () => {
    const module = new DesiredStateModule();
    const catalog = await readyCatalog();
    const source = "schema: railguard/project/v1\ntargets: []\nselections:\n  - ref: pack:go-service-foundation\n  - ref: verification-profile:change-guard\n    disabled: true\n";

    const result = module.evaluate({ kind: "yaml", source }, catalog);
    const withInputs = module.evaluate({
      kind: "draft",
      targets: [],
      selections: [{ ref: "verification-profile:change-guard", disabled: true, inputs: { approvers: ["rendis"] } }],
    }, catalog);

    expect(result.kind).toBe("ready");
    if (result.kind === "ready") {
      expect(result.state.selections[1]).toEqual({ ref: "verification-profile:change-guard", inputs: {}, disabled: true });
      expect(result.bytes.toString()).toBe(source);
    }
    expect(withInputs.kind).toBe("invalid");
    if (withInputs.kind === "invalid") expect(withInputs.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["project-state.disabled-inputs"]);
  });

  it("renders an empty project deterministically without blocking a new repository", async () => {
    const module = new DesiredStateModule();
    const catalog = await readyCatalog();
    const result = module.evaluate({ kind: "draft", targets: [], selections: [] }, catalog);

    expect(result.kind).toBe("ready");
    if (result.kind === "ready") {
      expect(result.bytes.toString()).toBe(`schema: railguard/project/v1
targets: []
selections: []
`);
    }
  });

  it.each([
    {
      name: "unknown component",
      input: {
        kind: "draft" as const,
        targets: ["codex"],
        selections: [{ ref: "skill:missing" }],
      },
      code: "project-state.component-unknown",
    },
    {
      name: "unknown semantic input",
      input: {
        kind: "draft" as const,
        targets: ["codex"],
        selections: [
          { ref: "verification-profile:go-quality", inputs: { missing: ["./..."] } },
        ],
      },
      code: "project-state.input-unknown",
    },
    {
      name: "invalid semantic input value",
      input: {
        kind: "draft" as const,
        targets: ["codex"],
        selections: [
          {
            ref: "verification-profile:go-quality",
            inputs: { test_packages: ["../outside/..."] },
          },
        ],
      },
      code: "project-state.input-value",
    },
    {
      name: "unsafe managed fuzz command input",
      input: {
        kind: "draft" as const,
        targets: ["codex"],
        selections: [
          {
            ref: "verification-profile:go-fuzz",
            inputs: { cases: ["./internal/parser:FuzzDecode:5s;rm"] },
          },
        ],
      },
      code: "project-state.input-value",
    },
    {
      name: "duplicate target",
      input: {
        kind: "draft" as const,
        targets: ["codex", "codex"],
        selections: [],
      },
      code: "project-state.schema-invalid",
    },
    {
      name: "duplicate selection",
      input: {
        kind: "draft" as const,
        targets: [],
        selections: [{ ref: "skill:tdd" }, { ref: "skill:tdd" }],
      },
      code: "project-state.selection-duplicate",
    },
  ])("rejects $name", async ({ input, code }) => {
    const result = new DesiredStateModule().evaluate(input, await readyCatalog());
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(code);
    }
  });

  it("rejects aliases and unknown YAML fields before semantic normalization", async () => {
    const catalog = await readyCatalog();
    const module = new DesiredStateModule();
    const unsafe = module.evaluate(
      {
        kind: "yaml",
        source: `schema: railguard/project/v1
targets: &targets [codex]
selections: *targets
`,
      },
      catalog,
    );
    const unknownField = module.evaluate(
      {
        kind: "yaml",
        source: `schema: railguard/project/v1
targets: []
selections: []
installed: true
`,
      },
      catalog,
    );

    expect(unsafe.kind).toBe("invalid");
    expect(unknownField.kind).toBe("invalid");
    if (unsafe.kind === "invalid") {
      expect(unsafe.diagnostics[0].code).toBe("project-state.yaml-invalid");
    }
    if (unknownField.kind === "invalid") {
      expect(unknownField.diagnostics[0].code).toBe("project-state.schema-invalid");
    }
  });
});

async function readyCatalog() {
  const loaded = await new FilesystemCatalog({
    catalogFile,
    supportedLanguages: [languageId("go")],
  }).load();
  if (loaded.kind !== "ready") throw new Error("Expected real catalog to be ready");
  return loaded.catalog;
}

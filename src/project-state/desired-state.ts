import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import projectStateSchema from "../../schemas/project-state.v1.schema.json" with {
  type: "json",
};
import type {
  CatalogInputDefinition,
  CatalogSnapshot,
} from "../domain/catalog/model.js";
import {
  ReadonlyBytes,
  canonicalJson,
  compareDiagnostics,
  compareUtf8,
  componentRef,
  harnessTargetId,
  relativePosixPath,
  sha256,
  type ComponentRef,
  type Diagnostic,
  type HarnessTargetId,
  type Sha256Digest,
} from "../domain/shared/types.js";
import { parseSafeYaml } from "../shared/safe-yaml.js";

export interface DesiredSelectionDraft {
  readonly ref: string;
  readonly inputs?: Readonly<Record<string, unknown>>;
}

export type DesiredStateInput =
  | { readonly kind: "yaml"; readonly source: string }
  | {
      readonly kind: "draft";
      readonly targets: readonly string[];
      readonly selections: readonly DesiredSelectionDraft[];
    };

export interface DesiredSelection {
  readonly ref: ComponentRef;
  readonly inputs: Readonly<Record<string, readonly string[]>>;
}

export interface DesiredState {
  readonly schema: "railguard/project/v1";
  readonly targets: readonly HarnessTargetId[];
  readonly selections: readonly DesiredSelection[];
}

export type DesiredStateResult =
  | {
      readonly kind: "ready";
      readonly state: DesiredState;
      readonly bytes: ReadonlyBytes;
      readonly digest: Sha256Digest;
      readonly diagnostics: readonly [];
    }
  | {
      readonly kind: "invalid";
      readonly diagnostics: readonly [Diagnostic, ...Diagnostic[]];
    };

interface ProjectEnvelope {
  readonly schema: "railguard/project/v1";
  readonly targets: readonly string[];
  readonly selections: readonly DesiredSelectionDraft[];
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateEnvelope = ajv.compile<ProjectEnvelope>(projectStateSchema);
const projectPath = relativePosixPath(".railguard/project.yaml");

export class DesiredStateModule {
  public evaluate(input: DesiredStateInput, catalog: CatalogSnapshot): DesiredStateResult {
    const decoded = decodeInput(input);
    if (decoded.kind === "invalid") return decoded;

    if (!validateEnvelope(decoded.value) || decoded.value.schema !== "railguard/project/v1") {
      return invalid([schemaDiagnostic(validateEnvelope.errors)]);
    }

    const diagnostics: Diagnostic[] = [];
    const targets = normalizeTargets(decoded.value.targets, diagnostics);
    const components = new Map(catalog.components.map((entry) => [entry.ref, entry]));
    const seenRefs = new Set<string>();
    const selections: DesiredSelection[] = [];

    for (const candidate of decoded.value.selections) {
      let ref: ComponentRef;
      try {
        ref = componentRef(candidate.ref);
      } catch {
        diagnostics.push(projectDiagnostic("project-state.ref-invalid", `Invalid component reference: ${candidate.ref}`, [candidate.ref]));
        continue;
      }
      if (seenRefs.has(ref)) {
        diagnostics.push(projectDiagnostic("project-state.selection-duplicate", `Component ${ref} is selected more than once.`, [ref], [ref]));
        continue;
      }
      seenRefs.add(ref);
      const component = components.get(ref);
      if (component === undefined) {
        diagnostics.push(projectDiagnostic("project-state.component-unknown", `Component ${ref} is not present in this catalog.`, [ref], [ref]));
        continue;
      }
      const definitions = component.kind === "verification-profile" ? component.inputs : [];
      const normalizedInputs = normalizeInputs(ref, candidate.inputs ?? {}, definitions, diagnostics);
      selections.push(Object.freeze({ ref, inputs: normalizedInputs }));
    }

    if (diagnostics.length > 0) return invalid(diagnostics);
    selections.sort((left, right) => compareUtf8(left.ref, right.ref));
    const state: DesiredState = Object.freeze({
      schema: "railguard/project/v1",
      targets: Object.freeze(targets),
      selections: Object.freeze(selections),
    });
    const bytes = new ReadonlyBytes(Buffer.from(render(state), "utf8"));
    return Object.freeze({
      kind: "ready",
      state,
      bytes,
      digest: sha256(canonicalJson(state)),
      diagnostics: Object.freeze([]) as readonly [],
    });
  }
}

function decodeInput(input: DesiredStateInput):
  | { readonly kind: "ready"; readonly value: unknown }
  | { readonly kind: "invalid"; readonly diagnostics: readonly [Diagnostic, ...Diagnostic[]] } {
  if (input.kind === "draft") {
    return {
      kind: "ready",
      value: { schema: "railguard/project/v1", targets: input.targets, selections: input.selections },
    };
  }
  const parsed = parseSafeYaml(input.source);
  return parsed.kind === "ready"
    ? { kind: "ready", value: parsed.value }
    : invalid([projectDiagnostic("project-state.yaml-invalid", "Desired state YAML is unsafe or malformed.", parsed.errors)]);
}

function normalizeTargets(values: readonly string[], diagnostics: Diagnostic[]): HarnessTargetId[] {
  const seen = new Set<string>();
  const targets: HarnessTargetId[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      diagnostics.push(projectDiagnostic("project-state.target-duplicate", `Target ${value} is declared more than once.`, [value]));
      continue;
    }
    seen.add(value);
    try {
      targets.push(harnessTargetId(value));
    } catch {
      diagnostics.push(projectDiagnostic("project-state.target-invalid", `Invalid harness target: ${value}`, [value]));
    }
  }
  return targets.sort(compareUtf8);
}

function normalizeInputs(
  ref: ComponentRef,
  values: Readonly<Record<string, unknown>>,
  definitions: readonly CatalogInputDefinition[],
  diagnostics: Diagnostic[],
): Readonly<Record<string, readonly string[]>> {
  const known = new Map(definitions.map((definition) => [definition.id, definition]));
  const entries: [string, readonly string[]][] = [];
  for (const [id, value] of Object.entries(values).sort(([left], [right]) => compareUtf8(left, right))) {
    const definition = known.get(id);
    if (definition === undefined) {
      diagnostics.push(projectDiagnostic("project-state.input-unknown", `${ref} does not define input ${id}.`, [id], [ref]));
      continue;
    }
    if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string")) {
      diagnostics.push(projectDiagnostic("project-state.input-type", `Input ${id} must be a non-empty list of strings.`, [id], [ref]));
      continue;
    }
    const strings = value as string[];
    if (new Set(strings).size !== strings.length) {
      diagnostics.push(projectDiagnostic("project-state.input-duplicate", `Input ${id} contains duplicate values.`, strings, [ref]));
      continue;
    }
    const pattern = new RegExp(definition.itemPattern, "u");
    const invalidValues = strings.filter((entry) => !pattern.test(entry));
    if (invalidValues.length > 0) {
      diagnostics.push(projectDiagnostic("project-state.input-value", `Input ${id} contains values rejected by its catalog contract.`, invalidValues, [ref]));
      continue;
    }
    entries.push([id, Object.freeze([...strings].sort(compareUtf8))]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

function render(state: DesiredState): string {
  const lines = ["schema: railguard/project/v1", "targets:"];
  for (const target of state.targets) lines.push(`  - ${target}`);
  if (state.targets.length === 0) lines[1] = "targets: []";
  lines.push("selections:");
  for (const selection of state.selections) {
    lines.push(`  - ref: ${selection.ref}`);
    const inputs = Object.entries(selection.inputs);
    if (inputs.length > 0) {
      lines.push("    inputs:");
      for (const [id, values] of inputs) {
        lines.push(`      ${id}:`);
        for (const value of values) lines.push(`        - ${JSON.stringify(value)}`);
      }
    }
  }
  if (state.selections.length === 0) lines[lines.length - 1] = "selections: []";
  return `${lines.join("\n")}\n`;
}

function schemaDiagnostic(errors: readonly ErrorObject[] | null | undefined): Diagnostic {
  const evidence = (errors ?? []).map((error) => `${error.instancePath || "/"}:${error.keyword}:${error.message ?? "invalid"}`);
  return projectDiagnostic("project-state.schema-invalid", "Desired state does not match railguard/project/v1.", evidence);
}

function projectDiagnostic(code: string, message: string, evidence: readonly string[], subjects: readonly ComponentRef[] = []): Diagnostic {
  return Object.freeze({
    code,
    severity: "failed",
    phase: "project-state",
    subjects: Object.freeze([...subjects]),
    location: Object.freeze({ path: projectPath }),
    message,
    evidence: Object.freeze([...evidence].sort(compareUtf8)),
    impact: "The desired project state cannot be reconciled.",
    action: "Correct the desired selection or input and review the plan again.",
  });
}

function invalid(diagnostics: readonly Diagnostic[]): DesiredStateResult & { readonly kind: "invalid" } {
  const sorted = [...diagnostics].sort(compareDiagnostics);
  const first = sorted[0];
  if (first === undefined) throw new Error("Invalid desired state requires a diagnostic");
  return Object.freeze({
    kind: "invalid",
    diagnostics: Object.freeze([first, ...sorted.slice(1)]) as readonly [Diagnostic, ...Diagnostic[]],
  });
}

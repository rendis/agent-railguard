import { createHash } from "node:crypto";
import { posix } from "node:path";

declare const brand: unique symbol;

type Branded<T, Name extends string> = T & { readonly [brand]: Name };

export type ComponentRef = Branded<string, "ComponentRef">;
export type SemVer = Branded<string, "SemVer">;
export type LanguageId = Branded<string, "LanguageId">;
export type ProjectUnitId = Branded<string, "ProjectUnitId">;
export type CapabilityId = Branded<string, "CapabilityId">;
export type HarnessTargetId = Branded<string, "HarnessTargetId">;
export type RelativePosixPath = Branded<string, "RelativePosixPath">;
export type Sha256Digest = Branded<`sha256:${string}`, "Sha256Digest">;

const componentRefPattern =
  /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*$/;
const semVerPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const languageIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const capabilityIdPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const targetIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export function componentRef(value: string): ComponentRef {
  if (!componentRefPattern.test(value)) {
    throw new TypeError(`Invalid component reference: ${value}`);
  }
  return value as ComponentRef;
}

export function semVer(value: string): SemVer {
  if (!semVerPattern.test(value)) {
    throw new TypeError(`Invalid SemVer: ${value}`);
  }
  return value as SemVer;
}

export function languageId(value: string): LanguageId {
  if (!languageIdPattern.test(value)) {
    throw new TypeError(`Invalid language ID: ${value}`);
  }
  return value as LanguageId;
}

export function projectUnitId(value: string): ProjectUnitId {
  if (value.length === 0 || value.includes("\0")) {
    throw new TypeError("Project unit ID must be non-empty and NUL-free");
  }
  return value as ProjectUnitId;
}

export function capabilityId(value: string): CapabilityId {
  if (!capabilityIdPattern.test(value)) {
    throw new TypeError(`Invalid capability ID: ${value}`);
  }
  return value as CapabilityId;
}

export function harnessTargetId(value: string): HarnessTargetId {
  if (!targetIdPattern.test(value)) {
    throw new TypeError(`Invalid harness target ID: ${value}`);
  }
  return value as HarnessTargetId;
}

export function relativePosixPath(
  value: string,
  options: { readonly allowRoot?: boolean } = {},
): RelativePosixPath {
  if (value === "." && options.allowRoot === true) {
    return value as RelativePosixPath;
  }
  if (
    value.length === 0 ||
    value === "." ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    value.includes("\\") ||
    value.includes("\0") ||
    posix.normalize(value) !== value ||
    value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new TypeError(`Invalid relative POSIX path: ${value}`);
  }
  return value as RelativePosixPath;
}


export function sha256(value: string | Uint8Array): Sha256Digest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}` as Sha256Digest;
}

export function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function sortedUnique<T extends string>(values: Iterable<T>): readonly T[] {
  return Object.freeze([...new Set(values)].sort(compareUtf8));
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON does not support non-finite numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Readonly<Record<string, unknown>>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareUtf8(left, right));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  throw new TypeError(`Unsupported canonical JSON value: ${typeof value}`);
}

export class ReadonlyBytes {
  readonly #value: Uint8Array;

  public constructor(value: Uint8Array) {
    this.#value = new Uint8Array(value);
  }

  public get byteLength(): number {
    return this.#value.byteLength;
  }

  public copy(): Uint8Array {
    return new Uint8Array(this.#value);
  }

  public digest(): Sha256Digest {
    return sha256(this.#value);
  }

  public equals(other: ReadonlyBytes): boolean {
    return Buffer.from(this.#value).equals(Buffer.from(other.#value));
  }

  public toString(encoding: BufferEncoding = "utf8"): string {
    return Buffer.from(this.#value).toString(encoding);
  }
}

export type DiagnosticSeverity = "info" | "warning" | "blocked" | "failed";

export interface Diagnostic {
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly phase:
    | "source"
    | "parse"
    | "schema"
    | "skill"
    | "payload"
    | "catalog"
    | "integrity"
    | "inventory"
    | "repository-gate"
    | "assessment"
    | "recommendation"
    | "resolution"
    | "project-state"
    | "observation"
    | "reconciliation"
    | "harness"
    | "planning"
    | "apply"
    | "verification";
  readonly subjects: readonly ComponentRef[];
  readonly location: {
    readonly path: RelativePosixPath;
    readonly pointer?: string;
  } | null;
  readonly message: string;
  readonly evidence: readonly string[];
  readonly impact: string;
  readonly action: string | null;
}

export function compareDiagnostics(left: Diagnostic, right: Diagnostic): number {
  const leftLocation = left.location === null ? "" : left.location.path;
  const rightLocation = right.location === null ? "" : right.location.path;
  const leftKey = [left.phase, left.code, left.subjects.join("\0"), leftLocation, left.location?.pointer ?? ""].join("\0");
  const rightKey = [right.phase, right.code, right.subjects.join("\0"), rightLocation, right.location?.pointer ?? ""].join("\0");
  return compareUtf8(leftKey, rightKey);
}

import { FilesystemCatalog } from "../filesystem-catalog.js";
import type {
  Catalog,
  CatalogLoadResult,
} from "../../domain/catalog/model.js";
import {
  compareDiagnostics,
  relativePosixPath,
  type Diagnostic,
  type LanguageId,
} from "../../domain/shared/types.js";
import type { ContentSource, ResolvedContentSource } from "./content-source.js";

export interface SourcedCatalogOptions {
  readonly source: ContentSource;
  readonly supportedLanguages: readonly LanguageId[];
}

export class SourcedCatalog implements Catalog {
  readonly #source: ContentSource;
  readonly #supportedLanguages: readonly LanguageId[];
  #ready: Extract<CatalogLoadResult, { readonly kind: "ready" }> | null = null;
  #inFlight: Promise<CatalogLoadResult> | null = null;

  public constructor(options: SourcedCatalogOptions) {
    this.#source = options.source;
    this.#supportedLanguages = Object.freeze([...options.supportedLanguages]);
  }

  public async load(): Promise<CatalogLoadResult> {
    if (this.#ready !== null) return this.#ready;
    if (this.#inFlight !== null) return await this.#inFlight;
    this.#inFlight = this.#load();
    try {
      const result = await this.#inFlight;
      if (result.kind === "ready") this.#ready = result;
      return result;
    } finally {
      this.#inFlight = null;
    }
  }

  async #load(): Promise<CatalogLoadResult> {
    let source: ResolvedContentSource;
    try {
      source = await this.#source.resolve();
    } catch (error) {
      return invalidSource(error);
    }
    const result = await new FilesystemCatalog({
      catalogFile: source.catalogFile,
      supportedLanguages: this.#supportedLanguages,
    }).load();
    if (result.kind === "invalid") return result;
    if (source.revision !== null && source.revision !== result.catalog.revision) {
      const diagnostics: readonly [Diagnostic] = Object.freeze([
        sourceRevisionDiagnostic(source, result.catalog.revision),
      ]);
      return Object.freeze({
        kind: "invalid" as const,
        diagnostics,
      });
    }
    const diagnostics = Object.freeze([
      ...result.diagnostics,
      sourceDiagnostic(source),
    ].sort(compareDiagnostics));
    return Object.freeze({ kind: "ready" as const, catalog: result.catalog, diagnostics });
  }
}

function invalidSource(error: unknown): Extract<CatalogLoadResult, { readonly kind: "invalid" }> {
  const diagnostic: Diagnostic = Object.freeze({
    code: "catalog.source.unavailable",
    severity: "blocked",
    phase: "source",
    subjects: Object.freeze([]),
    location: null,
    message: `Project content source is unavailable: ${errorMessage(error)}`,
    evidence: Object.freeze([]),
    impact: "The current catalog cannot be established, so no project content was planned or changed.",
    action: "Restore the configured content channel or run with --source <local-checkout>.",
  });
  const diagnostics: readonly [Diagnostic] = Object.freeze([diagnostic]);
  return Object.freeze({ kind: "invalid" as const, diagnostics });
}

function sourceDiagnostic(source: ResolvedContentSource): Diagnostic {
  return Object.freeze({
    code: `catalog.source.${source.kind}`,
    severity: "info",
    phase: "source",
    subjects: Object.freeze([]),
    location: null,
    message: `${source.kind === "local" ? "Local" : "Remote"} project content loaded from ${source.location}`,
    evidence: Object.freeze([source.identity]),
    impact: "This verified source is authoritative for the current process.",
    action: null,
  });
}

function sourceRevisionDiagnostic(source: ResolvedContentSource, catalogRevision: string): Diagnostic {
  return Object.freeze({
    code: "catalog.source.revision-mismatch",
    severity: "blocked",
    phase: "integrity",
    subjects: Object.freeze([]),
    location: { path: relativePosixPath("ai-harness.yaml"), pointer: "/version" },
    message: `Content manifest revision ${source.revision ?? "unknown"} does not match catalog revision ${catalogRevision}`,
    evidence: Object.freeze([source.identity]),
    impact: "The remote snapshot identity is inconsistent and cannot be installed.",
    action: "Republish the content manifest and its verified file inventory from one source revision.",
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

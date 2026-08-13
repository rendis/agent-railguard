import { readFile } from "node:fs/promises";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import contentManifestSchema from "../../../schemas/content-manifest.v1.schema.json" with {
  type: "json",
};
import {
  compareUtf8,
  relativePosixPath,
  sha256,
  sha256Digest,
  type RelativePosixPath,
  type Sha256Digest,
} from "../../domain/shared/types.js";

const maximumManifestBytes = 256 * 1024;
const maximumContentBytes = 16 * 1024 * 1024;

export interface ContentManifestFile {
  readonly path: string;
  readonly mode: "100644" | "100755";
  readonly sha256: Sha256Digest | `sha256:${string}`;
  readonly size: number;
}

export interface ContentManifest {
  readonly schema: "ai-harness/content-manifest/v1";
  readonly revision: string;
  readonly source: {
    readonly commit: string;
    readonly tree: string;
    readonly input_digest: Sha256Digest | `sha256:${string}`;
  };
  readonly files: readonly ContentManifestFile[];
  readonly authentication: {
    readonly kind: "external-https-channel";
    readonly manifest_authentication: string;
  };
}

export interface ResolvedContentFile {
  readonly path: RelativePosixPath;
  readonly mode: "100644" | "100755";
  readonly sha256: Sha256Digest;
  readonly size: number;
  readonly url: URL;
}

export interface ResolvedContentManifest {
  readonly manifestUrl: URL;
  readonly digest: Sha256Digest;
  readonly manifest: ContentManifest;
  readonly files: readonly ResolvedContentFile[];
}

export interface ContentTransport {
  get(url: URL, signal?: AbortSignal): Promise<Uint8Array>;
}

export interface ContentManifestClientOptions {
  readonly manifestUrl: string | URL;
  readonly transport?: ContentTransport;
  readonly timeoutMs?: number;
  readonly allowFileUrl?: boolean;
  readonly allowInsecureLoopback?: boolean;
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateManifest = ajv.compile<ContentManifest>(contentManifestSchema);

export class ContentManifestValidationError extends TypeError {
  public constructor(readonly issues: readonly string[]) {
    super(`Content manifest failed validation: ${issues.join("; ")}`);
    this.name = "ContentManifestValidationError";
  }
}

export class ContentArtifactIntegrityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ContentArtifactIntegrityError";
  }
}

export class FetchContentTransport implements ContentTransport {
  public async get(url: URL, signal?: AbortSignal): Promise<Uint8Array> {
    if (url.protocol === "file:") {
      return new Uint8Array(await readFile(url));
    }
    const response = await fetch(url, {
      ...(signal === undefined ? {} : { signal }),
      redirect: "error",
      headers: { accept: "application/octet-stream, application/json" },
    });
    if (!response.ok) {
      throw new Error(`Content channel returned HTTP ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}

export class ContentManifestClient {
  readonly #manifestUrl: URL;
  readonly #transport: ContentTransport;
  readonly #timeoutMs: number;
  readonly #allowFileUrl: boolean;
  readonly #allowInsecureLoopback: boolean;

  public constructor(options: ContentManifestClientOptions) {
    this.#manifestUrl = new URL(options.manifestUrl);
    this.#transport = options.transport ?? new FetchContentTransport();
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    this.#allowFileUrl = options.allowFileUrl ?? false;
    this.#allowInsecureLoopback = options.allowInsecureLoopback ?? false;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 60_000) {
      throw new TypeError("Content timeout must be an integer between 1 and 60000 milliseconds");
    }
    this.#assertChannelUrl(this.#manifestUrl);
  }

  public async fetchManifest(signal?: AbortSignal): Promise<ResolvedContentManifest> {
    const bytes = await this.#transport.get(
      this.#manifestUrl,
      timedSignal(signal, this.#timeoutMs),
    );
    if (bytes.byteLength > maximumManifestBytes) {
      throw new ContentManifestValidationError([
        `document exceeds ${maximumManifestBytes} bytes`,
      ]);
    }
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
    } catch (error) {
      throw new ContentManifestValidationError([errorMessage(error)]);
    }
    if (!validateManifest(value)) {
      throw new ContentManifestValidationError(validationIssues(validateManifest.errors));
    }
    const manifest = deepFreeze(value);
    const files = this.#resolveFiles(manifest);
    return Object.freeze({
      manifestUrl: new URL(this.#manifestUrl),
      digest: sha256(bytes),
      manifest,
      files,
    });
  }

  public async fetchFile(
    file: ResolvedContentFile,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const bytes = await this.#transport.get(file.url, timedSignal(signal, this.#timeoutMs));
    if (bytes.byteLength !== file.size) {
      throw new ContentArtifactIntegrityError(
        `Content file ${file.path} size mismatch: expected ${file.size}, received ${bytes.byteLength}`,
      );
    }
    const actualDigest = sha256(bytes);
    if (actualDigest !== file.sha256) {
      throw new ContentArtifactIntegrityError(
        `Content file ${file.path} digest mismatch: expected ${file.sha256}, received ${actualDigest}`,
      );
    }
    return new Uint8Array(bytes);
  }

  #resolveFiles(manifest: ContentManifest): readonly ResolvedContentFile[] {
    const issues: string[] = [];
    const seen = new Set<string>();
    const resolved: ResolvedContentFile[] = [];
    let totalBytes = 0;
    for (const file of manifest.files) {
      let path: RelativePosixPath;
      try {
        path = relativePosixPath(file.path);
      } catch {
        issues.push(`file path must be a relative portable POSIX path: ${file.path}`);
        continue;
      }
      if (seen.has(path)) {
        issues.push(`duplicate file path: ${path}`);
        continue;
      }
      seen.add(path);
      totalBytes += file.size;
      const url = new URL(`content/${path}`, this.#manifestUrl);
      this.#assertChannelUrl(url);
      const channelBase = new URL(".", this.#manifestUrl);
      if (url.origin !== channelBase.origin || !url.pathname.startsWith(channelBase.pathname)) {
        issues.push(`content URL escapes manifest channel: ${path}`);
        continue;
      }
      resolved.push(Object.freeze({
        path,
        mode: file.mode,
        sha256: sha256Digest(file.sha256),
        size: file.size,
        url,
      }));
    }
    if (manifest.files.filter((file) => file.path === "ai-harness.yaml").length !== 1) {
      issues.push("manifest must contain exactly one ai-harness.yaml");
    }
    if (totalBytes > maximumContentBytes) {
      issues.push(`content exceeds ${maximumContentBytes} total bytes`);
    }
    const sorted = [...resolved].sort((left, right) => compareUtf8(left.path, right.path));
    if (
      issues.length === 0 &&
      sorted.some((entry, index) => entry.path !== resolved[index]?.path)
    ) {
      issues.push("manifest files must be ordered by UTF-8 path");
    }
    if (issues.length > 0) {
      throw new ContentManifestValidationError(Object.freeze(issues.sort(compareUtf8)));
    }
    return Object.freeze(resolved);
  }

  #assertChannelUrl(url: URL): void {
    if (url.username.length > 0 || url.password.length > 0) {
      throw new TypeError("Content channel URLs must not contain credentials");
    }
    if (url.protocol === "https:") return;
    if (url.protocol === "file:" && this.#allowFileUrl) return;
    if (
      url.protocol === "http:" &&
      this.#allowInsecureLoopback &&
      (url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost")
    ) {
      return;
    }
    throw new TypeError("Content channel must use HTTPS");
  }
}

function timedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

function validationIssues(
  errors: readonly ErrorObject[] | null | undefined,
): readonly string[] {
  return Object.freeze(
    (errors ?? [])
      .map((error) => `${error.instancePath || "/"} ${error.message ?? error.keyword}`)
      .sort(compareUtf8),
  );
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Readonly<Record<string, unknown>>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

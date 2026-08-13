import { readFile } from "node:fs/promises";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import releaseManifestSchema from "../../schemas/release-manifest.v1.schema.json" with { type: "json" };
import { compareUtf8, sha256, type Sha256Digest } from "../domain/shared/types.js";

const maximumManifestBytes = 256 * 1024;

export interface ReleaseFile {
  readonly path: string;
  readonly sha256: Sha256Digest | `sha256:${string}`;
  readonly size: number;
}

export interface ReleaseManifest {
  readonly schema: "ai-harness/release-manifest/v1";
  readonly channel: string;
  readonly source: {
    readonly commit: string;
    readonly tree: string;
    readonly input_digest: Sha256Digest | `sha256:${string}`;
  };
  readonly release: {
    readonly name: "@example/ai-harness";
    readonly version: string;
    readonly runtime: {
      readonly node: ">=24.19.0 <25.0.0";
      readonly pnpm: ">=11.21.0 <12.0.0";
    };
    readonly artifact: ReleaseFile;
    readonly sbom: ReleaseFile;
    readonly notices: ReleaseFile;
    readonly notes: readonly string[];
  };
  readonly authentication: {
    readonly kind: "external-https-channel";
    readonly manifest_authentication: string;
  };
  readonly content: {
    readonly manifest: {
      readonly path: string;
    };
  };
}

export interface ResolvedRelease {
  readonly manifestUrl: URL;
  readonly artifactUrl: URL;
  readonly contentManifestUrl: URL;
  readonly manifest: ReleaseManifest;
}

export interface ReleaseTransport {
  get(url: URL, signal?: AbortSignal): Promise<Uint8Array>;
}

export interface ReleaseClientOptions {
  readonly manifestUrl: string | URL;
  readonly transport?: ReleaseTransport;
  readonly timeoutMs?: number;
  readonly allowFileUrl?: boolean;
  readonly allowInsecureLoopback?: boolean;
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateManifest = ajv.compile<ReleaseManifest>(releaseManifestSchema);

export class ReleaseManifestValidationError extends TypeError {
  public constructor(readonly issues: readonly string[]) {
    super(`Release manifest failed validation: ${issues.join("; ")}`);
    this.name = "ReleaseManifestValidationError";
  }
}

export class ArtifactIntegrityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ArtifactIntegrityError";
  }
}

export class FetchReleaseTransport implements ReleaseTransport {
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
      throw new Error(`Release channel returned HTTP ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}

export class ReleaseClient {
  readonly #manifestUrl: URL;
  readonly #transport: ReleaseTransport;
  readonly #timeoutMs: number;
  readonly #allowFileUrl: boolean;
  readonly #allowInsecureLoopback: boolean;

  public constructor(options: ReleaseClientOptions) {
    this.#manifestUrl = new URL(options.manifestUrl);
    this.#transport = options.transport ?? new FetchReleaseTransport();
    this.#timeoutMs = options.timeoutMs ?? 3_000;
    this.#allowFileUrl = options.allowFileUrl ?? false;
    this.#allowInsecureLoopback = options.allowInsecureLoopback ?? false;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 60_000) {
      throw new TypeError("Release timeout must be an integer between 1 and 60000 milliseconds");
    }
    this.#assertChannelUrl(this.#manifestUrl);
  }

  public async fetchManifest(signal?: AbortSignal): Promise<ResolvedRelease> {
    const bytes = await this.#transport.get(this.#manifestUrl, timedSignal(signal, this.#timeoutMs));
    if (bytes.byteLength > maximumManifestBytes) {
      throw new ReleaseManifestValidationError([
        `document exceeds ${maximumManifestBytes} bytes`,
      ]);
    }
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
    } catch (error) {
      throw new ReleaseManifestValidationError([errorMessage(error)]);
    }
    if (!validateManifest(value)) {
      throw new ReleaseManifestValidationError(validationIssues(validateManifest.errors));
    }
    const manifest = deepFreeze(value);
    const artifactUrl = new URL(manifest.release.artifact.path, this.#manifestUrl);
    const contentManifestUrl = new URL(manifest.content.manifest.path, this.#manifestUrl);
    this.#assertChannelUrl(artifactUrl);
    this.#assertChannelUrl(contentManifestUrl);
    const channelBase = new URL(".", this.#manifestUrl);
    if (
      artifactUrl.origin !== channelBase.origin ||
      !artifactUrl.pathname.startsWith(channelBase.pathname) ||
      contentManifestUrl.origin !== channelBase.origin ||
      !contentManifestUrl.pathname.startsWith(channelBase.pathname)
    ) {
      throw new ReleaseManifestValidationError([
        "release artifact and content manifest must remain inside the manifest channel directory",
      ]);
    }
    return Object.freeze({
      manifestUrl: new URL(this.#manifestUrl),
      artifactUrl,
      contentManifestUrl,
      manifest,
    });
  }

  public async fetchArtifact(
    release: ResolvedRelease,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const bytes = await this.#transport.get(
      release.artifactUrl,
      timedSignal(signal, this.#timeoutMs),
    );
    const expected = release.manifest.release.artifact;
    if (bytes.byteLength !== expected.size) {
      throw new ArtifactIntegrityError(
        `Release artifact size mismatch: expected ${expected.size}, received ${bytes.byteLength}`,
      );
    }
    const actualDigest = sha256(bytes);
    if (actualDigest !== expected.sha256) {
      throw new ArtifactIntegrityError(
        `Release artifact digest mismatch: expected ${expected.sha256}, received ${actualDigest}`,
      );
    }
    return new Uint8Array(bytes);
  }

  #assertChannelUrl(url: URL): void {
    if (url.username.length > 0 || url.password.length > 0) {
      throw new TypeError("Release channel URLs must not contain credentials");
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
    throw new TypeError("Release channel must use HTTPS");
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

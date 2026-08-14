import type { DiagnosticView } from "../interaction/model.js";
import type { ResolvedRelease } from "./release-client.js";

export interface VerifiedReleaseSource {
  fetchManifest(signal?: AbortSignal): Promise<ResolvedRelease>;
  fetchArtifact(release: ResolvedRelease, signal?: AbortSignal): Promise<Uint8Array>;
}

export interface UpdateInstallationRequest {
  readonly currentVersion: string;
  readonly release: ResolvedRelease;
}

export interface UpdateInstallationResult {
  readonly status: "applied" | "rolled-back";
  readonly previousVersion: string;
  readonly installedVersion: string | null;
}

export interface UpdateInstaller {
  install(
    request: UpdateInstallationRequest,
    artifact: Uint8Array,
    signal?: AbortSignal,
  ): Promise<UpdateInstallationResult>;
}

export interface UpdateResult {
  readonly status: "current" | "available" | "unknown" | "applied" | "rolled-back" | "failed";
  readonly currentVersion: string;
  readonly latestVersion: string | null;
  readonly release: ResolvedRelease | null;
  readonly diagnostics: readonly DiagnosticView[];
}

export class UpdateService {
  public constructor(
    readonly source: VerifiedReleaseSource | null,
    readonly installer: UpdateInstaller,
  ) {}

  public async check(
    currentVersion: string,
    signal?: AbortSignal,
  ): Promise<UpdateResult> {
    parseStableSemVer(currentVersion);
    if (this.source === null) {
      return result("unknown", currentVersion, null, null, [
        diagnostic(
          "update.channel-unconfigured",
          "warning",
          "No corporate release manifest URL is configured.",
          "Update availability remains unknown; project operations are unaffected.",
          "Set AI_HARNESS_RELEASE_MANIFEST_URL to the authenticated internal channel.",
        ),
      ]);
    }
    try {
      const release = await this.source.fetchManifest(signal);
      const latest = release.manifest.release.version;
      parseStableSemVer(latest);
      const comparison = compareStableSemVer(latest, currentVersion);
      return result(
        comparison > 0 ? "available" : "current",
        currentVersion,
        latest,
        release,
        comparison < 0
          ? [diagnostic(
              "update.channel-older",
              "warning",
              "The configured channel advertises a version older than this CLI.",
              "The installed CLI was not changed.",
              "Verify the selected corporate release channel.",
            )]
          : [],
      );
    } catch (error) {
      return result("unknown", currentVersion, null, null, [
        diagnostic(
          "update.channel-unavailable",
          "warning",
          `The corporate release channel could not be verified: ${errorMessage(error)}`,
          "Update availability remains unknown; project operations are unaffected.",
          "Check network access and channel authentication, then retry update --check.",
        ),
      ]);
    }
  }

  public async apply(
    currentVersion: string,
    signal?: AbortSignal,
  ): Promise<UpdateResult> {
    const checked = await this.check(currentVersion, signal);
    if (checked.status === "current") return checked;
    if (checked.status !== "available" || checked.release === null || this.source === null) {
      return result("failed", currentVersion, checked.latestVersion, checked.release, [
        ...checked.diagnostics,
        diagnostic(
          "update.release-unavailable",
          "blocked",
          "No newer verified release is available to install.",
          "The installed CLI was not changed.",
          "Resolve the channel diagnostic and run update --check first.",
        ),
      ]);
    }
    try {
      const artifact = await this.source.fetchArtifact(checked.release, signal);
      const installation = await this.installer.install(
        { currentVersion, release: checked.release },
        artifact,
        signal,
      );
      if (installation.status === "rolled-back") {
        return result("rolled-back", currentVersion, checked.latestVersion, checked.release, [
          diagnostic(
            "update.install-rolled-back",
            "blocked",
            "The candidate did not pass installation verification and the previous CLI was restored.",
            "The active CLI remains on the previous version.",
            "Inspect the installer evidence before retrying the update.",
          ),
        ]);
      }
      if (installation.installedVersion !== checked.latestVersion) {
        throw new Error(
          `Installed version ${installation.installedVersion ?? "unknown"} does not match ${checked.latestVersion}`,
        );
      }
      return result("applied", currentVersion, checked.latestVersion, checked.release, []);
    } catch (error) {
      return result("failed", currentVersion, checked.latestVersion, checked.release, [
        diagnostic(
          "update.install-failed",
          "failed",
          `The verified candidate could not be installed: ${errorMessage(error)}`,
          "The update did not produce a certified new CLI.",
          "Confirm pnpm global readiness and retry; the installer preserves or restores the previous version.",
        ),
      ]);
    }
  }
}

function result(
  status: UpdateResult["status"],
  currentVersion: string,
  latestVersion: string | null,
  release: ResolvedRelease | null,
  diagnostics: readonly DiagnosticView[],
): UpdateResult {
  return Object.freeze({
    status,
    currentVersion,
    latestVersion,
    release,
    diagnostics: Object.freeze([...diagnostics]),
  });
}

function diagnostic(
  code: string,
  severity: DiagnosticView["severity"],
  message: string,
  impact: string,
  action: string,
): DiagnosticView {
  return Object.freeze({
    code,
    severity,
    location: null,
    message,
    evidence: Object.freeze([]),
    impact,
    action,
  });
}

function parseStableSemVer(value: string): readonly [number, number, number] {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (match === null) throw new TypeError(`Expected stable SemVer, received: ${value}`);
  const parts = match.slice(1).map(Number) as [number, number, number];
  if (parts.some((part) => !Number.isSafeInteger(part))) {
    throw new TypeError(`SemVer component exceeds safe integer range: ${value}`);
  }
  return Object.freeze(parts);
}

function compareStableSemVer(left: string, right: string): number {
  const leftParts = parseStableSemVer(left);
  const rightParts = parseStableSemVer(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

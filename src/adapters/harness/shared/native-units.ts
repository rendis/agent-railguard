import { posix } from "node:path";
import type { ProjectionIdentity, ProjectedUnit } from "../../../domain/projection/model.js";
import {
  ReadonlyBytes,
  compareUtf8,
  relativePosixPath,
  semVer,
  sha256,
  type CapabilityId,
  type ComponentRef,
  type HarnessTargetId,
} from "../../../domain/shared/types.js";

export function nativeProjectionIdentity(
  target: HarnessTargetId,
  capabilities: readonly CapabilityId[],
): ProjectionIdentity {
  return Object.freeze({
    target,
    adapter: Object.freeze({ id: target, version: semVer("0.1.0") }),
    capabilities,
  });
}

export function nativeFileUnit(input: {
  readonly target: HarnessTargetId;
  readonly role: "agent" | "mcp" | "hook";
  readonly path: string;
  readonly text: string;
  readonly sources: readonly ComponentRef[];
  readonly owner?: string;
  readonly mode?: number;
}): ProjectedUnit {
  const path = relativePosixPath(input.path);
  const directory = posix.dirname(path);
  const scopeRoot = relativePosixPath(directory, { allowRoot: directory === "." });
  const suffix = sha256(path).slice("sha256:".length, "sha256:".length + 12);
  return Object.freeze({
    kind: "artifact",
    ownershipId: `${input.target}.${input.role}.file.${suffix}`,
    sources: Object.freeze([...input.sources].sort(compareUtf8)),
    intent: Object.freeze({
      kind: "file",
      owner: input.owner ?? `${input.target}:${input.role}`,
      scopeRoot,
      path,
      bytes: new ReadonlyBytes(new TextEncoder().encode(input.text)),
      mode: input.mode ?? 0o644,
    }),
  });
}

export function nativeSectionUnit(input: {
  readonly target: HarnessTargetId;
  readonly path: string;
  readonly sectionId: string;
  readonly body: string;
  readonly source: ComponentRef;
}): ProjectedUnit {
  return Object.freeze({
    kind: "artifact",
    ownershipId: `${input.target}.mcp.section.${input.sectionId}`,
    sources: Object.freeze([input.source]),
    intent: Object.freeze({
      kind: "managed-section",
      owner: input.source,
      path: relativePosixPath(input.path),
      sectionId: input.sectionId,
      body: input.body,
      mode: 0o644,
      markerStyle: "hash",
    }),
  });
}

/** A harness configuration entry owned inside a shared JSON file such as `.claude/settings.json`. */
export function nativeJsonMemberUnit(input: {
  readonly target: HarnessTargetId;
  readonly role: "hook";
  readonly path: string;
  readonly pointer: readonly string[];
  readonly value: unknown;
  readonly sources: readonly ComponentRef[];
}): ProjectedUnit {
  const suffix = sha256(`${input.path}\0${input.pointer.join("\0")}`).slice("sha256:".length, "sha256:".length + 12);
  return Object.freeze({
    kind: "artifact",
    ownershipId: `${input.target}.${input.role}.json.${suffix}`,
    sources: Object.freeze([...input.sources].sort(compareUtf8)),
    intent: Object.freeze({
      kind: "json-member" as const,
      owner: `${input.target}:${input.role}`,
      path: relativePosixPath(input.path),
      pointer: Object.freeze([...input.pointer]),
      value: input.value,
      mode: 0o644,
    }),
  });
}

/** Paths of the managed scripts each harness's agent hooks call; see the quality projector. */
export const agentStopScript = ".railguard/agent-hooks/stop";
export const agentGuardScript = ".railguard/agent-hooks/guard";
export const agentSessionStartScript = ".railguard/agent-hooks/session-start";

export function stablePrettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function yamlString(value: string): string {
  return JSON.stringify(value);
}

export function normalizedPrompt(value: string): string {
  return value.trimEnd();
}

export function componentId(ref: ComponentRef): string {
  return ref.slice(ref.indexOf(":") + 1);
}

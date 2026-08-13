import { compareUtf8, sha256, type Sha256Digest } from "../shared/types.js";

export type ManagedMarkerStyle = "markdown" | "hash";
export type ManagedSectionPlacement = "whole-file" | "append";

export type ManagedSectionInspection =
  | { readonly kind: "absent" }
  | {
      readonly kind: "present";
      readonly envelope: string;
      readonly digest: Sha256Digest;
    }
  | { readonly kind: "invalid"; readonly evidence: readonly string[] };

export type ManagedSectionRender =
  | { readonly kind: "ready"; readonly text: string }
  | { readonly kind: "invalid"; readonly evidence: readonly string[] };

export type ManagedSectionRemoval =
  | { readonly kind: "ready"; readonly text: string; readonly removed: boolean }
  | { readonly kind: "invalid"; readonly evidence: readonly string[] };

interface ParsedSection {
  readonly id: string;
  readonly style: ManagedMarkerStyle;
  readonly start: number;
  readonly end: number;
}

type ParsedManagedSections =
  | { readonly kind: "ready"; readonly sections: ReadonlyMap<string, ParsedSection> }
  | { readonly kind: "invalid"; readonly evidence: readonly string[] };

const sectionIdPattern = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*$/u;
const reservedMarkerPattern = /^(?:<!-- |# )ai-harness:managed:/gmu;
const markerPattern = /^(?:(<!--) |(#) )ai-harness:managed:(start|end) id="([a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*)"(?: -->)?\r?(?:\n|$)/gmu;

export function canonicalManagedEnvelope(
  sectionId: string,
  body: string,
  markerStyle: ManagedMarkerStyle,
  placement: ManagedSectionPlacement = "whole-file",
): string {
  assertSectionId(sectionId);
  const normalizedBody = normalizeEol(body).replace(/\n+$/u, "");
  const block = [
    marker(markerStyle, "start", sectionId),
    normalizedBody,
    marker(markerStyle, "end", sectionId),
    "",
  ].join("\n");
  return placement === "append" ? `\n${block}` : block;
}

export function managedSectionDigest(
  sectionId: string,
  body: string,
  markerStyle: ManagedMarkerStyle,
  placement: ManagedSectionPlacement = "whole-file",
): Sha256Digest {
  return sha256(canonicalManagedEnvelope(sectionId, body, markerStyle, placement));
}

export function inspectManagedSection(
  source: string,
  sectionId: string,
  markerStyle: ManagedMarkerStyle,
  placement: ManagedSectionPlacement = "whole-file",
): ManagedSectionInspection {
  if (!sectionIdPattern.test(sectionId)) {
    return invalid(["invalid-section-id"]);
  }
  const parsed = parseManagedSections(source);
  if (parsed.kind === "invalid") return parsed;
  const section = parsed.sections.get(sectionId);
  if (section === undefined) return Object.freeze({ kind: "absent" });
  if (section.style !== markerStyle) {
    return invalid([`marker-style:${section.style}`, `expected:${markerStyle}`]);
  }
  const range = ownedRange(source, section, placement);
  if (range === null) return invalid([`placement:${placement}`]);
  const envelope = normalizeEol(source.slice(range.start, range.end));
  return Object.freeze({ kind: "present", envelope, digest: sha256(envelope) });
}

export function renderManagedSection(
  source: string,
  sectionId: string,
  body: string,
  markerStyle: ManagedMarkerStyle,
): ManagedSectionRender {
  if (!sectionIdPattern.test(sectionId)) {
    return invalid(["invalid-section-id"]);
  }
  const parsed = parseManagedSections(source);
  if (parsed.kind === "invalid") return parsed;
  const existing = parsed.sections.get(sectionId);
  if (existing !== undefined && existing.style !== markerStyle) {
    return invalid([`marker-style:${existing.style}`, `expected:${markerStyle}`]);
  }

  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  if (existing !== undefined) {
    const placement: ManagedSectionPlacement = existing.start === 0 ? "whole-file" : "append";
    const range = ownedRange(source, existing, placement);
    if (range === null) return invalid([`placement:${placement}`]);
    const block = canonicalManagedEnvelope(sectionId, body, markerStyle, placement).replaceAll(
      "\n",
      eol,
    );
    return Object.freeze({
      kind: "ready",
      text: `${source.slice(0, range.start)}${block}${source.slice(range.end)}`,
    });
  }
  const placement: ManagedSectionPlacement = source.length === 0 ? "whole-file" : "append";
  const block = canonicalManagedEnvelope(sectionId, body, markerStyle, placement).replaceAll(
    "\n",
    eol,
  );
  return Object.freeze({ kind: "ready", text: `${source}${block}` });
}

export function removeManagedSection(
  source: string,
  sectionId: string,
  markerStyle: ManagedMarkerStyle,
  placement: ManagedSectionPlacement,
): ManagedSectionRemoval {
  if (!sectionIdPattern.test(sectionId)) return invalid(["invalid-section-id"]);
  const parsed = parseManagedSections(source);
  if (parsed.kind === "invalid") return parsed;
  const section = parsed.sections.get(sectionId);
  if (section === undefined) {
    return Object.freeze({ kind: "ready", text: source, removed: false });
  }
  if (section.style !== markerStyle) {
    return invalid([`marker-style:${section.style}`, `expected:${markerStyle}`]);
  }
  const range = ownedRange(source, section, placement);
  if (range === null) return invalid([`placement:${placement}`]);
  return Object.freeze({
    kind: "ready",
    text: `${source.slice(0, range.start)}${source.slice(range.end)}`,
    removed: true,
  });
}

function parseManagedSections(source: string): ParsedManagedSections {
  const reservedCount = [...source.matchAll(reservedMarkerPattern)].length;
  const matches = [...source.matchAll(markerPattern)];
  if (reservedCount !== matches.length) return invalid(["malformed-marker"]);

  const sections = new Map<string, ParsedSection>();
  let open:
    | { readonly id: string; readonly style: ManagedMarkerStyle; readonly start: number }
    | null = null;
  for (const match of matches) {
    const style: ManagedMarkerStyle = match[1] === "<!--" ? "markdown" : "hash";
    const kind = match[3];
    const id = match[4];
    if (id === undefined || kind === undefined) return invalid(["malformed-marker"]);
    const markerLine = match[0].replace(/\r?(?:\n|$)$/u, "");
    if (
      (style === "markdown" && !markerLine.endsWith(" -->")) ||
      (style === "hash" && markerLine.endsWith(" -->"))
    ) {
      return invalid(["malformed-marker"]);
    }
    if (kind === "start") {
      if (open !== null || sections.has(id)) return invalid(["duplicate-or-nested-start"]);
      open = Object.freeze({ id, style, start: match.index });
      continue;
    }
    if (open === null || id !== open.id || style !== open.style) {
      return invalid(["unmatched-end"]);
    }
    sections.set(
      id,
      Object.freeze({ id, style, start: open.start, end: match.index + match[0].length }),
    );
    open = null;
  }
  if (open !== null) return invalid(["unclosed-start"]);
  return Object.freeze({ kind: "ready", sections });
}

function marker(style: ManagedMarkerStyle, kind: "start" | "end", sectionId: string): string {
  return style === "markdown"
    ? `<!-- ai-harness:managed:${kind} id="${sectionId}" -->`
    : `# ai-harness:managed:${kind} id="${sectionId}"`;
}

function ownedRange(
  source: string,
  section: ParsedSection,
  placement: ManagedSectionPlacement,
): { readonly start: number; readonly end: number } | null {
  if (placement === "whole-file") {
    return section.start === 0 ? Object.freeze({ start: 0, end: section.end }) : null;
  }
  if (section.start === 0) return null;
  if (source.slice(Math.max(0, section.start - 2), section.start) === "\r\n") {
    return Object.freeze({ start: section.start - 2, end: section.end });
  }
  if (source[section.start - 1] === "\n") {
    return Object.freeze({ start: section.start - 1, end: section.end });
  }
  return null;
}

function normalizeEol(value: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function assertSectionId(sectionId: string): void {
  if (!sectionIdPattern.test(sectionId)) throw new TypeError(`Invalid section ID: ${sectionId}`);
}

function invalid(evidence: readonly string[]): Extract<ManagedSectionInspection, { kind: "invalid" }> {
  return Object.freeze({ kind: "invalid", evidence: Object.freeze([...evidence].sort(compareUtf8)) });
}

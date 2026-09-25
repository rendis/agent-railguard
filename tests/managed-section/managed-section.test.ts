import { describe, expect, it } from "vitest";
import {
  canonicalManagedEnvelope,
  inspectManagedSection,
  removeManagedSection,
  renderManagedSection,
} from "../../src/domain/managed-section/managed-section.js";
import { sha256 } from "../../src/domain/shared/types.js";

describe("managed section contract", () => {
  it("renders one canonical LF envelope", () => {
    const envelope = canonicalManagedEnvelope("skills.mapping", "one\r\ntwo\n", "markdown");

    expect(envelope).toBe(
      '<!-- railguard:managed:start id="skills.mapping" -->\none\ntwo\n<!-- railguard:managed:end id="skills.mapping" -->\n',
    );
  });

  it("normalizes only an extracted CRLF envelope for observation", () => {
    const canonical = canonicalManagedEnvelope(
      "verification.go-quality",
      "check:\n\t@true",
      "hash",
      "append",
    );
    const source = `user-owned:\r\n\t@true\r\n${canonical.replaceAll("\n", "\r\n")}`;

    expect(inspectManagedSection(source, "verification.go-quality", "hash", "append")).toEqual({
      kind: "present",
      envelope: canonical,
      digest: sha256(canonical),
    });
  });

  it("preserves external content while replacing the owned envelope", () => {
    const initial = `custom:\n\t@true\n${canonicalManagedEnvelope("verification.go-quality", "old", "hash", "append")}`;

    expect(renderManagedSection(initial, "verification.go-quality", "new", "hash")).toEqual({
      kind: "ready",
      text: `custom:\n\t@true\n${canonicalManagedEnvelope("verification.go-quality", "new", "hash", "append")}`,
    });
  });

  it("owns one append separator so removal restores external bytes exactly", () => {
    for (const source of ["user-owned", "user-owned\n", "user-owned\n\n"]) {
      const rendered = renderManagedSection(
        source,
        "skills.mapping",
        "body",
        "markdown",
      );
      expect(rendered.kind).toBe("ready");
      if (rendered.kind !== "ready") continue;

      const inspection = inspectManagedSection(
        rendered.text,
        "skills.mapping",
        "markdown",
        "append",
      );
      expect(inspection).toMatchObject({
        kind: "present",
        envelope: canonicalManagedEnvelope("skills.mapping", "body", "markdown", "append"),
      });
      expect(removeManagedSection(rendered.text, "skills.mapping", "markdown", "append")).toEqual({
        kind: "ready",
        text: source,
        removed: true,
      });
    }
  });

  it("keeps owning a whole-file block after another tool adds content before it", () => {
    const block = canonicalManagedEnvelope("claude.agents-import", "@AGENTS.md", "markdown");
    const source = `<!-- other-tool:managed:start -->\nForeign\n<!-- other-tool:managed:end -->\n\n${block}`;

    const inspection = inspectManagedSection(source, "claude.agents-import", "markdown", "whole-file");
    const removal = removeManagedSection(source, "claude.agents-import", "markdown", "whole-file");

    expect(inspection).toMatchObject({ kind: "present", digest: sha256(block) });
    expect(removal).toMatchObject({
      kind: "ready",
      removed: true,
      text: "<!-- other-tool:managed:start -->\nForeign\n<!-- other-tool:managed:end -->\n\n",
    });
  });

  it("rejects duplicate, nested, mixed-style, and malformed markers", () => {
    const duplicate = `${canonicalManagedEnvelope("skills.mapping", "one", "markdown")}${canonicalManagedEnvelope("skills.mapping", "two", "markdown")}`;
    expect(inspectManagedSection(duplicate, "skills.mapping", "markdown").kind).toBe("invalid");

    const mixed = '# railguard:managed:start id="skills.mapping"\n<!-- railguard:managed:end id="skills.mapping" -->\n';
    expect(inspectManagedSection(mixed, "skills.mapping", "hash").kind).toBe("invalid");

    const malformed = '# railguard:managed:start id="skills.mapping" -->\n';
    expect(inspectManagedSection(malformed, "skills.mapping", "hash").kind).toBe("invalid");
  });
});

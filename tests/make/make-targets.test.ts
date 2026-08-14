import { describe, expect, it } from "vitest";
import { inspectMakeTargets } from "../../src/domain/make/make-targets.js";

describe("Make target inspection", () => {
  it("finds exact declarations and includes their contiguous recipes", () => {
    const source = [
      ".PHONY: check checkout verify",
      "checkout:",
      "\t@true",
      "check: fmt test",
      "\t@echo checking",
      "\t@go vet ./...",
      "verify: check",
      "\t@true",
      "",
    ].join("\n");

    const declarations = inspectMakeTargets(source, ["verify", "check"]);

    expect(declarations.map(({ target, line, declaration, source: rule, replaceable }) => ({
      target,
      line,
      declaration,
      rule,
      replaceable,
    }))).toEqual([
      {
        target: "check",
        line: 4,
        declaration: "check: fmt test",
        rule: "check: fmt test\n\t@echo checking\n\t@go vet ./...\n",
        replaceable: true,
      },
      {
        target: "verify",
        line: 7,
        declaration: "verify: check",
        rule: "verify: check\n\t@true\n",
        replaceable: true,
      },
    ]);
  });

  it("preserves CRLF bytes and reports a dependency-only target", () => {
    const source = "before:\r\n\t@true\r\ncheck: fmt test\r\nafter:\r\n\t@true\r\n";

    const [declaration] = inspectMakeTargets(source, ["check"]);

    expect(declaration).toMatchObject({
      target: "check",
      line: 3,
      declaration: "check: fmt test",
      source: "check: fmt test\r\n",
      replaceable: true,
    });
    expect(source.slice(declaration!.start, declaration!.end)).toBe(declaration!.source);
  });

  it("does not confuse similarly prefixed or multi-target declarations", () => {
    const source = "check-all:\n\t@true\ncheck verify:\n\t@true\n";

    expect(inspectMakeTargets(source, ["check"])).toEqual([]);
  });

  it("reports double-colon declarations but does not mark them replaceable", () => {
    const [declaration] = inspectMakeTargets("check:: first\n\t@true\n", ["check"]);

    expect(declaration).toMatchObject({
      target: "check",
      line: 1,
      declaration: "check:: first",
      source: "check:: first\n",
      replaceable: false,
    });
  });

  it.each([
    ["continued prerequisites", "check: first \\\n  second\n\t@true\n"],
    ["custom recipe prefixes", ".RECIPEPREFIX = >\ncheck:\n>@true\n"],
    ["unbounded recipe continuations", "check:\n\t@echo first \\\n  second\n"],
  ])("keeps %s visible but not automatically replaceable", (_name, source) => {
    const [declaration] = inspectMakeTargets(source, ["check"]);

    expect(declaration).toMatchObject({ target: "check", replaceable: false });
  });

  it("returns every repeated exact declaration in source order", () => {
    const source = "check: first\n\t@one\ncheck: second\n\t@two\n";

    expect(inspectMakeTargets(source, ["check"]).map((entry) => entry.line)).toEqual([1, 3]);
  });
});

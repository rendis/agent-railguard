import { describe, expect, it } from "vitest";
import {
  changedLineCoverage,
  lineRanges,
  parseCoverProfile,
} from "../../src/adapters/stack/go/go-coverage.js";
import { matchesPackagePattern } from "../../src/adapters/stack/go/go-check-provider.js";
import type { ChangedLines } from "../../src/domain/verification/checks.js";

const profile = [
  "mode: set",
  "example.com/svc/internal/core/order.go:3.30,5.2 2 1",
  "example.com/svc/internal/core/order.go:7.20,9.2 1 0",
  "example.com/svc/internal/core/order.go:7.20,9.2 1 1",
  "example.com/svc/internal/core/order.go:11.20,13.2 3 0",
  "example.com/svc/cmd/main.go:3.13,4.2 1 0",
  "",
].join("\n");

describe("Go coverage", () => {
  it("merges blocks repeated by several test binaries and re-roots files to the module", () => {
    const blocks = parseCoverProfile(profile, "example.com/svc");

    expect(blocks).toHaveLength(4);
    expect(blocks.find((block) => block.startLine === 7)?.count).toBe(1);
    expect(blocks.map((block) => block.file)).toContain("cmd/main.go");
  });

  it("measures only changed lines that hold statements and lists the uncovered ones", () => {
    const blocks = parseCoverProfile(profile, "example.com/svc");
    const changed = new Map<string, ChangedLines>([
      ["internal/core/order.go", new Set([4, 8, 12, 13, 40])],
      ["cmd/main.go", "all"],
    ]);

    const core = changedLineCoverage(blocks, changed, (file) => file.startsWith("internal/core/"));
    const other = changedLineCoverage(blocks, changed, (file) => !file.startsWith("internal/core/"));

    expect(core).toMatchObject({ covered: 2, total: 4 });
    expect([...core.uncovered]).toEqual([["internal/core/order.go", [12, 13]]]);
    expect(other).toMatchObject({ covered: 0, total: 2 });
  });

  it("renders consecutive lines as ranges", () => {
    expect(lineRanges([3, 4, 5, 9, 11, 12])).toBe("3-5, 9, 11-12");
    expect(lineRanges([])).toBe("");
  });

  it("matches Go package patterns against unit-relative directories", () => {
    expect(matchesPackagePattern("internal/core/order", "./internal/core/...")).toBe(true);
    expect(matchesPackagePattern("internal/core", "./internal/core/...")).toBe(true);
    expect(matchesPackagePattern("internal/corex", "./internal/core/...")).toBe(false);
    expect(matchesPackagePattern("cmd/api", "./cmd/api")).toBe(true);
    expect(matchesPackagePattern("cmd/api/v2", "./cmd/api")).toBe(false);
    expect(matchesPackagePattern(".", "./...")).toBe(true);
  });
});

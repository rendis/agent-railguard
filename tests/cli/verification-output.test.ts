import { describe, expect, it } from "vitest";
import type { CheckResult, VerificationReport } from "../../src/application/verification-service.js";
import {
  encodeVerificationReport,
  renderVerificationReport,
} from "../../src/cli/verification-output.js";
import { componentRef, type Diagnostic } from "../../src/domain/shared/types.js";

const profile = componentRef("verification-profile:go-quality");

function result(check: string, unit: string, status: CheckResult["outcome"]["status"], details: string[] = []): CheckResult {
  return { profile, check, kind: `go-${check}`, unit, outcome: { status, summary: `${check} ${status}`, details } };
}

function report(overrides: Partial<VerificationReport>): VerificationReport {
  return {
    stage: "check",
    mode: "changed",
    base: "0123456789abcdef0123",
    baseRef: "origin/main",
    verdict: "passed",
    results: [],
    diagnostics: [],
    ...overrides,
  };
}

describe("verification output", () => {
  it("renders each outcome with its details, unit and a counted verdict", () => {
    const text = renderVerificationReport(report({
      verdict: "failed",
      results: [
        result("format", ".", "passed"),
        result("vet", "svc", "failed", ["svc/a.go:3: bad"]),
        result("lint", ".", "unavailable", ["golangci-lint is not pinned"]),
        result("test", ".", "skipped"),
      ],
    }), true);

    expect(text).toBe([
      "Railguard check · changes since origin/main (0123456789ab)",
      "  ok   go-quality/format  format passed",
      "  FAIL go-quality/vet [svc]  vet failed",
      "      svc/a.go:3: bad",
      "  N/A  go-quality/lint  lint unavailable",
      "      golangci-lint is not pinned",
      "  skip go-quality/test  test skipped",
      "Result: FAILED — 1 failed, 1 unavailable, 1 passed, 1 skipped",
      "",
    ].join("\n"));
  });

  it("names the scope of full and base-less runs and explains unavailable verdicts", () => {
    expect(renderVerificationReport(report({ mode: "full" }), false)).toContain("all project units");
    const unavailable = renderVerificationReport(report({
      base: null,
      verdict: "unavailable",
      results: [result("lint", ".", "unavailable")],
    }), false);

    expect(unavailable).toContain("no base commit");
    expect(unavailable).toContain("! go-quality/lint");
    expect(unavailable).toContain("Unavailable never counts as a pass.");
  });

  it("renders blocking diagnostics and encodes the report with its exit code", () => {
    const diagnostic: Diagnostic = {
      code: "verification.project.uninitialized",
      severity: "blocked",
      phase: "verification",
      subjects: [],
      location: null,
      message: "No selection.",
      evidence: [],
      impact: "No check can run.",
      action: "Run railguard init.",
    };
    const blocked = report({ verdict: "blocked", diagnostics: [diagnostic] });

    expect(renderVerificationReport(blocked, true)).toContain(
      "  BLOCKED verification.project.uninitialized: No selection.\n      Next: Run railguard init.",
    );
    expect(JSON.parse(encodeVerificationReport(blocked))).toMatchObject({
      schema: "railguard/verification-report/v1",
      verdict: "blocked",
      exit_code: 5,
      base_ref: "origin/main",
      diagnostics: [{ code: "verification.project.uninitialized", action: "Run railguard init." }],
    });
  });
});

import { chmod, lstat, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { ExecutableProbe } from "../../src/domain/harness/model.js";
import { createDefaultApplication } from "../../src/application/composition-root.js";
import type { ApplicationEvent } from "../../src/application/model.js";
import {
  componentRef,
  harnessTargetId,
  languageId,
} from "../../src/domain/shared/types.js";
import { createTempRepository } from "../helpers/temp-repository.js";

const probe: ExecutableProbe = {
  async probe() {
    return {
      detected: true,
      path: "/test/bin/codex",
      version: "codex-cli test",
      diagnostics: [],
    };
  },
};

const selection = componentRef("skill:develop-go-hexagonal-service");
const codex = harnessTargetId("codex");
const exec = promisify(execFile);

describe("AiHarnessApplication", () => {
  it("reconstructs durable managed state in a new process and plans an exact no-op", async () => {
    const repository = await createTempRepository({
      "go.mod": "module example.com/restart\n\ngo 1.24\n",
    });
    await exec("git", ["init", "--quiet", repository.root]);
    let firstRuntime = await createDefaultApplication({ executableProbe: probe });
    try {
      const baseline = await firstRuntime.application.scan(repository.root);
      if (baseline.kind !== "ready") throw new Error("Expected ready baseline scan");
      const prepared = await firstRuntime.application.prepareInstall(baseline, [selection], [codex]);
      if (prepared.plan?.kind !== "ready") throw new Error("Expected ready durable plan");
      expect((await firstRuntime.application.apply(prepared.plan)).kind).toBe("applied");
      await firstRuntime.dispose();

      firstRuntime = await createDefaultApplication({ executableProbe: probe });
      const restarted = await firstRuntime.application.scan(repository.root);
      expect(restarted.kind).toBe("ready");
      if (restarted.kind !== "ready") return;
      expect(restarted.desired?.state.selections.map((entry) => entry.ref)).toEqual([selection]);
      expect(restarted.lock?.state.components.map((entry) => entry.ref)).toContain(selection);
      expect(restarted.reconciliation).toMatchObject({
        management: "managed",
        integrity: "clean",
        readiness: "ready",
      });

      const repeated = await firstRuntime.application.prepareInstall(restarted, [selection], [codex]);
      expect(repeated.plan?.kind).toBe("ready");
      if (repeated.plan?.kind === "ready") {
        expect(repeated.plan.operations).toEqual([]);
        expect((await firstRuntime.application.apply(repeated.plan)).kind).toBe("no-changes");
      }
    } finally {
      await Promise.all([firstRuntime.dispose(), repository.cleanup()]);
    }
  });

  it("runs the complete reversible cycle through shared application cases", async () => {
    const repository = await createTempRepository({
      "go.mod": "module example.com/service\n\ngo 1.24\n",
      "README.md": "# Service\n",
    });
    await exec("git", ["init", "--quiet", repository.root]);
    const events: ApplicationEvent[] = [];
    const runtime = await createDefaultApplication({
      executableProbe: probe,
      events: (event) => events.push(event),
    });
    try {
      const baseline = await runtime.application.scan(repository.root);
      expect(baseline.kind).toBe("ready");
      if (baseline.kind !== "ready") {
        throw new Error("Expected baseline scan to be ready");
      }
      expect(baseline.assessment.projectUnits.map((unit) => unit.languages)).toEqual([["go"]]);
      expect(baseline.harnesses.map((harness) => harness.target)).toEqual([
        "claude-code",
        "codex",
        "cursor",
        "opencode",
        "vscode",
      ]);
      expect(baseline.harnesses.find((harness) => harness.target === "codex")).toMatchObject({
        target: "codex",
        detected: true,
        capabilities: [
          "project.agents",
          "project.instructions",
          "project.mcp",
          "project.skills",
        ],
      });
      const recommendations = await runtime.application.recommendations(baseline);
      expect(recommendations.candidates.map((candidate) => candidate.ref)).toContain(selection);

      const prepared = await runtime.application.prepareInstall(baseline, [selection], [codex]);
      expect(prepared.resolution.kind).toBe("ready");
      expect(
        prepared.plan?.kind,
        JSON.stringify(
          prepared.plan?.diagnostics.map((diagnostic) => ({
            code: diagnostic.code,
            evidence: diagnostic.evidence,
          })),
        ),
      ).toBe("ready");
      if (prepared.plan?.kind !== "ready") {
        throw new Error("Expected installation plan to be ready");
      }
      expect((await runtime.application.apply(prepared.plan)).kind).toBe("applied");
      expect(await readFile(`${repository.root}/Makefile`, "utf8")).toContain(
        "verify: ai-harness-go-verify",
      );
      await expect(
        readFile(`${repository.root}/.ai-harness/hooks/pre-commit`, "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const status = await runtime.application.status(repository.root, [codex]);
      expect(status.verification?.materialization).toBe("verified");
      expect(status.verification?.hostDiscovery).toBe("not-observable");

      const installedScan = status.scan;
      const noOp = await runtime.application.prepareInstall(installedScan, [selection], [codex]);
      expect(noOp.plan?.kind).toBe("ready");
      if (noOp.plan?.kind === "ready") {
        expect(noOp.plan.operations).toEqual([]);
        expect((await runtime.application.apply(noOp.plan)).kind).toBe("no-changes");
      }

      const current = await runtime.application.scan(repository.root);
      const removal = await runtime.application.prepareRemove(current, { all: true });
      expect(removal.resolution.kind).toBe("ready");
      expect(removal.resolution.components).toEqual([]);
      expect(removal.plan?.kind).toBe("ready");
      if (removal.plan?.kind !== "ready") {
        throw new Error("Expected removal plan to be ready");
      }
      expect((await runtime.application.apply(removal.plan)).kind).toBe("applied");
      const restored = await runtime.application.scan(repository.root);
      expect(restored.snapshot.fingerprint).toBe(baseline.snapshot.fingerprint);

      expect(events.some((event) => event.operation === "scan" && event.status === "started")).toBe(
        true,
      );
      expect(
        events.some((event) => event.operation === "verify" && event.status === "completed"),
      ).toBe(true);
      expect(events.some((event) => event.operation === "apply" && event.status === "completed")).toBe(
        true,
      );
    } finally {
      await Promise.all([runtime.dispose(), repository.cleanup()]);
    }
  });

  it("installs and removes one deduplicated configuration across all five harnesses", async () => {
    const repository = await createTempRepository({
      "go.mod": "module example.com/multi-harness\n\ngo 1.24\n",
      "README.md": "# Multi harness\n",
    });
    await exec("git", ["init", "--quiet", repository.root]);
    const runtime = await createDefaultApplication({ executableProbe: probe });
    const targets = ["claude-code", "codex", "cursor", "opencode", "vscode"].map(
      harnessTargetId,
    );
    try {
      const baseline = await runtime.application.scan(repository.root);
      if (baseline.kind !== "ready") throw new Error("Expected ready baseline");
      const prepared = await runtime.application.prepareInstall(
        baseline,
        [componentRef("agent:go-reviewer"), componentRef("mcp:context7")],
        targets,
      );
      expect(
        prepared.plan?.kind,
        JSON.stringify(prepared.plan?.diagnostics.map((diagnostic) => diagnostic.code)),
      ).toBe("ready");
      if (prepared.plan?.kind !== "ready") throw new Error("Expected multi-target plan");
      expect((await runtime.application.apply(prepared.plan)).kind).toBe("applied");

      expect(await readFile(`${repository.root}/AGENTS.md`, "utf8")).toContain(
        "## Delegation",
      );
      expect(await readFile(`${repository.root}/CLAUDE.md`, "utf8")).toContain("@AGENTS.md");
      expect(await readFile(`${repository.root}/.codex/config.toml`, "utf8")).toContain(
        "[mcp_servers.context7]",
      );
      expect(await readFile(`${repository.root}/.mcp.json`, "utf8")).toContain(
        '"mcpServers"',
      );
      expect(await readFile(`${repository.root}/.cursor/mcp.json`, "utf8")).toContain(
        '"mcpServers"',
      );
      expect(await readFile(`${repository.root}/.vscode/mcp.json`, "utf8")).toContain(
        '"servers"',
      );
      expect(await readFile(`${repository.root}/opencode.json`, "utf8")).toContain(
        '"type": "local"',
      );
      for (const path of [
        ".codex/agents/go-reviewer.toml",
        ".claude/agents/go-reviewer.md",
        ".cursor/agents/go-reviewer.md",
        ".github/agents/go-reviewer.agent.md",
        ".opencode/agents/go-reviewer.md",
        ".agents/skills/review-go-quality/SKILL.md",
      ]) {
        await expect(readFile(`${repository.root}/${path}`, "utf8")).resolves.toBeTruthy();
      }
      const claudeSkill = `${repository.root}/.claude/skills/review-go-quality`;
      expect((await lstat(claudeSkill)).isSymbolicLink()).toBe(true);
      expect(await readlink(claudeSkill)).toBe("../../.agents/skills/review-go-quality");
      await expect(readFile(`${claudeSkill}/SKILL.md`, "utf8")).resolves.toBeTruthy();

      const installed = await runtime.application.scan(repository.root);
      if (installed.kind !== "ready") throw new Error("Expected managed scan");
      expect(installed.reconciliation).toMatchObject({
        management: "managed",
        integrity: "clean",
        readiness: "ready",
      });
      const removal = await runtime.application.prepareRemove(installed, { all: true });
      if (removal.plan?.kind !== "ready") throw new Error("Expected exact removal plan");
      expect((await runtime.application.apply(removal.plan)).kind).toBe("applied");
      const restored = await runtime.application.scan(repository.root);
      expect(restored.snapshot.fingerprint).toBe(baseline.snapshot.fingerprint);
    } finally {
      await Promise.all([runtime.dispose(), repository.cleanup()]);
    }
  });

  it("allows deliberate Go selection in an empty repository", async () => {
    const repository = await createTempRepository({});
    await exec("git", ["init", "--quiet", repository.root]);
    const runtime = await createDefaultApplication({ executableProbe: probe });
    try {
      const scan = await runtime.application.scan(repository.root);
      expect(scan.kind).toBe("ready");
      if (scan.kind !== "ready") {
        throw new Error("Expected empty repository scan to be ready");
      }
      expect(scan.assessment.projectUnits).toEqual([]);
      expect((await runtime.application.recommendations(scan)).candidates).toEqual([]);

      const prepared = await runtime.application.prepareInstall(scan, [selection], [codex]);

      expect(prepared.resolution.kind).toBe("ready");
      expect(
        prepared.resolution.diagnostics.map((diagnostic) => diagnostic.code),
      ).toContain("resolution.selection.applicability-unverified");
      expect(
        prepared.plan?.kind,
        JSON.stringify(
          prepared.plan?.diagnostics.map((diagnostic) => ({
            code: diagnostic.code,
            evidence: diagnostic.evidence,
          })),
        ),
      ).toBe("ready");
    } finally {
      await Promise.all([runtime.dispose(), repository.cleanup()]);
    }
  });

  it("keeps manual selection available while modelling every Go module independently", async () => {
    const repository = await createTempRepository({
      "go.mod": "module example.com/root\n",
      "nested/go.mod": "module example.com/nested\n",
    });
    await exec("git", ["init", "--quiet", repository.root]);
    const runtime = await createDefaultApplication({ executableProbe: probe });
    try {
      const scan = await runtime.application.scan(repository.root);
      expect(scan.kind).toBe("ready");
      if (scan.kind !== "ready") {
        throw new Error("Expected multi-module scan to remain usable");
      }
      expect(scan.assessment.projectUnits.map((unit) => unit.root)).toEqual([".", "nested"]);
      expect(
        scan.assessment.projectUnits.every((unit) => unit.languages.includes(languageId("go"))),
      ).toBe(true);
      expect(scan.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
        "stack.go.multiple-modules-unsupported",
      );

      const prepared = await runtime.application.prepareInstall(scan, [selection], [codex]);

      expect(prepared.resolution.kind).toBe("ready");
      expect(prepared.plan?.kind).toBe("ready");
    } finally {
      await Promise.all([runtime.dispose(), repository.cleanup()]);
    }
  });

  it("blocks a mutable plan when the repository preflight finds a tracked sensitive path", async () => {
    const repository = await createTempRepository({
      "go.mod": "module example.com/gated\n",
      ".env": "TOKEN=redacted\n",
    });
    await exec("git", ["init", "--quiet", repository.root]);
    await exec("git", ["-C", repository.root, "add", "."]);
    const runtime = await createDefaultApplication({ executableProbe: probe });
    try {
      const scan = await runtime.application.scan(repository.root);
      const prepared = await runtime.application.prepareInstall(scan, [selection], [codex]);

      expect(prepared.plan).toBeNull();
      expect(prepared.diagnostics).toContainEqual(
        expect.objectContaining({ code: "repository.gate.sensitive-path" }),
      );
    } finally {
      await Promise.all([runtime.dispose(), repository.cleanup()]);
    }
  });

  it("installs and removes both Git gates without installing any skill", async () => {
    const repository = await createTempRepository({
      "go.mod": "module example.com/gated\n\ngo 1.24\n",
      "main.go": "package main\n\nfunc main() {}\n",
    });
    await exec("git", ["init", "--quiet", repository.root]);
    const runtime = await createDefaultApplication({ executableProbe: probe });
    try {
      const baseline = await runtime.application.scan(repository.root);
      expect(baseline.kind).toBe("ready");
      if (baseline.kind !== "ready") {
        throw new Error("Expected gate fixture scan to be ready");
      }

      const prepared = await runtime.application.prepareInstall(
        baseline,
        [componentRef("git-gate:pre-commit-check"), componentRef("git-gate:pre-push-verify")],
        [codex],
      );
      expect(prepared.resolution.kind).toBe("ready");
      expect(prepared.resolution.components.map((component) => component.ref)).toEqual([
        "verification-profile:go-quality",
        "git-gate:pre-commit-check",
        "git-gate:pre-push-verify",
      ]);
      expect(prepared.plan?.kind).toBe("ready");
      if (prepared.plan?.kind !== "ready") {
        throw new Error("Expected pre-commit installation plan to be ready");
      }
      expect(prepared.plan.operations.map((operation) => operation.path)).toEqual([
        ".ai-harness",
        ".ai-harness/hooks",
        ".ai-harness/hooks/pre-commit",
        ".ai-harness/hooks/pre-push",
        "AGENTS.md",
        "Makefile",
        ".ai-harness/project.yaml",
        ".ai-harness/lock.json",
        ".git/config",
      ]);
      expect((await runtime.application.apply(prepared.plan)).kind).toBe("applied");

      expect(await readFile(`${repository.root}/.ai-harness/hooks/pre-commit`, "utf8")).toContain(
        "make check",
      );
      expect(await readFile(`${repository.root}/.ai-harness/hooks/pre-push`, "utf8")).toContain(
        "make verify",
      );
      expect(await readFile(`${repository.root}/Makefile`, "utf8")).toContain(
        "verify: ai-harness-go-verify",
      );
      const goCache = await mkdtemp(join(tmpdir(), "ai-harness-go-cache-"));
      try {
        const environment = { ...process.env, GOCACHE: goCache };
        await exec("make", ["-C", repository.root, "check"], { env: environment });
        await exec("make", ["-C", repository.root, "verify"], { env: environment });
      } finally {
        await rm(goCache, { recursive: true, force: true });
      }
      expect(
        (await exec("git", ["-C", repository.root, "config", "--local", "--get", "core.hooksPath"]))
          .stdout.trim(),
      ).toBe(".ai-harness/hooks");

      const installed = await runtime.application.scan(repository.root);
      const noOp = await runtime.application.prepareInstall(
        installed,
        [componentRef("git-gate:pre-commit-check"), componentRef("git-gate:pre-push-verify")],
        [codex],
      );
      expect(noOp.plan?.kind).toBe("ready");
      if (noOp.plan?.kind === "ready") {
        expect(noOp.plan.operations).toEqual([]);
      }

      const removal = await runtime.application.prepareRemove(installed, { all: true });
      expect(removal.plan?.kind).toBe("ready");
      if (removal.plan?.kind !== "ready") {
        throw new Error("Expected gate removal plan to be ready");
      }
      expect((await runtime.application.apply(removal.plan)).kind).toBe("applied");
      await expect(readFile(`${repository.root}/Makefile`, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        exec("git", ["-C", repository.root, "config", "--local", "--get", "core.hooksPath"]),
      ).rejects.toMatchObject({ code: 1 });
    } finally {
      await Promise.all([runtime.dispose(), repository.cleanup()]);
    }
  });

  it("composes operations in one event hook and removes either operation independently", async () => {
    const repository = await createTempRepository({
      "go.mod": "module example.com/partial-remove\n\ngo 1.24\n",
    });
    await exec("git", ["init", "--quiet", repository.root]);
    const runtime = await createDefaultApplication({ executableProbe: probe });
    const preCommitCheck = componentRef("git-gate:pre-commit-check");
    const preCommitVerify = componentRef("git-gate:pre-commit-verify");
    try {
      const baseline = await runtime.application.scan(repository.root);
      if (baseline.kind !== "ready") throw new Error("Expected ready baseline");
      const install = await runtime.application.prepareInstall(
        baseline,
        [preCommitCheck, preCommitVerify],
        [codex],
      );
      if (install.plan?.kind !== "ready") throw new Error("Expected ready install");
      expect((await runtime.application.apply(install.plan)).kind).toBe("applied");
      const composedHook = await readFile(
        `${repository.root}/.ai-harness/hooks/pre-commit`,
        "utf8",
      );
      expect(composedHook).toContain("make check");
      expect(composedHook).toContain("make verify");
      await expect(
        readFile(`${repository.root}/.ai-harness/hooks/pre-push`, "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });

      const installed = await runtime.application.scan(repository.root);
      const partial = await runtime.application.prepareRemove(installed, {
        components: [preCommitCheck],
      });

      expect(partial.resolution.components.map((component) => component.ref)).toEqual([
        "verification-profile:go-quality",
        "git-gate:pre-commit-verify",
      ]);
      if (partial.plan?.kind !== "ready") throw new Error("Expected ready partial removal");
      expect((await runtime.application.apply(partial.plan)).kind).toBe("applied");
      const retainedHook = await readFile(
        `${repository.root}/.ai-harness/hooks/pre-commit`,
        "utf8",
      );
      expect(retainedHook).not.toContain("make check");
      expect(retainedHook).toContain("make verify");
      const after = await runtime.application.scan(repository.root);
      if (after.kind !== "ready") throw new Error("Expected ready managed scan");
      expect(after.desired?.state.selections.map((entry) => entry.ref)).toEqual([
        preCommitVerify,
      ]);
      expect(after.reconciliation.management).toBe("managed");
    } finally {
      await Promise.all([runtime.dispose(), repository.cleanup()]);
    }
  });

  it("blocks a foreign Make target before writing anything", async () => {
    const originalMakefile = "check:\n\t@echo foreign\n";
    const repository = await createTempRepository({
      "go.mod": "module example.com/collision\n\ngo 1.24\n",
      Makefile: originalMakefile,
    });
    await exec("git", ["init", "--quiet", repository.root]);
    const runtime = await createDefaultApplication({ executableProbe: probe });
    try {
      const scan = await runtime.application.scan(repository.root);
      if (scan.kind !== "ready") {
        throw new Error("Expected collision fixture scan to be ready");
      }
      const prepared = await runtime.application.prepareInstall(
        scan,
        [componentRef("skill:configure-go-quality")],
        [codex],
      );

      expect(prepared.plan?.kind).toBe("blocked");
      expect(prepared.plan?.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        "quality.make.target-collision",
      );
      const collision = prepared.plan?.diagnostics.find(
        (diagnostic) => diagnostic.code === "quality.make.target-collision",
      );
      expect(collision).toMatchObject({
        location: { path: "Makefile", pointer: "line:1" },
        message: 'Makefile defines unmanaged canonical target "check" at line 1.',
        evidence: ['target "check" at line 1: check:'],
        resolutions: [{ action: "replace", destructive: true }],
      });
      expect(await readFile(`${repository.root}/Makefile`, "utf8")).toBe(originalMakefile);
    } finally {
      await Promise.all([runtime.dispose(), repository.cleanup()]);
    }
  });

  it("prepares and applies an explicitly confirmed Make target replacement", async () => {
    const originalMakefile = "custom:\n\t@echo keep\ncheck: fmt test\n\t@echo foreign\n";
    const repository = await createTempRepository({
      "go.mod": "module example.com/replacement\n\ngo 1.24\n",
      Makefile: originalMakefile,
    });
    await exec("git", ["init", "--quiet", repository.root]);
    const runtime = await createDefaultApplication({ executableProbe: probe });
    try {
      const scan = await runtime.application.scan(repository.root);
      if (scan.kind !== "ready") throw new Error("Expected replacement fixture scan to be ready");
      const prepared = await runtime.application.preparePlan(
        scan,
        [{ ref: componentRef("skill:configure-go-quality") }],
        [codex],
        "reconcile",
        {
          conflictResolutions: [{
            code: "quality.make.target-collision",
            action: "replace",
          }],
        },
      );

      expect(prepared.plan?.kind).toBe("ready");
      if (prepared.plan?.kind !== "ready") throw new Error("Expected ready replacement plan");
      const makeWrite = prepared.plan.operations.find(
        (operation) => operation.kind === "write-file" && operation.path === "Makefile",
      );
      expect(makeWrite?.kind).toBe("write-file");
      const planned = makeWrite?.kind === "write-file" ? makeWrite.bytes.toString() : "";
      expect(planned).toContain("custom:\n\t@echo keep\n");
      expect(planned).not.toContain("@echo foreign");
      expect(planned).not.toContain("check: fmt test");
      expect(planned).toContain("check: ai-harness-go-check");
      expect(planned).toContain("verify: ai-harness-go-verify");
      expect(await readFile(`${repository.root}/Makefile`, "utf8")).toBe(originalMakefile);

      expect((await runtime.application.apply(prepared.plan)).kind).toBe("applied");
      expect(await readFile(`${repository.root}/Makefile`, "utf8")).toBe(planned);
    } finally {
      await Promise.all([runtime.dispose(), repository.cleanup()]);
    }
  });

  it("keeps unsupported double-colon Make targets blocked under replacement", async () => {
    const originalMakefile = "check:: first\n\t@echo foreign\n";
    const repository = await createTempRepository({
      "go.mod": "module example.com/double-colon\n\ngo 1.24\n",
      Makefile: originalMakefile,
    });
    await exec("git", ["init", "--quiet", repository.root]);
    const runtime = await createDefaultApplication({ executableProbe: probe });
    try {
      const scan = await runtime.application.scan(repository.root);
      if (scan.kind !== "ready") throw new Error("Expected double-colon fixture scan to be ready");
      const prepared = await runtime.application.preparePlan(
        scan,
        [{ ref: componentRef("skill:configure-go-quality") }],
        [codex],
        "reconcile",
        {
          conflictResolutions: [{
            code: "quality.make.target-collision",
            action: "replace",
          }],
        },
      );

      expect(prepared.plan?.kind).toBe("blocked");
      const collision = prepared.plan?.diagnostics.find(
        (diagnostic) => diagnostic.code === "quality.make.target-collision",
      );
      expect(collision).toMatchObject({
        evidence: ['target "check" at line 1: check:: first'],
        action: "Rename the unsupported Make declaration before planning again.",
      });
      expect(collision?.resolutions).toBeUndefined();
      expect(await readFile(`${repository.root}/Makefile`, "utf8")).toBe(originalMakefile);
    } finally {
      await Promise.all([runtime.dispose(), repository.cleanup()]);
    }
  });

  it("preserves an unrelated Makefile exactly across install and remove", async () => {
    const originalMakefile = "custom:\n\t@echo keep-me\n";
    const repository = await createTempRepository({
      "go.mod": "module example.com/preserved-make\n\ngo 1.24\n",
      Makefile: originalMakefile,
    });
    await exec("git", ["init", "--quiet", repository.root]);
    const runtime = await createDefaultApplication({ executableProbe: probe });
    try {
      const baseline = await runtime.application.scan(repository.root);
      if (baseline.kind !== "ready") {
        throw new Error("Expected Make preservation fixture scan to be ready");
      }
      const prepared = await runtime.application.prepareInstall(
        baseline,
        [componentRef("skill:configure-go-quality")],
        [codex],
      );
      if (prepared.plan?.kind !== "ready") {
        throw new Error("Expected non-colliding Makefile plan to be ready");
      }
      expect((await runtime.application.apply(prepared.plan)).kind).toBe("applied");
      const installed = await readFile(`${repository.root}/Makefile`, "utf8");
      expect(installed).toContain(originalMakefile);
      expect(installed).toContain('# ai-harness:managed:start id="verification.go-quality"');

      const scan = await runtime.application.scan(repository.root);
      const removal = await runtime.application.prepareRemove(scan, { all: true });
      if (removal.plan?.kind !== "ready") {
        throw new Error("Expected Make preservation removal plan to be ready");
      }
      expect((await runtime.application.apply(removal.plan)).kind).toBe("applied");
      expect(await readFile(`${repository.root}/Makefile`, "utf8")).toBe(originalMakefile);
    } finally {
      await Promise.all([runtime.dispose(), repository.cleanup()]);
    }
  });

  it("blocks quality setup when Make is unavailable", async () => {
    const repository = await createTempRepository({ "go.mod": "module example.com/no-make\n" });
    await exec("git", ["init", "--quiet", repository.root]);
    const missingMakeProbe: ExecutableProbe = {
      async probe(executable) {
        return executable === "make"
          ? { detected: false, path: null, version: null, diagnostics: [] }
          : { detected: true, path: "/test/bin/codex", version: "test", diagnostics: [] };
      },
    };
    const runtime = await createDefaultApplication({ executableProbe: missingMakeProbe });
    try {
      const scan = await runtime.application.scan(repository.root);
      if (scan.kind !== "ready") {
        throw new Error("Expected missing Make fixture scan to be ready");
      }
      const prepared = await runtime.application.prepareInstall(
        scan,
        [componentRef("skill:configure-go-quality")],
        [codex],
      );

      expect(prepared.plan?.kind).toBe("blocked");
      expect(prepared.plan?.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        "quality.make.missing",
      );
    } finally {
      await Promise.all([runtime.dispose(), repository.cleanup()]);
    }
  });

  it("preserves foreign or drifted core.hooksPath values", async () => {
    const repository = await createTempRepository({ "go.mod": "module example.com/git-policy\n" });
    await exec("git", ["init", "--quiet", repository.root]);
    await exec("git", ["-C", repository.root, "config", "--local", "core.hooksPath", ".custom-hooks"]);
    const runtime = await createDefaultApplication({ executableProbe: probe });
    try {
      const baseline = await runtime.application.scan(repository.root);
      if (baseline.kind !== "ready") {
        throw new Error("Expected Git policy fixture scan to be ready");
      }
      const foreign = await runtime.application.prepareInstall(
        baseline,
        [componentRef("git-gate:pre-commit-check")],
        [codex],
      );
      expect(foreign.plan?.kind).toBe("blocked");
      expect(foreign.plan?.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        "planning.git-config.foreign",
      );
      expect(await readFile(`${repository.root}/go.mod`, "utf8")).toContain("git-policy");

      await exec("git", ["-C", repository.root, "config", "--local", "--unset-all", "core.hooksPath"]);
      const clean = await runtime.application.scan(repository.root);
      if (clean.kind !== "ready") {
        throw new Error("Expected reconciled Git policy scan to be ready");
      }
      const install = await runtime.application.prepareInstall(
        clean,
        [componentRef("git-gate:pre-commit-check")],
        [codex],
      );
      if (install.plan?.kind !== "ready") {
        throw new Error("Expected gate plan after foreign policy removal");
      }
      expect((await runtime.application.apply(install.plan)).kind).toBe("applied");
      await exec("git", ["-C", repository.root, "config", "--local", "core.hooksPath", ".changed"]);

      const status = await runtime.application.status(repository.root, [codex]);
      expect(status.verification?.materialization).toBe("drift");
      expect(status.scan.kind).toBe("ready");
      if (status.scan.kind === "ready") {
        expect(status.scan.reconciliation.units).toContainEqual(
          expect.objectContaining({
            ownershipId: "project.git-gates.activation",
            classification: "drifted",
          }),
        );
      }
      const drifted = await runtime.application.scan(repository.root);
      const removal = await runtime.application.prepareRemove(drifted, { all: true });
      expect(removal.plan?.kind).toBe("blocked");
      expect(removal.plan?.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        "planning.git-config.drift",
      );
      expect(
        (await exec("git", ["-C", repository.root, "config", "--local", "--get", "core.hooksPath"]))
          .stdout.trim(),
      ).toBe(".changed");
    } finally {
      await Promise.all([runtime.dispose(), repository.cleanup()]);
    }
  });

  it("blocks activation that would hide an existing executable Git hook", async () => {
    const repository = await createTempRepository({ "go.mod": "module example.com/existing-hook\n" });
    await exec("git", ["init", "--quiet", repository.root]);
    const existingHook = join(repository.root, ".git", "hooks", "commit-msg");
    await writeFile(existingHook, "#!/bin/sh\nexit 0\n");
    await chmod(existingHook, 0o755);
    const runtime = await createDefaultApplication({ executableProbe: probe });
    try {
      const scan = await runtime.application.scan(repository.root);
      if (scan.kind !== "ready") {
        throw new Error("Expected existing hook fixture scan to be ready");
      }
      const prepared = await runtime.application.prepareInstall(
        scan,
        [componentRef("git-gate:pre-commit-check")],
        [codex],
      );

      expect(prepared.plan?.kind).toBe("blocked");
      expect(prepared.plan?.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        "quality.git-hooks.conflict",
      );
      expect(await readFile(existingHook, "utf8")).toBe("#!/bin/sh\nexit 0\n");
      await expect(readFile(join(repository.root, "Makefile"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await Promise.all([runtime.dispose(), repository.cleanup()]);
    }
  });
});

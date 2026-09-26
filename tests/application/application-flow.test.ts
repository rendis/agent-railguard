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

describe("RailguardApplication", () => {
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
          "project.agent-hooks",
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
      await expect(readFile(`${repository.root}/Makefile`, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        readFile(`${repository.root}/.railguard/hooks/pre-commit`, "utf8"),
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
      await expect(readFile(`${repository.root}/CLAUDE.md`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
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

  it("installs testing skills without changing unrelated tracked environment files", async () => {
    const repository = await createTempRepository({
      "go.mod": "module example.com/gated\n",
      ".env-local": "DB_HOST=127.0.0.1\nDB_PASS=\n",
    });
    await exec("git", ["init", "--quiet", repository.root]);
    await exec("git", ["-C", repository.root, "add", "."]);
    const runtime = await createDefaultApplication({ executableProbe: probe });
    try {
      const scan = await runtime.application.scan(repository.root);
      const prepared = await runtime.application.prepareInstall(scan, [componentRef("pack:testing-foundation")], [codex]);

      expect(prepared.plan?.kind).toBe("ready");
      if (prepared.plan?.kind !== "ready") throw new Error("Expected a ready plan");
      expect(prepared.plan.operations.some((operation) => operation.path === ".env-local")).toBe(false);
      expect((await runtime.application.apply(prepared.plan)).kind).toBe("applied");
      expect(await readFile(join(repository.root, ".env-local"), "utf8"))
        .toBe("DB_HOST=127.0.0.1\nDB_PASS=\n");
      expect((await exec("git", ["-C", repository.root, "diff", "--", ".env-local"])).stdout).toBe("");
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
        ".railguard",
        ".railguard/hooks",
        ".railguard/hooks/pre-commit",
        ".railguard/hooks/pre-push",
        "AGENTS.md",
        ".railguard/project.yaml",
        ".railguard/lock.json",
        ".git/config",
      ]);
      expect((await runtime.application.apply(prepared.plan)).kind).toBe("applied");

      expect(await readFile(`${repository.root}/.railguard/hooks/pre-commit`, "utf8")).toContain(
        "railguard check --changed",
      );
      expect(await readFile(`${repository.root}/.railguard/hooks/pre-push`, "utf8")).toContain(
        "railguard verify --changed",
      );
      await expect(readFile(`${repository.root}/Makefile`, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(
        (await exec("git", ["-C", repository.root, "config", "--local", "--get", "core.hooksPath"]))
          .stdout.trim(),
      ).toBe(".railguard/hooks");

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
        `${repository.root}/.railguard/hooks/pre-commit`,
        "utf8",
      );
      // Both operations for the same event compose into one hook; verify wins over check.
      expect(composedHook).toContain("railguard verify --changed");
      expect(composedHook).not.toContain("railguard check --changed");
      await expect(
        readFile(`${repository.root}/.railguard/hooks/pre-push`, "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });

      const installed = await runtime.application.scan(repository.root);
      const partial = await runtime.application.prepareRemove(installed, {
        components: [preCommitVerify],
      });

      expect(partial.resolution.components.map((component) => component.ref)).toEqual([
        "verification-profile:go-quality",
        "git-gate:pre-commit-check",
      ]);
      if (partial.plan?.kind !== "ready") throw new Error("Expected ready partial removal");
      expect((await runtime.application.apply(partial.plan)).kind).toBe("applied");
      const retainedHook = await readFile(
        `${repository.root}/.railguard/hooks/pre-commit`,
        "utf8",
      );
      expect(retainedHook).not.toContain("railguard verify --changed");
      expect(retainedHook).toContain("railguard check --changed");
      const after = await runtime.application.scan(repository.root);
      if (after.kind !== "ready") throw new Error("Expected ready managed scan");
      expect(after.desired?.state.selections.map((entry) => entry.ref)).toEqual([
        preCommitCheck,
      ]);
      expect(after.reconciliation.management).toBe("managed");
    } finally {
      await Promise.all([runtime.dispose(), repository.cleanup()]);
    }
  });

  it("adopts the core.hooksPath a sibling worktree already set", async () => {
    const repository = await createTempRepository({ "go.mod": "module example.com/worktree\n" });
    await exec("git", ["init", "--quiet", repository.root]);
    await exec("git", ["-C", repository.root, "config", "--local", "core.hooksPath", ".railguard/hooks"]);
    const runtime = await createDefaultApplication({ executableProbe: probe });
    try {
      const baseline = await runtime.application.scan(repository.root);
      const install = await runtime.application.prepareInstall(
        baseline,
        [componentRef("git-gate:pre-commit-check")],
        [codex],
      );
      if (install.plan?.kind !== "ready") {
        throw new Error("Expected the shared hooks path to be adopted");
      }
      expect(install.plan.operations.map((operation) => operation.path)).not.toContain(".git/config");
      expect((await runtime.application.apply(install.plan)).kind).toBe("applied");

      const status = await runtime.application.status(repository.root, [codex]);
      expect(status.verification?.materialization).toBe("verified");
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

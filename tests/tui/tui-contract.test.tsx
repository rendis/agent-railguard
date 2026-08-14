import React from "react";
import { renderToString } from "ink";
import { render as renderInteractive } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";
import {
  componentRef,
  harnessTargetId,
} from "../../src/domain/shared/types.js";
import type {
  InteractionAction,
  InteractionSession,
  InteractionSnapshot,
} from "../../src/interaction/model.js";
import {
  AiHarnessTui,
  AiHarnessTuiFrame,
  type TuiUpdateUi,
} from "../../src/tui/app.js";
import {
  asciiMode,
  isResumableDraft,
  keyActions,
  layoutMode,
  paneWidths,
  terminalText,
} from "../../src/tui/presenter.js";

const originalAscii = process.env.AI_HARNESS_ASCII;
const originalTerm = process.env.TERM;

afterEach(() => {
  restoreEnvironment("AI_HARNESS_ASCII", originalAscii);
  restoreEnvironment("TERM", originalTerm);
});

describe("responsive TUI contract", () => {
  it.each([180, 120, 80])(
    "uses the full terminal height and anchors the action bar at the bottom at %i columns",
    (columns) => {
      const rows = 48;
      const frame = renderToString(
        <AiHarnessTuiFrame
          snapshot={draftingSnapshot()}
          root="/tmp/inventory-service"
          columns={columns}
          rows={rows}
          detailOpen={false}
          error={null}
        />,
        { columns },
      );
      const lines = frame.split("\n");

      expect(lines).toHaveLength(rows);
      expect(lines.at(-1)).toContain("[q] Quit");
    },
  );

  it("derives catalog pagination from the available terminal height", () => {
    const tallCatalog = Object.freeze({
      ...emptyDraftingSnapshot(),
      catalog: Object.freeze(Array.from({ length: 18 }, (_, index) =>
        catalogItem(`skill:catalog-item-${String(index + 1).padStart(2, "0")}`, "skill"))),
    });
    const high = renderToString(
      <AiHarnessTuiFrame
        snapshot={tallCatalog}
        root="/tmp/inventory-service"
        columns={180}
        rows={48}
        detailOpen={false}
        error={null}
        configureUi={{ filterIndex: 1, componentIndex: 0, targetIndex: 0, focus: "items" }}
      />,
      { columns: 180 },
    );
    const low = renderToString(
      <AiHarnessTuiFrame
        snapshot={tallCatalog}
        root="/tmp/inventory-service"
        columns={120}
        rows={24}
        detailOpen={false}
        error={null}
        configureUi={{ filterIndex: 1, componentIndex: 0, targetIndex: 0, focus: "items" }}
      />,
      { columns: 120 },
    );

    expect(high).toContain("Catalog Item 18");
    expect(high).not.toContain("Showing 1-");
    expect(low).toContain("Showing 1-");
    expect(low).not.toContain("Catalog Item 18");
    expect(low.split("\n")).toHaveLength(24);
  });

  it("stops after scan with a concise summary and no persistent task rail", () => {
    const frame = renderFrame(160, 40);

    expect(frame).toContain("SCAN COMPLETE");
    expect(frame).toContain("1 component recommendation");
    expect(frame).toContain("[Enter] Configure components");
    expect(frame).not.toContain("WORKFLOW");
    expect(frame).not.toContain("TASKS");
    expect(frame).not.toContain("OVERVIEW");
  });

  it("does not treat an empty draft as resumable user intent", () => {
    const emptyDraft = emptyDraftingSnapshot().draft;
    const browsing = Object.freeze({
      ...snapshot(),
      draft: emptyDraft,
    });
    const frame = renderToString(
      <AiHarnessTuiFrame
        snapshot={browsing}
        root="/tmp/inventory-service"
        columns={160}
        rows={40}
        detailOpen={false}
        error={null}
      />,
      { columns: 160 },
    );

    expect(isResumableDraft(emptyDraft)).toBe(false);
    expect(frame).toContain("[Enter] Configure components");
    expect(frame).not.toContain("Resume draft");
  });

  it("shows review blockers and never advertises Apply for a non-approvable plan", () => {
    const blocked = reviewingBlockedSnapshot();
    const frame = renderToString(
      <AiHarnessTuiFrame
        snapshot={blocked}
        root="/tmp/inventory-service"
        columns={180}
        rows={40}
        detailOpen={false}
        error={null}
      />,
      { columns: 180 },
    );

    expect(keyActions(blocked)).not.toContainEqual({ key: "Enter", label: "Apply exact plan" });
    expect(frame).not.toContain("[Enter] Apply exact plan");
    expect(frame).toContain("planning.managed-section.foreign");
    expect(frame).toContain("Resolve the reported collision");
  });

  it("shows exact Make collision evidence and a separate destructive confirmation", () => {
    const blocked = makeCollisionSnapshot();
    const review = renderToString(
      <AiHarnessTuiFrame
        snapshot={blocked}
        root="/tmp/inventory-service"
        columns={180}
        rows={40}
        detailOpen={false}
        error={null}
      />,
      { columns: 180 },
    );

    expect(keyActions(blocked)).toContainEqual({ key: "o", label: "Replace conflicting targets" });
    expect(review).toContain('Makefile defines unmanaged canonical target "check" at line');
    expect(review).toContain("113.");
    expect(review).toContain("Makefile:113");
    expect(review).toContain('target "check" at line 113: check: fmt test');
    expect(review).toContain("[o] Replace conflicting targets");
    expect(review).not.toContain("[Enter] Apply exact plan");

    const confirmation = renderToString(
      <AiHarnessTuiFrame
        snapshot={blocked}
        root="/tmp/inventory-service"
        columns={180}
        rows={40}
        detailOpen={false}
        error={null}
        makeCollisionConfirmation
      />,
      { columns: 180 },
    );
    expect(confirmation).toContain("CONFIRM MAKE TARGET REPLACEMENT");
    expect(confirmation).toContain("Existing prerequisites and recipes");
    expect(confirmation).toContain("No file is written now");
    expect(confirmation).toContain("[Enter] Replace and review plan");
    expect(confirmation).toContain("[Esc] Keep existing targets");
  });

  it("opens, cancels, and confirms Make replacement without dispatching Apply", async () => {
    const blocked = makeCollisionSnapshot();
    const actions: InteractionAction[] = [];
    const session: InteractionSession = {
      snapshot: blocked,
      async dispatch(action) {
        actions.push(action);
        return blocked;
      },
      subscribe() {
        return () => undefined;
      },
    };
    const tui = renderInteractive(
      <AiHarnessTui session={session} root="/tmp/inventory-service" />,
    );
    try {
      await waitForInteractiveFrame(tui, "REVIEW EXACT PLAN");
      tui.stdin.write("o");
      await waitForInteractiveFrame(tui, "CONFIRM MAKE TARGET REPLACEMENT");
      tui.stdin.write("\u001B");
      await waitForInteractiveFrame(tui, "REVIEW EXACT PLAN");
      expect(actions.filter((action) => action.type === "resolve-plan-blocker")).toEqual([]);

      tui.stdin.write("o");
      await waitForInteractiveFrame(tui, "CONFIRM MAKE TARGET REPLACEMENT");
      tui.stdin.write("\r");
      await waitForAction(actions, "resolve-plan-blocker");

      expect(actions).toContainEqual({
        type: "resolve-plan-blocker",
        code: "quality.make.target-collision",
        resolution: "replace",
      });
      expect(actions.some((action) => action.type === "approve-plan")).toBe(false);
    } finally {
      tui.unmount();
    }
  });

  it("separates catalog composition from target selection", () => {
    const components = renderToString(
      <AiHarnessTuiFrame
        snapshot={draftingSnapshot()}
        root="/tmp/inventory-service"
        columns={180}
        rows={48}
        detailOpen={false}
        error={null}
        composerStage="components"
        configureUi={{
          filterIndex: 1,
          componentIndex: 0,
          targetIndex: 0,
          focus: "items",
        }}
      />,
      { columns: 180 },
    );

    expect(components).toContain("CATALOG VIEWS");
    expect(components).toContain("All");
    expect(components).toMatch(/COMPONENTS\s+[|·]\s+ALL/);
    expect(components).toContain("ABOUT");
    expect(components).toContain("INSTALLATION DRAFT");
    expect(components).not.toContain("TARGETS · SELECT");
    expect(components).not.toContain("TASKS");

    const targets = renderToString(
      <AiHarnessTuiFrame
        snapshot={draftingSnapshot()}
        root="/tmp/inventory-service"
        columns={180}
        rows={48}
        detailOpen={false}
        error={null}
        composerStage="targets"
        configureUi={{
          filterIndex: 1,
          componentIndex: 0,
          targetIndex: 0,
          focus: "items",
        }}
      />,
      { columns: 180 },
    );

    expect(targets).toMatch(/TARGETS\s+[|·]\s+SELECT/);
    expect(targets).toContain("Codex");
    expect(targets).toContain("INSTALLATION DRAFT");
    expect(targets).not.toContain("COMPONENTS · ALL");
  });

  it.each([{ columns: 180, rows: 48 }, { columns: 140, rows: 30 }])(
    "explains concrete project changes and workflow impact at $columns x $rows",
    ({ columns, rows }) => {
    const baseline = emptyDraftingSnapshot();
    const frame = renderToString(
      <AiHarnessTuiFrame
        snapshot={Object.freeze({
          ...baseline,
          catalog: Object.freeze([
            Object.freeze({
              ...catalogItem("verification-profile:go-quality", "verification-profile"),
              impact: Object.freeze({
                changes: "Creates or updates AI Harness-managed sections in the root Makefile and exposes make check and make verify.",
                workflow: "Developers, skills and optional Git hooks share one verification contract; no hook is enabled by this component alone.",
              }),
            }),
          ]),
        })}
        root="/tmp/inventory-service"
        columns={columns}
        rows={rows}
        detailOpen={false}
        error={null}
        configureUi={{ filterIndex: 6, componentIndex: 0, targetIndex: 0, focus: "items" }}
      />,
      { columns },
    );

    expect(frame).toContain("CHANGES");
    expect(frame).toContain("root Makefile");
    expect(frame).toContain("make check");
    expect(frame).toContain("WORKFLOW IMPACT");
    expect(frame).toContain("no hook is enabled");
    expect(frame.split("\n")).toHaveLength(rows);
  });

  it("groups every component family in All and exposes Installed only for managed projects", () => {
    const baseline = draftingSnapshot();
    const catalog = Object.freeze([
      catalogItem("pack:foundation", "pack"),
      catalogItem("skill:tdd", "skill"),
      catalogItem("mcp:context7", "mcp-integration"),
      catalogItem("agent:reviewer", "agent"),
      catalogItem("verification-profile:go-quality", "verification-profile"),
      catalogItem("git-gate:pre-commit-check", "git-gate"),
    ]);
    const managed = Object.freeze({
      ...baseline,
      catalog,
      repository: Object.freeze({
        ...baseline.repository!,
        management: "managed" as const,
        installedDirectSelections: Object.freeze([componentRef("skill:tdd")]),
        installedComponents: Object.freeze([componentRef("skill:tdd")]),
      }),
    });
    const all = renderToString(
      <AiHarnessTuiFrame
        snapshot={managed}
        root="/tmp/inventory-service"
        columns={220}
        rows={48}
        detailOpen={false}
        error={null}
        configureUi={{ filterIndex: 1, componentIndex: 0, targetIndex: 0, focus: "items" }}
      />,
      { columns: 220 },
    );
    expect(all).toContain("PACKS");
    expect(all).toContain("SKILLS");
    expect(all).toContain("MCP");
    expect(all).toContain("AGENTS");
    expect(all).toContain("QUALITY");
    expect(all).toContain("PRE-COMMIT");
    expect(all).toMatch(/Go Quality\s+[|·]\s+Check/);
    expect(all).toContain("make check");
    expect(all).not.toContain("AUTOMATION");
    expect(all).not.toContain("INSTRUCTIONS");

    const installed = renderToString(
      <AiHarnessTuiFrame
        snapshot={managed}
        root="/tmp/inventory-service"
        columns={180}
        rows={40}
        detailOpen={false}
        error={null}
        configureUi={{ filterIndex: 8, componentIndex: 0, targetIndex: 0, focus: "items" }}
      />,
      { columns: 180 },
    );
    expect(installed).toContain("Installed");
    expect(installed).toMatch(/CATALOG\s+[|·]\s+1 items/);
    expect(installed).toContain("TDD");
  });

  it("keeps installed OAuth MCP session actions available after a rescan", () => {
    const baseline = snapshot();
    const atlassian = Object.freeze({
      ...catalogItem("mcp:atlassian-rovo", "mcp-integration"),
      mcpAuth: "oauth" as const,
    });
    const managed: InteractionSnapshot = Object.freeze({
      ...baseline,
      repository: Object.freeze({
        ...baseline.repository!,
        management: "managed" as const,
        integrity: "clean" as const,
        installedDirectSelections: Object.freeze([atlassian.ref]),
        installedComponents: Object.freeze([atlassian.ref]),
        installedTargets: Object.freeze([harnessTargetId("codex")]),
      }),
      catalog: Object.freeze([atlassian]),
    });

    expect(keyActions(managed).map(({ label }) => label)).toEqual(expect.arrayContaining([
      "Check MCP authentication",
      "Authenticate MCP",
      "Logout MCP",
    ]));
    const browsing = renderToString(
      <AiHarnessTuiFrame
        snapshot={managed}
        root="/tmp/inventory-service"
        columns={180}
        rows={30}
        detailOpen={false}
        error={null}
      />,
      { columns: 180 },
    );
    expect(browsing).toContain("[c] Check MCP authentication");
    expect(browsing).toContain("[l] Logout MCP");

    const confirmation = renderToString(
      <AiHarnessTuiFrame
        snapshot={managed}
        root="/tmp/inventory-service"
        columns={180}
        rows={30}
        detailOpen={false}
        error={null}
        mcpLogoutConfirmation={atlassian.ref}
      />,
      { columns: 180 },
    );
    expect(confirmation).toContain("CONFIRM MCP LOGOUT");
    expect(confirmation).toContain("does not uninstall project configuration");
    expect(confirmation).toContain("[Enter] Confirm logout");

    const result = renderToString(
      <AiHarnessTuiFrame
        snapshot={Object.freeze({
          ...managed,
          phase: "receipted" as const,
          mcpSession: Object.freeze({
            operation: "inspect" as const,
            component: atlassian.ref,
            results: Object.freeze([
              Object.freeze({
                target: harnessTargetId("codex"),
                state: "authentication-unknown" as const,
                action: null,
                message: "Codex owns the OAuth session state.",
              }),
            ]),
          }),
        })}
        root="/tmp/inventory-service"
        columns={180}
        rows={30}
        detailOpen={false}
        error={null}
      />,
      { columns: 180 },
    );
    expect(result).toContain("MCP AUTHENTICATION");
    expect(result).toContain("authentication-unknown");
    expect(result).toContain("Project materialization and its receipt were not changed");
  });

  it("uses the approved deterministic breakpoints", () => {
    expect(layoutMode(160, 40)).toBe("wide");
    expect(layoutMode(140, 30)).toBe("wide");
    expect(layoutMode(120, 30)).toBe("medium");
    expect(layoutMode(90, 24)).toBe("medium");
    expect(layoutMode(89, 24)).toBe("compact");
    expect(layoutMode(70, 20)).toBe("compact");
    expect(layoutMode(60, 18)).toBe("compact");
    expect(layoutMode(59, 40)).toBe("unsupported");
    expect(layoutMode(120, 17)).toBe("unsupported");
    expect(paneWidths("wide", 160)).toEqual({ navigation: 36, detail: 44 });
    expect(paneWidths("medium", 120)).toEqual({ navigation: 40, detail: 0 });
  });

  it.each([
    { columns: 160, rows: 40 },
    { columns: 120, rows: 30 },
    { columns: 80, rows: 24 },
    { columns: 60, rows: 18 },
  ])(
    "keeps the completed scan concise and actionable at $columns x $rows",
    ({ columns, rows }) => {
      const frame = renderFrame(columns, rows);

      expect(frame).toContain("SCAN COMPLETE");
      expect(frame).toMatch(/No project changes were\s+made/);
      expect(frame).toContain("1 component recommendation");
      expect(frame).toContain("[Enter] Configure components");
      expect(frame).toContain("[d] Scan details");
      expect(frame).not.toContain("TASKS");
      expect(frame).not.toContain("...");
      expect(frame).not.toContain("…");
    },
  );

  it("shows only an actionable terminal-size requirement below the minimum", () => {
    const frame = renderFrame(59, 18);

    expect(frame).toContain("TERMINAL SIZE REQUIRED");
    expect(frame).toContain("59 columns");
    expect(frame).toContain("Resize to at least 60");
    expect(frame).not.toContain("RECOMMENDED SETUP");
    expect(frame).not.toContain("Draft:");
  });

  it("renders a strictly ASCII frame when requested", () => {
    process.env.AI_HARNESS_ASCII = "1";
    process.env.TERM = "dumb";

    expect(asciiMode()).toBe(true);
    expect(terminalText("Scan · inventory → done ✓")).toBe(
      "Scan | inventory -> done v",
    );
    const frame = renderFrame(120, 30);
    expect(frame).toMatch(/^[\x00-\x7F]*$/);
    expect(frame).toContain("SCAN COMPLETE");
    expect(frame).toContain("[Enter] Configure components");
  });

  it.each([160, 120, 80, 60])(
    "keeps the exact CLI update review and action visible at %i columns",
    (columns) => {
      const frame = renderFrame(columns, columns >= 140 ? 40 : columns >= 90 ? 30 : 24, availableUpdate("reviewing"));

      expect(frame).toContain("REVIEW CLI UPDATE");
      expect(frame).toContain("Installed");
      expect(frame).toContain("0.1.0");
      expect(frame).toContain("0.2.0");
      expect(frame).toMatch(/Download and verify the exact artifact size and\s+SHA-256/);
      expect(frame).toContain("[Enter] Apply verified CLI update");
      expect(frame).not.toContain("...");
      expect(frame).not.toContain("…");
    },
  );

  it.each([180, 80])(
    "keeps the complete cross-family draft visible at %i columns independently of the active filter",
    (columns) => {
      const frame = renderToString(
        <AiHarnessTuiFrame
          snapshot={draftingSnapshot()}
          root="/tmp/inventory-service"
          columns={columns}
          rows={48}
          detailOpen={false}
          summaryOpen
          error={null}
          configureUi={{
            filterIndex: 4,
            componentIndex: 0,
            targetIndex: 0,
            focus: "items",
          }}
        />,
        { columns },
      );

      expect(frame).toContain("INSTALLATION SUMMARY");
      expect(frame).toContain("INSTALLATION DRAFT");
      expect(frame).toContain("DIRECT SELECTIONS (3)");
      expect(frame).toContain("[skill] TDD");
      expect(frame).toContain("[MCP] Context7");
      expect(frame).toContain("[agent] Go Reviewer");
      expect(frame).toContain("INCLUDED DEPENDENCIES (2)");
      expect(frame).toContain("Go Quality");
      expect(frame).toContain("Test Go Service");
      expect(frame).not.toContain("TARGETS (1)");
      expect(frame).toContain("Targets are selected in the next step.");
      expect(frame).not.toContain("additional requirements");
    },
  );

  it("keeps wide pane dividers fixed when a selection expands the dependency closure", () => {
    process.env.AI_HARNESS_ASCII = "1";
    const columns = 220;
    const frame = renderToString(
      <AiHarnessTuiFrame
        snapshot={crowdedDraftingSnapshot()}
        root="/tmp/inventory-service"
        columns={columns}
        rows={48}
        detailOpen={false}
        error={null}
        configureUi={{
          filterIndex: 1,
          componentIndex: 0,
          targetIndex: 0,
          focus: "items",
        }}
      />,
      { columns },
    );
    const navigationLine = frame
      .split("\n")
      .find((line) => line.includes("CATALOG VIEWS") && line.includes("ABOUT"));
    expect(navigationLine).toBeDefined();
    expect(frame).toMatch(/Develop Go[\s|]+Hexagonal Service/);
    const dividers = [...navigationLine!.matchAll(/\|/g)].map((match) => match.index);
    const widths = paneWidths("wide", columns);

    expect(dividers).toEqual(expect.arrayContaining([
      widths.navigation - 1,
      columns - widths.detail - 1,
    ]));
  });

  it.each([180, 100, 70])(
    "shows the focused summary and a responsive information view at %i columns",
    (columns) => {
      const configureUi = {
        filterIndex: 5,
        componentIndex: 0,
        targetIndex: 0,
        focus: "items" as const,
      };
      const summary = renderToString(
        <AiHarnessTuiFrame
          snapshot={draftingSnapshot()}
          root="/tmp/inventory-service"
          columns={columns}
          rows={40}
          detailOpen={false}
          informationOpen={false}
          error={null}
          configureUi={configureUi}
        />,
        { columns },
      );
      if (columns >= 140) {
        expect(summary).toContain("ABOUT");
        expect(summary).toContain("TUI selection summary fixture");
      } else {
        expect(summary).not.toContain("TUI selection summary fixture");
      }
      expect(summary).toContain("[i] Information");
      expect(summary).not.toContain("Complete fixture guidance");

      const information = renderToString(
        <AiHarnessTuiFrame
          snapshot={draftingSnapshot()}
          root="/tmp/inventory-service"
          columns={columns}
          rows={40}
          detailOpen={false}
          informationOpen
          error={null}
          configureUi={configureUi}
        />,
        { columns },
      );
      expect(information).toContain("COMPONENT INFORMATION");
      expect(information).toContain("Go Reviewer");
      expect(information).toContain("TUI selection summary fixture");
      expect(information).toContain("Complete fixture guidance for understanding");
      expect(information).toContain("outcome it provides.");
      expect(information).toContain("[i] Close");
    },
  );

  it("shows only keyboard actions that can affect the focused configure collection", () => {
    const emptyFilter = renderToString(
      <AiHarnessTuiFrame
        snapshot={emptyDraftingSnapshot()}
        root="/tmp/inventory-service"
        columns={180}
        rows={40}
        detailOpen={false}
        error={null}
        configureUi={{
          filterIndex: 6,
          componentIndex: 0,
          targetIndex: 0,
          focus: "items",
        }}
      />,
      { columns: 180 },
    );

    expect(emptyFilter).not.toMatch(/\[(?:↑↓|Up\/Down)\] Move/);
    expect(emptyFilter).not.toContain("[Space] Toggle");
    expect(emptyFilter).not.toContain("[Enter] Select targets");
    expect(emptyFilter).toContain("[Left] Catalog views");

    const singleItem = renderToString(
      <AiHarnessTuiFrame
        snapshot={draftingSnapshot()}
        root="/tmp/inventory-service"
        columns={180}
        rows={40}
        detailOpen={false}
        error={null}
        configureUi={{
          filterIndex: 5,
          componentIndex: 0,
          targetIndex: 0,
          focus: "items",
        }}
      />,
      { columns: 180 },
    );

    expect(singleItem).not.toMatch(/\[(?:↑↓|Up\/Down)\] Move/);
    expect(singleItem).toContain("[Space] Toggle");
    expect(singleItem).toContain("[Enter] Select targets");
  });

  it("presents scan and blocking diagnostics as dedicated gates", () => {
    const scan = renderFrame(180, 40);
    expect(scan).toContain("SCAN COMPLETE");
    expect(scan).not.toContain("WORKFLOW");
    expect(scan).not.toContain("Overview");
    expect(scan).not.toContain("TASKS");

    const blocked = renderToString(
      <AiHarnessTuiFrame
        snapshot={blockedSnapshot()}
        root="/tmp/inventory-service"
        columns={180}
        rows={40}
        detailOpen={false}
        error={null}
      />,
      { columns: 180 },
    );
    expect(blocked).toContain("DIAGNOSTICS");
    expect(blocked).toContain("Resolve the condition and rescan.");
    expect(blocked).not.toContain("WORKFLOW");
  });

  it("shows update progress, rollback protection and restart outcome", () => {
    const applying = renderFrame(120, 30, availableUpdate("applying"));
    expect(applying).toContain("APPLY CLI UPDATE");
    expect(applying).toContain("Install verified CLI candidate");
    expect(applying).toContain("rollback protection");

    const applied = renderFrame(120, 30, availableUpdate("applied"));
    expect(applied).toContain("CLI UPDATE APPLIED");
    expect(applied).toContain("Restart AI Harness");
    expect(applied).toContain("[q] Quit and restart");
  });
});

function renderFrame(columns: number, rows: number, updateUi?: TuiUpdateUi): string {
  return renderToString(
    <AiHarnessTuiFrame
      snapshot={snapshot()}
      root="/tmp/inventory-service"
      columns={columns}
      rows={rows}
      detailOpen={false}
      error={null}
      {...(updateUi === undefined ? {} : { updateUi })}
    />,
    { columns },
  );
}

function availableUpdate(phase: TuiUpdateUi["phase"]): TuiUpdateUi {
  const digest = `sha256:${"a".repeat(64)}` as const;
  const manifest = Object.freeze({
    schema: "ai-harness/release-manifest/v1" as const,
    channel: "stable",
    source: Object.freeze({ commit: "abc123", tree: "def456", input_digest: digest }),
    release: Object.freeze({
      name: "@example/ai-harness" as const,
      version: "0.2.0",
      runtime: Object.freeze({
        node: ">=24.19.0 <25.0.0" as const,
        pnpm: ">=11.21.0 <12.0.0" as const,
      }),
      artifact: Object.freeze({ path: "ai-harness-0.2.0.tgz", sha256: digest, size: 12345 }),
      sbom: Object.freeze({ path: "ai-harness-0.2.0.sbom.json", sha256: digest, size: 120 }),
      notices: Object.freeze({ path: "THIRD_PARTY_NOTICES.txt", sha256: digest, size: 80 }),
      notes: Object.freeze(["Verified TUI update flow"]),
    }),
    authentication: Object.freeze({
      kind: "external-https-channel" as const,
      manifest_authentication: "Corporate HTTPS channel",
    }),
    content: Object.freeze({ manifest: Object.freeze({ path: "content-manifest.json" }) }),
  });
  const release = Object.freeze({
    manifestUrl: new URL("https://releases.example.test/stable/release-manifest.json"),
    artifactUrl: new URL("https://releases.example.test/stable/ai-harness-0.2.0.tgz"),
    contentManifestUrl: new URL("https://releases.example.test/stable/content-manifest.json"),
    manifest,
  });
  return Object.freeze({
    phase,
    result: Object.freeze({
      status: phase === "applied" ? "applied" as const : "available" as const,
      currentVersion: "0.1.0",
      latestVersion: "0.2.0",
      release,
      diagnostics: Object.freeze([]),
    }),
  });
}

function snapshot(): InteractionSnapshot {
  return Object.freeze({
    operationId: "11111111-1111-4111-8111-111111111111",
    phase: "browsing",
    tasks: Object.freeze([
      Object.freeze({
        id: "scan.inventory",
        label: "Scan repository inventory and managed artifacts",
        detail: "Repository inventory completed",
        state: "done" as const,
      }),
      Object.freeze({
        id: "recommend.compute",
        label: "Compute catalog recommendations for detected languages",
        detail: "Catalog recommendations computed",
        state: "done" as const,
      }),
    ]),
    repository: Object.freeze({
      root: "/tmp/inventory-service",
      fingerprint: `sha256:${"1".repeat(64)}`,
      languages: Object.freeze(["go"]),
      management: "uninitialized" as const,
      integrity: "unknown" as const,
      readiness: "ready" as const,
      updates: "unknown" as const,
      installedDirectSelections: Object.freeze([]),
      installedComponents: Object.freeze([]),
      installedTargets: Object.freeze([]),
      harnesses: Object.freeze([
        Object.freeze({
          id: harnessTargetId("codex"),
          detected: true,
          version: "codex 1.0.0",
          ready: true,
        }),
      ]),
    }),
    catalog: Object.freeze([]),
    recommendations: Object.freeze([
      Object.freeze({
        ref: componentRef("verification-profile:go-quality"),
        version: "1.0.0",
        reasons: Object.freeze(["language:go"]),
      }),
    ]),
    draft: null,
    plan: null,
    receipt: null,
    mcpSession: null,
    diagnostics: Object.freeze([]),
    cancellationRequested: false,
  });
}

function draftingSnapshot(): InteractionSnapshot {
  const baseline = snapshot();
  return Object.freeze({
    ...baseline,
    phase: "drafting" as const,
    catalog: Object.freeze([
      catalogItem("skill:tdd", "skill"),
      catalogItem("mcp:context7", "mcp-integration"),
      catalogItem("agent:go-reviewer", "agent"),
    ]),
    draft: Object.freeze({
      directSelections: Object.freeze([
        componentRef("skill:tdd"),
        componentRef("mcp:context7"),
        componentRef("agent:go-reviewer"),
      ]),
      selectionInputs: Object.freeze([]),
      targets: Object.freeze([harnessTargetId("codex")]),
      components: Object.freeze([
        draftComponent("skill:tdd", "direct"),
        draftComponent("mcp:context7", "direct"),
        draftComponent("agent:go-reviewer", "direct"),
        draftComponent("verification-profile:go-quality", "required"),
        draftComponent("skill:test-go-service", "required"),
      ]),
      blocked: false,
    }),
  });
}

function crowdedDraftingSnapshot(): InteractionSnapshot {
  const baseline = draftingSnapshot();
  const direct = Object.freeze([
    componentRef("mcp:context7"),
    componentRef("pack:go-service-foundation"),
  ]);
  const required = Object.freeze([
    "skill:design-tests",
    "skill:build-e2e-test-suite",
    "skill:tdd",
    "skill:test-go-service",
    "verification-profile:go-quality",
    "git-gate:pre-commit-check",
    "git-gate:pre-push-verify",
    "skill:configure-go-quality",
    "skill:review-go-quality",
    "agent:go-reviewer",
    "skill:develop-go-hexagonal-service",
  ].map(componentRef));
  return Object.freeze({
    ...baseline,
    catalog: Object.freeze([
      catalogItem("pack:go-service-foundation", "pack"),
      catalogItem("mcp:context7", "mcp-integration"),
    ]),
    draft: Object.freeze({
      ...baseline.draft!,
      directSelections: direct,
      components: Object.freeze([
        ...direct.map((ref) => draftComponent(ref, "direct")),
        ...required.map((ref) => draftComponent(ref, "required")),
      ]),
    }),
  });
}

function emptyDraftingSnapshot(): InteractionSnapshot {
  const baseline = draftingSnapshot();
  return Object.freeze({
    ...baseline,
    draft: Object.freeze({
      ...baseline.draft!,
      directSelections: Object.freeze([]),
      selectionInputs: Object.freeze([]),
      targets: Object.freeze([]),
      components: Object.freeze([]),
    }),
  });
}

function blockedSnapshot(): InteractionSnapshot {
  const baseline = snapshot();
  return Object.freeze({
    ...baseline,
    phase: "blocked" as const,
    diagnostics: Object.freeze([
      Object.freeze({
        code: "repository.readiness.blocked",
        severity: "blocked" as const,
        location: null,
        message: "Repository readiness check failed.",
        evidence: Object.freeze([]),
        impact: "No changes can be applied.",
        action: "Resolve the condition and rescan.",
      }),
    ]),
  });
}

function reviewingBlockedSnapshot(): InteractionSnapshot {
  const baseline = draftingSnapshot();
  return Object.freeze({
    ...baseline,
    phase: "reviewing" as const,
    plan: Object.freeze({
      kind: "blocked" as const,
      id: null,
      mode: "reconcile" as const,
      changes: Object.freeze([]),
      approvable: false,
      review: null,
      publicPlan: null,
    }),
    diagnostics: Object.freeze([
      Object.freeze({
        code: "planning.managed-section.foreign",
        severity: "blocked" as const,
        location: null,
        message: "A matching managed marker exists without portable ownership.",
        evidence: Object.freeze([]),
        impact: "AI Harness will not adopt or overwrite the unowned block.",
        action: "Resolve the reported collision or unsafe evidence, then generate a new plan.",
      }),
    ]),
  });
}

function makeCollisionSnapshot(): InteractionSnapshot {
  const baseline = draftingSnapshot();
  return Object.freeze({
    ...baseline,
    phase: "reviewing" as const,
    plan: Object.freeze({
      kind: "blocked" as const,
      id: null,
      mode: "reconcile" as const,
      changes: Object.freeze([]),
      approvable: false,
      review: null,
      publicPlan: null,
    }),
    diagnostics: Object.freeze([
      Object.freeze({
        code: "quality.make.target-collision",
        severity: "blocked" as const,
        location: Object.freeze({ path: "Makefile", pointer: "line:113" }),
        message: 'Makefile defines unmanaged canonical target "check" at line 113.',
        evidence: Object.freeze(['target "check" at line 113: check: fmt test']),
        impact: "AI Harness cannot own the canonical verification entrypoint while this rule remains.",
        action: "Choose explicit replacement to remove this rule, or rename it before planning again.",
        resolutions: Object.freeze([
          Object.freeze({
            action: "replace" as const,
            label: "Replace conflicting Make targets",
            destructive: true,
          }),
        ]),
      }),
    ]),
  });
}

async function waitForInteractiveFrame(
  tui: ReturnType<typeof renderInteractive>,
  text: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (tui.lastFrame()?.includes(text) === true) return;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 5));
  }
  throw new Error(`Timed out waiting for frame containing ${text}`);
}

async function waitForAction(
  actions: readonly InteractionAction[],
  type: InteractionAction["type"],
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (actions.some((action) => action.type === type)) return;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 5));
  }
  throw new Error(`Timed out waiting for action ${type}`);
}

function catalogItem(
  ref: string,
  kind: InteractionSnapshot["catalog"][number]["kind"],
): InteractionSnapshot["catalog"][number] {
  return Object.freeze({
    ref: componentRef(ref),
    kind,
    version: "1.0.0",
    description: "TUI selection summary fixture",
    details: "Complete fixture guidance for understanding when to use this component and what project outcome it provides.",
    impact: Object.freeze({
      changes: "Installs project-scoped component files managed by AI Harness.",
      workflow: "Makes this capability available without activating unrelated automation.",
    }),
    trust: "passive" as const,
    recommended: false,
    ...(kind === "git-gate"
      ? {
          gitGate: Object.freeze({
            event: "pre-commit" as const,
            operation: "check",
            provider: componentRef("verification-profile:go-quality"),
          }),
        }
      : {}),
  });
}

function draftComponent(
  ref: string,
  origin: "direct" | "required",
): NonNullable<InteractionSnapshot["draft"]>["components"][number] {
  return Object.freeze({
    ref: componentRef(ref),
    version: "1.0.0",
    origin,
    causes: Object.freeze([]),
    applicability: "portable" as const,
  });
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

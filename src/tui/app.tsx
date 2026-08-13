import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import type {
  DraftComponentView,
  InteractionPhase,
  InteractionSession,
  InteractionSnapshot,
  InteractionTask,
  PlannedChangeView,
} from "../interaction/model.js";
import type { ComponentRef, HarnessTargetId } from "../domain/shared/types.js";
import type { UpdateResult, UpdateService } from "../update/update-service.js";
import {
  basename,
  asciiMode,
  configureFilters,
  formatComponent,
  formatIdentifier,
  isCancellable,
  isMutating,
  isResumableDraft,
  isTransaction,
  keyActions,
  layoutMode,
  paneWidths,
  taskSymbol,
  taskTone,
  terminalText,
  transactionStep,
  transactionSteps,
  tuiBorderStyle,
  type LayoutMode,
  type KeyAction,
  type SemanticTone,
} from "./presenter.js";

export interface AiHarnessTuiProps {
  readonly session: InteractionSession;
  readonly root: string;
  readonly updateService?: Pick<UpdateService, "check" | "apply">;
  readonly currentVersion?: string;
}

export interface TuiUpdateUi {
  readonly phase:
    | "idle"
    | "checking"
    | "current"
    | "available"
    | "reviewing"
    | "applying"
    | "applied"
    | "unknown"
    | "failed"
    | "rolled-back";
  readonly result: UpdateResult | null;
}

const idleUpdateUi: TuiUpdateUi = Object.freeze({ phase: "idle", result: null });

interface ConfigureUi {
  readonly filterIndex: number;
  readonly componentIndex: number;
  readonly targetIndex: number;
  readonly focus: "filters" | "items";
  readonly searchQuery?: string;
  readonly searchActive?: boolean;
}

type ComposerStage = "components" | "targets";

export interface AiHarnessTuiFrameProps {
  readonly snapshot: InteractionSnapshot;
  readonly root: string;
  readonly columns: number;
  readonly rows: number;
  readonly detailOpen: boolean;
  readonly informationOpen?: boolean;
  readonly summaryOpen?: boolean;
  readonly error: string | null;
  readonly configureUi?: ConfigureUi;
  readonly composerStage?: ComposerStage;
  readonly updateUi?: TuiUpdateUi;
  readonly currentVersion?: string;
  readonly mcpLogoutConfirmation?: ComponentRef | null;
}

export function AiHarnessTui({
  session,
  root,
  updateService,
  currentVersion = "0.1.0",
}: AiHarnessTuiProps): React.JSX.Element {
  const [snapshot, setSnapshot] = useState(session.snapshot);
  const [error, setError] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [informationOpen, setInformationOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [composerStage, setComposerStage] = useState<ComposerStage>("components");
  const [filterIndex, setFilterIndex] = useState(0);
  const [componentIndex, setComponentIndex] = useState(0);
  const [targetIndex, setTargetIndex] = useState(0);
  const [configureFocus, setConfigureFocus] = useState<"filters" | "items">("filters");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchActive, setSearchActive] = useState(false);
  const [updateUi, setUpdateUi] = useState<TuiUpdateUi>(idleUpdateUi);
  const [mcpLogoutConfirmation, setMcpLogoutConfirmation] = useState<ComponentRef | null>(null);
  const filterIndexRef = useRef(0);
  const componentIndexRef = useRef(0);
  const targetIndexRef = useRef(0);
  const configureFocusRef = useRef<"filters" | "items">("filters");
  const searchQueryRef = useRef("");
  const searchActiveRef = useRef(false);
  const composerStageRef = useRef<ComposerStage>("components");
  const started = useRef(false);
  const updateStarted = useRef(false);
  const updateAbort = useRef<AbortController | null>(null);
  const phase = useRef(snapshot.phase);
  const app = useApp();
  const terminal = useWindowSize();

  const checkUpdate = (): void => {
    if (updateService === undefined || updateUi.phase === "checking" || updateUi.phase === "applying") {
      return;
    }
    updateStarted.current = true;
    const controller = new AbortController();
    updateAbort.current = controller;
    setUpdateUi(Object.freeze({ phase: "checking", result: null }));
    void updateService.check(currentVersion, controller.signal)
      .then((result) => {
        setUpdateUi(Object.freeze({ phase: updatePhase(result.status), result }));
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
        setUpdateUi(Object.freeze({ phase: "unknown", result: null }));
      })
      .finally(() => {
        if (updateAbort.current === controller) updateAbort.current = null;
      });
  };

  const applyUpdate = (): void => {
    if (updateService === undefined || updateUi.phase !== "reviewing") return;
    const controller = new AbortController();
    updateAbort.current = controller;
    setError(null);
    setUpdateUi(Object.freeze({ phase: "applying", result: updateUi.result }));
    void updateService.apply(currentVersion, controller.signal)
      .then((result) => {
        setUpdateUi(Object.freeze({ phase: updatePhase(result.status), result }));
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
        setUpdateUi(Object.freeze({ phase: "failed", result: updateUi.result }));
      })
      .finally(() => {
        if (updateAbort.current === controller) updateAbort.current = null;
      });
  };

  useEffect(() => {
    const unsubscribe = session.subscribe(({ snapshot: next }) => {
      if (phase.current !== next.phase) {
        phase.current = next.phase;
        setDetailOpen(false);
        setInformationOpen(false);
        setSummaryOpen(false);
        setMcpLogoutConfirmation(null);
        if (next.phase === "drafting") {
          const initialFilter = next.recommendations.length === 0 ? 1 : 0;
          setComposerStage("components");
          composerStageRef.current = "components";
          setFilterIndex(initialFilter);
          filterIndexRef.current = initialFilter;
          setComponentIndex(0);
          setTargetIndex(0);
          setConfigureFocus("filters");
          setSearchQuery("");
          setSearchActive(false);
          componentIndexRef.current = 0;
          targetIndexRef.current = 0;
          configureFocusRef.current = "filters";
          searchQueryRef.current = "";
          searchActiveRef.current = false;
        }
      }
      setSnapshot(next);
    });
    if (!started.current) {
      started.current = true;
      void session.dispatch({ type: "scan", root })
        .then(() => {
          if (updateService !== undefined && !updateStarted.current) checkUpdate();
        })
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : String(cause));
        });
    }
    return () => {
      unsubscribe();
      updateAbort.current?.abort();
    };
  }, [root, session, updateService]);

  const run = (operation: () => Promise<InteractionSnapshot>): void => {
    setError(null);
    void operation()
      .then(setSnapshot)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  };

  useInput((input, key) => {
    if (mcpLogoutConfirmation !== null) {
      if (key.escape) {
        setMcpLogoutConfirmation(null);
      } else if (key.return) {
        const component = mcpLogoutConfirmation;
        setMcpLogoutConfirmation(null);
        run(() => session.dispatch({
          type: "mcp-session",
          component,
          targets: sessionTargets(snapshot),
          operation: "logout",
        }));
      } else if (input === "q") {
        app.exit();
      }
      return;
    }
    if (summaryOpen) {
      if (input === "s" || key.escape) setSummaryOpen(false);
      else if (input === "q") app.exit();
      return;
    }
    if (informationOpen) {
      if (input === "i" || key.escape) setInformationOpen(false);
      else if (input === "q") app.exit();
      return;
    }
    if (updateUi.phase === "reviewing") {
      if (key.escape) {
        setUpdateUi(Object.freeze({ phase: "available", result: updateUi.result }));
      } else if (key.return) {
        applyUpdate();
      } else if (input === "q") {
        app.exit();
      }
      return;
    }
    if (updateUi.phase === "applying") {
      if (key.escape) updateAbort.current?.abort();
      return;
    }
    if (
      updateUi.phase === "applied" ||
      updateUi.phase === "failed" ||
      updateUi.phase === "rolled-back"
    ) {
      if (input === "o") setUpdateUi(Object.freeze({ phase: backgroundUpdatePhase(updateUi.result?.status ?? "unknown"), result: updateUi.result }));
      else if (input === "r") checkUpdate();
      else if (input === "q") app.exit();
      return;
    }
    if (searchActiveRef.current) {
      if (key.escape) {
        searchActiveRef.current = false;
        searchQueryRef.current = "";
        setSearchActive(false);
        setSearchQuery("");
        componentIndexRef.current = 0;
        setComponentIndex(0);
      } else if (key.return) {
        searchActiveRef.current = false;
        setSearchActive(false);
      } else if (key.backspace || key.delete) {
        const next = searchQueryRef.current.slice(0, -1);
        searchQueryRef.current = next;
        setSearchQuery(next);
        componentIndexRef.current = 0;
        setComponentIndex(0);
      } else if (!key.ctrl && !key.meta && input.length > 0) {
        const next = `${searchQueryRef.current}${input}`;
        searchQueryRef.current = next;
        setSearchQuery(next);
        componentIndexRef.current = 0;
        setComponentIndex(0);
      }
      return;
    }
    if (
      input === "/" &&
      snapshot.phase === "drafting" &&
      composerStageRef.current === "components"
    ) {
      searchActiveRef.current = true;
      setSearchActive(true);
      configureFocusRef.current = "items";
      setConfigureFocus("items");
      return;
    }
    if (
      input === "d" &&
      detailToggleAvailable(snapshot, layoutMode(terminal.columns, terminal.rows))
    ) {
      setDetailOpen((current) => !current);
      return;
    }
    if (
      input === "i" &&
      composerStageRef.current === "components" &&
      focusedCatalogItem(snapshot, {
        filterIndex: filterIndexRef.current,
        componentIndex: componentIndexRef.current,
        targetIndex: targetIndexRef.current,
        focus: configureFocusRef.current,
        searchQuery: searchQueryRef.current,
        searchActive: searchActiveRef.current,
      }) !== undefined
    ) {
      setInformationOpen(true);
      return;
    }
    if (input === "s" && snapshot.phase === "drafting") {
      setSummaryOpen(true);
      return;
    }
    if (input === "q" && !isMutating(snapshot.phase)) {
      app.exit();
      return;
    }
    if (key.escape && isCancellable(snapshot.phase)) {
      run(() => session.dispatch({ type: "cancel-operation" }));
      return;
    }
    if (snapshot.phase === "browsing") {
      const managed = snapshot.repository?.management !== "uninitialized";
      const component = installedOauthMcp(snapshot);
      if ((input === "c" || input === "a") && component !== null) {
        run(() => session.dispatch({
          type: "mcp-session",
          component,
          targets: sessionTargets(snapshot),
          operation: input === "c" ? "inspect" : "login",
        }));
        return;
      }
      if (input === "l" && component !== null) {
        setMcpLogoutConfirmation(component);
        return;
      }
      if (input === "u" && updateService !== undefined) {
        if (updateUi.phase === "available") {
          setUpdateUi(Object.freeze({ phase: "reviewing", result: updateUi.result }));
        } else {
          checkUpdate();
        }
        return;
      }
      if (key.return) {
        if (isResumableDraft(snapshot.draft)) {
          run(() =>
            session.dispatch({
              type: "replace-draft",
              selections: snapshot.draft!.selectionInputs,
              targets: snapshot.draft!.targets,
            }),
          );
          return;
        }
        run(() =>
          session.dispatch({
            type: "compose-draft",
            base: managed ? "installed" : "empty",
            recommended: false,
            add: [],
            remove: [],
            setInputs: [],
            targets: managed ? null : [],
          }),
        );
        return;
      }
    }
    if (snapshot.phase === "drafting") {
      const filters = availableConfigureFilters(snapshot);
      const items = filteredCatalog(snapshot, filterIndexRef.current, searchQueryRef.current);
      const harnesses = orderedHarnesses(snapshot);
      if (composerStageRef.current === "components" && key.rightArrow && configureFocusRef.current === "filters") {
        configureFocusRef.current = "items";
        setConfigureFocus("items");
        return;
      }
      if (composerStageRef.current === "components" && key.leftArrow && configureFocusRef.current === "items") {
        configureFocusRef.current = "filters";
        setConfigureFocus("filters");
        return;
      }
      if (composerStageRef.current === "targets" && (key.leftArrow || key.escape)) {
        composerStageRef.current = "components";
        setComposerStage("components");
        configureFocusRef.current = "items";
        setConfigureFocus("items");
        return;
      }
      if (key.upArrow || key.downArrow) {
        const delta = key.upArrow ? -1 : 1;
        if (composerStageRef.current === "targets") {
          const next = wrapIndex(targetIndexRef.current + delta, harnesses.length);
          targetIndexRef.current = next;
          setTargetIndex(next);
        } else if (configureFocusRef.current === "filters") {
          const next = wrapIndex(filterIndexRef.current + delta, filters.length);
          filterIndexRef.current = next;
          setFilterIndex(next);
          componentIndexRef.current = 0;
          setComponentIndex(0);
        } else {
          const next = wrapIndex(componentIndexRef.current + delta, items.length);
          componentIndexRef.current = next;
          setComponentIndex(next);
        }
        return;
      }
      if (input === " ") {
        if (composerStageRef.current === "targets") {
          const target = harnesses[targetIndexRef.current]?.id;
          if (target !== undefined) run(() => toggleTarget(session, snapshot, target));
        } else if (configureFocusRef.current === "items") {
          const item = items[componentIndexRef.current];
          if (item !== undefined) run(() => toggleComponent(session, snapshot, item.ref));
        }
        return;
      }
      if (key.return && composerStageRef.current === "components") {
        if (configureFocusRef.current === "filters") {
          configureFocusRef.current = "items";
          setConfigureFocus("items");
        } else if (canContinueFromComponents(snapshot)) {
          composerStageRef.current = "targets";
          setComposerStage("targets");
          targetIndexRef.current = 0;
          setTargetIndex(0);
        }
        return;
      }
      if (key.return && composerStageRef.current === "targets" && canReviewDraft(snapshot)) {
        run(() => session.dispatch({ type: "request-plan", mode: "reconcile" }));
      }
      return;
    }
    if (snapshot.phase === "reviewing") {
      if (input === "e" && snapshot.draft !== null) {
        const draft = snapshot.draft;
        run(() =>
          session.dispatch({
            type: "replace-draft",
            selections: draft.selectionInputs,
            targets: draft.targets,
          }),
        );
        return;
      }
      if (
        key.return &&
        snapshot.plan?.approvable === true &&
        snapshot.plan.id !== null
      ) {
        run(() =>
          session.dispatch({ type: "approve-plan", planId: snapshot.plan!.id! }),
        );
      }
      return;
    }
    if (snapshot.phase === "receipted" && input === "m") {
      run(() => reviewRemoveAll(session, root));
      return;
    }
    if (snapshot.phase === "receipted" && (input === "c" || input === "a")) {
      const component = actionableOauthMcp(snapshot);
      if (component !== null) {
        run(() => session.dispatch({
          type: "mcp-session",
          component,
          targets: sessionTargets(snapshot),
          operation: input === "c" ? "inspect" : "login",
        }));
      }
      return;
    }
    if (snapshot.phase === "receipted" && input === "l") {
      const component = actionableOauthMcp(snapshot);
      if (component !== null) setMcpLogoutConfirmation(component);
      return;
    }
    if (snapshot.phase === "receipted" && input === "o") {
      run(() => session.dispatch({ type: "scan", root }));
      return;
    }
    if (snapshot.phase === "blocked" && input === "r") {
      run(() => session.dispatch({ type: "scan", root }));
    }
  });

  return (
    <AiHarnessTuiFrame
      snapshot={snapshot}
      root={root}
      columns={terminal.columns}
      rows={terminal.rows}
      detailOpen={detailOpen}
      informationOpen={informationOpen}
      summaryOpen={summaryOpen}
      error={error}
      configureUi={{ filterIndex, componentIndex, targetIndex, focus: configureFocus, searchQuery, searchActive }}
      composerStage={composerStage}
      updateUi={updateUi}
      currentVersion={currentVersion}
      mcpLogoutConfirmation={mcpLogoutConfirmation}
    />
  );
}

export function AiHarnessTuiFrame({
  snapshot,
  root,
  columns,
  rows,
  detailOpen,
  informationOpen = false,
  summaryOpen = false,
  error,
  configureUi = {
    filterIndex: 0,
    componentIndex: 0,
    targetIndex: 0,
    focus: "filters",
  },
  composerStage = "components",
  updateUi = idleUpdateUi,
  currentVersion = "0.1.0",
  mcpLogoutConfirmation = null,
}: AiHarnessTuiFrameProps): React.JSX.Element {
  const layout = layoutMode(columns, rows);
  const unsupported = layout === "unsupported";
  return (
    <Box flexDirection="column" width={columns} minHeight={rows}>
      <AppHeader snapshot={snapshot} root={root} currentVersion={currentVersion} />
      {error === null ? null : (
        <Box paddingX={1}>
          <Text color="red">FAILED{separator()}{error}</Text>
        </Box>
      )}
      {unsupported ? (
        <TerminalRequirement columns={columns} rows={rows} />
      ) : mcpLogoutConfirmation !== null ? (
        <Box flexGrow={1} minHeight={0} paddingX={1} flexDirection="column">
          <McpLogoutConfirmation component={mcpLogoutConfirmation} />
        </Box>
      ) : (
        <Workspace
          snapshot={snapshot}
          layout={layout}
          columns={columns}
          rows={rows}
          detailOpen={detailOpen}
          informationOpen={informationOpen}
          summaryOpen={summaryOpen}
          configureUi={configureUi}
          composerStage={composerStage}
          updateUi={updateUi}
        />
      )}
      {unsupported ? null : (
        <>
          {isTransaction(snapshot.phase) ? <ImpactBar snapshot={snapshot} /> : null}
          <ActivityRail snapshot={snapshot} updateUi={updateUi} />
          {mcpLogoutConfirmation !== null ? (
            <ConfirmationKeyBar />
          ) : <KeyBar
            snapshot={snapshot}
            configureUi={configureUi}
            detailAvailable={detailToggleAvailable(snapshot, layout)}
            detailOpen={detailOpen}
            informationOpen={informationOpen}
            summaryOpen={summaryOpen}
            composerStage={composerStage}
            updateUi={updateUi}
          />}
        </>
      )}
    </Box>
  );
}

function AppHeader({
  snapshot,
  root,
  currentVersion,
}: {
  readonly snapshot: InteractionSnapshot;
  readonly root: string;
  readonly currentVersion: string;
}): React.JSX.Element {
  const repo = basename(snapshot.repository?.root ?? root);
  return (
    <Box
      paddingX={1}
      flexWrap="wrap"
      borderStyle={tuiBorderStyle()}
      borderTop={false}
      borderLeft={false}
      borderRight={false}
      borderColor="gray"
    >
      <Box marginRight={3}>
        <Text bold>AI HARNESS</Text>
      </Box>
      <Box marginRight={3}>
        <Text color="cyan">{repo}</Text>
      </Box>
      <Box marginRight={3}>
        <Text dimColor>local</Text>
      </Box>
      <Box marginRight={3}>
        <Text>CLI {currentVersion}</Text>
      </Box>
      <Text color="green">PROJECT CONFIGURATOR</Text>
    </Box>
  );
}

function Workspace({
  snapshot,
  layout,
  columns,
  rows,
  detailOpen,
  informationOpen,
  summaryOpen,
  configureUi,
  composerStage,
  updateUi,
}: {
  readonly snapshot: InteractionSnapshot;
  readonly layout: Exclude<LayoutMode, "unsupported">;
  readonly columns: number;
  readonly rows: number;
  readonly detailOpen: boolean;
  readonly informationOpen: boolean;
  readonly summaryOpen: boolean;
  readonly configureUi: ConfigureUi;
  readonly composerStage: ComposerStage;
  readonly updateUi: TuiUpdateUi;
}): React.JSX.Element {
  const widths = paneWidths(layout, columns);
  const information = focusedCatalogItem(snapshot, configureUi);
  if (summaryOpen && snapshot.phase === "drafting") {
    return (
      <Box flexGrow={1} minHeight={0} paddingX={1} flexDirection="column">
        <InstallationSummaryScreen snapshot={snapshot} composerStage={composerStage} />
      </Box>
    );
  }
  if (informationOpen && information !== undefined && composerStage === "components") {
    return (
      <Box flexGrow={1} minHeight={0} flexDirection="column">
        <ComponentInformation item={information} />
      </Box>
    );
  }
  if (
    snapshot.phase === "idle" ||
    snapshot.phase === "scanning" ||
    snapshot.phase === "browsing" ||
    snapshot.phase === "blocked" ||
    isUpdateSurface(updateUi.phase)
  ) {
    return (
      <Box flexGrow={1} minHeight={0} paddingX={1} flexDirection="column">
        <CurrentScreen
          snapshot={snapshot}
          spacious={layout === "wide"}
          rows={rows}
          configureUi={configureUi}
          composerStage={composerStage}
          scanDetailsOpen={detailOpen}
          updateUi={updateUi}
        />
      </Box>
    );
  }
  const showCollapsedDetail =
    snapshot.phase !== "drafting" && !detailOpen && detailToggleAvailable(snapshot, layout);
  if (layout === "wide") {
    return (
      <Box flexDirection="row" flexGrow={1} minHeight={0}>
        <Box
          width={widths.navigation}
          minWidth={widths.navigation}
          flexShrink={0}
          paddingX={1}
          flexDirection="column"
          borderStyle={tuiBorderStyle()}
          borderTop={false}
          borderBottom={false}
          borderLeft={false}
          borderColor="gray"
        >
          <Navigation snapshot={snapshot} configureUi={configureUi} composerStage={composerStage} updateUi={updateUi} />
        </Box>
        <Box
          flexGrow={1}
          minWidth={0}
          overflowX="hidden"
          paddingX={1}
          flexDirection="column"
          borderStyle={tuiBorderStyle()}
          borderTop={false}
          borderBottom={false}
          borderLeft={false}
          borderColor="gray"
        >
          <CurrentScreen snapshot={snapshot} spacious rows={rows} configureUi={configureUi} composerStage={composerStage} scanDetailsOpen={false} updateUi={updateUi} />
        </Box>
        <Box
          width={widths.detail}
          minWidth={widths.detail}
          flexShrink={0}
          paddingX={1}
          flexDirection="column"
          overflowX="hidden"
        >
          {snapshot.phase === "drafting" ? (
            <ComposerInspector snapshot={snapshot} configureUi={configureUi} composerStage={composerStage} />
          ) : (
            <DetailPane snapshot={snapshot} updateUi={updateUi} />
          )}
        </Box>
      </Box>
    );
  }

  if (layout === "medium") {
    return (
      <Box flexDirection="row" flexGrow={1} minHeight={0}>
        <Box
          width={widths.navigation}
          minWidth={widths.navigation}
          flexShrink={0}
          paddingX={1}
          flexDirection="column"
          borderStyle={tuiBorderStyle()}
          borderTop={false}
          borderBottom={false}
          borderLeft={false}
          borderColor="gray"
        >
          <Navigation snapshot={snapshot} configureUi={configureUi} composerStage={composerStage} updateUi={updateUi} />
        </Box>
        <Box flexGrow={1} minWidth={0} flexDirection="column" overflowX="hidden">
          <Box paddingX={1} flexDirection="column">
            {detailOpen && snapshot.phase !== "drafting" ? (
              <DetailPane snapshot={snapshot} updateUi={updateUi} compact />
            ) : (
              <CurrentScreen snapshot={snapshot} spacious={false} rows={rows} configureUi={configureUi} composerStage={composerStage} scanDetailsOpen={false} updateUi={updateUi} />
            )}
          </Box>
          {showCollapsedDetail ? <CollapsedDetailRail snapshot={snapshot} updateUi={updateUi} /> : null}
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1} minHeight={0}>
      <CompactNavigation snapshot={snapshot} configureUi={configureUi} composerStage={composerStage} />
      <Box paddingX={1} flexDirection="column">
        {detailOpen && snapshot.phase !== "drafting" ? (
          <DetailPane snapshot={snapshot} updateUi={updateUi} compact />
        ) : (
          <CurrentScreen snapshot={snapshot} spacious={false} rows={rows} configureUi={configureUi} composerStage={composerStage} scanDetailsOpen={false} updateUi={updateUi} />
        )}
      </Box>
      {showCollapsedDetail ? <CollapsedDetailRail snapshot={snapshot} updateUi={updateUi} /> : null}
    </Box>
  );
}

function CollapsedDetailRail({
  snapshot,
  updateUi,
}: {
  readonly snapshot: InteractionSnapshot;
  readonly updateUi: TuiUpdateUi;
}): React.JSX.Element {
  return (
    <Box paddingX={1} flexWrap="wrap">
      <Text dimColor>DETAIL  </Text>
      <Text bold color="cyan">{isUpdateSurface(updateUi.phase) ? "UPDATE SAFETY" : detailTitle(snapshot)}</Text>
      <Text>{separator()}{isUpdateSurface(updateUi.phase) ? updateUi.result?.latestVersion ?? "candidate" : detailSubject(snapshot)}  </Text>
      <Text bold color="cyan">[d]</Text>
      <Text> Open</Text>
    </Box>
  );
}

function Navigation({
  snapshot,
  configureUi,
  composerStage,
  updateUi,
}: {
  readonly snapshot: InteractionSnapshot;
  readonly configureUi: ConfigureUi;
  readonly composerStage: ComposerStage;
  readonly updateUi: TuiUpdateUi;
}): React.JSX.Element {
  const transaction = isTransaction(snapshot.phase);
  const filters = availableConfigureFilters(snapshot);
  return (
    <Box flexDirection="column">
      {transaction ? (
        <TransactionStepper phase={snapshot.phase} />
      ) : composerStage === "targets" ? (
        <Box flexDirection="column">
          <RegionTitle>SETUP</RegionTitle>
          <Text color="green">  [x] Components</Text>
          <Text bold color="cyan">&gt; [2] Targets</Text>
          <Text dimColor>  [3] Review</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          <RegionTitle>CATALOG VIEWS</RegionTitle>
          {filters.map((filter, index) => {
            const selected = index === configureUi.filterIndex;
            const focused = selected && configureUi.focus === "filters";
            return (
              <Text key={filter} {...colorProperty(selected ? "cyan" : undefined)} bold={focused}>
                {focused ? "> " : selected ? filterSelectionMarker() : "  "}{filter}
              </Text>
            );
          })}
        </Box>
      )}
      {updateUi.phase === "available" ? (
        <Box marginTop={1}><Text color="yellow">CLI update available</Text></Box>
      ) : null}
    </Box>
  );
}

function CompactNavigation({
  snapshot,
  configureUi,
  composerStage,
}: {
  readonly snapshot: InteractionSnapshot;
  readonly configureUi: ConfigureUi;
  readonly composerStage: ComposerStage;
}): React.JSX.Element {
  if (isTransaction(snapshot.phase)) {
    return (
      <Box paddingX={1} flexWrap="wrap">
        <Text dimColor>TRANSACTION  </Text>
        {transactionSteps.map((step, index) => {
          const active = transactionStep(snapshot.phase) === index;
          return (
            <Box key={step} marginRight={2}>
              <Text {...colorProperty(active ? "cyan" : undefined)} bold={active}>
                {active ? "> " : ""}{index + 1} {step}
              </Text>
            </Box>
          );
        })}
      </Box>
    );
  }
  const filters = availableConfigureFilters(snapshot);
  return (
    <Box paddingX={1} flexWrap="wrap">
      <Text dimColor>{composerStage === "components" ? "CATALOG  " : "SETUP  "}</Text>
      {composerStage === "components" ? filters.map((filter, index) => (
        <Box key={filter} marginRight={2}>
          <Text {...colorProperty(index === configureUi.filterIndex ? "cyan" : undefined)} bold={index === configureUi.filterIndex}>
            {index === configureUi.filterIndex ? "> " : ""}{filter}
          </Text>
        </Box>
      )) : (
        <Text><Text color="green">[x] Components</Text>{separator()}<Text bold color="cyan">&gt; Targets</Text>{separator()}Review</Text>
      )}
    </Box>
  );
}

function TransactionStepper({
  phase,
}: {
  readonly phase: InteractionPhase;
}): React.JSX.Element {
  const active = transactionStep(phase);
  return (
    <Box flexDirection="column">
      <RegionTitle>TRANSACTION</RegionTitle>
      {transactionSteps.map((step, index) => {
        const done = index < active;
        const current = index === active;
        return (
          <Text
            key={step}
            {...colorProperty(done ? "green" : current ? "cyan" : undefined)}
            dimColor={!done && !current}
            bold={current}
          >
            {current ? ">" : " "} [{done ? "x" : index + 1}] {step}
          </Text>
        );
      })}
    </Box>
  );
}

function CurrentScreen({
  snapshot,
  spacious,
  rows,
  configureUi,
  composerStage,
  scanDetailsOpen,
  updateUi,
}: {
  readonly snapshot: InteractionSnapshot;
  readonly spacious: boolean;
  readonly rows: number;
  readonly configureUi: ConfigureUi;
  readonly composerStage: ComposerStage;
  readonly scanDetailsOpen: boolean;
  readonly updateUi: TuiUpdateUi;
}): React.JSX.Element {
  if (isUpdateSurface(updateUi.phase)) {
    return <UpdateScreen updateUi={updateUi} />;
  }
  switch (snapshot.phase) {
    case "idle":
    case "scanning":
      return <ScanScreen snapshot={snapshot} />;
    case "browsing":
      return scanDetailsOpen
        ? <ScanDetailsScreen snapshot={snapshot} />
        : <ScanSummaryScreen snapshot={snapshot} />;
    case "drafting":
      return composerStage === "components" ? (
        <ConfigureScreen
          snapshot={snapshot}
          maxRows={responsiveListRows(rows, spacious ? 7 : 4, 15)}
          configureUi={configureUi}
        />
      ) : (
        <TargetScreen
          snapshot={snapshot}
          maxRows={responsiveListRows(rows, spacious ? 10 : 6, 12)}
          configureUi={configureUi}
        />
      );
    case "planning":
      return <TaskScreen title="PLANNING" snapshot={snapshot} />;
    case "reviewing":
      return <ReviewScreen snapshot={snapshot} maxRows={responsiveListRows(rows, spacious ? 9 : 6, 14)} />;
    case "applying":
      return <TaskScreen title="APPLY" snapshot={snapshot} />;
    case "verifying":
      return <TaskScreen title="VERIFY" snapshot={snapshot} />;
    case "authenticating":
      return <TaskScreen title="MCP AUTHENTICATION" snapshot={snapshot} />;
    case "receipted":
      return snapshot.mcpSession === null
        ? <ReceiptScreen snapshot={snapshot} />
        : <McpSessionResultScreen snapshot={snapshot} />;
    case "cancelled":
      return <ReceiptScreen snapshot={snapshot} />;
    case "blocked":
      return <DiagnosticsScreen snapshot={snapshot} />;
  }
}

function ScanScreen({
  snapshot,
}: {
  readonly snapshot: InteractionSnapshot;
}): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <ScreenTitle>SCAN REPOSITORY</ScreenTitle>
      <Text>Inspecting repository facts, catalog, stack and harness surfaces.</Text>
      <Box marginTop={1} flexDirection="column">
        <TaskList tasks={snapshot.tasks} />
      </Box>
    </Box>
  );
}

function ScanSummaryScreen({
  snapshot,
}: {
  readonly snapshot: InteractionSnapshot;
}): React.JSX.Element {
  const detected = snapshot.repository?.harnesses.filter((entry) => entry.detected) ?? [];
  const managed = snapshot.repository?.management !== "uninitialized";
  const warnings = snapshot.diagnostics.filter((entry) => entry.severity === "warning");
  const recommendationLabel = snapshot.recommendations.length === 1
    ? "1 component recommendation"
    : `${snapshot.recommendations.length} component recommendations`;
  return (
    <Box flexDirection="column" paddingX={1}>
      <ScreenTitle>SCAN COMPLETE</ScreenTitle>
      <Text color="green">Repository discovery is ready. No project changes were made.</Text>
      <Box marginTop={1} flexDirection="column">
      <DataRow label="Stack" value={snapshot.repository?.languages.join(", ") || "not detected"} />
      <DataRow
        label="Harnesses"
        value={`${detected.length}/${snapshot.repository?.harnesses.length ?? 0} detected`}
      />
      <DataRow
        label="Project"
        value={managed ? `managed${separator()}${snapshot.repository?.installedDirectSelections.length ?? 0} direct selections` : "new / unmanaged"}
      />
      <DataRow label="Catalog" value={`${snapshot.catalog.length} components`} />
      <DataRow label="Recommended" value={recommendationLabel} />
      <DataRow label="Warnings" value={`${warnings.length}`} tone={warnings.length > 0 ? "yellow" : "green"} />
      </Box>
      <Box marginTop={1} flexDirection="column">
        <RegionTitle>NEXT ACTION</RegionTitle>
        <Text>Press Enter to configure components. Recommendations remain suggestions until selected.</Text>
      </Box>
    </Box>
  );
}

function ScanDetailsScreen({ snapshot }: { readonly snapshot: InteractionSnapshot }): React.JSX.Element {
  return (
    <Box flexDirection="column" paddingX={1}>
      <ScreenTitle>SCAN DETAILS</ScreenTitle>
      <Text dimColor>Completed discovery tasks and diagnostics from this scan.</Text>
      <Box marginTop={1} flexDirection="column">
        <TaskList tasks={snapshot.tasks} />
      </Box>
      {snapshot.diagnostics.length === 0 ? null : (
        <Box marginTop={1} flexDirection="column">
          <RegionTitle>DIAGNOSTICS</RegionTitle>
          {snapshot.diagnostics.map((diagnostic) => (
            <Text key={diagnostic.code} {...colorProperty(diagnostic.severity === "blocked" ? "red" : "yellow")}>
              {diagnostic.code}{separator()}{diagnostic.message}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}

function ConfigureScreen({
  snapshot,
  maxRows,
  configureUi,
}: {
  readonly snapshot: InteractionSnapshot;
  readonly maxRows: number;
  readonly configureUi: ConfigureUi;
}): React.JSX.Element {
  const items = filteredCatalog(snapshot, configureUi.filterIndex, configureUi.searchQuery);
  const selectedRefs = new Set(snapshot.draft?.directSelections ?? []);
  const componentWindow = visibleWindow(items, configureUi.componentIndex, maxRows);
  return (
    <Box flexDirection="column">
      <ScreenTitle>COMPONENTS{separator()}{availableConfigureFilters(snapshot)[configureUi.filterIndex]?.toUpperCase()}</ScreenTitle>
      <Text {...colorProperty(configureUi.searchActive ? "cyan" : undefined)}>
        {configureUi.searchActive
          ? `SEARCH > ${configureUi.searchQuery ?? ""}_`
          : (configureUi.searchQuery?.length ?? 0) > 0
            ? `SEARCH${separator()}${configureUi.searchQuery}`
            : `SEARCH${separator()}Press / to search`}
      </Text>
      <Box flexDirection="column">
        <RegionTitle>CATALOG{separator()}{items.length} items</RegionTitle>
        {items.length === 0 ? (
          <Text dimColor>No components match this view and search.</Text>
        ) : (
          componentWindow.map(({ entry, index }) => {
            const active = configureUi.focus === "items" && index === configureUi.componentIndex;
            const selected = selectedRefs.has(entry.ref);
            const required = snapshot.draft?.components.some((component) => component.ref === entry.ref && component.origin === "required") === true;
            const previous = index === 0 ? undefined : items[index - 1];
            const showGroup = availableConfigureFilters(snapshot)[configureUi.filterIndex] === "All" &&
              (previous === undefined || catalogGroupLabel(previous) !== catalogGroupLabel(entry));
            return (
              <Box key={entry.ref} flexDirection="column">
                {showGroup ? <Text bold dimColor>{catalogGroupLabel(entry)}</Text> : null}
                <Box>
                <Text {...colorProperty(active ? "cyan" : undefined)} bold={active}>
                  {active ? "> " : "  "}[{selected ? "x" : required ? "+" : " "}] {catalogDisplayName(entry)}
                </Text>
                <Box flexGrow={1} />
                <Text dimColor>{componentFamilyLabel(entry)}{entry.recommended ? `${separator()}recommended` : required ? `${separator()}required` : ""}</Text>
                </Box>
              </Box>
            );
          })
        )}
        {items.length > componentWindow.length ? (
          <Text dimColor>
            Showing {componentWindow[0]?.index! + 1}-{componentWindow.at(-1)?.index! + 1} of {items.length}{separator()}use {asciiMode() ? "Up/Down" : "↑/↓"}
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}

function TargetScreen({
  snapshot,
  maxRows,
  configureUi,
}: {
  readonly snapshot: InteractionSnapshot;
  readonly maxRows: number;
  readonly configureUi: ConfigureUi;
}): React.JSX.Element {
  const harnesses = orderedHarnesses(snapshot);
  const window = visibleWindow(harnesses, configureUi.targetIndex, maxRows);
  return (
    <Box flexDirection="column">
      <ScreenTitle>TARGETS{separator()}SELECT</ScreenTitle>
      <Text dimColor>Choose which project-scoped harness configurations AI Harness will manage.</Text>
      <Box flexDirection="column" marginTop={1}>
        {window.map(({ entry, index }) => {
          const active = index === configureUi.targetIndex;
          const selected = snapshot.draft?.targets.includes(entry.id) === true;
          return (
            <Text key={entry.id} {...colorProperty(active ? "cyan" : undefined)} bold={active}>
              {active ? "> " : "  "}[{selected ? "x" : " "}] {formatIdentifier(entry.id)}{separator()}{entry.detected ? "detected" : "not detected"}{separator()}{entry.ready ? "ready" : "configuration unverified"}
            </Text>
          );
        })}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <RegionTitle>NEXT ACTION</RegionTitle>
        <Text {...colorProperty(canReviewDraft(snapshot) ? "green" : "yellow")}>
          {canReviewDraft(snapshot) ? "Enter reviews the exact plan." : "Select at least one target to continue."}
        </Text>
      </Box>
    </Box>
  );
}

function ComposerInspector({
  snapshot,
  configureUi,
  composerStage,
}: {
  readonly snapshot: InteractionSnapshot;
  readonly configureUi: ConfigureUi;
  readonly composerStage: ComposerStage;
}): React.JSX.Element {
  const component = composerStage === "components"
    ? filteredCatalog(snapshot, configureUi.filterIndex, configureUi.searchQuery)[configureUi.componentIndex]
    : undefined;
  const target = composerStage === "targets"
    ? orderedHarnesses(snapshot)[configureUi.targetIndex]
    : undefined;
  return (
    <Box flexDirection="column" flexGrow={1} minHeight={0}>
      <Box flexDirection="column" flexBasis="42%" minHeight={0}>
        <ScreenTitle>ABOUT</ScreenTitle>
        {component !== undefined ? (
          <>
            <Text bold>{catalogDisplayName(component)}</Text>
            <Text dimColor>{componentFamilyLabel(component)}{separator()}version {component.version}</Text>
            <Box marginTop={1}><Text>{component.description}</Text></Box>
            <Box marginTop={1} flexDirection="column">
              <RegionTitle>CHANGES</RegionTitle>
              <Text>{component.impact.changes}</Text>
            </Box>
            <Box marginTop={1} flexDirection="column">
              <RegionTitle>WORKFLOW IMPACT</RegionTitle>
              <Text>{component.impact.workflow}</Text>
            </Box>
            <Box marginTop={1}><Text dimColor>Press i for complete information.</Text></Box>
          </>
        ) : target !== undefined ? (
          <>
            <Text bold>{formatIdentifier(target.id)}</Text>
            <Text>{target.detected ? "Detected in this environment." : "Not detected; project configuration can still be prepared."}</Text>
            <Text dimColor>{target.ready ? "Adapter is ready." : "Configuration readiness is unverified."}</Text>
          </>
        ) : (
          <Text dimColor>{composerStage === "components" ? "Focus a component to see what it does." : "Focus a target to inspect its status."}</Text>
        )}
      </Box>
      <Box
        flexDirection="column"
        flexGrow={1}
        minHeight={0}
        paddingTop={1}
        borderStyle={tuiBorderStyle()}
        borderLeft={false}
        borderRight={false}
        borderBottom={false}
        borderColor="gray"
      >
        <DraftSummary
          snapshot={snapshot}
          title="INSTALLATION DRAFT"
          showNextAction={false}
          showTargets={composerStage === "targets"}
        />
      </Box>
    </Box>
  );
}

function InstallationSummaryScreen({
  snapshot,
  composerStage,
}: {
  readonly snapshot: InteractionSnapshot;
  readonly composerStage: ComposerStage;
}): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <ScreenTitle>INSTALLATION SUMMARY</ScreenTitle>
      <Text dimColor>Complete dependency closure for the current draft. No project changes have been made.</Text>
      <Box marginTop={1} flexDirection="column">
        <DraftSummary
          snapshot={snapshot}
          title="INSTALLATION DRAFT"
          showNextAction={false}
          showTargets={composerStage === "targets"}
        />
      </Box>
    </Box>
  );
}

function DraftSummary({
  snapshot,
  title = "INSTALLATION DRAFT",
  showNextAction = true,
  showTargets = true,
}: {
  readonly snapshot: InteractionSnapshot;
  readonly title?: string;
  readonly showNextAction?: boolean;
  readonly showTargets?: boolean;
}): React.JSX.Element {
  const direct = snapshot.draft?.directSelections ?? [];
  const required = snapshot.draft?.components.filter((entry) => entry.origin === "required") ?? [];
  const targets = snapshot.draft?.targets ?? [];
  const reviewReady = direct.length > 0 && targets.length > 0 && snapshot.draft?.blocked !== true;
  return (
    <Box flexDirection="column">
      <RegionTitle>{title}</RegionTitle>
      <Text bold>DIRECT SELECTIONS ({direct.length})</Text>
      <Text>{formatDraftItems(snapshot, direct) || "None selected."}</Text>
      <Text bold>INCLUDED DEPENDENCIES ({required.length})</Text>
      <Text dimColor>{formatDraftItems(snapshot, required.map((entry) => entry.ref)) || "None."}</Text>
      {showTargets ? (
        <>
          <Text bold>TARGETS ({targets.length})</Text>
          <Text {...colorProperty(targets.length === 0 ? "yellow" : "cyan")}>
            {targets.map(formatIdentifier).join(separator()) || "None selected."}
          </Text>
        </>
      ) : (
        <Text dimColor>Targets are selected in the next step.</Text>
      )}
      {showNextAction ? (
        <Text {...colorProperty(reviewReady ? "green" : "yellow")}>
          {reviewReady
            ? "Enter reviews exact files and effects before any change."
            : direct.length === 0
              ? "Select at least one catalog item to continue."
              : "Select at least one target to continue."}
        </Text>
      ) : null}
    </Box>
  );
}

function formatDraftItems(
  snapshot: InteractionSnapshot,
  refs: readonly ComponentRef[],
): string {
  return refs
    .map((ref) => `[${draftFamily(snapshot, ref)}] ${formatComponent(ref)}`)
    .join(separator());
}

function draftFamily(snapshot: InteractionSnapshot, ref: ComponentRef): string {
  const kind = snapshot.catalog.find((entry) => entry.ref === ref)?.kind ?? ref.slice(0, ref.indexOf(":"));
  switch (kind) {
    case "mcp-integration":
    case "mcp":
      return "MCP";
    case "verification-profile":
      return "quality";
    case "git-gate":
      return "hook";
    case "instruction-fragment":
      return "instructions";
    default:
      return kind;
  }
}

function ReviewScreen({
  snapshot,
  maxRows,
}: {
  readonly snapshot: InteractionSnapshot;
  readonly maxRows: number;
}): React.JSX.Element {
  const plan = snapshot.plan;
  const blockers = snapshot.diagnostics.filter(
    (diagnostic) => diagnostic.severity === "blocked" || diagnostic.severity === "failed",
  );
  return (
    <Box flexDirection="column">
      <ScreenTitle>REVIEW EXACT PLAN</ScreenTitle>
      <DataRow label="Plan" value={plan?.id ?? "blocked"} />
      <Text>Mode: {plan?.mode ?? "unknown"}</Text>
      <DataRow label="Changes" value={String(plan?.changes.length ?? 0)} />
      <Box flexDirection="column" marginTop={1}>
        <DraftSummary snapshot={snapshot} title="SELECTION SUMMARY" showNextAction={false} />
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <RegionTitle>PLANNED CHANGES</RegionTitle>
        <ChangeRows changes={(plan?.changes ?? []).slice(0, maxRows)} />
        {(plan?.changes.length ?? 0) > maxRows ? (
          <Text dimColor>  + {(plan?.changes.length ?? 0) - maxRows} more changes{separator()}details remain in the exact plan</Text>
        ) : null}
      </Box>
      {plan?.approvable === true || blockers.length === 0 ? null : (
        <Box flexDirection="column" marginTop={1}>
          <RegionTitle>PLAN BLOCKERS</RegionTitle>
          {blockers.slice(0, 2).map((diagnostic, index) => (
            <Box key={`${diagnostic.code}:${index}`} flexDirection="column">
              <Text color="red">{diagnostic.code}{separator()}{diagnostic.message}</Text>
              <Text dimColor>{diagnostic.action ?? "Resolve this blocker and review a new plan."}</Text>
            </Box>
          ))}
          {blockers.length > 2 ? <Text dimColor>+ {blockers.length - 2} more blockers</Text> : null}
        </Box>
      )}
      {(plan?.review?.runtimes.length ?? 0) === 0 ? null : (
        <Box flexDirection="column" marginTop={1}>
          <RegionTitle>MCP RUNTIME</RegionTitle>
          {plan!.review!.runtimes.map((runtime) => (
            <Box key={runtime.component} flexDirection="column">
              <Text>{formatComponent(runtime.component)}{separator()}{runtime.connection.type}{separator()}OAuth: {runtime.auth}</Text>
              <Text dimColor>
                {runtime.connection.type === "remote-http"
                  ? `${runtime.connection.url}${separator()}network required; authentication happens after Apply in the selected harness`
                  : `${runtime.connection.command.join(" ")}${separator()}starts only when the harness uses the MCP`}
              </Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}

function ChangeRows({
  changes,
}: {
  readonly changes: readonly PlannedChangeView[];
}): React.JSX.Element {
  if (changes.length === 0) {
    return <Text dimColor>No filesystem changes in this plan.</Text>;
  }
  return (
    <Box flexDirection="column">
      {changes.map((change, index) => (
        <Box key={`${change.action}:${change.path}`}>
          <Text {...colorProperty(index === 0 ? "cyan" : undefined)}>{index === 0 ? "> " : "  "}</Text>
          <Text {...colorProperty(change.action === "remove" ? "yellow" : undefined)}>
            {change.action.padEnd(7)}
          </Text>
          <Text> {change.path}</Text>
        </Box>
      ))}
    </Box>
  );
}

function TaskScreen({
  title,
  snapshot,
}: {
  readonly title: string;
  readonly snapshot: InteractionSnapshot;
}): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <ScreenTitle>{title}</ScreenTitle>
      {snapshot.cancellationRequested ? (
        <Text color="yellow">Cancellation requested{separator()}waiting for a safe boundary</Text>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        <TaskList tasks={snapshot.tasks} />
      </Box>
    </Box>
  );
}

function UpdateScreen({
  updateUi,
}: {
  readonly updateUi: TuiUpdateUi;
}): React.JSX.Element {
  const result = updateUi.result;
  const release = result?.release;
  if (updateUi.phase === "reviewing" && result !== null && release != null) {
    return (
      <Box flexDirection="column">
        <ScreenTitle>REVIEW CLI UPDATE</ScreenTitle>
        <DataRow label="Installed" value={result.currentVersion} />
        <DataRow label="Candidate" value={result.latestVersion ?? "unknown"} tone="green" />
        <DataRow label="Channel" value={release.manifest.channel} />
        <DataRow label="Manifest" value={release.manifestUrl.toString()} />
        <DataRow
          label="Artifact"
          value={`${release.manifest.release.artifact.path}${separator()}${release.manifest.release.artifact.size} bytes`}
        />
        <DataRow label="Node" value={release.manifest.release.runtime.node} />
        <DataRow label="pnpm" value={release.manifest.release.runtime.pnpm} />
        <Box flexDirection="column" marginTop={1}>
          <RegionTitle>EXACT EFFECTS</RegionTitle>
          <Text>1. Download and verify the exact artifact size and SHA-256.</Text>
          <Text>2. Install the candidate in an isolated pnpm home and run smoke checks.</Text>
          <Text>3. Replace the global CLI only after the candidate passes.</Text>
          <Text>4. Restore the previous package automatically if final verification fails.</Text>
        </Box>
        {release.manifest.release.notes.length === 0 ? null : (
          <Box flexDirection="column" marginTop={1}>
            <RegionTitle>RELEASE NOTES</RegionTitle>
            {release.manifest.release.notes.slice(0, 3).map((note) => (
              <Text key={note}>- {terminalText(note)}</Text>
            ))}
          </Box>
        )}
      </Box>
    );
  }
  if (updateUi.phase === "applying") {
    return (
      <Box flexDirection="column">
        <ScreenTitle>APPLY CLI UPDATE</ScreenTitle>
        <Text color="cyan">{taskSymbol("running")} Installing and verifying the reviewed CLI candidate</Text>
        <Text dimColor>The current CLI remains recoverable until final smoke verification passes.</Text>
        <Box flexDirection="column" marginTop={1}>
          <RegionTitle>CANDIDATE</RegionTitle>
          <DataRow label="Installed" value={result?.currentVersion ?? "unknown"} />
          <DataRow label="Target" value={result?.latestVersion ?? "resolving"} />
        </Box>
      </Box>
    );
  }

  const applied = updateUi.phase === "applied";
  const rolledBack = updateUi.phase === "rolled-back";
  return (
    <Box flexDirection="column">
      <Text bold color={applied ? "green" : rolledBack ? "yellow" : "red"}>
        CLI UPDATE {applied ? "APPLIED" : rolledBack ? "ROLLED BACK" : "FAILED"}
      </Text>
      <DataRow label="Previous" value={result?.currentVersion ?? "unknown"} />
      <DataRow label="Candidate" value={result?.latestVersion ?? "unknown"} />
      <Text>
        {applied
          ? "Restart AI Harness to run the newly installed CLI version."
          : rolledBack
            ? "The previous CLI remains active; no failed candidate was retained."
            : "No certified replacement was activated."}
      </Text>
      {(result?.diagnostics ?? []).map((diagnostic) => (
        <Box key={diagnostic.code} flexDirection="column" marginTop={1}>
          <Text color={diagnostic.severity === "failed" ? "red" : "yellow"}>
            {diagnostic.severity}{separator()}{diagnostic.code}
          </Text>
          <Text>{terminalText(diagnostic.message)}</Text>
          <Text dimColor>{terminalText(diagnostic.action ?? "Retry after resolving the diagnostic.")}</Text>
        </Box>
      ))}
    </Box>
  );
}

function UpdateDetail({
  updateUi,
}: {
  readonly updateUi: TuiUpdateUi;
}): React.JSX.Element {
  const result = updateUi.result;
  return (
    <Box flexDirection="column">
      <DataRow label="Installed" value={result?.currentVersion ?? "unknown"} />
      <DataRow label="Candidate" value={result?.latestVersion ?? "unknown"} />
      <Box flexDirection="column" marginTop={1}>
        <RegionTitle>GUARANTEES</RegionTitle>
        <Text>Verified channel manifest</Text>
        <Text>Exact artifact hash and size</Text>
        <Text>Isolated candidate smoke</Text>
        <Text>Automatic rollback</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <RegionTitle>PROJECT</RegionTitle>
        <Text dimColor>CLI update does not change repository configuration.</Text>
      </Box>
    </Box>
  );
}

function ReceiptScreen({
  snapshot,
}: {
  readonly snapshot: InteractionSnapshot;
}): React.JSX.Element {
  const receipt = snapshot.receipt;
  const successful = receipt?.result === "succeeded" || receipt?.result === "no-changes";
  return (
    <Box flexDirection="column">
      <Text bold color={successful ? "green" : "yellow"}>RECEIPT</Text>
      <Text>
        Verdict: <Text color={successful ? "green" : "yellow"}>{receipt?.result ?? snapshot.phase}</Text>
      </Text>
      <DataRow label="Plan" value={receipt?.planId ?? "none"} />
      <DataRow label="Materialization" value={receipt?.materialization ?? "unchanged"} />
      <DataRow label="Certification" value={receipt?.certification ?? "not-run"} />
      <DataRow label="Changed paths" value={String(receipt?.changedPaths.length ?? 0)} />
      {(receipt?.changedPaths ?? []).slice(0, 6).map((path) => (
        <Text key={path}>  {path}</Text>
      ))}
      {(receipt?.diagnostics ?? []).map((diagnostic) => (
        <Text key={diagnostic.code} color={diagnostic.severity === "failed" ? "red" : "yellow"}>
          {diagnostic.severity}{separator()}{diagnostic.code}
        </Text>
      ))}
      {oauthMcp(snapshot) !== null ? (
        <Box flexDirection="column" marginTop={1}>
          <RegionTitle>MCP AUTHENTICATION</RegionTitle>
          {snapshot.mcpSession === null ? (
            <Text color="cyan">Authenticate the OAuth MCP now, or skip and do it later.</Text>
          ) : snapshot.mcpSession.results.map((result) => (
            <Box key={result.target} flexDirection="column">
              <Text>{formatIdentifier(result.target)}{separator()}{result.state}</Text>
              <Text dimColor>{result.message}</Text>
              {result.action === null ? null : <Text color="cyan">Next: {result.action.description}</Text>}
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

function McpSessionResultScreen({
  snapshot,
}: {
  readonly snapshot: InteractionSnapshot;
}): React.JSX.Element {
  const session = snapshot.mcpSession;
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">MCP AUTHENTICATION</Text>
      <DataRow label="Component" value={session?.component ?? "unknown"} />
      <DataRow label="Operation" value={session?.operation ?? "unknown"} />
      <Box marginTop={1} flexDirection="column">
        {(session?.results ?? []).map((result) => (
          <Box key={result.target} flexDirection="column" marginBottom={1}>
            <Text>{formatIdentifier(result.target)}{separator()}<Text color={mcpStateTone(result.state)}>{result.state}</Text></Text>
            <Text dimColor>{result.message}</Text>
            {result.action === null ? null : <Text color="cyan">Next: {result.action.description}</Text>}
          </Box>
        ))}
      </Box>
      <Text dimColor>Project materialization and its receipt were not changed by this session action.</Text>
    </Box>
  );
}

function McpLogoutConfirmation({ component }: { readonly component: ComponentRef }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text bold color="yellow">CONFIRM MCP LOGOUT</Text>
      <Text>Logout {component} from the selected installed harness targets?</Text>
      <Text dimColor>This does not uninstall project configuration or revoke organization consent.</Text>
    </Box>
  );
}

function ConfirmationKeyBar(): React.JSX.Element {
  return (
    <Box paddingX={1} gap={3}>
      <Text><Text bold color="cyan">[Enter]</Text> Confirm logout</Text>
      <Text><Text bold color="cyan">[Esc]</Text> Keep session</Text>
      <Text><Text bold color="cyan">[q]</Text> Quit</Text>
    </Box>
  );
}

function oauthMcp(snapshot: InteractionSnapshot): ComponentRef | null {
  return snapshot.plan?.review?.runtimes.find((runtime) => runtime.auth === "oauth")?.component ?? null;
}

function installedOauthMcp(snapshot: InteractionSnapshot): ComponentRef | null {
  const installed = new Set(snapshot.repository?.installedComponents ?? []);
  return snapshot.catalog.find(
    (item) => item.kind === "mcp-integration" && item.mcpAuth === "oauth" && installed.has(item.ref),
  )?.ref ?? null;
}

function actionableOauthMcp(snapshot: InteractionSnapshot): ComponentRef | null {
  return snapshot.mcpSession?.component ?? oauthMcp(snapshot) ?? installedOauthMcp(snapshot);
}

function sessionTargets(snapshot: InteractionSnapshot): readonly HarnessTargetId[] {
  return snapshot.draft?.targets ?? snapshot.repository?.installedTargets ?? [];
}

function mcpStateTone(state: string): "green" | "yellow" | "red" | "cyan" {
  if (state === "authenticated") return "green";
  if (state === "unsupported") return "red";
  if (state === "authentication-required") return "yellow";
  return "cyan";
}

function DiagnosticsScreen({
  snapshot,
}: {
  readonly snapshot: InteractionSnapshot;
}): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text bold color="red">DIAGNOSTICS</Text>
      {snapshot.diagnostics.length === 0 ? (
        <Text dimColor>No diagnostics were produced.</Text>
      ) : (
        snapshot.diagnostics.map((diagnostic) => (
          <Box key={diagnostic.code} flexDirection="column" marginBottom={1}>
            <Text color={diagnostic.severity === "failed" ? "red" : "yellow"}>
              {diagnostic.severity}{separator()}{diagnostic.code}
            </Text>
            <Text>{diagnostic.message}</Text>
            <Text dimColor>{diagnostic.impact}</Text>
            <Text>{diagnostic.action ?? "No automatic action available"}</Text>
          </Box>
        ))
      )}
    </Box>
  );
}

function DetailPane({
  snapshot,
  updateUi,
  compact = false,
}: {
  readonly snapshot: InteractionSnapshot;
  readonly updateUi: TuiUpdateUi;
  readonly compact?: boolean;
}): React.JSX.Element {
  const direct = snapshot.draft?.components.filter((entry) => entry.origin === "direct") ?? [];
  const required = snapshot.draft?.components.filter((entry) => entry.origin === "required") ?? [];
  const running = snapshot.tasks.find((task) => task.state === "running");

  return (
    <Box flexDirection="column">
      <ScreenTitle>{isUpdateSurface(updateUi.phase) ? "UPDATE SAFETY" : detailTitle(snapshot)}</ScreenTitle>
      {isUpdateSurface(updateUi.phase) ? (
        <UpdateDetail updateUi={updateUi} />
      ) : snapshot.receipt !== null ? (
        <ReceiptDetail snapshot={snapshot} compact={compact} />
      ) : snapshot.phase === "applying" || snapshot.phase === "verifying" || snapshot.phase === "planning" ? (
        <ActiveTaskDetail task={running} />
      ) : (
        <DependencyDetail direct={direct} required={required} compact={compact} />
      )}
      {snapshot.receipt === null ? (
        <Box flexDirection="column" marginTop={1}>
          <RegionTitle>RECEIPT</RegionTitle>
          <Text dimColor>No receipt yet. No outcome has been claimed.</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function DependencyDetail({
  direct,
  required,
  compact,
}: {
  readonly direct: readonly DraftComponentView[];
  readonly required: readonly DraftComponentView[];
  readonly compact: boolean;
}): React.JSX.Element {
  const root = direct[0];
  if (root === undefined) {
    return <Text dimColor>Select a recommendation to resolve its dependency closure.</Text>;
  }
  const visible = required.slice(0, compact ? 3 : 6);
  return (
    <Box flexDirection="column">
      <Text bold>{formatComponent(root.ref)}</Text>
      <Text color="cyan">{asciiMode() ? "|- selected directly" : "├─ selected directly"}</Text>
      {visible.map((component, index) => (
        <Text key={component.ref} color="cyan">
          {asciiMode()
            ? index === visible.length - 1 ? "\\-" : "|-"
            : `${index === visible.length - 1 ? "└" : "├"}─`} requires {formatComponent(component.ref)}
        </Text>
      ))}
      {required.length > visible.length ? (
        <Text dimColor>   + {required.length - visible.length} more requirements</Text>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        <RegionTitle>RULE</RegionTitle>
        <Text dimColor>Required components follow the direct selection and cannot be removed independently.</Text>
      </Box>
    </Box>
  );
}

function ActiveTaskDetail({
  task,
}: {
  readonly task: InteractionTask | undefined;
}): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <RegionTitle>ACTIVE TASK</RegionTitle>
      {task === undefined ? (
        <Text dimColor>Waiting for the next deterministic task verdict.</Text>
      ) : (
        <>
          <Text color="cyan">{taskSymbol(task.state)} {terminalText(task.label)}</Text>
          <Text dimColor>{terminalText(task.detail ?? task.state)}</Text>
        </>
      )}
      <Box flexDirection="column" marginTop={1}>
        <RegionTitle>SAFETY</RegionTitle>
        <Text dimColor>Preflight completes before writes. Cancellation waits for a safe boundary.</Text>
      </Box>
    </Box>
  );
}

function ReceiptDetail({
  snapshot,
  compact,
}: {
  readonly snapshot: InteractionSnapshot;
  readonly compact: boolean;
}): React.JSX.Element {
  const receipt = snapshot.receipt;
  if (receipt === null) {
    return <Text dimColor>No receipt is available.</Text>;
  }
  const success = receipt.result === "succeeded" || receipt.result === "no-changes";
  return (
    <Box flexDirection="column">
      <Text bold color={success ? "green" : "yellow"}>{receipt.result}</Text>
      <Text>Materialization: {receipt.materialization}</Text>
      <Text>Certification: {receipt.certification}</Text>
      <Box flexDirection="column" marginTop={1}>
        <RegionTitle>FILES</RegionTitle>
        {receipt.changedPaths.length === 0 ? (
          <Text dimColor>No paths changed.</Text>
        ) : (
          receipt.changedPaths.slice(0, compact ? 3 : 7).map((path) => (
            <Text key={path}>{path}</Text>
          ))
        )}
      </Box>
    </Box>
  );
}

function TaskList({
  tasks,
  showDetails = true,
}: {
  readonly tasks: readonly InteractionTask[];
  readonly showDetails?: boolean;
}): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {tasks.map((task) => (
        <Box key={task.id} flexDirection="column">
          <Text {...colorProperty(taskTone(task.state))}>
            {taskSymbol(task.state)} {terminalText(task.label)}
            {task.current === undefined || task.total === undefined
              ? ""
              : `${separator()}${task.current}/${task.total}`}{separator()}{task.state}
          </Text>
          {showDetails && task.detail !== null ? <Text dimColor>  {terminalText(task.detail)}</Text> : null}
        </Box>
      ))}
    </Box>
  );
}

function ImpactBar({
  snapshot,
}: {
  readonly snapshot: InteractionSnapshot;
}): React.JSX.Element {
  const direct = snapshot.draft?.directSelections.length ?? 0;
  const components = snapshot.draft?.components.length ?? 0;
  const changes = snapshot.plan?.changes.length ?? 0;
  const targets = snapshot.draft?.targets.length ?? 0;
  return (
    <Box
      justifyContent="center"
      paddingX={1}
      borderStyle={tuiBorderStyle()}
      borderLeft={false}
      borderRight={false}
      borderColor="gray"
    >
      <Text color={snapshot.plan?.approvable === true ? "green" : "cyan"}>
        Draft: {direct} direct {arrow()} {components} components{separator()}{changes} changes{separator()}{targets} targets
      </Text>
    </Box>
  );
}

function ActivityRail({
  snapshot,
  updateUi,
}: {
  readonly snapshot: InteractionSnapshot;
  readonly updateUi: TuiUpdateUi;
}): React.JSX.Element | null {
  const updateTask = toUpdateTask(updateUi);
  const running = snapshot.tasks.find((task) => task.state === "running");
  const latest = updateTask?.state === "running" || updateTask?.state === "warning" || updateTask?.state === "failed"
    ? updateTask
    : running ?? (isTransaction(snapshot.phase) ? snapshot.tasks.at(-1) : undefined);
  if (latest === undefined) return null;
  return (
    <Box paddingX={1}>
      <Text dimColor>Activity: </Text>
      <Text {...colorProperty(taskTone(latest.state))}>
        [{latest.state}] {terminalText(latest.label)}
        {latest.current === undefined || latest.total === undefined
          ? ""
          : `${separator()}${latest.current}/${latest.total}`}
        {latest.detail === null ? "" : `${separator()}${terminalText(latest.detail)}`}
      </Text>
    </Box>
  );
}

function KeyBar({
  snapshot,
  configureUi,
  detailAvailable,
  detailOpen,
  informationOpen,
  summaryOpen,
  composerStage,
  updateUi,
}: {
  readonly snapshot: InteractionSnapshot;
  readonly configureUi: ConfigureUi;
  readonly detailAvailable: boolean;
  readonly detailOpen: boolean;
  readonly informationOpen: boolean;
  readonly summaryOpen: boolean;
  readonly composerStage: ComposerStage;
  readonly updateUi: TuiUpdateUi;
}): React.JSX.Element {
  if (summaryOpen) {
    return <KeyActions actions={Object.freeze([{ key: "s", label: "Close" }, { key: "Esc", label: "Close" }, { key: "q", label: "Quit" }])} />;
  }
  if (informationOpen) {
    return <KeyActions actions={Object.freeze([{ key: "i", label: "Close" }, { key: "Esc", label: "Close" }, { key: "q", label: "Quit" }])} />;
  }
  let baseActions = updateKeyActions(snapshot, updateUi, configureUi, composerStage);
  if (detailAvailable && baseActions.some((action) => action.key === "d")) {
    baseActions = baseActions.map((action) => action.key === "d"
      ? { ...action, label: detailOpen ? "Back to scan summary" : action.label }
      : action);
  }
  if (
    composerStage === "components" &&
    configureUi.searchActive !== true &&
    focusedCatalogItem(snapshot, configureUi) !== undefined
  ) {
    baseActions = insertBeforeExit(baseActions, { key: "i", label: "Information" });
  }
  const actions = detailAvailable && !baseActions.some((action) => action.key === "d")
    ? insertBeforeExit(baseActions, {
        key: "d",
        label: detailOpen ? "Back to current screen" : "Details",
      })
    : baseActions;
  return <KeyActions actions={actions} />;
}

function KeyActions({ actions }: { readonly actions: readonly KeyAction[] }): React.JSX.Element {
  return (
    <Box
      paddingX={1}
      flexWrap="wrap"
      borderStyle={tuiBorderStyle()}
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
      borderColor="gray"
    >
      {actions.map((action) => (
        <Box key={`${action.key}:${action.label}`} marginRight={3}>
          <Text color="cyan" bold>[{action.key}]</Text>
          <Text> {action.label}</Text>
        </Box>
      ))}
    </Box>
  );
}

function ComponentInformation({
  item,
}: {
  readonly item: InteractionSnapshot["catalog"][number];
}): React.JSX.Element {
  return (
    <Box
      marginX={1}
      paddingX={1}
      flexDirection="column"
      borderStyle={tuiBorderStyle()}
      borderColor="cyan"
    >
      <ScreenTitle>COMPONENT INFORMATION</ScreenTitle>
      <Text bold>{catalogDisplayName(item)}</Text>
      <Text dimColor>{item.kind}{separator()}version {item.version}{separator()}{item.trust}</Text>
      <Box flexDirection="column" marginTop={1}>
        <RegionTitle>SUMMARY</RegionTitle>
        <Text>{item.description}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <RegionTitle>DETAILS</RegionTitle>
        <Text>{item.details}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <RegionTitle>CHANGES</RegionTitle>
        <Text>{item.impact.changes}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <RegionTitle>WORKFLOW IMPACT</RegionTitle>
        <Text>{item.impact.workflow}</Text>
      </Box>
    </Box>
  );
}

function focusedCatalogItem(
  snapshot: InteractionSnapshot,
  configureUi: ConfigureUi,
): InteractionSnapshot["catalog"][number] | undefined {
  if (snapshot.phase !== "drafting" || configureUi.focus !== "items") return undefined;
  return filteredCatalog(snapshot, configureUi.filterIndex, configureUi.searchQuery)[configureUi.componentIndex];
}

function DataRow({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: string;
  readonly tone?: SemanticTone;
}): React.JSX.Element {
  return (
    <Box>
      <Box width={16}>
        <Text dimColor>{label}</Text>
      </Box>
      <Text {...colorProperty(tone)}>{value}</Text>
    </Box>
  );
}

function ScreenTitle({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return <Text bold color="cyan">{children}</Text>;
}

function RegionTitle({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return <Text bold dimColor>{children}</Text>;
}

function TerminalRequirement({
  columns,
  rows,
}: {
  readonly columns: number;
  readonly rows: number;
}): React.JSX.Element {
  return (
    <Box paddingX={1} flexDirection="column">
      <Text bold color="yellow">TERMINAL SIZE REQUIRED</Text>
      <Text>Current terminal: {columns} columns {asciiMode() ? "x" : "×"} {rows} rows.</Text>
      <Text>Resize to at least 60 {asciiMode() ? "x" : "×"} 18, or use a subcommand with --plain.</Text>
    </Box>
  );
}

function colorProperty(tone: SemanticTone | undefined): {} | { readonly color: SemanticTone } {
  return tone === undefined ? {} : { color: tone };
}

function detailTitle(snapshot: InteractionSnapshot): string {
  if (snapshot.phase === "browsing") {
    return "WHY RECOMMENDED";
  }
  return snapshot.receipt === null ? "WHY INCLUDED" : "OUTCOME";
}

function detailSubject(snapshot: InteractionSnapshot): string {
  if (snapshot.phase === "browsing") {
    const recommendation = snapshot.recommendations[0];
    return recommendation === undefined
      ? "No recommendation selected"
      : formatComponent(recommendation.ref);
  }
  if (snapshot.receipt !== null) {
    return snapshot.receipt.result;
  }
  const direct = snapshot.draft?.components.find((entry) => entry.origin === "direct");
  const running = snapshot.tasks.find((task) => task.state === "running");
  if (direct !== undefined) {
    return formatComponent(direct.ref);
  }
  return running === undefined ? "No component selected" : terminalText(running.label);
}

function detailToggleAvailable(
  snapshot: InteractionSnapshot,
  layout: LayoutMode,
): boolean {
  if (layout === "unsupported" || snapshot.repository === null) return false;
  if (snapshot.phase === "browsing") return true;
  return layout !== "wide" && snapshot.phase !== "idle" && snapshot.phase !== "scanning" && snapshot.phase !== "drafting";
}

function insertBeforeExit(
  actions: readonly KeyAction[],
  action: KeyAction,
): readonly KeyAction[] {
  const exitIndex = actions.findIndex((candidate) => candidate.key === "q");
  if (exitIndex === -1) {
    return [...actions, action];
  }
  return [...actions.slice(0, exitIndex), action, ...actions.slice(exitIndex)];
}

function updatePhase(status: UpdateResult["status"]): TuiUpdateUi["phase"] {
  return status;
}

function backgroundUpdatePhase(status: UpdateResult["status"]): TuiUpdateUi["phase"] {
  if (status === "applied") return "current";
  if (status === "failed" || status === "rolled-back") return "unknown";
  return updatePhase(status);
}

function isUpdateSurface(phase: TuiUpdateUi["phase"]): boolean {
  return (
    phase === "reviewing" ||
    phase === "applying" ||
    phase === "applied" ||
    phase === "failed" ||
    phase === "rolled-back"
  );
}

function toUpdateTask(updateUi: TuiUpdateUi): InteractionTask | null {
  const task = (state: InteractionTask["state"], label: string, detail: string) =>
    Object.freeze({
      id: "update.check",
      state,
      label,
      detail,
    });
  switch (updateUi.phase) {
    case "idle":
      return null;
    case "checking":
      return task("running", "Check verified CLI release channel", "Resolving the configured manifest without blocking project work");
    case "current":
      return task("done", "Check verified CLI release channel", "Installed CLI is current");
    case "available":
    case "reviewing":
      return task("warning", "Review available CLI update", `Candidate ${updateUi.result?.latestVersion ?? "unknown"} is available`);
    case "applying":
      return task("running", "Install verified CLI candidate", "Staging, smoke-checking and replacing with rollback protection");
    case "applied":
      return task("done", "Install verified CLI candidate", "Update applied; restart required");
    case "unknown":
      return task("warning", "Check verified CLI release channel", "Availability is unknown; project work remains ready");
    case "failed":
      return task("failed", "Install verified CLI candidate", "No certified replacement was activated");
    case "rolled-back":
      return task("warning", "Install verified CLI candidate", "Previous CLI was restored");
  }
}

function updateKeyActions(
  snapshot: InteractionSnapshot,
  updateUi: TuiUpdateUi,
  configureUi: ConfigureUi,
  composerStage: ComposerStage,
): readonly KeyAction[] {
  if (updateUi.phase === "reviewing") {
    return [
      { key: "Enter", label: "Apply verified CLI update" },
      { key: "Esc", label: "Back" },
      { key: "q", label: "Quit" },
    ];
  }
  if (updateUi.phase === "applying") {
    return [{ key: "Esc", label: "Request safe cancellation" }];
  }
  if (updateUi.phase === "applied") {
    return [
      { key: "o", label: "Scan summary; restart CLI next" },
      { key: "q", label: "Quit and restart" },
    ];
  }
  if (updateUi.phase === "failed" || updateUi.phase === "rolled-back") {
    return [
      { key: "o", label: "Scan summary" },
      { key: "r", label: "Retry update check" },
      { key: "q", label: "Quit" },
    ];
  }
  if (configureUi.searchActive === true) {
    return [
      { key: "Enter", label: "Keep search" },
      { key: "Backspace", label: "Delete" },
      { key: "Esc", label: "Clear search" },
    ];
  }
  const actions = keyActions(snapshot, {
    stage: composerStage,
    focus: configureUi.focus,
    filterCount: availableConfigureFilters(snapshot).length,
    componentCount: filteredCatalog(snapshot, configureUi.filterIndex, configureUi.searchQuery).length,
    targetCount: orderedHarnesses(snapshot).length,
    canContinue: composerStage === "components"
      ? canContinueFromComponents(snapshot)
      : canReviewDraft(snapshot),
  });
  const searchableActions = snapshot.phase === "drafting" && composerStage === "components"
    ? insertBeforeExit(actions, {
        key: "/",
        label: (configureUi.searchQuery?.length ?? 0) > 0 ? "Edit search" : "Search",
      })
    : actions;
  if (snapshot.phase !== "browsing" || updateUi.phase === "idle" || updateUi.phase === "checking") {
    return searchableActions;
  }
  return insertBeforeExit(searchableActions, {
    key: "u",
    label: updateUi.phase === "available" ? "Review CLI update" : "Check CLI update",
  });
}

function separator(): string {
  return asciiMode() ? " | " : " · ";
}

function filterSelectionMarker(): string {
  return asciiMode() ? "* " : "• ";
}

function arrow(): string {
  return asciiMode() ? "->" : "→";
}

function availableConfigureFilters(snapshot: InteractionSnapshot): readonly string[] {
  const managed = snapshot.repository?.management !== "uninitialized";
  return managed ? configureFilters : configureFilters.filter((filter) => filter !== "Installed");
}

function filteredCatalog(snapshot: InteractionSnapshot, filterIndex: number, searchQuery = "") {
  const filter = availableConfigureFilters(snapshot)[filterIndex] ?? "All";
  const publicCatalog = snapshot.catalog;
  const filtered = (() => {
    switch (filter) {
      case "Recommended":
        return publicCatalog.filter((entry) => entry.recommended);
      case "All":
        return [...publicCatalog].sort((left, right) => {
          const family = catalogKindOrder(left) - catalogKindOrder(right);
          return family === 0 ? left.ref.localeCompare(right.ref) : family;
        });
      case "Packs":
        return publicCatalog.filter((entry) => entry.kind === "pack");
      case "Skills":
        return publicCatalog.filter((entry) => entry.kind === "skill");
      case "MCP":
        return publicCatalog.filter((entry) => entry.kind === "mcp-integration");
      case "Agents":
        return publicCatalog.filter((entry) => entry.kind === "agent");
      case "Quality":
        return publicCatalog.filter((entry) => entry.kind === "verification-profile");
      case "Git Hooks":
        return publicCatalog.filter((entry) => entry.kind === "git-gate");
      case "Installed": {
        const installed = new Set(snapshot.repository?.installedDirectSelections ?? []);
        return publicCatalog.filter((entry) => installed.has(entry.ref));
      }
      default:
        return publicCatalog;
    }
  })();
  const tokens = searchQuery.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  if (tokens.length === 0) return filtered;
  return filtered.filter((entry) => {
    const searchable = [
      entry.ref,
      entry.kind,
      catalogDisplayName(entry),
      entry.description,
      entry.details,
      entry.impact.changes,
      entry.impact.workflow,
    ].join(" ").toLowerCase();
    return tokens.every((token) => searchable.includes(token));
  });
}

function catalogKindOrder(item: InteractionSnapshot["catalog"][number]): number {
  if (item.kind === "git-gate") {
    const event = item.gitGate?.event ?? "pre-push";
    return event === "pre-commit" ? 5 : 6;
  }
  switch (item.kind) {
    case "pack": return 0;
    case "skill": return 1;
    case "mcp-integration": return 2;
    case "agent": return 3;
    case "verification-profile": return 4;
  }
}

function catalogGroupLabel(item: InteractionSnapshot["catalog"][number]): string {
  switch (item.kind) {
    case "pack": return "PACKS";
    case "skill": return "SKILLS";
    case "mcp-integration": return "MCP";
    case "agent": return "AGENTS";
    case "verification-profile": return "QUALITY";
    case "git-gate": return (item.gitGate?.event ?? "git-hooks").toUpperCase();
  }
}

function componentFamilyLabel(item: InteractionSnapshot["catalog"][number]): string {
  switch (item.kind) {
    case "mcp-integration": return "MCP";
    case "verification-profile": return "quality";
    case "git-gate": return `make ${item.gitGate?.operation ?? "operation"}`;
    default: return item.kind;
  }
}

function catalogDisplayName(item: InteractionSnapshot["catalog"][number]): string {
  if (item.kind !== "git-gate" || item.gitGate === undefined) {
    return formatComponent(item.ref);
  }
  const operation = item.gitGate.operation.charAt(0).toUpperCase() + item.gitGate.operation.slice(1);
  return `${formatComponent(item.gitGate.provider)}${separator()}${operation}`;
}

function orderedHarnesses(snapshot: InteractionSnapshot) {
  const order = ["codex", "claude-code", "vscode", "cursor", "opencode"] as const;
  return [...(snapshot.repository?.harnesses ?? [])].sort((left, right) => {
    if (left.detected !== right.detected) return left.detected ? -1 : 1;
    return order.indexOf(left.id as (typeof order)[number]) - order.indexOf(right.id as (typeof order)[number]);
  });
}

function canContinueFromComponents(snapshot: InteractionSnapshot): boolean {
  if (snapshot.draft === null || snapshot.draft.blocked) return false;
  return snapshot.draft.directSelections.length > 0 ||
    (snapshot.repository?.installedDirectSelections.length ?? 0) > 0;
}

function canReviewDraft(snapshot: InteractionSnapshot): boolean {
  return canContinueFromComponents(snapshot) && (snapshot.draft?.targets.length ?? 0) > 0;
}

function responsiveListRows(
  terminalRows: number,
  minimum: number,
  reservedRows: number,
): number {
  return Math.max(minimum, terminalRows - reservedRows);
}

function visibleWindow<Entry>(
  entries: readonly Entry[],
  selectedIndex: number,
  maximum: number,
): readonly { readonly entry: Entry; readonly index: number }[] {
  if (entries.length <= maximum) {
    return entries.map((entry, index) => ({ entry, index }));
  }
  const half = Math.floor(maximum / 2);
  const start = Math.min(
    Math.max(0, selectedIndex - half),
    Math.max(0, entries.length - maximum),
  );
  return entries.slice(start, start + maximum).map((entry, offset) => ({
    entry,
    index: start + offset,
  }));
}

function wrapIndex(value: number, length: number): number {
  if (length === 0) return 0;
  return ((value % length) + length) % length;
}

async function toggleComponent(
  session: InteractionSession,
  snapshot: InteractionSnapshot,
  ref: ComponentRef,
): Promise<InteractionSnapshot> {
  const selections = snapshot.draft?.selectionInputs ?? [];
  const selected = selections.some((entry) => entry.ref === ref);
  return await session.dispatch({
    type: "replace-draft",
    selections: selected
      ? selections.filter((entry) => entry.ref !== ref)
      : [...selections, { ref }],
    targets: snapshot.draft?.targets ?? [],
  });
}

async function toggleTarget(
  session: InteractionSession,
  snapshot: InteractionSnapshot,
  target: HarnessTargetId,
): Promise<InteractionSnapshot> {
  const targets = snapshot.draft?.targets ?? [];
  const selected = targets.includes(target);
  return await session.dispatch({
    type: "replace-draft",
    selections: snapshot.draft?.selectionInputs ?? [],
    targets: selected ? targets.filter((entry) => entry !== target) : [...targets, target],
  });
}

async function reviewRemoveAll(
  session: InteractionSession,
  root: string,
): Promise<InteractionSnapshot> {
  const scanned = await session.dispatch({ type: "scan", root });
  if (scanned.phase !== "browsing") return scanned;
  const drafted = await session.dispatch({
    type: "compose-draft",
    base: "installed",
    recommended: false,
    add: [],
    remove: scanned.repository?.installedDirectSelections ?? [],
    setInputs: [],
    targets: null,
  });
  if (drafted.draft?.blocked === true) return drafted;
  return await session.dispatch({ type: "request-plan", mode: "remove" });
}

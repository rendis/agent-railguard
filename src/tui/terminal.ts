import type { InteractionSnapshot } from "../interaction/model.js";

const enterAlternateScreenAndHideCursor = "\u001B[?1049h\u001B[?25l";
const showCursorAndLeaveAlternateScreen = "\u001B[?25h\u001B[?1049l";

export interface TuiTerminalLifecycle {
  restore(): void;
}

export function beginTuiTerminal(
  stdout: NodeJS.WriteStream,
): TuiTerminalLifecycle {
  const enabled = stdout.isTTY === true;
  let restored = false;
  if (enabled) {
    stdout.write(enterAlternateScreenAndHideCursor);
  }
  return Object.freeze({
    restore(): void {
      if (restored) return;
      restored = true;
      if (enabled) {
        stdout.write(showCursorAndLeaveAlternateScreen);
      }
    },
  });
}

export function renderTuiExitSummary(snapshot: InteractionSnapshot): string {
  const receipt = snapshot.receipt;
  const succeeded =
    receipt?.result === "succeeded" || receipt?.result === "no-changes";
  const management = succeeded
    ? snapshot.plan?.mode === "remove"
      ? "uninitialized"
      : "managed"
    : snapshot.repository?.management ?? "uninitialized";
  const integrity = succeeded
    ? "clean"
    : snapshot.repository?.integrity ?? "unknown";
  if (receipt === null) {
    return `AI Harness: session closed | management=${management} | integrity=${integrity} | no repository changes applied\n`;
  }
  return [
    `AI Harness: ${receipt.result}`,
    `management=${management}`,
    `integrity=${integrity}`,
    `changed_paths=${receipt.changedPaths.length}`,
    `plan=${receipt.planId ?? "none"}`,
  ].join(" | ") + "\n";
}

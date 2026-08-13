# Interactive wizard

`railguard` with no subcommand, in an interactive terminal, opens a linear wizard. It uses the
same `InteractionSession` as the subcommands: the same repository, selection, and harnesses
produce the same plan as `railguard init|plan`.

`railguard --source /path/to/checkout` uses that checkout as the content source.

## Flow

1. **Scan.** Live progress and a summary: stack, detected harnesses, project status, installed
   and recommended components. A real blocker shows the diagnostics and offers to scan again;
   missing Git, language, or harness does not block the scan.
2. **Menu.** Configure (or change components/harnesses if already managed), actions for installed
   OAuth MCPs (check, log in, and log out), remove everything managed, view the scan detail, scan
   again, or exit.
3. **Components.** List grouped by family (Packs, Skills, MCP, Agents, Quality, Git hooks, Agent
   hooks) or search by text. Nothing is preselected: recommendations are indicated, not imposed.
   Afterward the dependencies that come in as required and any blockers are shown; from there you
   can read a component's detail or change the selection.
4. **Harnesses.** Detected ones appear first; detected does not mean selected.
5. **Plan.** Components, exact file changes, `core.hooksPath`, git hooks, MCP runtimes,
   prerequisites, and what apply runs.
6. **Apply.** Only after choosing "Apply." Ctrl+C during apply asks for a safe cancellation and
   what was applied is restored. When it finishes, the receipt is shown and it scans again.

## Keys

Arrows to move, Space to mark, Enter to confirm. Esc or Ctrl+C in a prompt goes back to the
previous step; in the main menu, it exits.

## Updating

The content comes from the engine the repository pins (its launcher) or from `--source`. On
exit, the TUI warns if there is a newer release; `railguard update --yes` moves the repository to
it ([Installation and updates](installation.md#updating)).

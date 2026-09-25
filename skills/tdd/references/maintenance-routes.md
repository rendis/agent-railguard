# Maintenance routes

Read only the route that applies to the current slice.

## Legacy without coverage

Run the baseline and note pre-existing failures. Add a characterization test for current behavior and confirm it passes. Write a separate test for the behavior that must change and observe RED there. Continue the normal slice from that RED. The characterization test is the safety net; the change test is RED.

## Pure refactor

Before editing, record the public boundary's current results and effects — return values, error categories, output destination, exit status, ordering, and whether a failing effect is surfaced or swallowed — for every affected success and failure path, not only the happy one. Don't freeze a call-time boundary into package or module state just to make it replaceable in a test; keep its real resolution time. Add a green characterization for each plausible change to that contract. A newly injectable effect must not start surfacing an error that was previously swallowed, merely because the new seam can carry it.

Refactor in small steps, rerunning the characterizations after each. Internal structure may change, but every recorded result and effect must stay stable — no functional RED applies here. Removing obsolete code does not license an observable behavior change; split any real behavior change into its own authorized slice and return to the main cycle.

## Pre-existing failures

Record the command, scope, and failure output before the change. Pick a focused signal that isolates the new RED from the old failure, and track the old failure separately, fixing it only under separate authorization.

## Runner or infrastructure unavailable

Restore an executable signal using repository or stack conventions. Until the command reaches the behavior, report the check as `blocked` or `unavailable` — RED and GREEN stay unobserved.

## Read-only work

Define the behavior, seam, check, proposed test, and RED/GREEN commands without changing files or dependencies. Mark both results `unavailable` and hand off the proposal as unexecuted evidence.

## Implementation written before its test

Add a useful regression or characterization test and report that FAIL→PASS was not observed — a test added afterward improves the safety net but does not prove TDD happened retroactively.

## Change without executable behavior

Apply whatever structural checks fit — documentation, formatting, metadata, mechanical moves — and record that RED/GREEN does not apply. If the change touches an API or observable output, treat it as behavior and return to the main cycle.

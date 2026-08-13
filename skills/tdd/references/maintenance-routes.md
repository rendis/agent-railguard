# Maintenance routes

Read only the routes that apply to the current slice.

## Legacy without coverage

1. Run the available baseline and delimit pre-existing failures.
2. Add a characterization or approval test that captures observed current behavior and verify that it passes.
3. Write a separate test for the behavior that must change and observe RED on that difference.
4. Continue the normal slice with the second signal.

The characterization test is the green safety net; the change test is RED.

## Pure refactor

Before editing, inventory the public boundary's current results and effects: returned values and error categories, emitted bytes and destination, exit status, ordering, when a dynamic destination is resolved, and whether an effect failure is ignored or surfaced. Cover every affected success and failure outcome, not only the happy path or newly extracted helper; an `err != nil` assertion does not characterize a stable error category or text, stderr destination, or exit status. Do not freeze a call-time process boundary into package or module state merely to make it replaceable in a test; preserve its resolution time through the live boundary or explicit call-time injection. Establish a green characterization for each plausible contract change not already rejected by the existing safety net. In particular, a newly injectable effect must not turn a previously ignored effect failure into a returned error merely because the new seam can represent it.

Refactor in small steps and repeat the green safety net after each step. Internal seams may change; every observable result and effect identified above must remain stable. Record that a functional RED does not apply. The instruction to remove obsolete paths without compatibility debris does not authorize an observable change in a behavior-preserving refactor. If behavior must change, separate it into a new authorized slice and return to the main cycle.

## Pre-existing failures

Record the command, scope, and failure output before the change. Choose a focused signal that attributes the new RED to the slice and keep the previous failure as a separate risk. Expand scope to fix it only with explicit authority.

## Runner or infrastructure unavailable

Use repository conventions or stack-specific guidance to restore an executable signal. Until the command reaches the behavior, report `blocked`, `not evaluated`, or `unavailable`; RED and GREEN remain unobserved.

## Read-only authority

Define the behavior, seam, oracle, proposed test, and RED/GREEN commands without changing files or dependencies. Mark both results as `not observed` and deliver the proposal as unexecuted evidence.

## Implementation written before its test

Add a useful regression or characterization test and report that FAIL→PASS was not observed. A later test improves the safety net but does not demonstrate TDD retrospectively.

## Change without executable behavior

Apply the appropriate structural checks to documentation, formatting, metadata, or mechanical moves and record that RED/GREEN does not apply. If the change modifies an API or observable output, treat it as behavior and return to the main cycle.

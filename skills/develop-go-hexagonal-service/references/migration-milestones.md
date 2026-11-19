# Migrating an Existing Service to the Hexagonal Layout

A migration moves a working service into the layout of [architecture-contract.md](architecture-contract.md) without changing what it does. It runs as numbered **milestones**: each one changes one kind of thing, keeps the same **safety net** green before and after, and closes with a handoff. Behavior changes only where H0 allowed it.

## Every milestone

Each milestone closes only when all of these hold:

1. **Same net.** The H0 characterization suite runs with no change to its scenarios or assertions (`git diff <H0 commit> -- <suite path>` is empty) and passes. A refactor manufactures no RED: the evidence is the net green before and after.
2. **Gate.** `railguard verify --changed` passes, or each blocker is recorded with its cause. A threshold, assertion or check is never relaxed to pass.
3. **Toolchain.** Every check runs with the toolchain H0 decided (see *Toolchain*), including the image build when the repository builds one.
4. **Review.** An independent `review-go-quality` pass over the fixed diff returns no unresolved finding; a fix starts a new review. Mutation experiments run in a disposable worktree, never in the shared checkout.
5. **Debt ledger.** Every finding the milestone noted for later (dead code, misplaced rule, weak test, open question) is in the ledger with the milestone that will close it.
6. **Commit and handoff.** One Conventional Commit per milestone, then a handoff package: task, changes, acceptance criteria with observed results (commands and outputs), out of scope, open questions, and the ledger delta. The next milestone starts from the handoff alone.

## H0 — Safety net and decisions

Build the net before moving any code, with `build-e2e-test-suite`:

- **Characterization suite.** Run the real binary against official emulators or disposable real dependencies, never in-process fakes of the service's own code. Each scenario observes the effect on the wire: every outbound call or its absence, and for a message consumer the Ack or Nack the broker actually received (see that skill's broker guidance; a dead-letter design gives false passes). The suite describes the code as it is: when a scenario fails, record the observed behavior and leave production untouched.
- **Repair the existing tests** that keep `go test ./...` from passing, without touching production code.
- **Prove the net.** It passes three consecutive runs, and each mutant from a short list turns it red: one per observable outcome (skip an outbound call, swap a success outcome for a failure, break one mapping, and for a message consumer drop the Ack or turn it into a Nack). A surviving mutant is a gap to close before H1.

Then ask the user and record each answer; these decisions are the user's:

- **Toolchain.** Does the migration include upgrading to the latest stable Go and dependencies? It moves the base and pipeline images, deprecations and reachable vulnerabilities (`review-go-quality` covers them in its toolchain and deprecations reference). With a yes, H5 carries it and every milestone after H5 runs on the new version. With a no, every milestone runs on the declared toolchain: `GOTOOLCHAIN` set to the `go.mod` version, plus the image build.
- **Dead code inventory.** List what no program reaches (`railguard verify` reports it through `deadcode`) and every unused type or mock. Each entry gets a planned outcome (delete, keep with a reason, or a ticket) and a milestone no later than H4.
- **Allowed behavior changes.** The explicit list of observable changes the migration may make (a log format, a fixed bug, a timeout). Anything else that the net detects is a regression.
- **Architecture debt.** Point `go-architecture`'s `core_packages` at the packages that will form the core with `on_violation: [report]`; `railguard verify` lists the violations as the debt H2 and H3 remove. Restore `block` when H3 closes.

Complete when the net is proved and every decision is recorded.

## H1 — Move

Create the topology and move each file to the layer where it mostly belongs today. Only mechanical changes: `package` clauses, imports, exporting identifiers that now cross packages, and build paths (Dockerfile, CI, build entry points). Anything that still mixes layers goes to the ledger for H3.

- Move with `git mv`, one file per target, so Git pairs each rename and `change-size` counts only the changed lines; justify each moved test file's findings with `Railguard-Justify: <kind> <path>: <reason>`.
- **Normalized diff.** For each moved file, the diff against its old path is empty once `package` and import lines are removed. Record the command and its empty output.

## H2 — Ports

Introduce the ports the core needs today, small and defined by their consumer; one use case per entry the primary adapter invokes; secondary adapters implement the ports; composition is explicit in `cmd/<runtime>` (load, build, run, shut down). The primary adapter keeps the same decisions (status codes, Ack or Nack).

## H3 — Responsibilities

Move each rule to its layer: eligibility and aggregation rules into the domain or core service as pure policies, transport details and mappers into the adapter that owns them. Separate domain models from transport DTOs where their fields or rules differ, and name use cases and parameters in business language. Core errors become typed ([error-management.md](error-management.md)) without changing which outcome each one reaches. Add unit tests with `design-tests` where code is now isolable; the core reaches 100% coverage. `go-architecture` returns to `block` with no violation.

## H4 — Infrastructure

Load and validate configuration once at start-up ([runtime-configuration.md](runtime-configuration.md)), share clients with explicit timeouts that keep the effective values, and make broker and client settings explicit with today's defaults. Close every dead code entry of the ledger: deleted, or kept with a recorded reason. Final hardening with `test-go-service`: race, coverage, `govulncheck`, mutation where the profile asks for it.

## H5 — Version

Only when H0 decided to upgrade: move the `go` directive, toolchain, direct dependencies, base and pipeline images to the latest stable versions; fix the deprecations; `govulncheck` reports no reachable vulnerability, or each one is recorded. Build locally with the pipeline's exact command.

## H6 — Quality and idiom

Configure and pass the quality gates with `configure-go-quality` (the pack's `golangci.yml`, cyclomatic and cognitive complexity, function length, unused code), then apply [go-design-practices.md](go-design-practices.md) and [error-management.md](error-management.md): wrapped and compared errors, propagated context, structured logging. The code gets simpler; what it does stays. A change of log format is observable: it goes to the user as its own decision, and the characterization adapts only after the user accepts it.

## Close the migration

Delivery closes when every milestone met *Every milestone*, the ledger holds no open dead code entry, the allowed behavior changes list matches what the net observed, and the final report names each milestone's commit, its handoff and the decisions still open.

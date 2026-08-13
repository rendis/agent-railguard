# Go and Godog Contract for E2E

Apply this reference only after the E2E owner observes Go and selects executable Gherkin with Godog. Do not select Gherkin here.

## Integrate the existing stack

- Reuse the module, Go version, test runner, task surface, build tags, harness, and lifecycle.
- Pin a compatible Godog version and execute scenarios through the established `go test` contract.
- Keep bootstrap/hooks separate from capability bindings and scenario state.
- Group features and bindings by capability; share drivers/environment at stable technical boundaries without generic helper drawers or a package per scenario.
- Keep large technical matrices in native Go tests when no shared audience benefits from Gherkin.

## Keep bindings discoverable

Use handler names traceable to the step intent and one clear registration owner per capability. Add package or handler documentation when it explains vocabulary, lifecycle, a non-obvious mapping, or an explicitly adopted traceability contract. Do not require exact phrase comments, manual indexes, or GoDoc on every binding by default.

The bundled `scripts/gherkin-docs` analyzer is an optional agent diagnostic for projects that explicitly adopt exact phrase-to-handler documentation. Resolve it from the installed skill root and pass the project step root. It must not be invoked by canonical CI from a skill path or copied into the consumer repository. A mandatory version requires a separately published and pinned CLI or a maintained standard replacement.

Return to E2E the Godog version, execution mode, locations, binding conventions, any adopted diagnostic, and observed result. Documentation evidence remains separate from the journey verdict.

# Runtime Configuration

Read this reference whenever a change creates, reads, maps, validates, or consumes runtime configuration.

## Own the runtime contract

- Keep the canonical versioned defaults at `internal/infra/config/application.yaml` and the typed model, loader, normalization, and validation in `internal/infra/config`.
- Make `main` select and load the configuration before constructing the graph. Pass the validated configuration to `cmd/<runtime>/bootstrap.go`; each constructor receives only its cohesive typed section.
- Keep file formats, environment names, endpoints, credentials, pools, and technical timeouts outside `internal/core`. Pass only technology-agnostic policies into the core when the application genuinely owns them.
- Treat other YAML files such as capability catalogs, permissions, fixtures, and manifests as adapter-owned static data. Do not merge them into global runtime configuration.

## Resolve sources deterministically

Use this precedence, from strongest to weakest:

1. variables already injected into the process environment;
2. `application.yaml`;
3. typed defaults declared by the configuration owner.

Choose the narrowest loader that implements the observed contract:

- Use `os.ReadFile` plus `gopkg.in/yaml.v3` and explicit `os.LookupEnv` mapping when the source set and precedence are small. Decode into a typed `Config`; do not pass maps through the application.
- Use `github.com/spf13/viper` when the current requirement genuinely needs hierarchical environment mapping, several configuration sources, or Viper's precedence machinery. Configure the key mapping explicitly and unmarshal the effective result into the same typed `Config`.
- Use `os.Getenv` or `os.LookupEnv` directly for values the platform already injects. Centralize names and conversion in the config loader rather than reading environment variables throughout adapters.
- Use `github.com/joho/godotenv` only through an explicit local-development entrypoint. Production startup consumes its process environment and never depends on a `.env` file.

Inspect the repository's current loader and pinned versions first. Preserve an established coherent mechanism. When no loader exists, recommend direct `yaml.v3` plus explicit environment mapping for the simple three-source contract; recommend Viper only when its additional composition removes more code and policy than it introduces.

An expression such as `${TOKEN}` inside YAML is inert text unless the loader implements interpolation. Add interpolation only for an observed requirement, resolve through `os.LookupEnv`, reject missing required variables, and test escaping and empty-value semantics. Do not apply unrestricted expansion to arbitrary YAML.

## Start only from valid configuration

1. Establish typed defaults.
2. Read the selected YAML file. Keep `internal/infra/config/application.yaml` as the repository default; allow deployment to supply an explicit path instead of deriving a path from source files or developer directories.
3. Apply environment overrides.
4. Parse and normalize durations, URLs, sizes, enums, and other semantic types.
5. Validate required values, ranges, cross-field rules, and mutually exclusive choices.
6. Return either one complete immutable configuration or an actionable startup error with no partial graph.

Fail before readiness when required configuration is absent or invalid. Never log secrets, tokens, connection strings, private keys, or complete sensitive configuration. Keep secrets in injected environment variables or a secret manager and use non-secret placeholders or empty values in versioned YAML.

Test default-only, YAML, environment override, malformed input, missing required values, sensitive diagnostics, and every explicit interpolation branch. A production-like startup test must prove that configuration is loaded and validated before server or adapter construction.

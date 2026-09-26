/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "domain-does-not-import-outer-layers",
      severity: "error",
      from: { path: "^src/domain" },
      to: { path: "^src/(adapters|application|catalog)" },
    },
    {
      name: "stack-adapter-does-not-import-harness-or-resolution",
      severity: "error",
      from: { path: "^src/adapters/stack" },
      to: { path: "^src/(adapters/harness|domain/(recommendation|resolution))" },
    },
    {
      name: "harness-adapter-does-not-import-stack-or-assessment",
      severity: "error",
      from: { path: "^src/adapters/harness" },
      to: { path: "^src/(adapters/stack|domain/repository/assessment)" },
    },
    {
      name: "recommendation-does-not-import-io",
      severity: "error",
      from: { path: "^src/domain/recommendation" },
      to: { path: "^src/(adapters|catalog)" },
    },
    {
      name: "no-orphans",
      severity: "warn",
      from: { orphan: true, pathNot: "(^|/)(cli|model)\\.ts$|\\.d\\.ts$" },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      conditionNames: ["types", "import", "node", "default"],
      exportsFields: ["exports"],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};

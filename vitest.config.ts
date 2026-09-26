import { defineConfig } from "vitest/config";

export default defineConfig({
  // Matches the esbuild text loader: Markdown the CLI prints is imported as a string.
  plugins: [{
    name: "markdown-as-text",
    transform(code, id) {
      return id.endsWith(".md") ? `export default ${JSON.stringify(code)};` : undefined;
    },
  }],
  test: {
    environment: "node",
    fileParallelism: false,
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/cli.ts", "src/**/model.ts"],
      thresholds: {
        statements: 80,
        branches: 70,
        functions: 85,
        lines: 80,
      },
    },
  },
});

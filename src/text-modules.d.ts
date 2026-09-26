/** Markdown files imported as text; esbuild and vitest load them with a text loader. */
declare module "*.md" {
  const text: string;
  export default text;
}

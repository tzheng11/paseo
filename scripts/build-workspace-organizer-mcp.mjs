import { build } from "esbuild";
await build({
  entryPoints: ["plugin-examples/workspace-organizer/server/mcp/serve.ts"],
  outfile: "plugin-examples/workspace-organizer/dist/mcp.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
  logLevel: "info",
});

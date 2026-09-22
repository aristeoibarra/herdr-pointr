import { defineConfig } from "tsup";

export default defineConfig([
  {
    // CLI + server bundle — Node, no runtime deps, executable shebang.
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    platform: "node",
    target: "node20",
    banner: { js: "#!/usr/bin/env node" },
    outDir: "dist",
  },
  {
    // Browser bundles, both IIFE: the widget with finder inlined, and
    // modern-screenshot on its own so tabs only load it when a screenshot is taken.
    entry: { widget: "client/widget.ts", screenshot: "client/screenshot.ts" },
    format: ["iife"],
    platform: "browser",
    target: "es2020",
    minify: true,
    outDir: "dist",
  },
]);

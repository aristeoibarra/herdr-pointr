import { defineConfig } from "tsup";

// Browser bundles, both IIFE, written where the Go bridge embeds them: the
// widget with finder inlined, and modern-screenshot on its own so tabs only
// load it when a screenshot is taken.
export default defineConfig({
  entry: { widget: "client/widget.ts", screenshot: "client/screenshot.ts" },
  format: ["iife"],
  platform: "browser",
  target: "es2020",
  minify: true,
  outDir: "bridge/web",
  clean: false,
});

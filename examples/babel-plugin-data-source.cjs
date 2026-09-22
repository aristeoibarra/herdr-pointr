/**
 * Babel plugin: stamp every JSX *host* element (div, button, …) with
 * data-source="relative/path.tsx:line". The pointr widget reads
 * the attribute (client/capture.ts) and the prompt gains an exact `Source:`
 * line, so Claude opens the file instead of grepping by component name.
 *
 * Host elements only — lowercase tags become real DOM attributes. Stamping
 * <MyComponent> would only add an unused prop (and noise in captured props).
 *
 * Cost: Next 16.2+ keeps Turbopack and runs the Babel config as an external
 * transform (measured cold-compile cost within noise); older Next falls back
 * from Turbopack to Babel, which is slower. Mount it per project, dev-only —
 * see the README section "Optional: exact file:line via Babel".
 */
"use strict";

const { relative } = require("node:path");

module.exports = function dataSourcePlugin({ types: t }) {
  return {
    name: "data-source",
    visitor: {
      JSXOpeningElement(path, state) {
        const node = path.node;
        if (!node.loc) return;
        if (!t.isJSXIdentifier(node.name) || !/^[a-z]/.test(node.name.name)) return;
        const exists = node.attributes.some(
          (attr) => t.isJSXAttribute(attr) && attr.name.name === "data-source",
        );
        if (exists) return;

        const filename = state.filename ?? state.file.opts.filename ?? "";
        if (!filename || filename.includes("node_modules")) return;
        const root = state.file.opts.root ?? state.cwd ?? "";
        const rel = root ? relative(root, filename) : filename;

        node.attributes.push(
          t.jsxAttribute(
            t.jsxIdentifier("data-source"),
            t.stringLiteral(`${rel}:${node.loc.start.line}`),
          ),
        );
      },
    },
  };
};

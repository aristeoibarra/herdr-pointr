# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A dev-only **herdr plugin** that lets you select DOM elements in any localhost app and send them —
with React component name/ancestry, a clean selector, computed styles, and an optional screenshot —
into the coding agent that owns that project. One global bridge serves every project; routing from
browser tab to the right agent is automatic (dev-server port → cwd → agent). Agent-agnostic: herdr
detects 24 agent kinds, so nothing here is specific to Claude Code. Linux and macOS.

## Commands

```bash
npm run build      # tsup: produces dist/cli.js AND dist/widget.global.js
npm run dev        # tsx src/cli.ts serve — runs the server from source, no build step
npm run typecheck  # tsc --noEmit
npm test           # vitest run — src/routing.test.ts only
```

There is no linter. `npm run typecheck && npm test` is the gate before committing, and shell
scripts go through `shellcheck`.

Tests cover `src/routing.ts` and nothing else, deliberately. Everything else in this repo fails
loudly — a bad herdr call throws, a broken widget shows an error. Routing is the one place where
being wrong is *invisible*: it does not fail, it delivers somewhere else. The cases in
`src/routing.test.ts` are the shapes that actually misrouted.

Runtime CLI (`dist/cli.js`, or `pointr` once installed): `start|stop|status` manage the background
bridge, `serve` runs it in the foreground, `agents` lists what herdr can see, `pin`/`pick` choose a
destination, `doctor` checks herdr and port lookup. `GET /debug?port=N` returns the full
resolution trace, which is the fastest way to answer "why did it route there?".

**Gotcha:** `npm run dev` runs the server from source via tsx, but the server still serves the widget
from the **pre-built** `dist/widget.global.js`. After editing anything under `client/`, re-run
`npm run build` or the browser gets stale JS. Editing `src/` only needs a dev restart.

**Gotcha:** `herdr plugin link` does **not** run the manifest's `[[build]]` commands — only
`herdr plugin install` does. A local checkout must be built by hand or `scripts/pointr.sh` refuses
to start.

## Two build targets, two source trees

`tsup.config.ts` emits two independent bundles, and the source is split to match:

- **`src/` → `dist/cli.js`** — the Node side: CLI, HTTP server, herdr socket client, routing, daemon.
  ESM, no runtime deps, executable shebang.
- **`client/` → `dist/widget.global.js`** — the browser widget: an IIFE with `@medv/finder` and
  `modern-screenshot` inlined. Served at `GET /widget.js`. These deps are `devDependencies` precisely
  because they're bundled into the widget at build time, never required at runtime.

Imports use explicit `.ts` extensions (`allowImportingTsExtensions` + Bundler resolution); keep that
style. `verbatimModuleSyntax` is on, so use `import type` for type-only imports.

## Request flow (the core path)

1. Browser widget (`client/widget.ts`) captures one or more elements via `client/capture.ts`
   (component name/ancestry **and serialized props** from the fiber), optionally rasterizes a
   screenshot, and `POST`s `{message, url, elements, screenshot, autoSubmit, targetAgent,
   diagnostics}` to `/send`. `diagnostics` is a ring buffer of recent console errors / uncaught
   exceptions / failed fetches kept by `client/diagnostics.ts`.
2. `src/server.ts` resolves the destination via `src/routing.ts` (cascade below), `formatPrompt()`
   (`src/format.ts`) renders the agent-facing prompt, and a base64 screenshot is written to a temp
   file so the agent can read it by path.
3. `src/herdr.ts` delivers it: `agent.prompt` when auto-submitting, `pasteText` otherwise.
4. The widget opens `GET /status?agent=…` (SSE) and follows the agent's real lifecycle state until
   it settles.

## Routing cascade (`resolveTarget` in src/routing.ts)

Zero per-project config, tolerant of panes that come and go. Order:

1. **Per-tab override** from the extension popup, then the **pinned agent** from config — each only
   if that pane still exists.
2. **port → cwd → agent** — parse the dev-server port from the page URL, find the process listening
   on it, take its cwd, and match the agent working there.
3. **Configured `projectPath`**.
4. **The only agent**, if exactly one exists.

`matchAgents` works in **ordered, exclusive tiers**: exact cwd, then nearest *ancestor* (deepest),
then nearest *descendant* (shallowest). More than one agent surviving a tier is ambiguous and
answers **409 with the candidates** — it never breaks the tie itself.

The tier boundary is the whole point, and it is easy to talk yourself out of. *Within* a tier every
candidate is a prefix of the next, so "deepest" and "longest string" agree and a plain length sort
looks correct. They only part company *across* tiers — which is exactly where the old rule, one
length sort over every match, sent a project's feedback to an unrelated session.

**`isInformativeProjectDir` is the load-bearing part**, and it applies to *both* sides.

On the dev server's directory: one started from `$HOME` has every agent below it, so containment
matches all of them and any tie-break is arbitrary. `$HOME`, `/`, tmpdir, any ancestor of home, and
directories with no project marker are rejected as evidence, so the port step yields nothing and the
user is asked.

On an agent's directory, in the ancestor tier only: an agent parked in `$HOME` *contains* every
project on the machine, so containment alone would make it win for all of them and route each
project's feedback to a session holding none of its code. Applying the test to only the dev-server
side was the same idea done halfway. The exact tier needs no such check — exact is exact — and a
descendant is inside the project by construction.

## herdr specifics that bite

All of these were verified against herdr 0.9.1 (protocol 22), not inferred from docs:

- **One request, one connection.** The server closes the socket after a single response; a second
  write gets `EPIPE`. There is no multiplexing by request id. `events.subscribe` is the sole
  exception — its connection stays open past the ack and streams.
- **Event names use two conventions.** You subscribe with dotted types, but only the three
  subscription-scoped events come back dotted (`pane.agent_status_changed`); lifecycle events come
  back underscored (`pane.updated` → `pane_updated`). Match one convention and half the stream
  vanishes. `src/herdr.ts` normalizes both into a discriminated union.
- **Agent status is per-pane.** `pane.agent_status_changed` requires a `pane_id`; there is no global
  status stream. Titles only arrive on the global `pane.updated`, so `src/watch.ts` keeps one shared
  globals connection plus one subscription per watched pane.
- **Subscriptions never replay.** Anything between losing a connection and re-acking one is gone, so
  subscribe *before* prompting and re-seed from `agent.get` after a reconnect.
- **Miss codes are namespaced**: `agent_not_found`, `pane_not_found` — never a bare `not_found`.
- **`pane.send_text` is raw.** It does not wrap in bracketed paste, so an unwrapped multi-line prompt
  is submitted line by line. `pasteText` wraps in `ESC[200~ … ESC[201~` itself. `agent.prompt` does
  its own handling and needs no wrapping.
- **`pane.send_text` has no `agent_blocked` guard**, unlike `agent.prompt`, so the no-submit path can
  answer an approval dialog. `/send` checks the last known status first; the race is documented and
  accepted.

## Running as a plugin (herdr-plugin.toml, src/daemon.ts)

herdr `[[startup]]` hooks are **one-shot, not supervised**, so the plugin owns its process: `start`
health-checks first, spawns the server detached, writes a pidfile under `HERDR_PLUGIN_STATE_DIR`,
and waits for it to actually answer. `status` exits 0 even when down — herdr records a non-zero exit
as a failed action.

**Every manifest command goes through `scripts/pointr.sh`, and that indirection is not decoration.**
A manifest `command = ["node", …]` resolves through the herdr server's PATH, which under fnm points
at a per-shell symlink farm in `/run` and under nvm/asdf at a versioned directory a later upgrade
deletes. The plugin would work until the next reboot or node upgrade, then fail with `node: not
found` from a service with no terminal attached. The script resolves a stable interpreter first.

`min_herdr_version = "0.9.0"` is a real floor: `agent_blocked` rejection landed in 0.8.2 and the
"prompt and Enter both sent before reporting success" guarantee in 0.9.0. herdr re-checks it on
every dispatch and a shortfall is a hard load failure, so do not raise it casually. Declaring an
unknown `[[events]]` name, by contrast, is only an install-preview warning.

## React fiber walking (client/react-fiber.ts)

Resolves the owning component name + ancestry by walking `__reactFiber$*`, mirroring React DevTools'
name resolution (memo/forwardRef/lazy). `getComponentProps` snapshots the owner's `memoizedProps` as
flat strings (scalars verbatim; functions/objects/elements summarized, never deep-serialized — keep
it that way, props can hold huge object graphs). React 19 removed `_debugSource`, so file:line is
**not** available from the fiber — component identity is what lets the agent grep to the file.
`FRAMEWORK_RE` is a **pattern** (not an exact list) that filters Next.js/App-Router internal
wrappers, because Next renames them across versions; extend the pattern rather than hardcoding
names. Exact `file:line` is only available if a project opts into a `data-source` Babel plugin.

## Widget delivery & config

- Three ways to load the widget, all hitting the same `/widget.js`: the **browser extension**
  (`extension/`, MV3 content script, auto-injects on `localhost`/`127.0.0.1`, skips port 7331), the
  **bookmarklet** (`src/bookmarklet.ts`, served at `/`), or mounting `examples/Pointr.tsx` from a
  project (CSP-strict fallback).
- The widget derives the bridge origin from its own `<script src>`, so it works on any port with no
  build-time define.
- Config lives in `HERDR_PLUGIN_CONFIG_DIR` when running as a plugin, else
  `~/.config/herdr-pointr/config.json` (`src/config.ts`); default port `7331`. `herdrSocketPath`
  exists because a detached daemon inherits a fresh environment, so a named session's socket has to
  be configured rather than inherited.
- The server is intentionally permissive (CORS `*`, accepts any local origin) — it's localhost-only
  dev tooling. Don't add auth/origin checks expecting production hardening; that's out of scope.
- `extension/` is hand-written JS, not a build target: `content.js`/`popup.js` are loaded verbatim by
  MV3 and so are outside `tsconfig`/tsup. Keep them small and plain; anything that wants types
  belongs in `client/`.
- **Icons**: `extension/icons/icon.svg` is the source; the four committed PNGs are rasterized from it
  (regenerate by hand with `npx @resvg/resvg-js` or any SVG rasterizer — ImageMagick's built-in MSVG
  renderer drops the gradient and every `stroke`). Its geometry is deliberately a multiple of 8 on a
  128 grid so it lands on whole pixels at 16px, the size the toolbar actually renders.

## Settings live in the widget

The gear in the panel header opens them; the extension popup is a health
indicator and nothing else. It used to be the other way round, and the reason
for moving was not only "one place instead of two": loaded by bookmarklet or by
mounting `examples/Pointr.tsx`, there is no popup at all, so those paths had no
settings UI whatsoever.

- Three settings: the destination agent (per origin), send-on-click, and the
  selection shortcut.
- The widget runs in the page's **MAIN world** (it's a `<script src>`), so it
  cannot touch `chrome.storage` directly. `window.postMessage` is the only
  channel to `content.js`. Protocol: widget → `prefs:get`, `prefs:set`,
  `pin:clear`; extension → `prefs`.
- `content.js` splits a `prefs:set` back into scopes on write exactly as it
  joins them on read: `global` (`autoSend`, `hotkey`) and `agent:<origin>`
  (`{id, session, label}`). Splitting them is the point — nobody wants to
  re-record the shortcut per project, and nobody wants a destination chosen on
  one site to follow them to another.
- `content.js` re-pushes on `chrome.storage.onChanged`, so a change made in one
  tab lands live in every other open tab. The widget never answers a `prefs`
  push with a `prefs:set`, which is what keeps that from looping.
- The stored destination label holds **only stable fields** (`project · kind`).
  It sits beside the pin so the widget can render a pinned destination while the
  bridge is unreachable; status changes by the second and is fetched live from
  `/agents`, never persisted.
- Identifiers that must agree across the MAIN-world bundle and the isolated
  content script (`pointr-root`, `pointr-widget`, `pointr-ext`) are **hardcoded
  in both files** — there is no shared module between the two worlds. Change one
  side only and injection or the prefs channel breaks silently.
- Loaded without the extension, nothing answers `prefs:get` or `prefs:set` and
  the widget keeps everything in its own `localStorage` (`pointr-prefs`), which
  it writes on every change either way.

## Releasing

Distribution is the repo itself: tag the GitHub repo with the topic `herdr-plugin` and users run
`herdr plugin install aristeoibarra/herdr-pointr`. There is no npm publish. `dist/` is **not**
committed — `herdr plugin install` runs the manifest's `[[build]]` commands.

`version` lives in three files — `package.json`, `extension/manifest.json` and `herdr-plugin.toml` —
read by npm, Chrome and herdr's registry respectively. Drift breaks no build; it just ships a plugin
whose manifest disagrees with its own package, which is invisible to whoever released it and
confusing to whoever installed it. `src/version.test.ts` fails when they disagree, so bumping means
bumping all three.

## Conventions

Conventional commits with a scope reflecting the layer touched (`herdr`, `routing`, `ports`,
`server`, `widget`, `plugin`). Strict TypeScript: no `any`, no `as` (prefer `satisfies`), named
exports, `interface` for object shapes.

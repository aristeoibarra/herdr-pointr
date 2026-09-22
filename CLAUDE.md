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
npm run typecheck  # tsc --noEmit (the ONLY check — there are no tests and no linter)
```

There is no test runner and no ESLint/Prettier config. `npm run typecheck` is the gate before
committing. Shell scripts go through `shellcheck`.

Runtime CLI (`dist/cli.js`, or `pointr` once installed): `start|stop|status` manage the background
bridge, `serve` runs it in the foreground, `agents` lists what herdr can see, `pin`/`pick` choose a
destination, `doctor` checks herdr + port lookup + dictation. `GET /debug?port=N` returns the full
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

**`isInformativeProjectDir` is the load-bearing part.** A dev server started from `$HOME` has every
agent below it, so containment matches all of them and any tie-break is arbitrary. `$HOME`, `/`,
tmpdir, any ancestor of home, and directories with no project marker are rejected as *evidence*, so
the port step yields nothing and the user is asked. It applies only to the dev server's directory,
never to an agent's — an agent legitimately sits anywhere.

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

## Dictation (client/dictation.ts + src/transcribe.ts)

Record in the browser, transcribe on the bridge with whisper.cpp. **Don't "simplify" this back to
the Web Speech API**: it's Google's hosted recognizer, Chromium-only in practice, and Brave disables
it — it fails `not-allowed` with no permission prompt, which is exactly what this replaced.

- **Client**: `getUserMedia` → `AudioContext({ sampleRate: 16000 })` → `ScriptProcessorNode`
  accumulating Float32 chunks → 16-bit mono WAV → base64 → `POST /transcribe`. The processor is
  connected through a **muted gain node** because a ScriptProcessor only runs while connected to the
  graph, and going straight to `destination` would echo the mic. `generation` is bumped on `cancel()`
  so a late transcription can't land in a composer the user already closed.
- **Server**: `resolveSetup` finds the binary (`whisper-cli`, then `whisper-cpp`) and the best model,
  and caches the pair. Model ranking prefers `small` for latency and skips `.en` models (they'd
  mistranscribe Spanish). Both halves are overridable via `whisperBin`/`whisperModel` in the config.
- `GET /dictation` reports availability so the widget can hide the mic instead of failing on click.
  `/transcribe` gets its own 40 MB body cap — audio dwarfs the 5 MB JSON limit.

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

## User settings live in the extension popup

The widget has **no Settings UI** — `extension/popup.html`+`popup.js` own it, and the widget only
reads. Don't re-add a gear to the widget.

- Storage is `chrome.storage.local`, split by scope: `global` (`autoSend`, `dictationLang`, `hotkey`
  — user preferences) and `agent:<origin>` (`{id, session, label}` — which agent this project sends
  to, hence per-origin). Splitting them is the point: nobody wants to re-record the shortcut per
  project.
- The stored label holds **only stable fields** (`project · kind`). It is persisted beside the pin so
  the widget never has to call `/agents`; a status baked into it would be wrong seconds later, so
  status is rendered live by the popup instead.
- The widget runs in the page's **MAIN world** (it's a `<script src>`), so `window.postMessage` is
  the only channel to `content.js`. Protocol: widget → `prefs:get`, `pin:clear`, `dictation`;
  extension → `prefs`. `content.js` re-pushes on `chrome.storage.onChanged`, so popup edits land live
  in every open tab.
- Identifiers that must agree across the MAIN-world bundle and the isolated content script
  (`pointr-root`, `pointr-widget`, `pointr-ext`) are **hardcoded in both files** — there is no shared
  module between the two worlds. Change one side only and injection or the prefs channel breaks
  silently.
- Loaded without the extension, nothing answers `prefs:get` and the widget keeps the values in its
  own `localStorage` (`pointr-prefs`) — still written on every change so removing the extension
  doesn't reset anything.

## Releasing

Distribution is the repo itself: tag the GitHub repo with the topic `herdr-plugin` and users run
`herdr plugin install aristeoibarra/herdr-pointr`. There is no npm publish. `dist/` is **not**
committed — `herdr plugin install` runs the manifest's `[[build]]` commands. Keep `version` in sync
across `package.json`, `extension/manifest.json` and `herdr-plugin.toml`.

## Conventions

Conventional commits with a scope reflecting the layer touched (`herdr`, `routing`, `ports`,
`server`, `widget`, `plugin`). Strict TypeScript: no `any`, no `as` (prefer `satisfies`), named
exports, `interface` for object shapes.

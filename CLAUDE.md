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
npm run build      # tsup (widget → bridge/web/) then go build → dist/pointr, one static binary
npm run typecheck  # tsc --noEmit (client/) and go vet (bridge/)
npm test           # go test ./bridge — routing and the version check
```

Needs Go and Node to build; the built binary needs neither. `npm run typecheck && npm test` is
the gate before committing, and shell scripts go through `shellcheck`.

Tests cover routing and nothing else, deliberately. Everything else fails loudly — a bad herdr
call errors, a broken widget shows an error. Routing is the one place where being wrong is
*invisible*: it does not fail, it delivers somewhere else. The cases in
`bridge/routing_test.go` are the shapes that actually misrouted.

Runtime CLI (`dist/pointr`): `start|stop|status` manage the background bridge, `serve` runs it in
the foreground, `agents` lists what herdr can see, `pin`/`pick` choose a destination, `open`
opens a dev server through the proxy, `doctor` checks herdr and port lookup. `GET /debug?port=N`
returns the full resolution trace — the fastest way to answer "why did it route there?".

**Gotcha:** the widget and the setup page are **embedded** in the binary (`go:embed`). After
editing anything under `client/` or `bridge/web/index.html`, re-run `npm run build` and restart
the bridge, or the browser gets the old ones.

**Gotcha:** `herdr plugin link` does **not** run the manifest's `[[build]]` commands — only
`herdr plugin install` does. A local checkout must be built by hand or `scripts/pointr.sh` refuses
to start.

## Two source trees, one binary

- **`bridge/` → `dist/pointr`** — Go, standard library only: CLI, HTTP server, herdr socket client,
  routing, port lookup, proxy, daemon. One package; files are named for what they hold.
- **`client/` → `bridge/web/*.global.js`** — the browser widget, an IIFE with `@medv/finder`
  inlined, served at `GET /widget.js`; and `modern-screenshot` as its own IIFE at
  `GET /screenshot.js`, which `client/shot-loader.ts` injects only when a screenshot is wanted.
  The rasterizer is ~40% of the total and most sends take none. These are git-ignored build
  output that `go:embed` picks up, so the TypeScript has to build before the Go does.
- Both scripts are served with a fixed `ETag` and `cache-control: no-cache`: a reload costs a 304,
  a new binary lands on the next one. Loaders must **not** add a `?t=Date.now()` cache-buster —
  that makes every URL unique and throws the cache away.
- The bridge was Node until 2.1.0. It moved to Go so users need nothing installed — no Node, no
  version manager — and to run in ~8 MB instead of ~64. Keep it standard-library only.

In `client/`, imports use explicit `.ts` extensions (`allowImportingTsExtensions` + Bundler
resolution); keep that style. `verbatimModuleSyntax` is on, so use `import type` for types.

## Request flow (the core path)

1. Browser widget (`client/widget.ts`) captures one or more elements via `client/capture.ts`
   (component name/ancestry **and serialized props** from the fiber), optionally rasterizes a
   screenshot, and `POST`s `{message, url, elements, screenshot, autoSubmit, targetAgent,
   diagnostics}` to `/send`. `diagnostics` is a ring buffer of recent console errors / uncaught
   exceptions / failed fetches kept by `client/diagnostics.ts`.
2. `bridge/server.go` resolves the destination via `bridge/routing.go` (cascade below),
   `formatPrompt` (`bridge/format.go`) renders the agent-facing prompt, and a base64 screenshot is
   written to a temp file so the agent can read it by path.
3. `bridge/herdr.go` delivers it: `agent.prompt` when auto-submitting, `pasteText` otherwise.
4. The widget opens `GET /status?agent=…` (SSE) and follows the agent's real lifecycle state until
   it settles.

## Routing cascade (`resolveTarget` in bridge/routing.go)

Zero per-project config, tolerant of panes that come and go. Order:

1. **Per-tab override** from the widget's settings, then the **pinned agent** from config — each only
   if that pane still exists.
2. **port → cwd → agent** — parse the dev-server port from the page URL, find the process listening
   on it, take its cwd, and match the agent working there. A proxy port is first translated back to
   the port it fronts (`upstreamUrl`, via `portAliases`), and the bridge's own pid is never taken
   as evidence. Both matter for the same reason: a proxy port is served by the bridge, whose cwd is
   pointr's checkout, so an untranslated one routes every project to the agent working on pointr.
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
  vanishes. `bridge/herdr.go` normalizes both into one `Event` type.
- **Agent status is per-pane.** `pane.agent_status_changed` requires a `pane_id`; there is no global
  status stream. Titles only arrive on the global `pane.updated`, so `bridge/watch.go` keeps one shared
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

## Running as a plugin (herdr-plugin.toml, bridge/daemon.go)

herdr `[[startup]]` hooks are **one-shot, not supervised**, so the plugin owns its process: `start`
health-checks first, spawns the server detached, writes a pidfile under `HERDR_PLUGIN_STATE_DIR`,
and waits for it to actually answer. `status` exits 0 even when down — herdr records a non-zero exit
as a failed action.

Every manifest command goes through `sh scripts/pointr.sh`: `sh` is always on the herdr server's
PATH, and the script runs `dist/pointr` from the plugin root wherever herdr started it.

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

- Three ways to load the widget, all hitting the same `/widget.js`. The default is the **injection
  proxy** (`bridge/proxy.go`): the setup page's Open button, `pointr open 3000`, a ctrl-clicked link,
  or `GET /open?url=` serve the dev server on port + 10000 with the widget's `<script>` first in
  `<head>` of each navigation. Then the **bookmarklet** (on the setup page, `bridge/web/index.html`), for
  keeping the app's own URL, or mounting `examples/Pointr.tsx` from a project.
- There was a Chrome extension; it was removed in 2.0.0 once the proxy covered its one job
  (injecting before the app's code). Don't bring it back to solve the origin change: the
  bookmarklet and `Pointr.tsx` already keep the app's URL, without a second codebase in a second
  JS world.
- The proxy touches **only** top-level navigations (`Sec-Fetch-Dest: document`) that return HTML:
  those are requested uncompressed, decoded if the server compresses anyway, get the tag
  spliced in at byte level (searched as latin1, so the page's encoding is never re-encoded) and
  lose their CSP. Everything else — assets, fetches, iframes — is piped untouched, and WebSocket
  upgrades (HMR) are a raw TCP tunnel. Host/Origin/Referer are rewritten to the dev server's port
  going in (Next server actions and Vite's WS check compare them) and absolute `Location` headers
  back to the proxy's coming out. It binds `127.0.0.1` only — a dev server on localhost is private
  on purpose. Open proxies persist in the state dir (`proxies.json`) and reopen on the same port
  at startup; an idle one with no connections closes after 30 minutes.
- The setup page at `/` lists dev servers from `GET /servers`: every listening port outside the
  ephemeral range (where port-0 binds land — Next's router workers, debuggers), whose owner's cwd
  passes `isInformativeProjectDir`, minus the bridge's own ports. Reusing the routing's evidence
  test is deliberate: the list shows exactly the ports routing could attribute to a project, with
  `matchAgents` saying where each would land.
- The widget derives the bridge origin from its own `<script src>`, so it works on any port with no
  build-time define.
- Config lives in `HERDR_PLUGIN_CONFIG_DIR` when running as a plugin, else
  `~/.config/herdr-pointr/config.json` (`bridge/config.go`); default port `7331`. `herdrSocketPath`
  exists because a detached daemon inherits a fresh environment, so a named session's socket has to
  be configured rather than inherited.
- The server is intentionally permissive (CORS `*`, accepts any local origin) — it's localhost-only
  dev tooling. Don't add auth/origin checks expecting production hardening; that's out of scope.

## Settings live in the widget

The gear in the panel header opens them. Three settings: the destination agent,
send-on-click, and the selection shortcut. They live in the page's
`localStorage` (`pointr-prefs`), written on every change.

- `localStorage` is per origin, and origin includes the port, so every setting
  is per app — including the shortcut. A destination chosen for one app not
  following you to another is the point; re-recording a custom shortcut per app
  is the accepted cost of having nothing installed in the browser.
- The stored destination label holds **only stable fields** (`project · kind`).
  It sits beside the pin so the widget can render a pinned destination while the
  bridge is unreachable; status changes by the second and is fetched live from
  `/agents`, never persisted.

## Releasing

Distribution is the repo itself: tag the GitHub repo with the topic `herdr-plugin` and users run
`herdr plugin install aristeoibarra/herdr-pointr`. There is no npm publish. `dist/` is **not**
committed — the manifest's one `[[build]]` step is `scripts/build.sh`.

That script fetches `pointr-<os>-<arch>-<commit>.tar.gz` from the `dist` prerelease, which
`.github/workflows/dist.yml` fills on every push to `main` and every `v*` tag for linux and darwin,
amd64 and arm64 (keeping the newest 80 plus every tagged commit), and checks the binary runs
before installing it. Only if that misses does it build from source, which needs Go and npm. The
binary is keyed by **commit, not version**, and that is the part not to "simplify": an install from `main`
a few commits past a release would otherwise get a binary that disagrees with its own source, and
nothing would fail. herdr checks out with `.git` present (`fetch --depth 1` + detached checkout,
verified in herdr 0.9.1's `src/cli/plugin.rs`), which is what makes `git rev-parse HEAD` work there.

`version` lives in two files — `package.json` and `herdr-plugin.toml` — read by npm and herdr's
registry respectively. Drift breaks no build; it just ships a plugin whose manifest disagrees with
its own package, which is invisible to whoever released it and confusing to whoever installed it.
`bridge/version_test.go` fails when they disagree, so bumping means bumping both.

Cutting a release: bump both, commit `chore: release vX.Y.Z`, tag `vX.Y.Z` on that commit, push
`main` and the tag, then `gh release create vX.Y.Z` with notes written for users (what changed
for them, not the commit list). Pushing the tag keeps that commit's binaries past the prune, so
`herdr plugin install … --ref vX.Y.Z` keeps working.

## Conventions

Conventional commits with a scope reflecting the layer touched (`herdr`, `routing`, `ports`,
`server`, `widget`, `plugin`). Go: standard library only, `gofmt`, errors returned rather than
panicked. TypeScript (`client/`): strict, no `any`, no `as` (prefer `satisfies`), named exports,
`interface` for object shapes.

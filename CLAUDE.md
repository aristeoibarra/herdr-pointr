# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A dev-only **herdr plugin** that lets you comment on DOM elements in any localhost app. The comment
goes — with React component name/ancestry, a clean selector, computed styles, and an optional
screenshot — into the coding agent that owns that project, and the agent's answer comes back as a
thread pinned to the element (`pointr reply`). One global bridge serves every project; routing from
browser tab to the right agent is automatic (dev-server port → cwd → agent). Agent-agnostic: herdr
detects 24 agent kinds, so nothing here is specific to Claude Code. Linux and macOS.

## Commands

```bash
npm run build      # tsup (widget → bridge/web/) then go build → dist/pointr, one static binary
npm run typecheck  # tsc --noEmit (client/) and go vet (bridge/)
npm test           # go test ./bridge — routing, thread delivery and the version check
npm run scenarios  # builds dist/scenarios/anchor-scenarios.html: open it, every row must PASS
```

Needs Go and Node to build; the built binary needs neither. `npm run typecheck && npm test` is
the gate before committing, and shell scripts go through `shellcheck`.

Tests cover what delivers somewhere else when it is wrong, and nothing else, deliberately.
Everything else fails loudly — a bad herdr call errors, a broken widget shows an error. Routing is
where being wrong is *invisible*: it does not fail, it delivers somewhere else. The cases in
`bridge/routing_test.go` are the shapes that actually misrouted. Threads have the same failure
shape, so `projectKeyFor`, `followUpTarget`, the reply command and a thread surviving a restart are
tested too (`bridge/threads_test.go`): wrong there, a reply just never shows up where the user looks.

Runtime CLI (`dist/pointr`): `start|stop|status` manage the background bridge, `serve` runs it in
the foreground, `agents` lists what herdr can see, `pin`/`pick` choose a destination, `open`
opens a dev server through the proxy, `doctor` checks herdr and port lookup, `reply <thread-id>` is
what agents run to answer a comment. `GET /debug?port=N` returns the full resolution trace — the
fastest way to answer "why did it route there?" — and `threadsKey`, where that page's threads live.

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

The widget is small modules wired by `client/widget.ts`: `ui/` holds the dock, composer, thread
popover, list, destination picker, settings and toast; `store.ts`/`poller.ts` keep the project's
threads; `pins.ts` and `anchor.ts` put them on the page and keep them there (below). Three rules
hold across all of them:
- **Text goes in as text.** `dom.ts`'s `h()` appends strings as text nodes; thread messages come from
  agents, so nothing built from data passes through `innerHTML`.
- **Everything lives in the shadow root**, pins included — the host's event guards are what keep a
  host-page modal open while the widget is used.
- **Every document/window listener registers with the mount's `AbortSignal`.** `Pointr.tsx` can load
  the script twice (StrictMode, HMR); the new mount disposes the old one through
  `window.__pointrWidget`, and the history hook is installed once per page.

## Request flow (the core path)

1. The widget's composer (`client/ui/composer.ts`) captures one or more elements via
   `client/capture.ts` (component name/ancestry **and serialized props** from the fiber),
   optionally rasterizes a screenshot, and `POST`s `{message, url, page, elements, screenshot,
   targetAgent, diagnostics}` to `/send`. `diagnostics` is a ring buffer of recent console errors /
   uncaught exceptions / failed fetches kept by `client/diagnostics.ts`.
2. `bridge/server.go` resolves the destination via `bridge/routing.go` (cascade below), reserves a
   thread (`bridge/threads.go`), and `formatPrompt` (`bridge/format.go`) renders the agent-facing
   prompt — ending with the exact `pointr reply` command for that thread. A base64 screenshot is
   written to a temp file so the agent can read it by path; it is never stored with the thread.
3. `bridge/herdr.go` delivers it with `agent.prompt`, then the thread is committed. (`pasteText`
   remains only for `autoSubmit:false`, which only a widget from before threads sends.)
4. The agent runs `pointr reply <id>`, which `POST`s to `/threads/reply`. The widget, which polls
   `GET /threads` while anything waits, shows the reply in the thread next to the element.

If the agent is busy at step 3, nothing is typed yet: the comment is held (below).

## Comment threads (bridge/threads.go, bridge/thread_handlers.go)

- **Storage.** One JSON file per project in `stateDir()/threads/` (`<slug>-<hash>.json`, 0600),
  loaded at startup, rewritten whole through `writeFileAtomic` on every change. The bridge is the
  only writer. A file that does not parse is renamed `.corrupt-<ms>`, never overwritten. Resolved
  threads go after 30 days; a project keeps at most 500.
- **Reserve, then prompt, then commit.** A fast agent can reply before `agent.prompt` returns, so
  the thread exists (hidden from lists) before the prompt goes out. It is dropped if herdr refused
  definitively, and kept on a timeout or garbled answer, since the prompt may have been typed.
- **Project key** (`projectKeyFor`): the dev server's directory (the same `portEvidence` routing
  uses, proxy ports translated), then `projectPath`, then the origin. **Not** the agent's cwd:
  which agent routing picks changes as panes open and close, and threads keyed on it would drop off
  the page without an error. `Server.projectKey` caches per port and keeps the last good answer
  through a dev-server restart. The **page key** is upstream port + path (+ hash route), computed
  by the widget (`pageKey`), so an app and its Storybook do not share `/`.
- **`rev`** is per project and persisted. A widget's `since` is "unchanged" only when it equals
  `rev` exactly — a deleted file restarts at 0 and must force a full refetch.
- **The reply path is HTTP only.** An agent pane has none of herdr's plugin variables, so
  `pointr reply` would compute a different state dir and config than the bridge. The prompt spells
  out this binary's absolute path (`os.Executable`) and this bridge's port; `shellWord` leaves a
  plain path bare so a prefix allow rule matches. The heredoc delimiter is `POINTR`, not `EOF`.
- **Follow-ups** (`/threads/message`) stay with the pane holding the conversation while it lives
  (`followUpTarget`), and always carry the thread so far, capped — a restarted pane or a new agent
  would not remember the start.
- **Held comments (bridge/delivery.go).** Claude Code does queue what `agent.prompt` types while it
  is working (verified 2026-09-24, herdr 0.9.1: the queued comment ran as the next turn), but once
  typed it belongs to the agent and cannot be taken back. So a comment for a `working` or `blocked`
  agent is **held** by the bridge — first message stores the prompt to type, follow-ups are written
  at delivery — and a 2 s loop delivers it once the agent reads `idle`/`done`, one per pane per pass
  with a cooldown, so the rest stay cancellable. `/threads/cancel` takes back what is held (a thread
  the agent never saw is deleted); `/threads/deliver` is "Send now". Deliveries are serialized by
  `deliverMu`. Held state survives a restart; the stored prompt never reaches the widget.
- **No "no reply" detection.** herdr does not track turns, so "finished without replying" cannot be
  told apart from "not there yet"; a thread just waits and shows what its agent is doing.
- **Read state lives in the bridge**, not the tab: `/servers` counts unread replies per project for
  the setup page, and two tabs of one app must agree.
- **No stream per tab.** The widget polls `/threads` once on load, then only while a thread waits
  and the tab is visible, slower as the wait grows. A browser allows ~6 HTTP/1.1 connections per
  host across all tabs; an SSE per tab would starve the bridge. `/status` (SSE) stays for tooling.

## Finding a thread's element again (client/anchor.ts, client/pins.ts)

A thread stores a photo of its element (`Anchor`): selector, text, the text around it (`contextOf`:
the nearest ancestor with other text, 90 characters each side), component/source, its box
(`pos`, with the viewport width) and, for a positional selector, what its look-alikes read
(`peers`). Most of the time the element goes missing because the agent edited it, so finding it
again is the normal case, not the edge.

- **Proof first.** The id, a selector without positions, or a positional one whose element reads
  the same — by text only when nothing built the same way shares it (a row's "Edit" button proves
  nothing), else by the text around it.
- **Then weighing.** Every look-alike scores on text, surroundings, whether the agent's reply
  quotes its text (replies say what the element reads now — this is what brings back threads
  from before `context` existed), the selector and its shape, and the same box in the same place.
  The best is taken only at 4 or more and 2 ahead of the next.
- **The neighbour guard is the load-bearing part.** When the element is removed, the next one
  slides into its place and matches its selector, shape and box. A candidate reading like one of
  the stored `peers` (or the context's edges) is that neighbour and loses 6. Weakening this pins
  threads to the wrong element, silently. A pin on the wrong element misleads; no pin does not.
- **Pins keep the photo current.** The mutation pass (childList + characterData, on whenever the
  page has threads) notices a pinned element that reads differently. Still proven: nothing. The
  photo points elsewhere: the content moved there (a list reusing nodes), so does the pin. The
  node now reads like a neighbour: it was reused for it, the pin drops. Otherwise it was edited in
  place (hot reload): the pin stays and the photo is renewed through `/threads/anchor` after
  1.5 s quiet. Anything found by weighing is renewed too, so the next load proves it. Renewing is
  not activity: `updatedAt` stays.
- **Last resort is manual.** A thread whose element is gone offers "Pin again"; a pinned one has
  "Move pin". Both replace the first anchor with a picked element.

The scoring was tuned against the scenarios in `client/dev/anchor-scenarios.ts`, and each guard
fails at least one of them when removed: own text edited; text and its label edited in place; a
sibling edited; old photos with the reply quoting the new text (a one-letter one too — "Uno" became
`"I"`) and without; card removed (with and without the reply naming the neighbour); card inserted
before (and edited); list reordered; list item removed; same-text buttons with a row inserted,
removed, re-sorted; class renamed (and text edited); item removed while two were added and quoted;
element replaced by another tag. `npm run scenarios` builds them into a page; open it in any
browser and every row must read PASS (a driven browser can call `anchorScenarios()`). There is no
browser in the repo's toolchain, so this is not part of `npm test`: re-run it after touching a
weight.

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
- **`agent.prompt` only refuses a `blocked` agent.** While it is `working` the text is typed and
  Enter pressed; Claude Code queues it as the next turn.
- **Pane ids are opaque.** Workspaces are not always numeric (`w3Y:p2`), so never match them with a
  pattern like `w\d+:p\d+`.

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

## Framework adapters (client/frameworks/)

`capture.ts` asks each adapter in `index.ts`, in order, what component rendered the clicked element;
the first non-null answer wins, and an adapter that throws is skipped, never fatal. Each one
implements `FrameworkAdapter` (`types.ts`) and reads only what its framework exposes in dev builds.
Props go through `describeProps` (`props.ts`): summarized, never deep-serialized — props can hold
huge object graphs. A `data-source` attribute (the optional Babel plugin in `examples/`) is exact,
so it beats any source an adapter infers.

`react.ts` walks `__reactFiber$*`, mirroring React DevTools' name resolution (memo/forwardRef/lazy).
React 19 removed `_debugSource`, so it has no file:line — component identity is what lets the agent
grep to the file. `FRAMEWORK_RE` is a **pattern**, not an exact list, filtering Next.js/App-Router
wrappers because Next renames them across versions; extend the pattern rather than hardcoding names.

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

The destination is the chip on a comment (`ui/destination.ts`): one click opens the widget's own
list — Auto with where it would route, then each agent with its pane title and live status. Not a
native `<select>`: that opens in the system's colours, with no room for either. It warns before
sending when `/resolve` reports more than one candidate, listing those first, and a thread shows
the same picker only when a reply comes back 409. The selection shortcut and the screenshot
framing are behind the gear in the comment list, which turns that panel into the settings — no
popover of its own. The dock's bubble toggles the pins. All of it lives in the page's
`localStorage` (`pointr-prefs`), written on every change. Send-on-click is gone: every comment is
submitted, since the thread is where it gets reviewed. Whether a comment carries a screenshot is
chosen per comment and not remembered — an image in every comment costs context.

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

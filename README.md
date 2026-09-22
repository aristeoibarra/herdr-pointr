# pointr

[![herdr](https://img.shields.io/badge/dynamic/toml?url=https%3A%2F%2Fraw.githubusercontent.com%2Faristeoibarra%2Fherdr-pointr%2Fmain%2Fherdr-plugin.toml&query=%24.min_herdr_version&prefix=%3E%3D%20&label=herdr&color=d97757)](https://herdr.dev)
[![platforms](https://img.shields.io/badge/platforms-linux%20%7C%20macos-555)](#install)
[![license](https://img.shields.io/badge/license-MIT-555)](LICENSE)

**Point at what's wrong in your browser. Fix it in the agent you already have open.**

Click an element in your local app, say what should change, and it lands in the coding
agent working on that project — with the React component and its ancestry, props, a
selector, recent console errors and an optional screenshot. A [herdr](https://herdr.dev)
plugin; works with any agent herdr detects.

![The widget open on a dev app: a ProfileCard outlined, and the panel showing the destination, the component ancestry, the request and the screenshot toggle](docs/widget.png)

## Install

```bash
herdr plugin install aristeoibarra/herdr-pointr
```

Needs herdr 0.9.0+ on Linux or macOS — nothing else, and nothing in the browser.

## Use

**1. Open `http://localhost:7331`** — bookmark it. It lists the dev servers running in
your projects and which agent each one sends to.

![The pointr page at localhost:7331 listing three dev servers, each with the agent it routes to and an Open button; one warns that no agent is open there yet](docs/setup-page.png)

**2. Click Open.** Your app opens on its port + 10000 (`:3000` → `:13000`) with the
widget already in the page. Hot reload, API calls and assets work as usual. Ctrl-clicking
a localhost URL in herdr does the same.

**3. Press `Alt+C`, click an element, type the change, send.** It goes to the agent
working in that project's directory. If none is open there, the page warns you; if
several are, it asks.

## What the agent gets

```text
[pointr] UI change request from the browser

Request: Make the avatar bigger and move the tags under the name.
Page: http://localhost:3000/
Screenshot: /tmp/herdr-pointr/shot-1754112000-a1b2c3.png

Element 1: <ProfileCard> (react)
- Component path: ProfileCard › ProfileGrid › AppShell
- Selector: article:nth-of-type(2)
- Props: name="Idris Okonkwo", role="Product Designer", tags=Array(1)
- Text: "IOIdris OkonkwoProduct Designer"
- HTML: <article class="card">…
```

React 19 no longer exposes `file:line`, so the component ancestry is what lets the agent
find the file. For exact locations, mount
[`examples/babel-plugin-data-source.cjs`](examples/babel-plugin-data-source.cjs) dev-only.

## Good to know

- **Settings** (destination, send-on-click, shortcut) are behind the gear in the widget.
- **Keeping your app's URL** — for OAuth callbacks registered on `:3000`, say — use the
  bookmarklet on `localhost:7331`, or render [`examples/Pointr.tsx`](examples/Pointr.tsx)
  in your root layout.
- **Wrong destination?** `http://localhost:7331/debug?port=3000` shows why it chose it.
- **Commands:** `herdr plugin action invoke aristeoibarra.pointr.<action>` with `status`,
  `doctor`, `start`, `stop`, `pin` (send to the focused pane) or `unpin`.
- **Development only.** The bridge and its proxies listen on localhost and forward what
  they receive to your agent.

## Develop

```bash
git clone https://github.com/aristeoibarra/herdr-pointr && cd herdr-pointr
npm install && npm run build   # needs Go and Node; `herdr plugin link` does not build
herdr plugin link .
```

MIT

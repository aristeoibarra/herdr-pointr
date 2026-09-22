/** The page served at `/`: running dev servers to open, plus the bookmarklet. */

export function bookmarkletCode(port: number): string {
  return (
    "javascript:(function(){var d=document;" +
    "if(d.getElementById('pointr-root'))return;" +
    "var s=d.createElement('script');" +
    `s.src='http://localhost:${port}/widget.js';` +
    "s.onerror=function(){alert('pointr: bridge not reachable on :" +
    port +
    "');};" +
    "d.body.appendChild(s);})();"
  );
}

export function bookmarkletPage(port: number): string {
  const code = bookmarkletCode(port).replace(/"/g, "&quot;");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pointr</title>
<style>
  body { font: 15px/1.6 ui-sans-serif, system-ui, sans-serif; background: #121212; color: #eee;
         max-width: 640px; margin: 40px auto; padding: 0 20px; }
  h1 { color: #d97757; font-size: 22px; }
  code { background: #1f1f1f; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
  .bm { display: inline-block; background: #2a2a2a; color: #eee; text-decoration: none;
        padding: 4px 12px; border-radius: 999px; font-weight: 700; cursor: grab; }
  ol { padding-left: 20px; } li { margin: 8px 0; }
  .status { margin-top: 16px; font-size: 13px; }
  .ok { color: #6ee7a8; } .err { color: #ff8a8a; }
  .servers { list-style: none; padding: 0; margin: 12px 0; display: grid; gap: 8px; }
  .servers li { display: flex; align-items: center; gap: 12px; background: #1a1a1a; border: 1px solid #2a2a2a;
                border-radius: 12px; padding: 10px 14px; }
  .servers .who { flex: 1; min-width: 0; }
  .servers .name { font-weight: 700; } .servers .port { color: #999; font-size: 13px; margin-left: 6px; }
  .servers .dest { font-size: 13px; color: #999; overflow-wrap: anywhere; }
  .servers .dest.ok { color: #6ee7a8; } .servers .dest.warn { color: #f5c16c; }
  .servers a.go { background: #d97757; color: #fff; text-decoration: none; border-radius: 999px;
                  padding: 7px 16px; font-weight: 700; white-space: nowrap; }
  .muted { color: #999; font-size: 13px; }
  .open { display: flex; gap: 8px; margin: 10px 0; }
  .open input { flex: 1; background: #1f1f1f; color: #eee; border: 1px solid #333; border-radius: 8px;
                padding: 9px 12px; font: inherit; }
  .open button { background: #d97757; color: #fff; border: 0; border-radius: 999px; padding: 9px 18px;
                 font: inherit; font-weight: 700; cursor: pointer; }
  hr { border: none; border-top: 1px solid #2a2a2a; margin: 24px 0; }
  small { color: #999; }
</style>
</head>
<body>
  <h1>pointr</h1>
  <p class="muted">Bridge on <code>localhost:${port}</code> <span id="st" class="status"></span></p>

  <p><strong>Your dev servers.</strong> Open one and the widget is already in the page —
  <code>Alt+C</code>, click an element, describe the change.</p>
  <ul id="servers" class="servers"><li class="muted">looking…</li></ul>
  <p id="pinned" class="muted" hidden></p>
  <form action="/open" method="get" class="open">
    <input name="url" placeholder="Not listed? Type a port or URL" required>
    <button type="submit">Open</button>
  </form>

  <hr>
  <p class="muted">To keep your app's own URL instead, drag this to your bookmarks bar and
  click it on the page: <a class="bm" href="${code}">◎ pointr</a></p>

<script>
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  fetch('/health').then(r=>r.json()).then(d=>{
    document.getElementById('st').innerHTML = d.ok ? '<span class="ok">● connected</span>' : '';
    const pinned = document.getElementById('pinned');
    if (d.targetAgent) {
      pinned.hidden = false;
      pinned.textContent = 'A destination is pinned (' + d.targetAgent.paneId + '): every project sends there until you clear it.';
    }
  }).catch(()=>{ document.getElementById('st').innerHTML='<span class="err">● offline</span>'; });

  // Where a server's feedback would land, by the same tiers routing uses —
  // "no agent" is the thing worth seeing before sending, not after.
  function dest(agents, cwd) {
    if (agents.length === 1) return '<div class="dest ok">→ ' + esc(agents[0].label) + ' · ' + esc(agents[0].status) + '</div>';
    if (agents.length > 1) return '<div class="dest warn">' + agents.length + ' agents work here — you will be asked which</div>';
    return '<div class="dest warn">no agent here yet — open one in herdr in ' + esc(cwd) + '</div>';
  }

  function render(servers) {
    const list = document.getElementById('servers');
    if (servers.length === 0) {
      list.innerHTML = '<li class="muted">No dev server running in a project directory. Start one — <code>npm run dev</code> — and it shows up here.</li>';
      return;
    }
    list.innerHTML = servers.map((s) =>
      '<li><div class="who"><span class="name">' + esc(s.project) + '</span><span class="port">:' + s.port + '</span>' +
      dest(s.agents, s.cwd) + '</div><a class="go" href="/open?url=' + s.port + '">Open</a></li>'
    ).join('');
  }

  // Cheap for the bridge (one procfs pass), and only while this tab is looked at.
  function refresh() {
    if (document.hidden) return;
    fetch('/servers').then(r=>r.json()).then(d=>render(d.servers || [])).catch(()=>{});
  }
  refresh();
  setInterval(refresh, 4000);
  document.addEventListener('visibilitychange', refresh);
</script>
</body>
</html>`;
}

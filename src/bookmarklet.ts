/** Setup page served at `/` — drag the bookmarklet to your bookmarks bar once. */

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
<title>pointr — setup</title>
<style>
  body { font: 15px/1.6 ui-sans-serif, system-ui, sans-serif; background: #121212; color: #eee;
         max-width: 640px; margin: 40px auto; padding: 0 20px; }
  h1 { color: #d97757; font-size: 22px; }
  code { background: #1f1f1f; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
  .bm { display: inline-block; background: #d97757; color: #fff; text-decoration: none;
        padding: 10px 18px; border-radius: 999px; font-weight: 700; margin: 10px 0; cursor: grab; }
  ol { padding-left: 20px; } li { margin: 8px 0; }
  .status { margin-top: 16px; font-size: 13px; }
  .ok { color: #6ee7a8; } .err { color: #ff8a8a; }
  hr { border: none; border-top: 1px solid #2a2a2a; margin: 24px 0; }
  small { color: #999; }
</style>
</head>
<body>
  <h1>pointr</h1>
  <p>Bridge is running on <code>http://localhost:${port}</code> <span id="st" class="status"></span></p>

  <p><strong>1.</strong> Drag this button to your bookmarks bar:</p>
  <a class="bm" href="${code}">◎ Select → agent</a>

  <p><strong>2.</strong> Use it on any local dev app:</p>
  <ol>
    <li>Open your app (e.g. <code>http://localhost:3000</code>)</li>
    <li>Make sure your coding agent runs in a herdr pane <em>inside that project's directory</em></li>
    <li>Click the bookmark — the toolbar appears</li>
    <li><code>Alt+C</code> or the button to select an element, then send</li>
  </ol>

  <hr>
  <p><small>Routing is automatic: the bridge maps the dev-server port to its project
  directory and finds the agent working there. No per-project setup needed.</small></p>

  <p><small>Settings — destination agent, auto-send, the selection
  shortcut — live in the <strong>browser extension's toolbar popup</strong>
  (<code>Load unpacked</code> the <code>extension/</code> folder). Loaded via the
  bookmarklet alone, the widget runs on defaults.</small></p>

<script>
  fetch('/health').then(r=>r.json()).then(d=>{
    document.getElementById('st').innerHTML = d.ok ? '<span class="ok">● connected</span>' : '';
  }).catch(()=>{ document.getElementById('st').innerHTML='<span class="err">● offline</span>'; });
</script>
</body>
</html>`;
}

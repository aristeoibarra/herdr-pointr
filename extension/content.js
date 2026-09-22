// Auto-injects the pointr widget on every localhost page, and bridges
// the extension's stored settings into it — the widget has no Settings UI of its
// own, it all lives in the toolbar popup.
//
// The widget runs in the page's MAIN world (it is a <script src>), so the only
// channel between it and this isolated-world script is window.postMessage.
(function () {
  var BRIDGE_PORT = "7331";
  // Don't inject on the bridge's own setup page.
  if (location.port === BRIDGE_PORT) return;
  if (window.__pointrInjected) return;
  window.__pointrInjected = true;

  var GLOBAL_KEY = "global";
  var PANE_KEY = "pane:" + location.origin;
  var LEGACY_KEY = "pointr-prefs";
  var FROM_WIDGET = "pointr-widget";
  var FROM_EXT = "pointr-ext";

  // Inject first and synchronously: the widget installs console/fetch/error hooks
  // on load, and those are only worth anything if they beat the app's own code.
  var s = document.createElement("script");
  s.src = "http://localhost:" + BRIDGE_PORT + "/widget.js?t=" + Date.now();
  s.onerror = function () {
    // Bridge not running — fail silently, don't disturb the page.
  };
  (document.head || document.documentElement).appendChild(s);

  function push() {
    chrome.storage.local.get([GLOBAL_KEY, PANE_KEY], function (stored) {
      var global = stored[GLOBAL_KEY] || {};
      var pane = stored[PANE_KEY] || {};
      window.postMessage(
        {
          source: FROM_EXT,
          type: "prefs",
          prefs: {
            autoSend: global.autoSend,
            dictationLang: global.dictationLang,
            hotkey: global.hotkey,
            targetPane: pane.id || null,
            targetPaneLabel: pane.label || null,
          },
        },
        location.origin,
      );
    });
  }

  /**
   * Settings used to live in the page's localStorage, written by the widget.
   * Content scripts share that store, so the move to extension storage can be
   * silent — seed once, per key, and never look again.
   */
  function migrateLegacyPrefs() {
    var legacy;
    try {
      legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || "null");
    } catch (e) {
      return;
    }
    if (!legacy || typeof legacy !== "object") return;
    chrome.storage.local.get([GLOBAL_KEY, PANE_KEY], function (stored) {
      var write = {};
      // The shortcut, language and auto-send default are the user's, not the
      // project's — the first origin to be seen seeds them for every origin.
      if (!stored[GLOBAL_KEY]) {
        write[GLOBAL_KEY] = {
          autoSend: typeof legacy.autoSend === "boolean" ? legacy.autoSend : true,
          dictationLang: typeof legacy.dictationLang === "string" ? legacy.dictationLang : "auto",
          hotkey: legacy.hotkey || null,
        };
      }
      // The pinned session is per-project, so it stays keyed by origin.
      if (!stored[PANE_KEY] && typeof legacy.targetPane === "string") {
        write[PANE_KEY] = { id: legacy.targetPane, label: null };
      }
      if (Object.keys(write).length > 0) chrome.storage.local.set(write);
    });
  }

  // What the widget last reported about dictation on this page. The popup asks
  // for it because the blocking reason can be page-local (Permissions-Policy)
  // and is therefore invisible to both the popup and the bridge.
  var dictation = null;

  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    var data = event.data;
    if (!data || data.source !== FROM_WIDGET) return;
    if (data.type === "prefs:get") {
      push();
      return;
    }
    if (data.type === "pin:clear") {
      // The pinned pane died mid-send; blank it so the popup stops showing it.
      // Written as an explicit "no pin" rather than removed, so the legacy
      // migration below can't resurrect it on the next page load.
      var cleared = {};
      cleared[PANE_KEY] = { id: null, label: null };
      chrome.storage.local.set(cleared);
      return;
    }
    if (data.type === "dictation") {
      dictation = { available: data.available === true, reason: data.reason || "" };
    }
  });

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "local") return;
    if (changes[GLOBAL_KEY] || changes[PANE_KEY]) push();
  });

  chrome.runtime.onMessage.addListener(function (message, _sender, respond) {
    if (message && message.type === "pointr:dictation") respond(dictation);
  });

  migrateLegacyPrefs();
  push();
})();

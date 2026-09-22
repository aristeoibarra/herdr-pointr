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
  // Per-origin: which agent this project sends to. Global settings (shortcut,
  // language, auto-send) are the user's and are keyed separately, so nobody has
  // to re-record a shortcut per project.
  var AGENT_KEY = "agent:" + location.origin;
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
    chrome.storage.local.get([GLOBAL_KEY, AGENT_KEY], function (stored) {
      var global = stored[GLOBAL_KEY] || {};
      var agent = stored[AGENT_KEY] || {};
      window.postMessage(
        {
          source: FROM_EXT,
          type: "prefs",
          prefs: {
            autoSend: global.autoSend,
            hotkey: global.hotkey,
            targetAgent: agent.id ? { paneId: agent.id, session: agent.session || null } : null,
            targetAgentLabel: agent.label || null,
          },
        },
        location.origin,
      );
    });
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    var data = event.data;
    if (!data || data.source !== FROM_WIDGET) return;
    if (data.type === "prefs:get") {
      push();
      return;
    }
    if (data.type === "pin:clear") {
      // The pinned agent's terminal closed mid-send; blank it so the popup
      // stops offering a destination that cannot come back.
      var cleared = {};
      cleared[AGENT_KEY] = { id: null, session: null, label: null };
      chrome.storage.local.set(cleared);
      return;
    }
  });

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "local") return;
    if (changes[GLOBAL_KEY] || changes[AGENT_KEY]) push();
  });

  push();
})();

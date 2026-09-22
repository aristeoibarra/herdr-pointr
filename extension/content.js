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
  // No cache-buster: the bridge answers with an ETag, so a reload costs a 304
  // and a rebuild is still picked up on the next one.
  s.src = "http://localhost:" + BRIDGE_PORT + "/widget.js";
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

  /**
   * The widget owns the settings UI, so it is the writer now; this script is
   * the only thing that can reach chrome.storage from a MAIN-world script.
   * Global keys and the per-origin destination are split exactly as they are
   * on read, so a destination chosen on one site never follows you to another.
   */
  function writePrefs(incoming) {
    chrome.storage.local.get([GLOBAL_KEY, AGENT_KEY], function (stored) {
      var write = {};
      var global = stored[GLOBAL_KEY] || {};
      var touchedGlobal = false;
      if (typeof incoming.autoSend === "boolean") {
        global.autoSend = incoming.autoSend;
        touchedGlobal = true;
      }
      if (incoming.hotkey && typeof incoming.hotkey.code === "string") {
        global.hotkey = incoming.hotkey;
        touchedGlobal = true;
      }
      if (touchedGlobal) write[GLOBAL_KEY] = global;

      if ("targetAgent" in incoming) {
        write[AGENT_KEY] = incoming.targetAgent
          ? {
              id: incoming.targetAgent.paneId,
              session: incoming.targetAgent.session || null,
              label: incoming.targetAgentLabel || null,
            }
          : { id: null, session: null, label: null };
      }
      if (Object.keys(write).length > 0) chrome.storage.local.set(write);
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
    if (data.type === "prefs:set") {
      writePrefs(data.prefs || {});
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

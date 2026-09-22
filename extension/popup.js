// Settings live here, not in the widget. Everything written to chrome.storage.local
// is picked up by content.js and pushed into the widget of every open localhost tab.
(function () {
  var BRIDGE = "http://localhost:7331";
  var GLOBAL_KEY = "global";

  // Must stay in sync with DEFAULT_HOTKEY in client/widget.ts.
  var DEFAULT_HOTKEY = { code: "KeyC", alt: true, ctrl: false, shift: false, meta: false };

  var $ = function (id) {
    return document.getElementById(id);
  };
  var healthEl = $("health");
  var scopeEl = $("scope");
  var paneField = $("pane-field");
  var paneNote = $("pane-note");
  var sessionSelect = $("session");
  var autosend = $("autosend");
  var hotkeyBtn = $("hotkey");

  var origin = null;
  var tabId = null;
  var global = { autoSend: true, hotkey: DEFAULT_HOTKEY };
  var agent = { id: null, session: null, label: null };

  function agentKey() {
    return "agent:" + origin;
  }

  function saveGlobal() {
    var write = {};
    write[GLOBAL_KEY] = global;
    chrome.storage.local.set(write);
  }

  function saveAgent() {
    if (!origin) return;
    var write = {};
    write[agentKey()] = agent;
    chrome.storage.local.set(write);
  }

  // ── Hotkey recorder ────────────────────────────────────────────────────────
  function hotkeyLabel(h) {
    var parts = [];
    if (h.ctrl) parts.push("Ctrl");
    if (h.alt) parts.push("Alt");
    if (h.shift) parts.push("Shift");
    if (h.meta) parts.push("⌘");
    parts.push(h.code.replace(/^(?:Key|Digit)/, ""));
    return parts.join("+");
  }

  var recording = false;

  function renderHotkey() {
    hotkeyBtn.textContent = recording ? "press the new combo… (Esc cancels)" : hotkeyLabel(global.hotkey);
    hotkeyBtn.classList.toggle("recording", recording);
  }

  hotkeyBtn.addEventListener("click", function () {
    recording = !recording;
    renderHotkey();
  });

  document.addEventListener("keydown", function (e) {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      recording = false;
      renderHotkey();
      return;
    }
    // A modifier on its own is the user still reaching for the key.
    if (/^(?:Alt|Control|Shift|Meta)/.test(e.code)) return;
    if (!e.altKey && !e.ctrlKey && !e.metaKey) {
      hotkeyBtn.textContent = "add Alt, Ctrl or ⌘ to the key…";
      return;
    }
    global.hotkey = { code: e.code, alt: e.altKey, ctrl: e.ctrlKey, shift: e.shiftKey, meta: e.metaKey };
    recording = false;
    renderHotkey();
    saveGlobal();
  });

  // ── Destination agent ──────────────────────────────────────────────────────
  // The label is stored beside the pin so the widget never has to call /agents.
  // Only stable parts go in it: status changes by the second, so it is rendered
  // live here and never baked into what gets persisted.
  function renderAgents(agents, live) {
    sessionSelect.replaceChildren();
    var auto = document.createElement("option");
    auto.value = "";
    auto.textContent = "Auto (detect)";
    sessionSelect.append(auto);
    agents.forEach(function (a) {
      var opt = document.createElement("option");
      opt.value = a.id;
      opt.textContent = a.label + " — " + a.status;
      opt.dataset.label = a.label;
      opt.dataset.session = a.session || "";
      sessionSelect.append(opt);
    });
    // A pin that a reachable bridge no longer lists is a dead id — pane ids are
    // never reused. An unreachable bridge proves nothing, so don't guess.
    var stale = live && agent.id !== null && !agents.some(function (a) {
      return a.id === agent.id;
    });
    if (!live && agent.id) {
      // Keep the pin selectable while the bridge is down.
      var pinned = document.createElement("option");
      pinned.value = agent.id;
      pinned.textContent = agent.label || agent.id;
      sessionSelect.append(pinned);
    }
    sessionSelect.value = stale ? "" : agent.id || "";
    paneNote.classList.toggle("hidden", !stale);
    if (stale) paneNote.textContent = "That agent is gone — sends fall back to auto-routing.";
  }

  function loadAgents() {
    return fetch(BRIDGE + "/agents")
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        renderAgents(d.agents || [], true);
      })
      .catch(function () {
        renderAgents([], false);
      });
  }

  sessionSelect.addEventListener("change", function () {
    var opt = sessionSelect.selectedOptions[0];
    agent = sessionSelect.value
      ? {
          id: sessionSelect.value,
          // The session rides along so the bridge can tell an agent that
          // restarted in this terminal from one that never moved.
          session: opt && opt.dataset.session ? opt.dataset.session : null,
          label: opt && opt.dataset.label ? opt.dataset.label : null,
        }
      : { id: null, session: null, label: null };
    paneNote.classList.add("hidden");
    saveAgent();
  });

  $("refresh").addEventListener("click", function () {
    void loadAgents();
  });

  autosend.addEventListener("change", function () {
    global.autoSend = autosend.checked;
    saveGlobal();
  });

  // ── Boot ───────────────────────────────────────────────────────────────────
  function loadHealth() {
    return fetch(BRIDGE + "/health")
      .then(function () {
        healthEl.textContent = "● connected";
        healthEl.className = "health ok";
      })
      .catch(function () {
        healthEl.textContent = "● bridge offline";
        healthEl.className = "health err";
      });
  }

  function render() {
    autosend.checked = global.autoSend !== false;
    renderHotkey();
  }

  // Outside the chain below: the bridge's health doesn't depend on the tab, and
  // it's the one line that should still be right when everything else fails.
  void loadHealth();

  chrome.tabs
    .query({ active: true, currentWindow: true })
    .then(function (tabs) {
      var tab = tabs[0];
      tabId = tab && typeof tab.id === "number" ? tab.id : null;
      try {
        var url = new URL(tab.url);
        if (url.hostname === "localhost" || url.hostname === "127.0.0.1") origin = url.origin;
      } catch (e) {
        /* chrome:// pages and the like have no usable URL */
      }

      var keys = origin ? [GLOBAL_KEY, agentKey()] : [GLOBAL_KEY];
      return chrome.storage.local.get(keys).then(function (stored) {
        var savedGlobal = stored[GLOBAL_KEY] || {};
        if (typeof savedGlobal.autoSend === "boolean") global.autoSend = savedGlobal.autoSend;
        if (savedGlobal.hotkey && typeof savedGlobal.hotkey.code === "string") global.hotkey = savedGlobal.hotkey;
        if (origin && stored[agentKey()]) agent = stored[agentKey()];

        render();

        if (origin) {
          scopeEl.textContent = "The destination agent applies to " + origin + ". The rest is global.";
          void loadAgents();
        } else {
          // Without a localhost tab there is no project to pin a session to.
          scopeEl.textContent = "Open a localhost dev app to pick its target session.";
          paneField.classList.add("off");
        }

      });
    })
    .catch(function (error) {
      // Anything that throws up there leaves every control unrendered, so say
      // what actually broke instead of blaming the tab — a missing "storage"
      // permission looked exactly like a missing tab.
      healthEl.textContent = "● settings unavailable";
      healthEl.className = "health err";
      scopeEl.textContent = error && error.message ? error.message : String(error);
      void loadAgents();
      renderHotkey();
    });
})();

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
  var dicLang = $("diclang");
  var dicNote = $("dicnote");
  var hotkeyBtn = $("hotkey");

  var origin = null;
  var tabId = null;
  var global = { autoSend: true, dictationLang: "auto", hotkey: DEFAULT_HOTKEY };
  var pane = { id: null, label: null };

  function paneKey() {
    return "pane:" + origin;
  }

  function saveGlobal() {
    var write = {};
    write[GLOBAL_KEY] = global;
    chrome.storage.local.set(write);
  }

  function savePane() {
    if (!origin) return;
    var write = {};
    write[paneKey()] = pane;
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

  // ── Sessions ───────────────────────────────────────────────────────────────
  function renderSessions(sessions, live) {
    sessionSelect.replaceChildren();
    var auto = document.createElement("option");
    auto.value = "";
    auto.textContent = "Auto (detect)";
    sessionSelect.append(auto);
    sessions.forEach(function (s) {
      var opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = s.label;
      sessionSelect.append(opt);
    });
    // A pinned pane that a reachable tmux no longer reports is a dead id — show
    // Auto and say why. An unreachable bridge proves nothing, so don't guess.
    var stale = live && pane.id !== null && !sessions.some(function (s) {
      return s.id === pane.id;
    });
    if (!live && pane.id) {
      // Keep the pin selectable while the bridge is down.
      var pinned = document.createElement("option");
      pinned.value = pane.id;
      pinned.textContent = pane.label || "pane " + pane.id;
      sessionSelect.append(pinned);
    }
    sessionSelect.value = stale ? "" : pane.id || "";
    paneNote.classList.toggle("hidden", !stale);
    if (stale) paneNote.textContent = "The pinned session is gone — sends fall back to auto-routing.";
  }

  function loadSessions() {
    return fetch(BRIDGE + "/sessions")
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        renderSessions(d.sessions || [], true);
      })
      .catch(function () {
        renderSessions([], false);
      });
  }

  sessionSelect.addEventListener("change", function () {
    var opt = sessionSelect.selectedOptions[0];
    pane = sessionSelect.value
      ? { id: sessionSelect.value, label: opt ? opt.textContent : null }
      : { id: null, label: null };
    paneNote.classList.add("hidden");
    savePane();
  });

  $("refresh").addEventListener("click", function () {
    void loadSessions();
  });

  autosend.addEventListener("change", function () {
    global.autoSend = autosend.checked;
    saveGlobal();
  });

  dicLang.addEventListener("change", function () {
    global.dictationLang = dicLang.value;
    saveGlobal();
  });

  // ── Dictation status ───────────────────────────────────────────────────────
  /**
   * The widget knows the whole picture — browser support, the page's own
   * Permissions-Policy, and the bridge's whisper setup — so ask the tab first
   * and only fall back to the bridge when no widget answers.
   */
  function loadDictationStatus() {
    var fromTab = tabId === null
      ? Promise.reject()
      : chrome.tabs.sendMessage(tabId, { type: "pointr:dictation" }).then(function (state) {
          if (!state) throw new Error("no widget");
          return state;
        });
    return fromTab
      .catch(function () {
        return fetch(BRIDGE + "/dictation")
          .then(function (r) {
            return r.json();
          })
          .then(function (d) {
            return {
              available: d.available === true,
              reason: d.available
                ? "Transcribed locally with whisper.cpp (" + (d.model || "model") + "). Audio never leaves this machine."
                : d.error || "Dictation unavailable.",
            };
          });
      })
      .then(function (state) {
        dicNote.textContent = state.reason;
        dicNote.classList.toggle("err", !state.available);
        dicLang.disabled = !state.available;
      })
      .catch(function () {
        /* bridge offline — the health line already says so */
      });
  }

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
    dicLang.value = global.dictationLang || "auto";
    if (dicLang.value !== (global.dictationLang || "auto")) dicLang.value = "auto"; // unknown saved tag
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

      var keys = origin ? [GLOBAL_KEY, paneKey()] : [GLOBAL_KEY];
      return chrome.storage.local.get(keys).then(function (stored) {
        var savedGlobal = stored[GLOBAL_KEY] || {};
        if (typeof savedGlobal.autoSend === "boolean") global.autoSend = savedGlobal.autoSend;
        if (typeof savedGlobal.dictationLang === "string") global.dictationLang = savedGlobal.dictationLang;
        if (savedGlobal.hotkey && typeof savedGlobal.hotkey.code === "string") global.hotkey = savedGlobal.hotkey;
        if (origin && stored[paneKey()]) pane = stored[paneKey()];

        render();

        if (origin) {
          scopeEl.textContent = "Target session applies to " + origin + ". The rest is global.";
          void loadSessions();
        } else {
          // Without a localhost tab there is no project to pin a session to.
          scopeEl.textContent = "Open a localhost dev app to pick its target session.";
          paneField.classList.add("off");
        }

        void loadDictationStatus();
      });
    })
    .catch(function (error) {
      // Anything that throws up there leaves every control unrendered, so say
      // what actually broke instead of blaming the tab — a missing "storage"
      // permission looked exactly like a missing tab.
      healthEl.textContent = "● settings unavailable";
      healthEl.className = "health err";
      scopeEl.textContent = error && error.message ? error.message : String(error);
      void loadSessions();
      renderHotkey();
    });
})();

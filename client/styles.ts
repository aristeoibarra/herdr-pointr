/**
 * The widget's stylesheet, scoped by its shadow root. One fixed dark theme,
 * monochrome: the only colour carrying meaning is the blue of an unread
 * reply (plus amber/red for warnings and errors). Pins and outlines sit on
 * the page itself, so they carry their own contrasting ring and read on any
 * background, light or dark.
 */
export const STYLES = `
:host {
  all: initial;
  color-scheme: dark;
  --sans: "Geist", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --bg: #18181b; --line: #27272a; --line2: #3f3f46;
  --ink: #fafafa; --ink2: #e4e4e7; --muted: #a1a1aa; --dim: #8e8e96; --sunk: #09090b;
  --blue: #60a5fa; --pin-blue: #3b82f6; --warn: #e8b454; --err: #f87171;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
button { font: inherit; color: inherit; }
.layer { font: 13px/1.45 var(--sans); color: var(--ink); }
.mono { font-family: var(--mono); }
.items, .msgs, textarea { scrollbar-width: thin; scrollbar-color: var(--line2) transparent; }
.items, .msgs { overscroll-behavior: contain; }

/* Dock */
.dock {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483646;
  display: flex; align-items: center; gap: 3px; padding: 4px;
  background: var(--bg); border: 1px solid var(--line); border-radius: 14px;
  box-shadow: 0 10px 30px rgba(0,0,0,.3), 0 1px 3px rgba(0,0,0,.2);
}
.sep { width: 1px; height: 20px; margin: 0 2px; background: var(--line); flex-shrink: 0; }
.ibtn {
  width: 36px; height: 36px; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center;
  padding: 0; border: 0; border-radius: 10px; background: transparent; color: var(--muted); cursor: pointer;
}
.ibtn:hover { color: var(--ink); background: #1f1f23; }
.ibtn.on { background: var(--line); color: var(--ink); }
.ibtn.select.on { background: var(--ink); color: var(--sunk); }
.count {
  position: relative; height: 36px; min-width: 52px; display: inline-flex; align-items: center; justify-content: center;
  gap: 2px; padding: 0 4px 0 9px; border: 0; border-radius: 10px; background: transparent; color: var(--ink);
  font: 600 13px var(--mono); cursor: pointer;
}
.count:hover { background: #1f1f23; }
.count.on { background: var(--line); }
.count svg { color: var(--dim); }
.dot {
  position: absolute; top: 5px; right: 5px; width: 8px; height: 8px; border-radius: 50%;
  background: var(--blue); box-shadow: 0 0 0 2px var(--bg);
}

/* Picking */
.overlay, .mark {
  position: fixed; z-index: 2147483645; pointer-events: none;
  border: 2px solid #09090b; border-radius: 6px; background: rgba(9,9,11,.05); box-shadow: 0 0 0 2px #fff;
}
.overlay { display: none; }
.anchor {
  position: fixed; z-index: 2147483645; pointer-events: none;
  border: 1.5px dashed #09090b; border-radius: 8px; box-shadow: 0 0 0 1.5px rgba(255,255,255,.85);
}
.tag {
  position: fixed; z-index: 2147483646; pointer-events: none; height: 24px; padding: 0 8px;
  display: none; align-items: center; gap: 8px; border-radius: 7px; background: #09090b; color: #fff;
  font: 11.5px var(--mono); white-space: nowrap;
}
.tag.show { display: inline-flex; }
.tag .sub { color: var(--muted); }
.hint {
  position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); z-index: 2147483646;
  display: flex; align-items: center; gap: 10px; height: 40px; padding: 0 5px 0 14px;
  background: var(--bg); border: 1px solid var(--line); border-radius: 12px;
  box-shadow: 0 10px 30px rgba(0,0,0,.3); font-size: 12.5px; white-space: nowrap;
}

/* Popovers */
.pop {
  position: fixed; z-index: 2147483647; width: 320px; max-width: calc(100vw - 24px);
  display: flex; flex-direction: column; background: var(--bg); border: 1px solid var(--line);
  border-radius: 14px; box-shadow: 0 16px 40px rgba(0,0,0,.3), 0 1px 3px rgba(0,0,0,.2);
}
.pop.wide { width: 364px; }
.head { display: flex; align-items: center; gap: 4px; padding: 8px 6px 8px 14px; min-height: 44px; }
.head.ruled { border-bottom: 1px solid var(--line); }
.title { font-weight: 600; }
.title.big { font-size: 14px; }
.label { font: 12px var(--mono); color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sub-label { font: 11.5px var(--mono); color: var(--dim); white-space: nowrap; }
.push { margin-left: auto; }
.sbtn {
  width: 28px; height: 28px; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center;
  padding: 0; border: 0; border-radius: 8px; background: transparent; color: var(--muted); cursor: pointer;
}
.sbtn:hover { color: var(--ink); background: var(--line); }
.dest {
  position: relative; height: 24px; min-width: 0; max-width: 210px; padding-left: 8px;
  display: inline-flex; align-items: center; gap: 6px; border-radius: 7px; background: var(--line);
  color: var(--muted); font: 11px var(--mono); white-space: nowrap; overflow: hidden;
}
.dest:hover, .dest:focus-within { color: var(--ink); }
.dest:has(select:focus-visible) { box-shadow: 0 0 0 1px var(--muted); }
.dest select {
  appearance: none; -webkit-appearance: none; field-sizing: content; min-width: 0; height: 24px;
  margin: 0; padding: 0 22px 0 0; border: 0; background: transparent; color: inherit;
  font: inherit; text-overflow: ellipsis; cursor: pointer; outline: none;
}
.dest option { background: var(--bg); color: var(--ink); font: 12px var(--sans); }
.dest svg { position: absolute; right: 5px; pointer-events: none; }
.dest.warn { color: var(--warn); }
.dest-row { display: flex; padding: 0 14px 10px; }
.led { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex-shrink: 0; }
.chips { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 0 14px 10px; }
.chip {
  height: 26px; max-width: 100%; padding: 0 3px 0 8px; display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid var(--line2); border-radius: 7px; font: 11.5px var(--mono); white-space: nowrap;
}
.chip .sub { color: var(--muted); overflow: hidden; text-overflow: ellipsis; max-width: 120px; }
.chip button, .nav {
  width: 22px; height: 22px; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center;
  padding: 0; border: 0; border-radius: 5px; background: transparent; color: var(--muted); cursor: pointer;
}
.chip button:hover, .nav:hover { color: var(--ink); background: var(--line); }
.add {
  height: 26px; padding: 0 9px; border: 1px dashed var(--line2); border-radius: 7px; background: transparent;
  color: var(--muted); font-size: 11.5px; cursor: pointer;
}
.add:hover { color: var(--ink); border-color: var(--muted); }
.pad { padding: 0 14px; }
textarea {
  display: block; width: 100%; resize: none; padding: 10px 12px; border-radius: 10px;
  background: var(--sunk); border: 1px solid var(--line2); color: var(--ink);
  font: 13px/1.45 var(--sans); outline: none;
}
textarea:focus { border-color: var(--muted); }
textarea::placeholder { color: var(--dim); }
.row { display: flex; align-items: center; gap: 8px; padding: 10px 10px 10px 14px; }
.gbtn {
  height: 32px; padding: 0 10px; display: inline-flex; align-items: center; gap: 7px; flex-shrink: 0;
  border: 1px solid var(--line2); border-radius: 8px; background: transparent; color: var(--muted);
  font-size: 12px; cursor: pointer; white-space: nowrap;
}
.gbtn:hover, .gbtn.on { color: var(--ink); border-color: var(--muted); }
.pbtn {
  height: 32px; padding: 0 14px; display: inline-flex; align-items: center; gap: 8px; flex-shrink: 0;
  border: 0; border-radius: 8px; background: var(--ink); color: var(--sunk);
  font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap;
}
.pbtn:disabled, .sq:disabled { opacity: .45; cursor: default; }
.kbd { font: 500 11px var(--mono); color: #52525b; }
.note { padding: 0 14px 12px; font-size: 12px; color: var(--muted); }
.note:empty { display: none; }
.note.err { color: var(--err); }
.note.warn { color: var(--warn); }

/* Threads */
.msgs { max-height: min(50vh, 340px); overflow-y: auto; padding: 2px 0 8px; }
.msg { display: flex; flex-direction: column; gap: 5px; padding: 10px 14px 2px; }
.who { display: flex; align-items: center; gap: 8px; font-size: 12.5px; }
.who b { font-weight: 600; }
.meta { color: var(--dim); }
.text { color: var(--ink2); white-space: pre-wrap; overflow-wrap: anywhere; }
.av {
  width: 22px; height: 22px; flex-shrink: 0; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
}
.av.you { background: #09090b; color: #fff; border: 1.5px solid #fff; }
.av.agent { background: #fff; color: #09090b; font: 700 9px var(--mono); }
.shot-note { font: 11px var(--mono); color: var(--dim); }
.wait {
  display: flex; align-items: flex-start; gap: 10px; margin: 2px 12px 12px; padding: 10px 12px;
  border-radius: 10px; background: var(--line);
}
.wait .t { font-size: 12.5px; font-weight: 500; }
.wait .s { font-size: 12px; color: var(--muted); }
.wait.warn .t { color: var(--warn); }
.wait-body { flex: 1; min-width: 0; }
.held-actions { display: flex; gap: 8px; margin-top: 10px; }
.held-actions .gbtn { height: 28px; }
.spin { flex-shrink: 0; margin-top: 1px; animation: pointr-spin .9s linear infinite; }
@keyframes pointr-spin { to { transform: rotate(360deg); } }
.reply { display: flex; align-items: flex-end; gap: 8px; padding: 10px 10px 10px 14px; border-top: 1px solid var(--line); }
.reply textarea {
  height: 34px; min-height: 34px; max-height: 120px; padding: 7px 10px; border-radius: 8px;
  line-height: 18px; overflow-y: hidden;
}
.sq {
  width: 34px; height: 34px; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center;
  padding: 0; border: 0; border-radius: 8px; background: var(--ink); color: var(--sunk); cursor: pointer;
}
.foot { display: flex; align-items: center; gap: 8px; padding: 10px 12px 12px 14px; border-top: 1px solid var(--line); }
.foot .lost { font-size: 12px; color: var(--muted); }

/* Pins */
.pins { position: fixed; inset: 0; z-index: 2147483646; pointer-events: none; }
.pin {
  position: absolute; left: 0; top: 0; width: 28px; height: 28px; padding: 0;
  display: flex; align-items: center; justify-content: center; border-radius: 14px 14px 14px 3px;
  pointer-events: auto; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.28);
}
.pin.waiting { background: #09090b; color: #fff; border: 2px solid #fff; }
.pin.replied { background: #fff; color: #09090b; border: 2px solid #09090b; font: 700 10px var(--mono); }
.pin .dot { top: -4px; right: -4px; width: 10px; height: 10px; background: var(--pin-blue); box-shadow: 0 0 0 2px #fff; }

/* List */
.items { display: flex; flex-direction: column; gap: 2px; padding: 2px 6px 6px; max-height: min(60vh, 460px); overflow-y: auto; }
.item {
  width: 100%; display: flex; align-items: flex-start; gap: 10px; padding: 10px 8px; border: 0;
  border-radius: 10px; background: transparent; color: var(--ink); text-align: left; cursor: pointer;
}
.item:hover, .item.other { background: var(--line); }
.item.other:hover { background: var(--line2); }
.mini {
  width: 22px; height: 22px; flex-shrink: 0; display: flex; align-items: center; justify-content: center;
  border-radius: 11px 11px 11px 3px; font: 700 8.5px var(--mono);
}
.mini.waiting { background: #09090b; color: #fff; border: 1.5px solid #fff; }
.mini.replied { background: #fff; color: #09090b; }
.mini.gone { background: transparent; color: var(--muted); border: 1.5px dashed #52525b; }
.mini.resolved { background: transparent; color: var(--muted); border: 1.5px solid #52525b; }
.tabs { padding: 0 16px 8px; }
.tabs .seg { width: 100%; }
.tabs .seg button { flex: 1; height: 28px; font-size: 12px; }
.ghead { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding: 12px 8px 4px; font-size: 11.5px; color: var(--dim); }
.ghead .mono { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ghead .here { flex-shrink: 0; color: var(--muted); }
.lines { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.l1 { display: flex; align-items: baseline; gap: 6px; white-space: nowrap; overflow: hidden; font-size: 13px; }
.l1 .c { flex-shrink: 0; font: 11.5px var(--mono); color: var(--muted); }
.l1 .x { overflow: hidden; text-overflow: ellipsis; }
.l2 { font-size: 11.5px; color: var(--dim); }
.udot { flex-shrink: 0; margin-top: 6px; width: 8px; height: 8px; border-radius: 50%; background: var(--blue); }
.section { padding: 12px 8px 4px; font-size: 11px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: var(--dim); }
.empty { padding: 12px 10px; font-size: 12.5px; color: var(--muted); }
.lfoot { display: flex; align-items: center; gap: 8px; padding: 10px 12px 12px 16px; border-top: 1px solid var(--line); font-size: 12px; color: var(--dim); }

/* Toast */
.toast {
  position: fixed; right: 16px; bottom: 72px; z-index: 2147483647; max-width: min(420px, calc(100vw - 32px));
  display: flex; align-items: center; gap: 10px; min-height: 46px; padding: 6px 6px 6px 14px;
  background: var(--bg); border: 1px solid var(--line); border-radius: 12px;
  box-shadow: 0 10px 30px rgba(0,0,0,.3); font-size: 12.5px;
}
.toast .led { width: 8px; height: 8px; color: var(--muted); }
.toast.reply .led { color: var(--blue); }
.toast.warn .led { color: var(--warn); }
.toast.err .led { color: var(--err); }
.toast .msg-text { flex: 1; min-width: 0; }
.toast .pbtn { height: 30px; padding: 0 12px; font-size: 12px; }

/* Settings, inside the comment list */
.settings { display: flex; flex-direction: column; gap: 16px; padding: 6px 0 16px; }
.srow { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 16px; font-size: 12.5px; color: var(--ink2); }
.sname { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.shelp { font-size: 11.5px; color: var(--dim); }
.hk {
  flex-shrink: 0; min-width: 104px; height: 30px; padding: 0 10px; border-radius: 8px; cursor: pointer;
  background: var(--sunk); color: var(--ink); border: 1px solid var(--line2); font: 12px var(--mono); text-align: center;
}
.hk:hover, .hk.rec { border-color: var(--muted); }
.seg { display: flex; flex-shrink: 0; padding: 2px; border-radius: 8px; background: var(--sunk); border: 1px solid var(--line2); }
.seg button { height: 24px; padding: 0 10px; border: 0; border-radius: 6px; background: transparent; color: var(--dim); font-size: 11.5px; cursor: pointer; }
.seg button.on { background: var(--line); color: var(--ink); }
.sfoot { padding: 4px 16px 0; font-size: 11.5px; color: var(--dim); }
`;

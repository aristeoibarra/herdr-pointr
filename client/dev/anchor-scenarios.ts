/**
 * The scenarios the anchor weighing was tuned against — see "Finding a
 * thread's element again" in CLAUDE.md. `npm run scenarios` builds the page;
 * open it in any browser and every row must read PASS. Each guard in
 * client/anchor.ts fails at least one of these when it is removed, so run
 * them after touching a weight.
 *
 * Each scenario builds a page, takes the photo a comment would, changes the
 * page the way an agent's edit or the app would, and checks what the photo
 * finds: the element it should, or nothing, when nothing is the right answer.
 */

import { anchorFor, findAnchor } from "../anchor.ts";
import type { Anchor } from "../api.ts";

interface Scenario {
  name: string;
  html: string;
  /** Changes the page before the photo is taken. */
  before?: () => void;
  pick(): Element | null;
  /** A photo from before context, pos and peers were stored. */
  old?: boolean;
  /** What the agent wrote in the thread. */
  replies?: string;
  mutate(): void;
  /** The element the photo must find afterwards, or null for nothing. */
  expect(): Element | null;
}

interface Result {
  name: string;
  ok: boolean;
  detail: string;
}

const CARDS: Array<[string, string]> = [["Usuarios activos", "12,480"], ["Visitas", "38,109"], ["Churn", "1.9%"]];
const ROWS: Array<[string, string]> = [
  ["INV-2041", "Halden & Moss"],
  ["INV-2040", "Pellworth Studio"],
  ["INV-2039", "Oriel Logistics"],
  ["INV-2038", "Brightwater Co-op"],
];

const cards = (items: Array<[string, string]>): string =>
  `<main><h1>App · Inicio</h1><p>Una app.</p><div class="grid">${items.map(([k, v]) => `<div class="card"><div class="k">${k}</div><div class="v">${v}</div></div>`).join("")}</div></main>`;
const rows = (items: Array<[string, string]>): string =>
  `<main><h1>Facturas</h1><table><tbody>${items.map(([id, name]) => `<tr><td>${id}</td><td>${name}</td><td><button>Edit</button></td></tr>`).join("")}</tbody></table></main>`;
const list = (items: string[]): string => `<main><h1>Lista</h1><ul>${items.map((t) => `<li>${t}</li>`).join("")}</ul></main>`;
const HERO = '<main><section><h2 class="hero-title">Welcome</h2><p>Intro text</p></section></main>';

function app(): HTMLElement {
  const el = document.getElementById("app");
  if (!el) throw new Error("no #app");
  return el;
}

function set(html: string): void {
  app().innerHTML = html;
}

function must(el: Element | null): Element {
  if (!el) throw new Error("scenario element missing");
  return el;
}

const byText = (selector: string, text: string): Element | null =>
  [...app().querySelectorAll(selector)].find((el) => el.textContent?.trim() === text) ?? null;
const rowButton = (id: string): Element | null =>
  [...app().querySelectorAll("tr")].find((tr) => tr.textContent?.includes(id))?.querySelector("button") ?? null;
const addCard = (k: string, v: string): void =>
  must(app().querySelector(".grid")).insertAdjacentHTML("afterbegin", `<div class="card"><div class="k">${k}</div><div class="v">${v}</div></div>`);
const setText = (el: Element | null, text: string): void => {
  must(el).textContent = text;
};

const SCENARIOS: Scenario[] = [
  {
    name: "own text edited",
    html: cards(CARDS),
    pick: () => byText(".v", "1.9%"),
    mutate: () => setText(byText(".v", "1.9%"), "I.IX%"),
    expect: () => byText(".v", "I.IX%"),
  },
  {
    name: "text and its label edited, same place",
    html: cards(CARDS),
    pick: () => byText(".v", "1.9%"),
    mutate: () => {
      setText(byText(".k", "Churn"), "Abandono");
      setText(byText(".v", "1.9%"), "2.4%");
    },
    expect: () => byText(".v", "2.4%"),
  },
  {
    name: "label next to it edited, it is unchanged",
    html: cards(CARDS),
    pick: () => byText(".v", "1.9%"),
    mutate: () => setText(byText(".k", "Churn"), "Abandono"),
    expect: () => byText(".v", "1.9%"),
  },
  {
    name: "old photo, reply quotes the new text",
    html: cards(CARDS),
    pick: () => byText(".v", "1.9%"),
    old: true,
    replies: 'Cambié "1.9%" por "I.IX%" en la tarjeta Churn.',
    mutate: () => setText(byText(".v", "1.9%"), "I.IX%"),
    expect: () => byText(".v", "I.IX%"),
  },
  {
    name: "old photo, label, reply quotes it and names the number",
    html: cards(CARDS),
    before: () => setText(byText(".k", "Visitas"), "Sesiones"),
    pick: () => byText(".k", "Sesiones"),
    old: true,
    replies: 'Cambié la etiqueta "Sesiones" por "Visitas"; la cifra 38,109 queda igual.',
    mutate: () => setText(byText(".k", "Sesiones"), "Visitas"),
    expect: () => byText(".k", "Visitas"),
  },
  {
    name: "old photo, one-letter new text quoted",
    html: '<main><h1>Hash · Uno</h1><div class="card" id="tarjeta-uno"><div class="k">Tarjeta de #/uno</div><div class="v">Uno</div></div></main>',
    pick: () => app().querySelector("#tarjeta-uno .v"),
    old: true,
    replies: 'Cambié "Uno" por "I" en la tarjeta de #/uno. El título "Hash · Uno" y la tarjeta de #/dos (que dice "Dos") siguen igual; si quieres que "Dos" pase a "II", dime.',
    mutate: () => setText(app().querySelector("#tarjeta-uno .v"), "I"),
    expect: () => app().querySelector("#tarjeta-uno .v"),
  },
  {
    name: "old photo, no reply: no guess",
    html: cards(CARDS),
    pick: () => byText(".v", "1.9%"),
    old: true,
    mutate: () => setText(byText(".v", "1.9%"), "I.IX%"),
    expect: () => null,
  },
  {
    name: "card removed: not the neighbour",
    html: cards(CARDS),
    pick: () => byText(".v", "38,109"),
    mutate: () => must(byText(".v", "38,109")).parentElement?.remove(),
    expect: () => null,
  },
  {
    name: "card removed, reply names the neighbour",
    html: cards(CARDS),
    pick: () => byText(".v", "38,109"),
    replies: 'Quité la tarjeta "Visitas"; quedan "12,480" y "1.9%".',
    mutate: () => must(byText(".v", "38,109")).parentElement?.remove(),
    expect: () => null,
  },
  {
    name: "card inserted before it",
    html: cards(CARDS),
    pick: () => byText(".v", "38,109"),
    mutate: () => addCard("Nuevos", "312"),
    expect: () => byText(".v", "38,109"),
  },
  {
    name: "card inserted before it, and it was edited",
    html: cards(CARDS),
    pick: () => byText(".v", "38,109"),
    replies: 'Cambié la cifra a "40,000" y agregué "Nuevos".',
    mutate: () => {
      addCard("Nuevos", "312");
      setText(byText(".v", "38,109"), "40,000");
    },
    expect: () => byText(".v", "40,000"),
  },
  {
    name: "list reordered",
    html: list(["Alpha", "Beta", "Gamma", "Delta"]),
    pick: () => byText("li", "Beta"),
    mutate: () => set(list(["Delta", "Gamma", "Beta", "Alpha"])),
    expect: () => byText("li", "Beta"),
  },
  {
    name: "list item removed",
    html: list(["Alpha", "Beta", "Gamma", "Delta"]),
    pick: () => byText("li", "Beta"),
    mutate: () => must(byText("li", "Beta")).remove(),
    expect: () => null,
  },
  {
    name: "same-text button, row inserted above",
    html: rows(ROWS),
    pick: () => rowButton("INV-2039"),
    mutate: () =>
      must(app().querySelector("tbody")).insertAdjacentHTML("afterbegin", "<tr><td>INV-2042</td><td>Nova</td><td><button>Edit</button></td></tr>"),
    expect: () => rowButton("INV-2039"),
  },
  {
    name: "same-text button, its row removed",
    html: rows(ROWS),
    pick: () => rowButton("INV-2039"),
    mutate: () => must(rowButton("INV-2039")).closest("tr")?.remove(),
    expect: () => null,
  },
  {
    name: "same-text button, rows re-sorted",
    html: rows(ROWS),
    pick: () => rowButton("INV-2039"),
    mutate: () => set(rows([...ROWS].reverse())),
    expect: () => rowButton("INV-2039"),
  },
  {
    name: "class renamed, text kept",
    html: HERO,
    pick: () => app().querySelector("h2"),
    mutate: () => {
      must(app().querySelector("h2")).className = "headline";
    },
    expect: () => app().querySelector("h2"),
  },
  {
    name: "class renamed, text edited, reply quotes it",
    html: HERO,
    pick: () => app().querySelector("h2"),
    replies: 'Renombré la clase y cambié el título a "Hello there".',
    mutate: () => {
      const title = must(app().querySelector("h2"));
      title.className = "headline";
      title.textContent = "Hello there";
    },
    expect: () => app().querySelector("h2"),
  },
  {
    name: "item removed, two added, reply quotes both",
    html: list(["Alpha", "Beta", "Gamma"]),
    pick: () => byText("li", "Beta"),
    replies: 'Quité "Beta" y agregué "Epsilon" y "Zeta".',
    mutate: () => set(list(["Alpha", "Gamma", "Epsilon", "Zeta"])),
    expect: () => null,
  },
  {
    name: "value replaced by something else",
    html: cards(CARDS),
    pick: () => byText(".v", "38,109"),
    mutate: () => {
      must(byText(".v", "38,109")).outerHTML = '<canvas width="80" height="20"></canvas>';
    },
    expect: () => null,
  },
  {
    name: "whole page rebuilt, same content",
    html: cards(CARDS),
    pick: () => byText(".v", "1.9%"),
    mutate: () => set(cards(CARDS)),
    expect: () => byText(".v", "1.9%"),
  },
];

function describe(el: Element | null): string {
  return el ? `${el.tagName.toLowerCase()} "${el.textContent?.trim().slice(0, 24) ?? ""}"` : "nothing";
}

function runOne(s: Scenario): Result {
  set(s.html);
  s.before?.();
  const photo: Anchor = anchorFor(must(s.pick()));
  const anchor: Anchor = s.old ? { ...photo, context: "", pos: null, peers: [] } : photo;
  s.mutate();
  const want = s.expect();
  const found = findAnchor(anchor, () => false, { replies: s.replies ?? "" });
  const got = found?.el ?? null;
  const how = found ? (found.sure ? " (proof)" : " (weighed)") : "";
  return { name: s.name, ok: got === want, detail: `${describe(got)}${how}${got === want ? "" : `, wanted ${describe(want)}`}` };
}

function run(): Result[] {
  const results = SCENARIOS.map((s) => {
    try {
      return runOne(s);
    } catch (error) {
      return { name: s.name, ok: false, detail: `threw: ${error instanceof Error ? error.message : String(error)}` };
    }
  });
  set("");
  return results;
}

function render(results: Result[]): void {
  const passed = results.filter((r) => r.ok).length;
  document.title = `${passed}/${results.length} pass`;
  const out = document.getElementById("results");
  if (!out) return;
  out.replaceChildren(
    ...results.map((r) => {
      const line = document.createElement("div");
      line.className = r.ok ? "pass" : "fail";
      line.textContent = `${r.ok ? "PASS" : "FAIL"}  ${r.name}  →  ${r.detail}`;
      return line;
    }),
  );
  const summary = document.getElementById("summary");
  if (summary) summary.textContent = `${passed} of ${results.length} pass`;
}

// Also callable from a driven browser: anchorScenarios() → "21/21 pass" plus failures.
Object.assign(window, {
  anchorScenarios: (): string => {
    const results = run();
    render(results);
    return [document.title, ...results.filter((r) => !r.ok).map((r) => `FAIL ${r.name}: ${r.detail}`)].join("\n");
  },
});

render(run());

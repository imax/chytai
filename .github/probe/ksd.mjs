// One-off check for the КСД thread: the new source against the live API, and loadShelves timed with and
// without its shelf on a synthetic ~20k-item catalog. Not part of the site.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { SOURCES, refresh } = require("../../web/catalogs.js");
const Store = require("../../web/store.js").Store || require("../../web/store.js");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chytai-"));
const store = new Store(dir);
// Synthetic catalog: ~19k items over the other sources, with real-looking titles and a shared author pool.
const W = "світло тінь дім море ніч вітер сад місто зима літо серце сон дорога вогонь ліс пам'ять шлях небо камінь птах голос лист берег острів".split(" ");
const N = "Олена Андрій Марія Тарас Ірина Сергій Анна Остап Софія Богдан Kate John Anne Peter Stephen Агата Ґабріель".split(" ");
const S = "Коваль Шевченко Мельник Бойко Кінг Крісті Гейлі Остін Фолетт Роулінг Пратчетт Сандерсон Морріс Ліндґрен Мартін".split(" ");
let k = 0;
const rnd = (a) => a[(k = (k * 1103515245 + 12345) % 2147483648) % a.length];
const others = SOURCES.filter((s) => !["ksd", "lobster", "vydavnytstvo"].includes(s.id));
const shelves = others.map((s) => ({ id: s.id, kind: s.kind, name: s.name, tagline: s.tagline, url: s.url, items: [] }));
for (let i = 0; i < 19000; i++) {
  const t = `${rnd(W)} ${rnd(W)} ${rnd(W)}`.replace(/^./, (c) => c.toUpperCase()) + (i % 9 === 0 ? `. Книга ${1 + (i % 4)}` : "");
  shelves[i % shelves.length].items.push({ id: `${shelves[i % shelves.length].id}-x${i}`, title: t, author: `${rnd(N)} ${rnd(S)}`, isbn: `978617${String(1e6 + i).slice(1)}${i % 10}`, format: i % 3 ? "папір" : "e-book", series: "", volume: 0, bundle: false, cover: "", url: `https://example.com/${i}`, price: "300 ₴", status: "є", isNew: false, genres: [], blurb: "Опис ".repeat(40), language: "українська" });
}
store.saveShelves(shelves, { fetched: "2026-10-24" });
const time = (label) => { const r = []; for (let i = 0; i < 3; i++) { const t = performance.now(); store.loadShelves(); r.push(performance.now() - t); } console.log(`${label}: loadShelves ${r.map((x) => x.toFixed(0)).join(" / ")} ms, ${store.shelves.reduce((n, s) => n + s.items.length, 0)} items`); };
time("without КСД");
const t0 = Date.now();
const res = await refresh({ store, only: "ksd", log: (m) => console.log("  " + m) });
console.log(`refresh ksd: ${((Date.now() - t0) / 1000).toFixed(0)} s, ${JSON.stringify(res.errors)}`);
time("with КСД");
const ksd = store.shelves.find((s) => s.id === "ksd").items;
const c = (f) => ksd.filter(f).length;
console.log(`ksd items ${ksd.length}: paper ${c((x) => x.format === "папір")}, e-book ${c((x) => x.format === "e-book")}, in stock ${c((x) => x.status === "є")}, isbn ${c((x) => x.isbn)}, original title ${c((x) => x.altTitle)}, translator ${c((x) => x.translator)}, blurb ${c((x) => x.blurb)}, cover ${c((x) => x.cover)}, bundles ${c((x) => x.bundle)}, with an e-book edition ${c((x) => (x.editions || 1) > 1)}`);
const yrs = {}; for (const x of ksd) { const y = x.year ? Math.floor(x.year / 5) * 5 : "?"; yrs[y] = (yrs[y] || 0) + 1; } console.log("years:", JSON.stringify(yrs));
const au = {}; for (const x of ksd) for (const a of x.author.split(", ")) au[a] = (au[a] || 0) + 1;
console.log("top authors:", Object.entries(au).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([a, n]) => `${a} ${n}`).join(", "));
for (const x of ksd.filter((_, i) => i % 300 === 0)) console.log(JSON.stringify({ ...x, blurb: x.blurb?.slice(0, 160) }));

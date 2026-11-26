// Books from MEGOGO BOOKS' feed that no catalog of ours has become catalog books (Max 2026-11-26, the fourth point
// of the feed's analysis: «для 4 можемо окремий тред»). megogo.js reads the feed for «Де взяти» and the
// descriptions; this file reads it once a day on its own (a conditional request) and adds what is missing:
//   - only the categories Max chose (`GROUPS`, meta `megogo:fill` {on, groups}), only books with an author, a
//     Ukrainian (Cyrillic) title, not Russian;
//   - rows of one book (several printings) are one book with all their ISBNs;
//   - a book we have under another edition is left: any ISBN of any edition, the same title (any edition's, a
//     shop's «Акція -20%:» taken off) by the same author, or the same title before «.», «:», «(» («Втрачаючи надію
//     (Цикл «Безнадія». Книга 2)»), never across volume numbers («Сага про Вінланд. Том 9» is not «Том 1»);
//   - at most `DAY` books a day (the new books' queue, newbooks.js, takes 1,500 a day for every source: readers'
//     books must not wait behind these), news («Новинка») and books in stock first.
// A book comes in as store.addBook({ source: "megogo", isbns, cover, links: [Megogo] }); the next megogo.run (forced
// after a run that added any) finds it by ISBN, so «Де взяти» gets the shop's row and the book the publisher's
// description and genre (megogo:info); the queue does the rest (language, genres, original, cover copies).
const { norm, sameAuthor, isRussian } = require("./store");
const { parse, FEED } = require("./megogo");
const { kyivHour } = require("./newbooks");

const DAY = 400;
const CYR = /[а-яіїєґ]/i;
// The feed's categories (product_type) by group. Subcategories left out of every group: Max's rules or no reader's
// book (laws, prayers, medicine; toys and copybooks for children).
const GROUPS = {
  fiction: "Художня література",
  nonfiction: "Нонфікшн",
  comics: "Комікси й манґа",
  "kids-fiction": "Дитяча художня",
  "kids-other": "Інші дитячі (розвиток, енциклопедії, ігри)",
};
const NEVER = /Юридична|Медичні|Релігійні|Підручник|Шкільн/;
function groupOf(b) {
  const [top, sub = ""] = b.cats || [];
  if (NEVER.test(sub)) return "";
  if (/Комікси|манґа/i.test(sub)) return "comics";
  if (top === "Художня література") return "fiction";
  if (top === "Нонфікшн") return "nonfiction";
  if (top === "Книги для дітей") return /Художня/.test(sub) ? "kids-fiction" : "kids-other";
  return "";
}

// A title compared: lower case without punctuation, a shop's sale words in front taken off.
const nt = (s) => norm(String(s || "").replace(/^\s*(акція|знижка|розпродаж)[^:]*:\s*/i, ""));
const head = (s) => nt(String(s || "").split(/[.:(]\s|\s[—–]\s|:/)[0]);
// A volume number other than the first: «Том 9», «Книга 2», «Частина 3».
const VOL = /(?:том|книга|частина|ч\.|омнібус|vol\.?|volume|book)\s*(\d+)/i;
const volNum = (t) => Number((String(t).match(VOL) || [])[1] || 0);

class MegogoFill {
  constructor({ store, megogo = null, fetchImpl = fetch, log = () => {} }) {
    Object.assign(this, { store, megogo, fetchImpl, log, db: store.db });
    this.running = false;
  }

  settings() {
    try {
      return { on: false, groups: [], ...JSON.parse(this.db.get("megogo:fill") || "{}") };
    } catch {
      return { on: false, groups: [] };
    }
  }
  set({ on, groups }) {
    const s = this.settings();
    if (typeof on === "boolean") s.on = on;
    if (Array.isArray(groups)) s.groups = groups.filter((g) => GROUPS[g]);
    this.db.set("megogo:fill", JSON.stringify(s));
    return s;
  }
  count() {
    const day = new Date().toISOString().slice(0, 10);
    try {
      const c = JSON.parse(this.db.get("megogo:fill-count") || "{}");
      return c.day === day ? c : { day, n: 0 };
    } catch {
      return { day, n: 0 };
    }
  }

  // Every work's ISBNs and titles, of all its editions, for have().
  index() {
    const s = this.store;
    const isbn = new Map();
    const titles = new Map(); // nt(title) -> Set(ids)
    const heads = new Map(); // head(title) -> Set(ids)
    const add = (m, k, id) => k.length >= 2 && (m.get(k) || m.set(k, new Set()).get(k)).add(id);
    for (const id of s.workIds()) {
      const b = s.book(id);
      if (!b) continue;
      for (const e of [b, ...(b.editions || [])]) {
        for (const i of [e.isbn, ...(e.isbns || [])]) if (i) isbn.set(String(i).replace(/[^\dX]/gi, ""), id);
        for (const t of [e.title, e.altTitle]) if (t) add(titles, nt(t), id), add(heads, head(t), id);
      }
    }
    for (const [i, id] of s.workIndex().byIsbn) if (!isbn.has(i)) isbn.set(i, id);
    return { isbn, titles, heads };
  }

  // Our work for a book of the feed ({ title, author, isbns }), or null.
  have(b, ix) {
    const s = this.store;
    for (const i of b.isbns) if (ix.isbn.has(i)) return ix.isbn.get(i);
    const byAuthor = (ids) => [...(ids || [])].find((id) => {
      const w = s.book(id);
      return w && [w.author, ...(w.editions || []).map((e) => e.author)].some((a) => a && sameAuthor(a, b.author));
    });
    const t = nt(b.title);
    const v = volNum(b.title);
    let id = byAuthor(ix.titles.get(t));
    // The same title before «.», «:», «(» on either side, when the volume numbers agree (none counts as the first).
    if (!id) id = byAuthor([...(ix.heads.get(t) || [])].filter((x) => volNum(s.book(x)?.title || "") <= 1 && v <= 1));
    if (!id && head(b.title) !== t && v <= 1) id = byAuthor([...(ix.titles.get(head(b.title)) || [])].filter((x) => volNum(s.book(x)?.title || "") <= 1));
    return id || (v <= 1 && s.findWork({ title: b.title, author: b.author, isbns: b.isbns })) || null;
  }

  // The feed's books we lack, one per book, in the order they would come in: { group, title, author, isbns, url,
  // cover, isNew, status, cats }.
  missing(books, groups = Object.keys(GROUPS)) {
    const one = new Map();
    for (const b of books) {
      const group = groupOf(b);
      if (!group || !groups.includes(group) || !b.author || !CYR.test(b.title) || b.title.length < 2) continue;
      if (isRussian({ title: b.title, author: b.author })) continue;
      const k = `${nt(b.title)}|${norm(b.author)}`;
      const o = one.get(k);
      const isNew = (b.labels || []).includes("Новинка");
      if (!o) {
        one.set(k, { group, title: b.title, author: b.author, isbns: b.isbn.length >= 10 ? [b.isbn] : [], url: b.url, cover: b.image || "", isNew, status: b.status, cats: b.cats });
        continue;
      }
      if (b.isbn.length >= 10 && !o.isbns.includes(b.isbn)) o.isbns.push(b.isbn);
      o.isNew ||= isNew;
      if (b.status === "є" && o.status !== "є") Object.assign(o, { url: b.url, cover: b.image || o.cover, status: b.status });
    }
    const ix = this.index();
    const out = [];
    const near = [];
    for (const b of one.values()) {
      const id = this.have(b, ix);
      if (id) near.push({ ...b, id });
      else out.push(b);
    }
    const rank = (b) => (b.isNew ? 0 : 2) + (b.status === "є" ? 0 : 1) + groups.indexOf(b.group) * 4;
    out.sort((a, b) => rank(a) - rank(b));
    return { out, had: near, rows: one.size };
  }

  async feed() {
    const was = JSON.parse(this.db.get("megogo:fill-feed") || "null");
    const r = await this.fetchImpl(FEED, { signal: AbortSignal.timeout(180000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const books = parse(await r.text());
    if (books.length < 1000) throw new Error(`only ${books.length} books in the feed`);
    this.db.set("megogo:fill-feed", JSON.stringify({ at: Date.now(), books: books.length, was: was?.at || 0 }));
    return books;
  }

  // What a run would add, by group, with samples; nothing kept.
  async dry({ groups } = {}) {
    const t0 = Date.now();
    const books = await this.feed();
    const { out, had, rows } = this.missing(books, groups || Object.keys(GROUPS));
    const by = {};
    for (const b of out) {
      const g = (by[b.group] ||= { name: GROUPS[b.group], n: 0, news: 0, sample: [] });
      g.n++;
      if (b.isNew) g.news++;
      if (g.sample.length < 25 && Math.random() < 0.15) g.sample.push(`${b.title} — ${b.author} (${b.cats.slice(1).join(" / ")})`);
    }
    const tick = (b) => `${b.title} — ${b.author} ~ ${this.store.book(b.id)?.title} (${b.id})`;
    return { feed: books.length, rows, missing: out.length, had: had.length, groups: by, hadSample: had.filter(() => Math.random() < 0.05).slice(0, 25).map(tick), ms: Date.now() - t0 };
  }

  // Adds up to `limit` books (the day's cap at most) of the chosen groups. by hand: a run Max asked for in a thread,
  // even while the daily run is off.
  async run({ limit = DAY, groups, byHand = false } = {}) {
    if (this.running) return null;
    const set = this.settings();
    if (!byHand && !set.on) return null;
    const use = groups || set.groups;
    if (!use.length) return null;
    // The daily run once a Kyiv night (02–05), when readers are asleep: its books' checks wait for the night too
    // (newbooks.js BULK). The schedule asks hourly.
    const day = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
    if (!byHand) {
      const h = kyivHour();
      if (h < 2 || h >= 5 || this.db.get("megogo:fill-day") === day) return null;
      this.db.set("megogo:fill-day", day);
    }
    this.running = true;
    try {
      const c = this.count();
      // A run Max asked for by hand takes what he asked (Max 2026-11-26: «можеш всі прогнати, не треба по 200»).
      const room = byHand ? limit : Math.min(limit, DAY - c.n);
      if (room <= 0) return { added: 0, note: "the day's cap", changed: false };
      this.store.fresh(); // the site may have added books since this process read them
      const books = await this.feed();
      const { out } = this.missing(books, use);
      const s = this.store;
      const made = [];
      for (const b of out.slice(0, room)) {
        const id = s.addBook({ title: b.title, author: b.author, cover: b.cover, links: [{ label: "MEGOGO BOOKS", url: b.url }], source: "megogo", language: "українська", ...(b.isbns.length ? { isbns: b.isbns.slice(0, 10) } : {}) }, { index: false }).id;
        made.push(id);
      }
      if (made.length) s.indexSlugs(), s.indexBooks(made);
      c.n += made.length;
      this.db.set("megogo:fill-count", JSON.stringify(c));
      const log = JSON.parse(this.db.get("megogo:fill-log") || "[]");
      log.unshift({ at: new Date().toISOString(), added: made.length, left: out.length - made.length, ids: made.slice(0, 50) });
      this.db.set("megogo:fill-log", JSON.stringify(log.slice(0, 30)));
      this.log(`megogo fill: ${made.length} new books (${out.length - made.length} left)`);
      // The shop's row, description and genre for them now, not in six hours.
      if (made.length && this.megogo) await this.megogo.run({ force: true }).catch((e) => this.log(`megogo fill: links: ${e.message}`));
      return { added: made.length, left: out.length - made.length, changed: made.length > 0 };
    } finally {
      this.running = false;
    }
  }
}

module.exports = { MegogoFill, GROUPS, groupOf };

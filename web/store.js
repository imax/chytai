// Data for the Chytai web platform: the library (one profile for now), the public shelves and
// the book registry. Everything is JSON on disk; the library lives in DATA_DIR/web/library.json
// and is seeded once from web/seed/max.json (Books.md import) and web/seed/office.json (the paper
// books in Max's office). Books.md is not read again after that (Max, 2026-10-18).
const fs = require("fs");
const path = require("path");

const SEED = path.join(__dirname, "seed");
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

// Office books that match a library book under a different spelling (title-matching misses them).
const OFFICE_MATCHES = { 6: "bastiat-essays", 7: "гемінгвей-нічого-не-знає", 35: "deep-work", 44: "subtle-art-of-not-giving-a-fuck", 46: "andy-grove-one-on-ones" };
const RU = /[ыэъё]/i; // Russian-only letters: these office books stay out of the profile until Max says otherwise

const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/[’'"«»“”]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "book";
const norm = (s) => String(s || "").toLowerCase().replace(/^(the|a)\s+/, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

class Store {
  constructor(dataDir) {
    this.file = path.join(dataDir, "library.json");
    fs.mkdirSync(dataDir, { recursive: true });
    this.seedBooks = readJson(path.join(SEED, "books.json"));
    const shelvesFile = readJson(path.join(SEED, "shelves.json"));
    this.shelves = shelvesFile.shelves;
    this.shelvesFetched = shelvesFile.fetched;
    this.shelfItems = new Map(); // item id -> { shelf, item }
    for (const s of this.shelves) for (const it of s.items) this.shelfItems.set(it.id, { shelf: s, item: it });
    this.load();
  }

  load() {
    try {
      this.lib = readJson(this.file);
    } catch {
      this.lib = this.seed();
      this.save();
    }
    this.lib.books ??= {};
    this.lib.entries ??= {};
    this.lib.subscriptions ??= [];
  }

  seed() {
    const max = readJson(path.join(SEED, "max.json"));
    const lib = { name: max.name, books: {}, entries: {}, subscriptions: [], seeded: new Date().toISOString() };
    for (const e of max.entries) lib.entries[e.book] = { status: "read", year: e.year, rating: e.rating, note: e.noteMd || e.note, copy: "", order: e.order };
    // Paper books in the office: known ones get "paper", the rest are added as books without a status.
    let office = [];
    try {
      office = readJson(path.join(SEED, "office.json"));
    } catch {
      /* no office list */
    }
    const idx = new Map();
    for (const b of this.seedBooks) {
      idx.set(norm(b.title), b.id);
      if (b.altTitle) idx.set(norm(b.altTitle), b.id);
    }
    let order = max.entries.length;
    for (const o of office) {
      if (RU.test(o.title) || RU.test(o.author)) continue;
      const n = norm(o.title);
      let id = OFFICE_MATCHES[o.n] || idx.get(n);
      if (!id) for (const [k, v] of idx) if (k.length > 6 && (n.startsWith(k) || k.startsWith(n))) { id = v; break; }
      if (id) {
        lib.entries[id] ??= { status: "", year: null, rating: null, note: "", copy: "", order: order++ };
        lib.entries[id].copy = "paper";
      } else {
        id = slugify(o.title);
        while (lib.books[id] || this.seedBooks.some((b) => b.id === id)) id += "-2";
        lib.books[id] = { id, title: o.title, author: o.author, cover: "", tags: [], links: [], source: "office" };
        lib.entries[id] = { status: "", year: null, rating: null, note: "", copy: "paper", order: order++ };
      }
    }
    return lib;
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.lib, null, 1));
      fs.renameSync(tmp, this.file);
    }, 100);
  }

  // ---- books ----

  book(id) {
    const own = this.lib.books[id];
    if (own) return own;
    const seed = this.seedBooks.find((b) => b.id === id);
    if (seed) return seed;
    const si = this.shelfItems.get(id);
    if (si) return this.fromShelfItem(si.shelf, si.item);
    return null;
  }

  fromShelfItem(shelf, it) {
    return { id: it.id, title: it.title, author: it.author, altTitle: it.altTitle || "", cover: it.cover, tags: it.genres || [], links: [{ label: shelf.name, url: it.url }], source: shelf.id, shelf: shelf.id, blurb: it.blurb || "", price: it.price, status: it.status, language: it.language };
  }

  addBook({ title, author, cover, links }) {
    let id = slugify(title);
    while (this.book(id)) id += "-2";
    this.lib.books[id] = { id, title: title.trim(), author: (author || "").trim(), cover: cover || "", tags: [], links: links || [], source: "manual" };
    this.save();
    return this.lib.books[id];
  }

  updateBook(id, patch) {
    const b = this.lib.books[id] || this.book(id);
    if (!b) return null;
    const copy = { ...b, ...patch, id };
    this.lib.books[id] = copy; // seed and shelf books become own copies once edited
    this.save();
    return copy;
  }

  // ---- library entries ----

  entry(id) {
    return this.lib.entries[id] || null;
  }

  setEntry(id, patch) {
    if (!this.book(id)) return null;
    const cur = this.lib.entries[id] || { status: "", year: null, rating: null, note: "", copy: "", order: Object.keys(this.lib.entries).length, added: new Date().toISOString().slice(0, 10) };
    const next = { ...cur, ...patch };
    if (next.status === "read" && !next.year && cur.status !== "read") next.year = new Date().getFullYear();
    if (next.rating === "" || next.rating === undefined) next.rating = cur.rating ?? null;
    this.lib.entries[id] = next;
    this.save();
    return next;
  }

  removeEntry(id) {
    delete this.lib.entries[id];
    if (this.lib.books[id]?.source === "manual") delete this.lib.books[id];
    this.save();
  }

  // Every library row with its book, newest first (Books.md order for the import).
  library() {
    return Object.entries(this.lib.entries)
      .map(([id, e]) => ({ id, ...e, book: this.book(id) }))
      .filter((r) => r.book)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  // ---- shelves and subscriptions ----

  shelf(id) {
    return this.shelves.find((s) => s.id === id) || null;
  }

  subscribed(id) {
    return this.lib.subscriptions.includes(id);
  }

  toggleSubscription(id) {
    if (!this.shelf(id)) return null;
    const on = !this.subscribed(id);
    this.lib.subscriptions = on ? [...this.lib.subscriptions, id] : this.lib.subscriptions.filter((s) => s !== id);
    this.save();
    return on;
  }
}

module.exports = { Store, slugify };

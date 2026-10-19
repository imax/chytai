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
const PICK = { "": 0, "є": 1, передзамовлення: 2, немає: 3 }; // which edition stands for the work on a shelf

const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/[’'"«»“”]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "book";
const norm = (s) => String(s || "").toLowerCase().replace(/^(the|a)\s+/, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const isbnKey = (s) => String(s || "").replace(/[^0-9X]/gi, "");

// Two entries for one work (one saved under an edition id): keep the fuller of each field.
const RANK = { read: 3, reading: 2, want: 1, "": 0 };
function mergeEntries(a, b) {
  const pick = (x, y) => (x !== "" && x != null ? x : y);
  return { ...b, ...a, status: (RANK[a.status] ?? 0) >= (RANK[b.status] ?? 0) ? a.status : b.status, rating: Math.max(a.rating ?? -1, b.rating ?? -1) < 0 ? null : Math.max(a.rating ?? 0, b.rating ?? 0), year: pick(a.year, b.year), note: (a.note || "").length >= (b.note || "").length ? a.note || "" : b.note, copy: pick(a.copy, b.copy), order: Math.min(a.order ?? 1e9, b.order ?? 1e9) };
}

class Store {
  constructor(dataDir) {
    this.file = path.join(dataDir, "library.json");
    fs.mkdirSync(dataDir, { recursive: true });
    this.seedBooks = readJson(path.join(SEED, "books.json"));
    // The shelves: the seed, or the newer copy the daily refresh wrote under dataDir.
    const seedShelves = readJson(path.join(SEED, "shelves.json"));
    let shelvesFile = seedShelves;
    try {
      const live = readJson(path.join(dataDir, "shelves.json"));
      if (live.fetched >= seedShelves.fetched) shelvesFile = live;
    } catch {
      /* no refresh yet */
    }
    this.baseline = seedShelves.baseline || seedShelves.fetched;
    this.load();
    this.setShelves(shelvesFile);
  }

  // Swap in a fresh set of shelves (at start and after every refresh) and rebuild everything derived.
  setShelves(shelvesFile) {
    this.shelves = shelvesFile.shelves;
    this.shelvesFetched = shelvesFile.fetched;
    this.shelvesRefreshedAt = shelvesFile.refreshedAt || "";
    this.shelfItems = new Map(); // item id -> { shelf, item }
    for (const s of this.shelves) for (const it of s.items) this.shelfItems.set(it.id, { shelf: s, item: it });
    this.linkEditions();
    this.migrateEntries();
    this.indexSlugs();
  }

  // ---- canonical URLs ----
  // Every work has one address, /book/<slug>, built from its title (the Books.md ids already are
  // such slugs); an edition id or an old address redirects there. Slugs are rebuilt on every start,
  // so the library keeps its entries under the stable ids and only the links use slugs.
  indexSlugs() {
    this.slugs = new Map(); // slug -> id
    this.slugOf = new Map(); // id -> slug
    const take = (id, title, author) => {
      if (this.slugOf.has(id)) return;
      let slug = slugify(title);
      const last = slugify((author || "").split(/[,\s]+/).filter(Boolean).pop() || "");
      if (this.slugs.has(slug) && this.slugs.get(slug) !== id && last) slug = `${slug}-${last}`;
      while (this.slugs.has(slug) && this.slugs.get(slug) !== id) slug += "-2";
      this.slugs.set(slug, id);
      this.slugOf.set(id, slug);
    };
    for (const b of this.seedBooks) take(b.id, b.id, "");
    for (const b of Object.values(this.lib.books)) take(b.id, b.id, "");
    for (const { item } of this.shelfItems.values()) if (this.canonical(item.id) === item.id) take(item.id, item.title, item.author);
    for (const { item } of this.shelfItems.values()) item.href = this.href(item.id);
  }

  href(id) {
    id = this.canonical(id);
    return `/book/${encodeURIComponent(this.slugOf.get(id) || id)}`;
  }

  // The id behind an address: a slug, an id, or an edition id.
  resolve(param) {
    return this.slugs.get(param) || (this.book(param) ? this.canonical(param) : null);
  }

  // ---- search ----
  // One list over everything: the library and every shelf, works only (editions and volumes fold in).
  search(q, limit = 40) {
    const terms = norm(q).split(" ").filter(Boolean);
    if (!terms.length) return [];
    const ids = new Set([...this.seedBooks.map((b) => b.id), ...Object.keys(this.lib.books), ...[...this.shelfItems.keys()].filter((id) => this.canonical(id) === id && !this.hidden.has(id))]);
    const hits = [];
    for (const id of ids) {
      const b = this.book(id);
      if (!b) continue;
      const fields = [
        [norm(b.title), 3],
        [norm(b.altTitle), 3],
        [norm(b.author), 2],
        [norm(b.series?.name), 2],
        [(b.editions || []).map((e) => `${norm(e.title)} ${norm(e.altTitle)} ${norm(e.author)}`).join(" "), 1],
      ];
      let score = 0;
      for (const t of terms) {
        let best = 0;
        for (const [f, w] of fields) {
          if (!f) continue;
          if (f === t || f.startsWith(`${t} `)) best = Math.max(best, w * 3);
          else if (f.split(" ").some((word) => word.startsWith(t))) best = Math.max(best, w * 2);
          else if (f.includes(t)) best = Math.max(best, w);
        }
        if (!best) {
          score = 0;
          break;
        }
        score += best;
      }
      if (score) hits.push({ book: b, entry: this.entry(id), score });
    }
    return hits.sort((a, b) => b.score - a.score || a.book.title.localeCompare(b.book.title, "uk")).slice(0, limit);
  }

  // ---- works and editions ----
  // One book can sit on a shelf several times (paper and limited edition, three languages) and in the
  // library under its own id. Those are editions of one work: every edition id is aliased to one
  // canonical id (the library book when there is one, else one shelf item), the library keys its
  // entries by the canonical id, and book pages list all editions with their buy links.
  linkEditions() {
    this.aliases = new Map(); // edition id -> canonical id
    this.editions = new Map(); // canonical id -> [{ shelf, item }]
    this.hidden = new Set(); // shelf items that are a second edition of another item on the same shelf
    let matches = { same: {}, different: [] };
    try {
      matches = readJson(path.join(SEED, "matches.json"));
    } catch {
      /* no hand-confirmed matches */
    }
    const no = new Set(matches.different.map((p) => p.join("|")));

    // 1. Shelf items that share an ISBN or an author+title are one work.
    const groups = new Map(); // key -> group (array of {shelf,item})
    const groupOf = new Map(); // item id -> group
    const join = (key, si) => {
      const g = groupOf.get(si.item.id);
      const other = groups.get(key);
      if (other && g && other !== g) {
        for (const m of g) (other.push(m), groupOf.set(m.item.id, other));
      } else if (other && !g) (other.push(si), groupOf.set(si.item.id, other));
      else if (!other && g) groups.set(key, g);
      else {
        const ng = [si];
        groups.set(key, ng);
        groupOf.set(si.item.id, ng);
      }
    };
    // A shared ISBN counts only with the same author or title: publishers' sites reuse ISBNs by mistake.
    const alike = (a, b) => (norm(a.author) && norm(a.author) === norm(b.author)) || norm(a.title).startsWith(norm(b.title)) || norm(b.title).startsWith(norm(a.title));
    for (const si of this.shelfItems.values()) {
      const it = si.item;
      const ik = `isbn:${isbnKey(it.isbn)}`;
      if (isbnKey(it.isbn).length >= 10 && (!groups.has(ik) || alike(groups.get(ik)[0].item, it))) join(ik, si);
      if (norm(it.title) && norm(it.author)) join(`at:${norm(it.author)}|${norm(it.title)}`, si);
      if (!groupOf.has(it.id)) groupOf.set(it.id, [si]);
    }

    // 2. A shelf item whose title (or original title) is exactly a library book's title is that book.
    const byTitle = new Map();
    for (const b of this.seedBooks) for (const t of [b.title, b.altTitle]) if (norm(t).length >= 6) byTitle.set(norm(t), b.id);
    const bookOf = (it) => {
      if (matches.same[it.id]) return matches.same[it.id];
      for (const t of [it.title, it.altTitle]) {
        const id = byTitle.get(norm(t));
        if (id && !no.has(`${it.id}|${id}`)) return id;
      }
      return null;
    };

    const seen = new Set();
    for (const g of new Set(groupOf.values())) {
      const sorted = [...g].sort((a, b) => (a.item.edition ? 1 : 0) - (b.item.edition ? 1 : 0) || (PICK[a.item.status] ?? 9) - (PICK[b.item.status] ?? 9) || a.item.id.localeCompare(b.item.id, "en", { numeric: true }));
      const canonical = g.map((si) => bookOf(si.item)).find(Boolean) || sorted[0].item.id;
      this.editions.set(canonical, sorted);
      const perShelf = new Set();
      for (const si of sorted) {
        if (si.item.id !== canonical) this.aliases.set(si.item.id, canonical);
        if (perShelf.has(si.shelf.id)) this.hidden.add(si.item.id);
        perShelf.add(si.shelf.id);
        si.item.editions = g.length; // for the cards
      }
      seen.add(canonical);
    }
    this.linkSeries(matches.volumes || {});
  }

  // ---- series ----
  // Numbered volumes of one series on a shelf («Коли завмирає серце, том перший» … шостий, plus the
  // bundle) fold into one card: the bundle when the shelf sells one, else volume one. Each volume keeps
  // its own page; every page of the series lists all volumes. Volume numbers come from the titles,
  // or from matches.json when the titles carry none (Lobster's «Бобів усесвіт»).
  linkSeries(volumes = {}) {
    this.series = new Map(); // item id -> { name, items: [{ shelf, item }] }
    const groups = new Map();
    for (const si of this.shelfItems.values()) {
      const it = si.item;
      if (!it.series) continue;
      if (volumes[it.id]) it.volume = volumes[it.id];
      const key = `${si.shelf.id}|${norm(it.series)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(si);
    }
    for (const g of groups.values()) {
      if (g.length < 2 || !g.some((si) => si.item.volume || si.item.bundle)) continue; // a label like «Шеклі» is not a series
      const sorted = [...g].sort((a, b) => (a.item.bundle ? 1 : 0) - (b.item.bundle ? 1 : 0) || (a.item.volume || 99) - (b.item.volume || 99) || a.item.id.localeCompare(b.item.id, "en", { numeric: true }));
      const head = g.find((si) => si.item.bundle) || sorted[0];
      const ser = { name: head.item.series, head: head.item.id, items: sorted, volumes: sorted.filter((si) => !si.item.bundle).length };
      for (const si of sorted) {
        this.series.set(si.item.id, ser);
        si.item.volumes = ser.volumes;
        if (si !== head) this.hidden.add(si.item.id);
      }
    }
  }

  canonical(id) {
    return this.aliases.get(id) || id;
  }

  // Shelf items worth a card: one per work per shelf.
  visible(shelf) {
    return shelf.items.filter((it) => !this.hidden.has(it.id));
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

  // Entries saved under an edition id (before editions were linked, or by a shelf that changed) move to the work.
  migrateEntries() {
    let moved = false;
    for (const [id, e] of Object.entries(this.lib.entries)) {
      const c = this.canonical(id);
      if (c === id) continue;
      const cur = this.lib.entries[c];
      this.lib.entries[c] = cur ? mergeEntries(cur, e) : e;
      delete this.lib.entries[id];
      moved = true;
    }
    if (moved) this.save();
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
    id = this.canonical(id);
    const own = this.lib.books[id];
    const seed = own || this.seedBooks.find((b) => b.id === id);
    const si = seed ? null : this.shelfItems.get(id);
    const b = seed || (si && this.fromShelfItem(si.shelf, si.item));
    if (!b) return null;
    const eds = this.editions.get(id);
    const ser = [id, ...(eds || []).map((e) => e.item.id)].map((i) => this.series.get(i)).find(Boolean);
    const out = eds ? { ...b, editions: eds.map(({ shelf, item }) => ({ ...this.fromShelfItem(shelf, item), shelf })) } : { ...b };
    if (ser) out.series = { name: ser.name, head: ser.head, volumes: ser.volumes, items: ser.items.map(({ shelf, item }) => ({ ...this.fromShelfItem(shelf, item), shelf, work: this.canonical(item.id), href: this.href(item.id) })) };
    out.href = this.slugs ? this.href(id) : `/book/${encodeURIComponent(id)}`;
    return out;
  }

  fromShelfItem(shelf, it) {
    return { id: it.id, title: it.title, author: it.author, altTitle: it.altTitle || "", cover: it.cover, tags: it.genres || [], links: [{ label: shelf.name, url: it.url }], source: shelf.id, shelf: shelf.id, blurb: it.blurb || "", price: it.price, status: it.status, language: it.language, edition: it.edition || "", isbn: it.isbn || "", volume: it.volume || 0, bundle: !!it.bundle, format: shelf.kind === "free" ? "e-book" : "папір" };
  }

  addBook({ title, author, cover, links }) {
    let id = slugify(title);
    while (this.book(id)) id += "-2";
    this.lib.books[id] = { id, title: title.trim(), author: (author || "").trim(), cover: cover || "", tags: [], links: links || [], source: "manual" };
    this.save();
    this.indexSlugs();
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
    return this.lib.entries[this.canonical(id)] || null;
  }

  // Library membership by any id, edition ids included (for the shelf cards).
  inLibrary() {
    const m = new Map(Object.entries(this.lib.entries));
    for (const [alias, c] of this.aliases) if (m.has(c)) m.set(alias, m.get(c));
    return m;
  }

  setEntry(id, patch) {
    id = this.canonical(id);
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
    id = this.canonical(id);
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

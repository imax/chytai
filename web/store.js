// Data for the Chytai web platform: the library (every reader's entries, by reader id), the public shelves and the
// book registry, kept in SQLite (db.js, DATA_DIR/web/chytai.db) and cached in memory, where editions,
// series and addresses are derived. The library was seeded once from web/seed/max.json (Books.md
// import) and web/seed/office.json (the paper books in Max's office); Books.md is not read again
// after that (Max, 2026-10-18). A library.json or shelves.json from before the database is imported
// on the first start and renamed to *.migrated.
const fs = require("fs");
const path = require("path");
const { open } = require("./db");

const SEED = path.join(__dirname, "seed");
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

// Office books that match a library book under a different spelling (title-matching misses them).
const OFFICE_MATCHES = { 6: "bastiat-essays", 7: "гемінгвей-нічого-не-знає", 35: "deep-work", 44: "subtle-art-of-not-giving-a-fuck", 46: "andy-grove-one-on-ones" };
const RU = /[ыэъё]/i; // Russian-only letters: these office books stay out of the profile until Max says otherwise
const FMT = (f) => (f === "аудіо" ? 2 : f === "e-book" ? 1 : 0); // print first, then e-book, then audio
const PICK = { "": 0, "є": 1, передзамовлення: 2, анонс: 3, немає: 4 }; // which edition stands for the work on a shelf

// Ukrainian national transliteration (КМУ 2010), so an address stays readable when copied: Cyrillic
// in a link turns into %D1%8F… (Max, 2026-10-19). Є, Ї, Й, Ю, Я start a word as ye, yi, y, yu, ya.
const LAT = { а: "a", б: "b", в: "v", г: "h", ґ: "g", д: "d", е: "e", є: "ie", ж: "zh", з: "z", и: "y", і: "i", ї: "i", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ь: "", ю: "iu", я: "ia", ы: "y", э: "e", ъ: "", ё: "io" };
const FIRST = { є: "ye", ї: "yi", й: "y", ю: "yu", я: "ya" };
function translit(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const start = !/[\p{L}’'ʼ]/u.test(s[i - 1] || "");
    if (c === "з" && s[i + 1] === "г") (out += "zgh"), i++;
    else out += (start && FIRST[c]) || (LAT[c] ?? c);
  }
  return out;
}
const slugify = (s) =>
  translit(String(s).toLowerCase())
    .replace(/[łđøß]/g, (c) => ({ ł: "l", đ: "d", ø: "o", ß: "ss" })[c])
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[’'"«»“”ʼ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "book";
const OWNER = "owner"; // the reader id of the owner (Max): the only reader before accounts, so old rows are his
// Books in Russian stay on the shelf of the reader who added them and nowhere else: not in search,
// author pages, feeds, picks or recommendations (Max, 2026-10-20: «не показувати книжки рос в пошуку.
// Навіть якщо хтось її додав. Тільки на сторінці цього читача»). The catalog's language word wins,
// otherwise the Russian-only letters ы э ъ ё in the title or the author, or, with no Ukrainian-only
// letter, a Russian ending: «Ненасильственное общение» has neither ы nor э.
const RU_ENDING = /(ое|ая|ые|ие)(?![\p{L}])|(?<![\p{L}])(и|что|как|это|лет|или)(?![\p{L}])/iu;
const isRussian = (b) => {
  const lang = String(b?.language || "").toLowerCase();
  if (lang) return /^(ru|рос)/.test(lang);
  const text = `${b?.title || ""} ${b?.author || ""}`;
  return RU.test(text) || (!/[іїєґ]/i.test(text) && RU_ENDING.test(b?.title || ""));
};
const norm = (s) => String(s || "").toLowerCase().replace(/^(the|a)\s+/, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const isbnKey = (s) => String(s || "").replace(/[^0-9X]/gi, "");
// The ISBNs a library book is known by: its own field, plus the Amazon /dp/<ISBN-10> links from Books.md.
const isbnsOf = (b) => [...(b.isbns || []), b.isbn || "", ...(b.links || []).map((l) => /amazon\.[a-z.]+\/(?:[^/]+\/)?dp\/([0-9X]{10})/i.exec(l.url || "")?.[1] || "")].map(isbnKey).filter((i) => i.length >= 10);

// Levenshtein distance, giving up once it is past max.
function editDistance(a, b, max) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// Two entries for one work (one saved under an edition id): keep the fuller of each field.
const RANK = { read: 3, reading: 2, want: 1, "": 0 };
function mergeEntries(a, b) {
  const pick = (x, y) => (x !== "" && x != null ? x : y);
  return { ...b, ...a, status: (RANK[a.status] ?? 0) >= (RANK[b.status] ?? 0) ? a.status : b.status, rating: Math.max(a.rating ?? -1, b.rating ?? -1) < 0 ? null : Math.max(a.rating ?? 0, b.rating ?? 0), year: pick(a.year, b.year), note: (a.note || "").length >= (b.note || "").length ? a.note || "" : b.note, copy: pick(a.copy, b.copy), order: Math.min(a.order ?? 1e9, b.order ?? 1e9) };
}

class Store {
  constructor(dataDir) {
    this.dir = dataDir;
    this.file = path.join(dataDir, "chytai.db");
    this.db = open(dataDir);
    this.seedBooks = readJson(path.join(SEED, "books.json"));
    this.importOld();
    this.load();
    this.loadShelves();
  }

  // ---- first start on the database: bring over the JSON files ----
  importOld() {
    const db = this.db;
    if (!db.get("library_imported")) {
      const file = path.join(this.dir, "library.json");
      let lib;
      try {
        lib = readJson(file);
      } catch {
        lib = this.seed();
      }
      db.tx(() => {
        for (const b of Object.values(lib.books || {})) db.prepare("INSERT OR REPLACE INTO books (id, data) VALUES (?, ?)").run(b.id, JSON.stringify(b));
        for (const [id, e] of Object.entries(lib.entries || {})) this.writeEntry(OWNER, id, e);
        for (const s of lib.subscriptions || []) db.prepare("INSERT OR IGNORE INTO subscriptions (reader, shelf) VALUES (?, ?)").run(OWNER, s);
        db.set("library_imported", new Date().toISOString());
      });
      if (fs.existsSync(file)) fs.renameSync(file, `${file}.migrated`);
    }
    // The shelves: the seed, or the newer copy a refresh wrote under dataDir before the database.
    const seedShelves = readJson(path.join(SEED, "shelves.json"));
    if (!db.get("baseline")) db.set("baseline", seedShelves.baseline || seedShelves.fetched);
    if (!db.get("shelves_imported")) {
      const file = path.join(this.dir, "shelves.json");
      let shelvesFile = seedShelves;
      try {
        const live = readJson(file);
        if (live.fetched >= seedShelves.fetched) shelvesFile = live;
      } catch {
        /* no refresh yet */
      }
      let seen = {};
      try {
        seen = readJson(path.join(this.dir, "catalog-seen.json"));
      } catch {
        /* every item counts as seen on the shelves' date */
      }
      this.saveShelves(shelvesFile.shelves, { fetched: shelvesFile.fetched, refreshedAt: shelvesFile.refreshedAt || "", seen });
      db.set("shelves_imported", new Date().toISOString());
      for (const f of ["shelves.json", "catalog-seen.json"]) if (fs.existsSync(path.join(this.dir, f))) fs.renameSync(path.join(this.dir, f), path.join(this.dir, `${f}.migrated`));
    }
  }

  get baseline() {
    return this.db.get("baseline");
  }

  // When each catalog item was first seen (for «нове»).
  seen() {
    return Object.fromEntries(this.db.prepare("SELECT id, first_seen FROM items").all().map((r) => [r.id, r.first_seen]));
  }

  // Write fresh shelves (the whole catalog of each source given; other shelves stay as they are).
  saveShelves(shelves, { fetched, refreshedAt = "", seen = {} }) {
    const db = this.db;
    const today = fetched || new Date().toISOString().slice(0, 10);
    db.tx(() => {
      for (const s of shelves) {
        const { items, ...meta } = s;
        db.prepare("INSERT INTO shelves (id, data, refreshed_at) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data, refreshed_at = excluded.refreshed_at").run(s.id, JSON.stringify(meta), refreshedAt);
        db.prepare("CREATE TEMP TABLE IF NOT EXISTS keep (id TEXT PRIMARY KEY)").run();
        db.prepare("DELETE FROM keep").run();
        const up = db.prepare("INSERT INTO items (id, shelf, data, first_seen, last_seen, ord) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET shelf = excluded.shelf, data = excluded.data, last_seen = excluded.last_seen, ord = excluded.ord");
        items.forEach((it, i) => {
          const { href, editions, volumes, ...data } = it; // derived on load
          up.run(it.id, s.id, JSON.stringify(data), seen[it.id] || today, today, i);
          db.prepare("INSERT OR IGNORE INTO keep (id) VALUES (?)").run(it.id);
        });
        db.prepare("DELETE FROM items WHERE shelf = ? AND id NOT IN (SELECT id FROM keep)").run(s.id);
      }
      db.set("fetched", today);
      if (refreshedAt) db.set("refreshed_at", refreshedAt);
    });
  }

  // Read the shelves back (at start and after every refresh) and rebuild everything derived.
  loadShelves() {
    const { SOURCES } = require("./catalogs");
    const order = SOURCES.map((s) => s.id);
    // A draft shelf is draft while its source says so (catalogs.js).
    const draft = new Set(SOURCES.filter((s) => s.draft).map((s) => s.id));
    const shelves = this.db
      .prepare("SELECT id, data FROM shelves")
      .all()
      .map((r) => ({ ...JSON.parse(r.data), draft: draft.has(r.id), items: [] }))
      .filter((s) => order.includes(s.id)) // a source that was removed (Standard Ebooks) leaves its rows behind, unseen
      .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    const byId = new Map(shelves.map((s) => [s.id, s]));
    // Names saved before a catalog's entities were decoded («Neurosurgeon&#x27;s Journey») are decoded here.
    const { ent } = require("./catalogs");
    for (const r of this.db.prepare("SELECT shelf, data FROM items ORDER BY shelf, ord").all()) {
      const it = JSON.parse(r.data);
      for (const k of ["title", "altTitle", "author", "series", "translator", "publisher"]) if (typeof it[k] === "string" && it[k].includes("&")) it[k] = ent(it[k]);
      byId.get(r.shelf)?.items.push(it);
    }
    this.shelves = shelves;
    this.shelvesFetched = this.db.get("fetched") || "";
    this.shelvesRefreshedAt = this.db.get("refreshed_at") || "";
    this.shelfItems = new Map(); // item id -> { shelf, item }
    for (const s of this.shelves) for (const it of s.items) this.shelfItems.set(it.id, { shelf: s, item: it });
    this.linkEditions();
    this.migrateEntries();
    this.indexSlugs();
    this.pickCovers();
    this.linkTranslations();
    this.indexSearch();
  }

  // A book and its translation are two works, linked: each page points at the other, and having read
  // one counts for the other (Max, 2026-10-19: «якщо читав одну то автоматично і другу теж»). Linked
  // when one's original title is the other's title, or by hand in matches.json «translations».
  linkTranslations() {
    this._titles = null; // titleIndex() and workIndex() are rebuilt with the new shelves
    this._works = null;
    this.translations = new Map(); // work id -> Set of work ids
    const link = (a, b) => {
      a = a && this.canonical(a);
      b = b && this.canonical(b);
      if (!a || !b || a === b) return;
      for (const [x, y] of [[a, b], [b, a]]) (this.translations.get(x) || this.translations.set(x, new Set()).get(x)).add(y);
    };
    const works = [...this.seedBooks, ...Object.values(this.lib.books), ...[...this.shelfItems.values()].filter(({ item }) => this.canonical(item.id) === item.id && !this.hidden.has(item.id)).map(({ item }) => item)];
    const byTitle = new Map();
    for (const w of works) if (norm(w.title).length >= 4) (byTitle.get(norm(w.title)) || byTitle.set(norm(w.title), []).get(norm(w.title))).push(w);
    for (const w of works) for (const o of byTitle.get(norm(w.altTitle)) || []) link(w.id, o.id); // the same work already shares one id
    // A foreign book's Ukrainian title from Wikidata (wikidata.js): a book of that title by the same author.
    this.ukTitles = JSON.parse(this.db.get("wikidata:uk") || "{}");
    const names = (a) => norm(a).split(" ").filter((w) => w.length >= 3);
    for (const [id, { uk, ukAuthor }] of Object.entries(this.ukTitles)) for (const o of byTitle.get(norm(uk)) || []) if (names(o.author).some((n) => names(ukAuthor).includes(n))) link(id, o.id);
    let pairs = [];
    try {
      pairs = readJson(path.join(SEED, "matches.json")).translations || [];
    } catch {
      /* none */
    }
    for (const [a, b] of pairs) link(this.slugs.get(a) || a, this.slugs.get(b) || b);
    this.authors = require("./authors").build(this);
  }

  // Titles of known books mentioned in a note become links (Max, 2026-10-19: «Див також Circe» ->
  // /book/tsyrtseia, whose original title is Circe). Library books by title or original title; catalog
  // books by original title, or by a title of two words or more and 12+ letters, so a common word
  // («Дім», «Free») never links. Case-sensitive, whole words; the book's own title and text already
  // inside a link are left alone.
  titleIndex() {
    if (this._titles) return this._titles;
    const map = new Map(); // title -> id, the library first
    const ok = (t, strict) => {
      t = String(t || "").trim();
      if (t.length < 4 || /^[\d\s.]+$/.test(t)) return false;
      const words = t.split(/\s+/).length;
      return strict ? words >= 2 && t.length >= 12 : words >= 2 || t.length >= 5;
    };
    const put = (t, id) => !map.has(t) && map.set(t, this.canonical(id));
    for (const b of [...this.seedBooks, ...Object.values(this.lib.books)]) for (const t of [b.title, b.altTitle]) if (ok(t)) put(t.trim(), b.id);
    for (const { shelf, item } of this.shelfItems.values()) {
      if (shelf.draft || this.hidden.has(item.id)) continue;
      if (ok(item.altTitle)) put(item.altTitle.trim(), item.id);
      if (ok(item.title, true)) put(item.title.trim(), item.id);
    }
    const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const titles = [...map.keys()].sort((a, b) => b.length - a.length);
    const re = titles.length ? new RegExp(`(?<![\\p{L}\\p{N}])(${titles.map(esc).join("|")})(?![\\p{L}\\p{N}])`, "gu") : null;
    return (this._titles = { map, re });
  }

  // Markdown with the titles it mentions linked to their pages.
  linkTitles(md, selfId) {
    const { map, re } = this.titleIndex();
    if (!md || !re) return md || "";
    const self = selfId && this.canonical(selfId);
    // Leave existing links and bare URLs as they are.
    return md
      .split(/(\[[^\]]*\]\([^)]*\)|https?:\/\/\S+)/)
      .map((part, i) => (i % 2 ? part : part.replace(re, (t) => (map.get(t) === self ? t : `[${t}](${this.href(map.get(t))})`))))
      .join("");
  }

  // The other-language versions of a work: [{ id, title, href }].
  translationsOf(id) {
    return [...(this.translations?.get(this.canonical(id)) || [])].map((t) => this.book(t)).filter(Boolean).map((b) => ({ id: b.id, title: b.title, author: b.author, href: this.href(b.id) }));
  }

  // The reader's entry for a work, or, failing that, for one of its translations ({ ...entry, via }).
  sharedEntry(reader, id) {
    const own = this.entry(reader, id);
    if (own) return own;
    for (const t of this.translations?.get(this.canonical(id)) || []) {
      const e = this.entriesOf(reader)[t];
      if (e) return { ...e, via: { id: t, title: this.book(t)?.title || t, href: this.href(t) } };
    }
    return null;
  }

  // Every reader who has the work (or a translation of it): [{ reader, entry }], fullest first.
  readersOf(id) {
    const out = [];
    for (const reader of this.entries.keys()) {
      const e = this.sharedEntry(reader, id);
      if (e) out.push({ reader, entry: e });
    }
    return out.sort((a, b) => (b.entry.note?.length || 0) - (a.entry.note?.length || 0) || (b.entry.rating ?? -1) - (a.entry.rating ?? -1));
  }

  // ---- canonical URLs ----
  // Every work has one address, /book/<slug>, built from its title (the Books.md ids already are
  // such slugs); an edition id or an old address redirects there. A slug, once given, is kept in the
  // database and stays with its work, so a new shelf never moves an existing book's address.
  indexSlugs() {
    this.slugs = new Map(); // slug -> id
    this.slugOf = new Map(); // id -> slug
    // Cyrillic slugs given before 2026-10-19 stay as old addresses that redirect to the Latin one.
    const latin = (slug) => /^[\x00-\x7f]*$/.test(slug);
    for (const r of this.db.prepare("SELECT slug, id FROM slugs").all()) {
      this.slugs.set(r.slug, r.id);
      if (!this.slugOf.has(r.id) || (latin(r.slug) && !latin(this.slugOf.get(r.id)))) this.slugOf.set(r.id, r.slug);
    }
    const add = this.db.prepare("INSERT OR IGNORE INTO slugs (slug, id) VALUES (?, ?)");
    this.db.exec("BEGIN");
    const take = (id, title, author) => {
      if (this.slugOf.has(id) && latin(this.slugOf.get(id))) return;
      let slug = slugify(title);
      const surname = (author || "").split(/[,\s]+/).filter(Boolean).pop();
      const last = surname ? slugify(surname) : ""; // slugify("") is "book": «tyhrolovy-book»
      if (this.slugs.has(slug) && this.slugs.get(slug) !== id && last) slug = `${slug}-${last}`;
      while (this.slugs.has(slug) && this.slugs.get(slug) !== id) slug += "-2";
      this.slugs.set(slug, id);
      this.slugOf.set(id, slug);
      add.run(slug, id);
    };
    for (const b of this.seedBooks) take(b.id, b.id, "");
    for (const b of Object.values(this.lib.books)) take(b.id, b.id, "");
    for (const { item } of this.shelfItems.values()) if (this.canonical(item.id) === item.id) take(item.id, item.title, item.author);
    this.db.exec("COMMIT");
    for (const { item } of this.shelfItems.values()) item.href = this.href(item.id);
  }

  // Covers picked by hand in matches.json «covers» (Max chose Основи's «Тигролови», 2026-10-20).
  pickCovers() {
    let covers = {};
    try {
      covers = readJson(path.join(SEED, "matches.json")).covers || {};
    } catch {
      /* none */
    }
    this.covers = new Map(Object.entries(covers).map(([k, url]) => [this.canonical(this.slugs.get(k) || k), url]));
  }

  href(id) {
    id = this.canonical(id);
    return `/book/${encodeURIComponent(this.slugOf.get(id) || id)}`;
  }

  // The id behind an address: a slug, an id, or an edition id.
  resolve(param) {
    const id = this.slugs.has(param) ? this.slugs.get(param) : param;
    return this.book(id) ? this.canonical(id) : null;
  }

  // ---- search ----
  // One index over everything: the library and every shelf, works only (editions and volumes fold
  // in as extra text). FTS5 with prefix matching ranks title over author over series; when that finds
  // nothing, a trigram index catches a word typed from its middle («кирпат» in «Кирпатого»).
  indexSearch() {
    const ids = new Set([...this.seedBooks.map((b) => b.id), ...Object.keys(this.lib.books), ...[...this.shelfItems.keys()].filter((id) => this.canonical(id) === id && !this.hidden.has(id))]);
    const db = this.db;
    db.tx(() => {
      db.exec("DELETE FROM search; DELETE FROM search_tri;");
      this.vocab = null; // the typo search reloads the word list
      const add = db.prepare("INSERT INTO search (id, title, alt, author, series, extra) VALUES (?, ?, ?, ?, ?, ?)");
      const tri = db.prepare("INSERT INTO search_tri (id, text) VALUES (?, ?)");
      for (const id of ids) {
        const b = this.book(id);
        if (!b) continue;
        const uk = this.ukTitles?.[id];
        const extra = [...(b.editions || []).map((e) => [e.title, e.altTitle, e.author, e.isbn].filter(Boolean).join(" ")), uk ? `${uk.uk} ${uk.ukAuthor}` : "", ...isbnsOf(b)].join(" ");
        add.run(id, b.title || "", b.altTitle || "", b.author || "", b.series?.name || "", extra);
        tri.run(id, [b.title, b.altTitle, b.author, b.series?.name, uk?.uk].filter(Boolean).join(" · "));
      }
    });
  }

  // A typo («лялки», «легйон»): each word the index does not know is replaced by the indexed words
  // one or two letters away from it, and the search runs again.
  fuzzy(terms, limit) {
    this.vocab ??= this.db.prepare("SELECT term FROM search_vocab").all().map((r) => r.term);
    const alts = terms.map((t) => {
      if (this.vocab.some((w) => w.startsWith(t))) return [t];
      const max = t.length >= 7 ? 2 : t.length >= 4 ? 1 : 0;
      return this.vocab.filter((w) => Math.abs(w.length - t.length) <= max && editDistance(t, w, max) <= max).slice(0, 8);
    });
    if (alts.some((a) => !a.length)) return [];
    const match = alts.map((a) => `(${a.map((w) => `"${w}"*`).join(" OR ")})`).join(" AND ");
    return this.db.prepare("SELECT id FROM search WHERE search MATCH ? ORDER BY bm25(search, 0, 10, 10, 5, 4, 1) LIMIT ?").all(match, limit * 2);
  }

  search(q, { reader = null, limit = 40 } = {}) {
    const terms = norm(q).split(" ").filter(Boolean);
    if (!terms.length) return [];
    let rows = this.db
      .prepare("SELECT id FROM search WHERE search MATCH ? ORDER BY bm25(search, 0, 10, 10, 5, 4, 1) LIMIT ?")
      .all(terms.map((t) => `"${t.replace(/"/g, "")}"*`).join(" "), limit * 2);
    if (!rows.length && terms.every((t) => t.length >= 3)) rows = this.db.prepare("SELECT id FROM search_tri WHERE search_tri MATCH ? ORDER BY rank LIMIT ?").all(terms.map((t) => `"${t}"`).join(" AND "), limit * 2);
    if (!rows.length) rows = this.fuzzy(terms, limit);
    const exact = norm(q);
    const hits = [];
    for (const [i, { id }] of rows.entries()) {
      const b = this.book(id);
      if (!b || isRussian(b)) continue;
      // An exact title (or original title) goes first, then books where every typed word is a whole
      // word of the title or the author («Лем» is Станіслав Лем, not «Моцарт із Лемберга»); otherwise
      // the index's own order.
      const words = new Set(norm([b.title, b.altTitle, b.author].join(" ")).split(" "));
      const whole = terms.every((t) => words.has(t));
      const score = (norm(b.title) === exact || norm(b.altTitle) === exact ? 1000 : 0) + (whole ? 500 : 0) - i;
      hits.push({ book: b, entry: reader ? this.entry(reader, id) : null, score });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
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
    // A shared ISBN counts only with the same title: publishers' sites reuse ISBNs by mistake.
    // (Основи gives a bundle the ISBN of one of its books, so a bundle never joins a single book this way.)
    const alike = (a, b) => !a.bundle === !b.bundle && (norm(a.title).startsWith(norm(b.title)) || norm(b.title).startsWith(norm(a.title)));
    // The title for that compares without a note on the edition in brackets: Старий Лев sells
    // «Тигролови (м'яка обкладинка)» and «Тигролови (в-во Віхола)» next to «Тигролови». A bracket with
    // a number or a volume word («(том 2)», «(1984)») stays, so volumes never fold into one book.
    const workTitle = (t) => norm(String(t || "").replace(/\s*\(([^()]*)\)/g, (m, inner) => (/\d|том|книга|частина|част\./i.test(inner) ? m : "")));
    const titled = new Map(); // work title -> Set of authors, for the items that have none
    for (const si of this.shelfItems.values()) {
      const it = si.item;
      const ik = `isbn:${isbnKey(it.isbn)}`;
      if (isbnKey(it.isbn).length >= 10 && (!groups.has(ik) || alike(groups.get(ik)[0].item, it))) join(ik, si);
      if (workTitle(it.title) && norm(it.author)) {
        join(`at:${norm(it.author)}|${workTitle(it.title)}`, si);
        (titled.get(workTitle(it.title)) || titled.set(workTitle(it.title), new Set()).get(workTitle(it.title))).add(norm(it.author));
      }
      if (!groupOf.has(it.id)) groupOf.set(it.id, [si]);
    }
    // A shop that gives no author (MEGOGO Books' Stone «Тигролови») joins the work of that title when
    // only one author has a book called so. Short titles («Дім») are too common to trust.
    for (const si of this.shelfItems.values()) {
      const it = si.item;
      const t = workTitle(it.title);
      if (norm(it.author) || t.length < 6 || titled.get(t)?.size !== 1) continue;
      join(`at:${[...titled.get(t)][0]}|${t}`, si);
    }
    // An audiobook's title often keeps the subtitle the print edition drops, or the other way round
    // («Атомні звички. Легкий і перевірений спосіб…»): with the same author, one title starting with the
    // other joins them, when the shorter one has at least two words (one word, «Дюна», is too little).
    const byAuthor = new Map(); // author -> print and e-book items
    for (const si of this.shelfItems.values()) {
      const a = norm(si.item.author);
      if (a && si.item.format !== "аудіо" && !si.item.bundle) (byAuthor.get(a) || byAuthor.set(a, []).get(a)).push(si);
    }
    for (const si of this.shelfItems.values()) {
      const it = si.item;
      if (it.format !== "аудіо" || groupOf.get(it.id).length > 1) continue;
      const short = (o) => (norm(o.title).length < norm(it.title).length ? norm(o.title) : norm(it.title));
      const other = (byAuthor.get(norm(it.author)) || []).find((o) => (o.item.volume || 0) === (it.volume || 0) && alike(o.item, it) && short(o.item).includes(" "));
      if (other) join(`at:${norm(other.item.author)}|${workTitle(other.item.title)}`, si);
    }

    // 2. A shelf item whose title (or original title) is exactly a library book's title is that book.
    // Failing that, the library book links to the item's own page, or has the same words in its main
    // title, in any order, by the same author («Я кров твою змішаю з вугіллям» is Старий Лев's
    // «Я змішаю твою кров із вугіллям: зрозуміти український Схід»).
    const byTitle = new Map();
    const byUrl = new Map();
    const byWords = new Map();
    const byIsbn = new Map(); // a library book's ISBN (a Goodreads import keeps it; Books.md links to Amazon by ISBN-10)
    const pageKey = (u) => String(u || "").replace(/^https?:\/\/(www\.)?/, "").replace(/[?#].*$/, "").replace(/\/+$/, "");
    const words = (t) => norm(String(t || "").split(/[:.(]/)[0]).split(" ").filter((w) => w.length >= 3).sort().join(" ");
    const names = (a) => norm(a).split(" ").filter((w) => w.length >= 3);
    // Books.md often adds the author to the title («Моя війна Залужний», «Genome, Matt Ridley»): the
    // title without the author's names at its end counts too.
    const bare = (t, author) => {
      const ws = norm(t).split(" ");
      const a = new Set(norm(author).split(" ").filter((w) => w.length >= 3));
      while (ws.length > 1 && a.has(ws[ws.length - 1])) ws.pop();
      return ws.join(" ");
    };
    for (const b of [...this.seedBooks, ...Object.values(this.lib.books).filter((b) => !this.seedBooks.some((s) => s.id === b.id))]) {
      const own = this.lib.books[b.id] || b; // an edited copy keeps its old title
      for (const t of [b.title, b.altTitle]) if (norm(t).length >= 6) byTitle.set(norm(t), b.id);
      for (const t of [own.title, b.title]) if (norm(bare(t, b.author)).length >= 6 && !byTitle.has(bare(t, b.author))) byTitle.set(bare(t, b.author), b.id);
      for (const l of b.links || []) if (pageKey(l.url).includes("/")) byUrl.set(pageKey(l.url), b.id);
      for (const i of isbnsOf(own)) byIsbn.set(i, b.id);
      for (const t of [b.title, b.altTitle]) if (words(t).includes(" ")) (byWords.get(words(t)) || byWords.set(words(t), []).get(words(t))).push(b);
    }
    const bookOf = (it) => {
      if (matches.same[it.id]) return matches.same[it.id];
      const ok = (id) => id && !no.has(`${it.id}|${id}`);
      if (isbnKey(it.isbn).length >= 10 && ok(byIsbn.get(isbnKey(it.isbn)))) return byIsbn.get(isbnKey(it.isbn));
      for (const t of [it.title, it.altTitle]) if (ok(byTitle.get(norm(t)))) return byTitle.get(norm(t));
      if (ok(byUrl.get(pageKey(it.url)))) return byUrl.get(pageKey(it.url));
      for (const t of [it.title, it.altTitle]) {
        const b = (byWords.get(words(t)) || []).find((b) => names(b.author).some((n) => names(it.author).includes(n)));
        if (b && ok(b.id)) return b.id;
      }
      return null;
    };

    const seen = new Set();
    for (const g of new Set(groupOf.values())) {
      const sorted = [...g].sort((a, b) => (a.item.edition ? 1 : 0) - (b.item.edition ? 1 : 0) || FMT(a.item.format) - FMT(b.item.format) || (PICK[a.item.status] ?? 9) - (PICK[b.item.status] ?? 9) || a.item.id.localeCompare(b.item.id, "en", { numeric: true }));
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
    const db = this.db;
    this.lib = { books: {} };
    this.entries = new Map(); // reader id -> { book id -> entry }
    this.subs = new Map(); // reader id -> [shelf id]
    for (const r of db.prepare("SELECT id, data FROM books").all()) this.lib.books[r.id] = JSON.parse(r.data);
    // Max (2026-10-19): «не дуже люблю Readeat», so its links (imported from Books.md) go.
    for (const b of Object.values(this.lib.books)) {
      const links = (b.links || []).filter((l) => !/readeat\.com/i.test(l.url));
      if (links.length !== (b.links || []).length) (b.links = links), this.writeBook(b.id);
    }
    for (const r of db.prepare("SELECT * FROM entries").all()) this.entriesOf(r.reader)[r.book] = { status: r.status, year: r.year, rating: r.rating, note: r.note, copy: r.copy, order: r.ord, ...(r.added ? { added: r.added } : {}), ...(r.updated ? { updated: r.updated } : {}) };
    for (const r of db.prepare("SELECT reader, shelf FROM subscriptions").all()) this.subscriptions(r.reader).push(r.shelf);
  }

  // A reader's entries (made on first touch) and subscriptions.
  entriesOf(reader) {
    if (!this.entries.has(reader)) this.entries.set(reader, {});
    return this.entries.get(reader);
  }
  subscriptions(reader) {
    if (!this.subs.has(reader)) this.subs.set(reader, []);
    return this.subs.get(reader);
  }
  // A reader who is gone (deleted account): their rows are already deleted by auth.js.
  forgetReader(reader) {
    this.entries.delete(reader);
    this.subs.delete(reader);
  }

  writeEntry(reader, id, e) {
    if (!e) return this.db.prepare("DELETE FROM entries WHERE reader = ? AND book = ?").run(reader, id);
    this.db
      .prepare("INSERT INTO entries (reader, book, status, rating, year, note, copy, ord, added, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (reader, book) DO UPDATE SET status = excluded.status, rating = excluded.rating, year = excluded.year, note = excluded.note, copy = excluded.copy, ord = excluded.ord, added = excluded.added, updated = excluded.updated")
      .run(reader, id, e.status || "", e.rating ?? null, e.year ?? null, e.note || "", e.copy || "", e.order ?? null, e.added || null, e.updated || null);
  }

  writeBook(id) {
    const b = this.lib.books[id];
    if (b) this.db.prepare("INSERT OR REPLACE INTO books (id, data) VALUES (?, ?)").run(id, JSON.stringify(b));
    else this.db.prepare("DELETE FROM books WHERE id = ?").run(id);
  }

  // Entries saved under an edition id (before editions were linked, or by a shelf that changed) move to the work.
  migrateEntries() {
    for (const [reader, entries] of this.entries) {
      for (const [id, e] of Object.entries(entries)) {
        const c = this.canonical(id);
        if (c === id) continue;
        const cur = entries[c];
        entries[c] = cur ? mergeEntries(cur, e) : e;
        delete entries[id];
        this.db.tx(() => (this.writeEntry(reader, c, entries[c]), this.writeEntry(reader, id, null)));
      }
    }
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
    if (this.covers?.has(id)) out.cover = this.covers.get(id);
    // A book a reader added by hand or imported has no cover; its catalog editions do («Сила інтровертів»).
    else if (!out.cover) out.cover = (out.editions || []).find((e) => e.cover)?.cover || "";
    out.href = this.slugs ? this.href(id) : `/book/${encodeURIComponent(id)}`;
    return out;
  }

  // book() plus its translations, for the book page (kept out of book() so the two don't recurse).
  bookPage(id) {
    const b = this.book(id);
    const translations = b && this.translationsOf(b.id);
    // The Ukrainian title from Wikidata is named only while no catalog has it: not as a translation, and
    // not as an edition either (MEGOGO Books gives «Марсіанин» the original title, so it joins The Martian).
    const uk = (b && this.ukTitles?.[b.id]?.uk) || "";
    const inCatalog = translations?.length || (b?.editions || []).some((e) => norm(e.title) === norm(uk) || /[а-яіїєґ]/i.test(e.title));
    return b && { ...b, translations, ukTitle: inCatalog ? "" : uk };
  }

  fromShelfItem(shelf, it) {
    return { id: it.id, title: it.title, author: it.author, altTitle: it.altTitle || "", cover: it.cover, tags: it.genres || [], links: [{ label: shelf.name, url: it.url }], source: shelf.id, shelf: shelf.id, blurb: require("./catalogs").ent(it.blurb || ""), price: it.price, status: it.status, expected: it.expected || "", language: it.language, edition: it.edition || "", isbn: it.isbn || "", volume: it.volume || 0, bundle: !!it.bundle, format: it.format || (shelf.kind === "free" ? "e-book" : shelf.kind === "audio" ? "аудіо" : "папір"), narrator: it.narrator || "", duration: it.duration || "", subscription: !!it.subscription };
  }

  addBook({ title, author, cover, links }) {
    let id = slugify(title);
    while (this.book(id)) id += "-2";
    this.lib.books[id] = { id, title: title.trim(), author: (author || "").trim(), cover: cover || "", tags: [], links: links || [], source: "manual" };
    this.writeBook(id);
    this._works = null;
    this.indexSlugs();
    this.indexSearch();
    return this.lib.books[id];
  }

  updateBook(id, patch) {
    const b = this.lib.books[id] || this.book(id);
    if (!b) return null;
    const copy = { ...b, ...patch, id };
    this.lib.books[id] = copy; // seed and shelf books become own copies once edited
    this.writeBook(id);
    return copy;
  }

  // ---- finding a work from the outside (the Goodreads import) ----
  // Every work by ISBN and by title: the library and the shelves, with original titles and the
  // Ukrainian titles Wikidata knows for foreign books.
  workIndex() {
    if (this._works) return this._works;
    const byIsbn = new Map();
    const byTitle = new Map(); // norm(title) -> [{ id, author }]
    const put = (t, id, author) => {
      const k = norm(t);
      if (k.length < 2) return;
      const list = byTitle.get(k) || byTitle.set(k, []).get(k);
      if (!list.some((w) => w.id === id)) list.push({ id, author: author || "" });
    };
    for (const b of [...this.seedBooks, ...Object.values(this.lib.books)]) {
      const id = this.canonical(b.id);
      const own = this.lib.books[b.id] || b;
      for (const i of isbnsOf(own)) byIsbn.set(i, id);
      for (const t of [own.title, own.altTitle, b.title, b.altTitle]) put(t, id, own.author || b.author);
    }
    for (const { item } of this.shelfItems.values()) {
      const id = this.canonical(item.id);
      if (isbnKey(item.isbn).length >= 10 && !byIsbn.has(isbnKey(item.isbn))) byIsbn.set(isbnKey(item.isbn), id);
      for (const t of [item.title, item.altTitle]) put(t, id, item.author);
    }
    for (const [id, { uk, ukAuthor }] of Object.entries(this.ukTitles || {})) if (this.book(id)) put(uk, this.canonical(id), ukAuthor);
    return (this._works = { byIsbn, byTitle });
  }

  // The work for a book named from outside ({ title, author, isbns }), or null. An ISBN is enough on
  // its own; a title needs the same author (a surname in common, in either alphabet, a typo allowed),
  // unless only one work has that title and the title is not a single short word.
  findWork({ title, author = "", isbns = [] }) {
    const { byIsbn, byTitle } = this.workIndex();
    for (const i of isbns) if (byIsbn.has(isbnKey(i))) return byIsbn.get(isbnKey(i));
    const names = (a) =>
      norm(a)
        .split(" ")
        .filter((w) => w.length >= 3)
        .map((w) => (/[а-яіїєґ]/.test(w) ? translit(w).replace(/[^a-z]/g, "") : w.normalize("NFKD").replace(/\p{M}/gu, "")));
    const mine = names(author);
    const sameAuthor = (a) => {
      const theirs = names(a);
      return mine.some((m) => theirs.some((t) => m === t || (m.length >= 4 && t.length >= 4 && editDistance(m, t, 2) <= 2)));
    };
    // The title as given, then without a subtitle after a colon («Sapiens: A Brief History of Humankind»).
    const variants = [...new Set([norm(title), norm(String(title).split(/[:(]/)[0]), norm(String(title).split(/\.\s/)[0])].filter((t) => t.length >= 2))];
    for (const t of variants) {
      const found = byTitle.get(t) || [];
      const byAuthor = found.filter((w) => sameAuthor(w.author));
      if (byAuthor.length) return byAuthor[0].id;
      if (found.length === 1 && t === norm(title) && (t.includes(" ") || t.length >= 8) && (!norm(author) || !names(found[0].author).length)) return found[0].id;
    }
    return null;
  }

  // Put rows of an import on a reader's shelf: each row is an entry with either the id of a work it
  // matched or the book to make ({ title, author, isbns, goodreadsId }). A book the reader already has
  // keeps what it had and takes only what was missing. Rows come in the order they should sit in.
  importEntries(reader, rows, { source = "goodreads" } = {}) {
    const entries = this.entriesOf(reader);
    let order = Object.values(entries).reduce((m, e) => Math.max(m, e.order ?? -1), -1) + 1;
    const now = new Date().toISOString();
    const result = { added: 0, updated: 0, created: [] };
    this.db.tx(() => {
      for (const r of rows) {
        let id = r.id && this.book(r.id) ? this.canonical(r.id) : null;
        if (!id) {
          id = slugify(r.title);
          while (this.book(id)) id += "-2";
          this.lib.books[id] = { id, title: r.title.trim(), author: (r.author || "").trim(), cover: "", tags: [], links: [], source, ...(r.isbns?.length ? { isbns: r.isbns } : {}), ...(r.goodreadsId ? { goodreads: r.goodreadsId } : {}), ...(r.appleId ? { apple: r.appleId } : {}) };
          this.writeBook(id);
          result.created.push(this.lib.books[id]);
        }
        // An import is history, not news: the entry is dated when the book was read (or added) on Goodreads,
        // so a hundred old books don't fill the feed as «сьогодні» (Max, 2026-10-20). An entry the reader
        // already had keeps its own date.
        const imported = { status: r.status || "", year: r.year ?? null, rating: r.rating ?? null, note: r.note || "", copy: r.copy || "", order: order++, added: r.added || now.slice(0, 10), updated: r.read || r.touched || r.added || now };
        const cur = entries[id];
        entries[id] = cur ? { ...mergeEntries(cur, imported), updated: cur.updated || cur.added || imported.updated } : imported;
        this.writeEntry(reader, id, entries[id]);
        cur ? result.updated++ : result.added++;
      }
    });
    if (result.created.length) {
      this._works = null;
      this.indexSlugs();
      this.indexSearch();
    }
    return result;
  }

  // ---- library entries ----

  entry(reader, id) {
    return (reader && this.entriesOf(reader)[this.canonical(id)]) || null;
  }

  // The reader's library membership by any id, edition ids included (for the shelf cards).
  inLibrary(reader) {
    if (!reader) return new Map();
    const entries = this.entriesOf(reader);
    const m = new Map(Object.entries(entries));
    for (const [w, ts] of this.translations || []) if (!m.has(w)) for (const t of ts) if (entries[t]) m.set(w, entries[t]);
    for (const [alias, c] of this.aliases) if (m.has(c)) m.set(alias, m.get(c));
    return m;
  }

  setEntry(reader, id, patch) {
    id = this.canonical(id);
    if (!this.book(id)) return null;
    const entries = this.entriesOf(reader);
    const cur = entries[id] || { status: "", year: null, rating: null, note: "", copy: "", order: Object.keys(entries).length, added: new Date().toISOString().slice(0, 10) };
    const next = { ...cur, ...patch, updated: new Date().toISOString() };
    if (next.status === "read" && !next.year && cur.status !== "read") next.year = new Date().getFullYear();
    if (next.rating === "" || next.rating === undefined) next.rating = cur.rating ?? null;
    entries[id] = next;
    this.writeEntry(reader, id, next);
    return next;
  }

  removeEntry(reader, id) {
    id = this.canonical(id);
    delete this.entriesOf(reader)[id];
    this.writeEntry(reader, id, null);
    // A book someone typed in by hand goes with the last entry that had it.
    if (this.lib.books[id]?.source === "manual" && ![...this.entries.values()].some((e) => e[id])) {
      delete this.lib.books[id];
      this.writeBook(id);
    }
  }

  // Every library row of the reader with its book, in the reader's order (Books.md order for the import).
  library(reader) {
    return Object.entries(reader ? this.entriesOf(reader) : {})
      .map(([id, e]) => ({ id, ...e, book: this.book(id) }))
      .filter((r) => r.book)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  // ---- shelves and subscriptions ----

  shelf(id) {
    return this.shelves.find((s) => s.id === id) || null;
  }

  subscribed(reader, id) {
    return !!reader && this.subscriptions(reader).includes(id);
  }

  toggleSubscription(reader, id) {
    if (!this.shelf(id)) return null;
    const on = !this.subscribed(reader, id);
    this.subs.set(reader, on ? [...this.subscriptions(reader), id] : this.subscriptions(reader).filter((s) => s !== id));
    this.db.prepare(on ? "INSERT OR IGNORE INTO subscriptions (reader, shelf) VALUES (?, ?)" : "DELETE FROM subscriptions WHERE reader = ? AND shelf = ?").run(reader, id);
    return on;
  }
}

module.exports = { isRussian, Store, slugify, OWNER };

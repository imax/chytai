// «Списки» (Max, 2026-10-23: «плейлісти, списки а-ля Spotify, коли рідери можуть створювати власні списки і шарити
// їх на паблік»): a reader's own public list of books, in their order, with a short word on top and a line on each
// book («чому вона тут»). Lists hold links to our books, never files. Others save a list («Зберегти список»): it
// shows on their page, and the books added to it later come in their Friday letter. Design: 2026-10-23,
// /mnt/project-files/chytai-lists/. Not in the main menu (Max, 2026-10-23: «в головне меню поки не додавай»).
//
// Addresses: /@<username>/list/<slug>; the slug is made once from the first title and stays when the title
// changes, so a shared link keeps working. Books are kept by their work id (store.canonical).
const crypto = require("crypto");
const { slugify, isRussian } = require("./store");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lists (
  id TEXT PRIMARY KEY, reader TEXT NOT NULL, slug TEXT NOT NULL, title TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL, updated TEXT NOT NULL, UNIQUE (reader, slug)
);
CREATE TABLE IF NOT EXISTS list_items (
  list TEXT NOT NULL, book TEXT NOT NULL, ord INTEGER NOT NULL, why TEXT NOT NULL DEFAULT '', added TEXT NOT NULL,
  PRIMARY KEY (list, book)
);
CREATE INDEX IF NOT EXISTS list_items_book ON list_items (book);
CREATE TABLE IF NOT EXISTS list_saves (reader TEXT NOT NULL, list TEXT NOT NULL, created TEXT NOT NULL, PRIMARY KEY (reader, list));
CREATE INDEX IF NOT EXISTS list_saves_list ON list_saves (list);
CREATE TABLE IF NOT EXISTS list_comments (
  id TEXT PRIMARY KEY, list TEXT NOT NULL, reader TEXT NOT NULL, text TEXT NOT NULL, created TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS list_comments_list ON list_comments (list, created);
CREATE TABLE IF NOT EXISTS list_skips (list TEXT NOT NULL, book TEXT NOT NULL, PRIMARY KEY (list, book));
CREATE TABLE IF NOT EXISTS fav_no (reader TEXT PRIMARY KEY, at TEXT NOT NULL);
`;
const TITLE_MAX = 100;
// A list can be a small article (Max, 2026-10-27: «списки в контексті editorial … header image, якийсь опис»):
// a picture on top and an intro of a few paragraphs.
const NOTE_MAX = 4000;
const WHY_MAX = 300;
const SECTION_MAX = 100;
const ITEMS_MAX = 300;
// «Клуб Chytai» (Max, 2026-10-27): readers' words under a list, signed-in readers only, no likes and no
// replies; the list's author sees the new ones in the Friday letter.
const COMMENT_MAX = 2000;
const COMMENTS_A_DAY = 20;
// «Добірка Chytai»: the owner's list in the site's name («Редакція Chytai» instead of his own).
const EDITORIAL = "Редакція Chytai";
// A draft (Max, 2026-10-28: «мій до публікації не готовий ще») is its author's alone: others get a 404 on its
// page, and it stays off /lists, the reader's page, «У списках», «Схожі списки», the homepage and the sitemap.

// «Мої фаворити» (Max, 2026-11-13: «пропонувати створювати список … куди додавати автоматом книжки з такими високими
// оцінками»): a reader with FAV_OFFER books rated FAV_MIN or more is offered, on their own shelf, a list of them. Only
// when they press «Зібрати» is it made, as a draft like any new list; they publish it themselves. From then on a book
// they rate FAV_MIN+ comes into it by itself (`auto` rows), one per series; one rated lower again leaves, unless the
// reader wrote a line or a section on it. A book the reader took out by hand stays out (list_skips). The switch in
// «Назва й опис» stops the filling (`fav` 2); «Не треба» or deleting the list stops the offer (fav_no).
const FAV_TITLE = "Мої фаворити";
const FAV_MIN = 4.5;
const FAV_OFFER = 3;

class Lists {
  // `who(readerId)` is the public reader ({ name, username, href }) or null.
  constructor(store, who) {
    this.store = store;
    this.db = store.db;
    this.who = who;
    this.db.exec(SCHEMA);
    for (const [col, def] of [["image", "TEXT NOT NULL DEFAULT ''"], ["editorial", "INTEGER NOT NULL DEFAULT 0"], ["source", "TEXT NOT NULL DEFAULT ''"], ["draft", "INTEGER NOT NULL DEFAULT 0"], ["home", "TEXT NOT NULL DEFAULT ''"]])
      if (!this.db.prepare("PRAGMA table_info(lists)").all().some((c) => c.name === col)) this.db.exec(`ALTER TABLE lists ADD COLUMN ${col} ${def}`);
    // A section heading over a book and the books after it (Max, 2026-11-09: «секції, щоб довгий список побити на розділи»).
    for (const [col, def] of [["section", "TEXT NOT NULL DEFAULT ''"], ["section_note", "TEXT NOT NULL DEFAULT ''"]])
      if (!this.db.prepare("PRAGMA table_info(list_items)").all().some((c) => c.name === col)) this.db.exec(`ALTER TABLE list_items ADD COLUMN ${col} ${def}`);
    if (!this.db.prepare("PRAGMA table_info(list_comments)").all().some((c) => c.name === "edited")) this.db.exec("ALTER TABLE list_comments ADD COLUMN edited TEXT NOT NULL DEFAULT ''");
    if (!this.db.prepare("PRAGMA table_info(lists)").all().some((c) => c.name === "fav")) this.db.exec("ALTER TABLE lists ADD COLUMN fav INTEGER NOT NULL DEFAULT 0");
    if (!this.db.prepare("PRAGMA table_info(list_items)").all().some((c) => c.name === "auto")) this.db.exec("ALTER TABLE list_items ADD COLUMN auto INTEGER NOT NULL DEFAULT 0");
    // A changed shelf brings the reader's «Мої фаворити» up to date once the change is done (an import is one pass).
    this.favQueue = new Set();
    (store.entryHooks ||= []).push((reader) => {
      if (!this.favQueue.size) setImmediate(() => { const q = [...this.favQueue]; this.favQueue.clear(); for (const r of q) this.syncFav(r); });
      this.favQueue.add(reader);
    });
  }

  // ---- «Мої фаворити» ----
  // The reader's books for it, best rated first (then the latest): one per series, its first such volume.
  favBooks(readerId) {
    const rows = [];
    for (const [book, e] of Object.entries(this.store.entriesOf(readerId) || {})) {
      if (!(e.rating >= FAV_MIN) || e.kids || e.status === "abandoned") continue;
      const id = this.store.canonical(book);
      const b = this.store.book(id);
      if (b && !isRussian(b)) rows.push({ id, rating: e.rating, at: e.updated || e.added || "", s: this.store.seriesOf(id) });
    }
    rows.sort((a, b) => b.rating - a.rating || (b.at > a.at ? 1 : b.at < a.at ? -1 : 0));
    const first = new Map();
    for (const r of rows) if (r.s && (!first.has(r.s.key) || r.s.n < first.get(r.s.key).s.n)) first.set(r.s.key, r);
    const seen = new Set();
    return rows.filter((r) => (!r.s || first.get(r.s.key) === r) && !seen.has(r.id) && seen.add(r.id)).map((r) => r.id);
  }
  favOf(readerId) {
    return this.view(this.db.prepare("SELECT * FROM lists WHERE reader = ? AND fav > 0").get(readerId));
  }
  // How many books the offer would take, or 0 when there is nothing to offer.
  favOffer(readerId) {
    if (!readerId || this.db.prepare("SELECT 1 FROM lists WHERE reader = ? AND fav > 0").get(readerId) || this.db.prepare("SELECT 1 FROM fav_no WHERE reader = ?").get(readerId)) return 0;
    const n = this.favBooks(readerId).length;
    return n >= FAV_OFFER ? n : 0;
  }
  favNo(readerId) {
    this.db.prepare("INSERT OR IGNORE INTO fav_no (reader, at) VALUES (?, ?)").run(readerId, new Date().toISOString());
  }
  makeFav(readerId) {
    const had = this.favOf(readerId);
    if (had) return had;
    const l = this.create(readerId, { title: FAV_TITLE, draft: true });
    this.db.prepare("UPDATE lists SET fav = 1 WHERE id = ?").run(l.id);
    this.syncFav(readerId);
    return this.get(l.id);
  }
  // Bring the list in line with the shelf; true when something changed.
  syncFav(readerId) {
    const l = this.db.prepare("SELECT id FROM lists WHERE reader = ? AND fav = 1").get(readerId);
    if (!l) return false;
    const want = this.favBooks(readerId);
    const wanted = new Set(want);
    const rows = this.db.prepare("SELECT book, auto, why, section FROM list_items WHERE list = ?").all(l.id);
    const has = new Set(rows.map((r) => this.store.canonical(r.book)));
    const series = new Set([...has].map((id) => this.store.seriesOf(id)?.key).filter(Boolean));
    const skip = new Set(this.db.prepare("SELECT book FROM list_skips WHERE list = ?").all(l.id).map((r) => this.store.canonical(r.book)));
    let changed = false;
    for (const r of rows)
      if (r.auto && !r.why && !r.section && !wanted.has(this.store.canonical(r.book))) {
        this.db.prepare("DELETE FROM list_items WHERE list = ? AND book = ?").run(l.id, r.book);
        changed = true;
      }
    for (const id of want) {
      const s = this.store.seriesOf(id)?.key;
      if (has.has(id) || skip.has(id) || (s && series.has(s))) continue;
      if (!this.add(l.id, id)) break; // full
      this.db.prepare("UPDATE list_items SET auto = 1 WHERE list = ? AND book = ?").run(l.id, id);
      if (s) series.add(s);
      changed = true;
    }
    if (changed) this.touch(l.id);
    return changed;
  }

  // A list as the pages see it: its author, address and how many books and saves it has.
  view(row) {
    if (!row) return null;
    const reader = this.who(row.reader);
    if (!reader) return null;
    const n = this.db.prepare("SELECT COUNT(*) AS n FROM list_items WHERE list = ?").get(row.id).n;
    const saves = this.db.prepare("SELECT COUNT(*) AS n FROM list_saves WHERE list = ?").get(row.id).n;
    return { ...row, editorial: !!row.editorial, draft: !!row.draft, by: row.editorial ? EDITORIAL : reader.name, reader, href: `${reader.href}/list/${row.slug}`, count: n, saves };
  }
  get(id) {
    return this.view(this.db.prepare("SELECT * FROM lists WHERE id = ?").get(String(id)));
  }
  bySlug(readerId, slug) {
    return this.view(this.db.prepare("SELECT * FROM lists WHERE reader = ? AND slug = ?").get(readerId, String(slug)));
  }
  // A reader's lists, the last changed first.
  of(readerId) {
    return this.db.prepare("SELECT * FROM lists WHERE reader = ? ORDER BY updated DESC").all(readerId).map((r) => this.view(r)).filter(Boolean);
  }

  // A reader's new list starts as a draft (Max, 2026-10-28: «Статус чернетка по дефолту, кнопка Опублікувати»);
  // the site's own (seeded) lists don't ask for `draft`.
  create(readerId, { title, note = "", draft = false }) {
    title = String(title || "").replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);
    if (!title) return null;
    const base = slugify(title).slice(0, 60).replace(/-+$/, "") || "spysok";
    let slug = base;
    for (let i = 2; this.db.prepare("SELECT 1 FROM lists WHERE reader = ? AND slug = ?").get(readerId, slug); i++) slug = `${base}-${i}`;
    const id = crypto.randomBytes(6).toString("hex");
    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO lists (id, reader, slug, title, note, created, updated, draft) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, readerId, slug, title, String(note).trim().slice(0, NOTE_MAX), now, now, draft ? 1 : 0);
    return this.get(id);
  }
  // `editorial` is the owner's to set (server.js); undefined leaves it (and `draft`) as it is.
  // `source`: where the list comes from, an address shown under the intro (Max, 2026-10-28: the Diia vote's page).
  edit(id, { title, note, editorial, source, draft, fav }) {
    const l = this.get(id);
    if (!l) return null;
    const t = String(title ?? l.title).replace(/\s+/g, " ").trim().slice(0, TITLE_MAX) || l.title;
    const ed = editorial === undefined ? l.editorial : !!editorial;
    const dr = draft === undefined ? l.draft : !!draft;
    const src = source === undefined ? l.source : /^https?:\/\/[^\s"<>]+$/.test(String(source).trim()) ? String(source).trim().slice(0, 500) : "";
    this.db.prepare("UPDATE lists SET title = ?, note = ?, editorial = ?, source = ?, draft = ?, updated = ? WHERE id = ?").run(t, String(note ?? l.note).replace(/\r/g, "").trim().slice(0, NOTE_MAX), ed ? 1 : 0, src, dr ? 1 : 0, new Date().toISOString(), id);
    // «Мої фаворити» filling itself (1) or not any more (2).
    if (l.fav && fav !== undefined && (fav ? 1 : 2) !== l.fav) {
      this.db.prepare("UPDATE lists SET fav = ? WHERE id = ?").run(fav ? 1 : 2, id);
      if (fav) this.syncFav(l.reader.id);
    }
    return this.get(id);
  }
  // The picture on top: our own /covers/<name>, or "" for the one made of the list's covers.
  setImage(id, url) {
    this.db.prepare("UPDATE lists SET image = ? WHERE id = ?").run(/^\/covers\/[\w.-]+$/.test(url || "") ? url : "", id);
  }
  // The owner's editorial lists with books, the newest first.
  editorials() {
    return this.db.prepare("SELECT * FROM lists WHERE editorial = 1 AND draft = 0 ORDER BY created DESC").all().map((r) => this.view(r)).filter((l) => l && l.count);
  }
  // A reader's list the owner puts on the homepage, under its author's name (Max, 2026-11-07: @daryna's
  // «Сучасна фантастика»). `home` is when it was put there; "" is not there.
  setHome(id, on) {
    this.db.prepare("UPDATE lists SET home = ? WHERE id = ?").run(on ? new Date().toISOString() : "", id);
  }
  // «Добірки Chytai» on the homepage: editorial lists and readers' lists put there, the newest (or newest put) first.
  homeLists() {
    return this.db.prepare("SELECT * FROM lists WHERE (editorial = 1 OR home != '') AND draft = 0 ORDER BY max(created, home) DESC").all().map((r) => this.view(r)).filter((l) => l && l.count);
  }

  // ---- «Клуб Chytai» ----
  comments(listId) {
    return this.db.prepare("SELECT * FROM list_comments WHERE list = ? ORDER BY created").all(listId).map((c) => ({ ...c, reader: this.who(c.reader) })).filter((c) => c.reader);
  }
  comment(id) {
    return this.db.prepare("SELECT * FROM list_comments WHERE id = ?").get(String(id)) || null;
  }
  // null when there is nothing to say or the reader has said enough today.
  addComment(listId, readerId, text) {
    text = String(text || "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, COMMENT_MAX);
    if (!text || !this.get(listId)) return null;
    const day = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    if (this.db.prepare("SELECT COUNT(*) AS n FROM list_comments WHERE reader = ? AND created > ?").get(readerId, day).n >= COMMENTS_A_DAY) return null;
    const id = crypto.randomBytes(6).toString("hex");
    this.db.prepare("INSERT INTO list_comments (id, list, reader, text, created) VALUES (?, ?, ?, ?, ?)").run(id, listId, readerId, text, new Date().toISOString());
    return id;
  }
  // The author's new words; false when there are none.
  editComment(id, text) {
    const c = this.comment(id);
    text = String(text || "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, COMMENT_MAX);
    if (!c || !text) return false;
    if (text !== c.text) this.db.prepare("UPDATE list_comments SET text = ?, edited = ? WHERE id = ?").run(text, new Date().toISOString(), c.id);
    return true;
  }
  dropComment(id) {
    this.db.prepare("DELETE FROM list_comments WHERE id = ?").run(String(id));
  }
  // /admin/comments: the newest everywhere.
  recentComments(limit = 200) {
    return this.db.prepare("SELECT * FROM list_comments ORDER BY created DESC LIMIT ?").all(limit).map((c) => ({ ...c, reader: this.who(c.reader), list: this.get(c.list) })).filter((c) => c.list);
  }
  // For the Friday letter: others' words under the reader's own lists since `sinceIso`, [{ list, reader, text }].
  newComments(readerId, sinceIso) {
    return this.db
      .prepare("SELECT c.* FROM list_comments c JOIN lists l ON l.id = c.list WHERE l.reader = ? AND c.reader != ? AND c.created > ? ORDER BY c.created DESC")
      .all(readerId, readerId, sinceIso)
      .map((c) => ({ ...c, reader: this.who(c.reader), list: this.get(c.list) }))
      .filter((c) => c.reader && c.list);
  }
  remove(id) {
    const l = this.db.prepare("SELECT reader, fav FROM lists WHERE id = ?").get(id);
    if (l?.fav) this.favNo(l.reader); // a deleted «Мої фаворити» is not offered again
    this.db.tx(() => {
      for (const [t, c] of [["list_items", "list"], ["list_saves", "list"], ["list_comments", "list"], ["list_skips", "list"], ["lists", "id"]]) this.db.prepare(`DELETE FROM ${t} WHERE ${c} = ?`).run(id);
    });
  }
  // Everything of a reader's goes with the account: their lists and the lists they saved.
  forgetReader(readerId) {
    for (const l of this.db.prepare("SELECT id FROM lists WHERE reader = ?").all(readerId)) this.remove(l.id);
    this.db.prepare("DELETE FROM list_saves WHERE reader = ?").run(readerId);
    this.db.prepare("DELETE FROM list_comments WHERE reader = ?").run(readerId);
    this.db.prepare("DELETE FROM fav_no WHERE reader = ?").run(readerId);
  }

  // The books of a list in its order: [{ id, book, why, added }]. Books we no longer know are left out,
  // and so are books in Russian unless it is the author looking (store.isRussian: never shown to others).
  items(listId, { own = false } = {}) {
    const out = [];
    const seen = new Set();
    for (const r of this.db.prepare("SELECT book, why, added, section, section_note, auto FROM list_items WHERE list = ? ORDER BY ord, added").all(listId)) {
      const id = this.store.canonical(r.book);
      const book = this.store.book(id);
      if (!book || seen.has(id) || (!own && isRussian(book))) continue;
      seen.add(id);
      out.push({ id, book, why: r.why, added: r.added, section: r.section, sectionNote: r.section_note, auto: !!r.auto });
    }
    return out;
  }
  ids(listId) {
    return new Set(this.db.prepare("SELECT book FROM list_items WHERE list = ?").all(listId).map((r) => this.store.canonical(r.book)));
  }
  has(listId, bookId) {
    return this.ids(listId).has(this.store.canonical(bookId));
  }
  touch(listId) {
    this.db.prepare("UPDATE lists SET updated = ? WHERE id = ?").run(new Date().toISOString(), listId);
  }
  // A new book goes to the end of the list.
  add(listId, bookId, why = "") {
    const id = this.store.canonical(bookId);
    if (!this.store.book(id) || this.has(listId, id)) return false;
    if (this.db.prepare("SELECT COUNT(*) AS n FROM list_items WHERE list = ?").get(listId).n >= ITEMS_MAX) return false;
    const ord = (this.db.prepare("SELECT MAX(ord) AS m FROM list_items WHERE list = ?").get(listId).m ?? -1) + 1;
    this.db.prepare("INSERT INTO list_items (list, book, ord, why, added) VALUES (?, ?, ?, ?, ?)").run(listId, id, ord, String(why).trim().slice(0, WHY_MAX), new Date().toISOString());
    this.db.prepare("DELETE FROM list_skips WHERE list = ? AND book = ?").run(listId, id);
    this.touch(listId);
    return true;
  }
  // The rows a book may be stored under (a work merged since keeps its old id there).
  rowsOf(listId, bookId) {
    const id = this.store.canonical(bookId);
    return this.db.prepare("SELECT book FROM list_items WHERE list = ?").all(listId).filter((r) => this.store.canonical(r.book) === id).map((r) => r.book);
  }
  // By the author's hand: «Мої фаворити» doesn't bring it back.
  drop(listId, bookId) {
    for (const b of this.rowsOf(listId, bookId)) this.db.prepare("DELETE FROM list_items WHERE list = ? AND book = ?").run(listId, b);
    if (this.db.prepare("SELECT 1 FROM lists WHERE id = ? AND fav > 0").get(listId)) this.db.prepare("INSERT OR IGNORE INTO list_skips (list, book) VALUES (?, ?)").run(listId, this.store.canonical(bookId));
    this.touch(listId);
  }
  setWhy(listId, bookId, why) {
    for (const b of this.rowsOf(listId, bookId)) this.db.prepare("UPDATE list_items SET why = ? WHERE list = ? AND book = ?").run(String(why || "").trim().slice(0, WHY_MAX), listId, b);
    this.touch(listId);
  }
  // A section starts at this book (an empty title takes it away); it moves with the book.
  setSection(listId, bookId, title, note = "") {
    title = String(title || "").replace(/\s+/g, " ").trim().slice(0, SECTION_MAX);
    note = title ? String(note || "").trim().slice(0, WHY_MAX) : "";
    for (const b of this.rowsOf(listId, bookId)) this.db.prepare("UPDATE list_items SET section = ?, section_note = ? WHERE list = ? AND book = ?").run(title, note, listId, b);
    this.touch(listId);
  }
  // One place up (-1) or down (+1).
  move(listId, bookId, dir) {
    const rows = this.db.prepare("SELECT book FROM list_items WHERE list = ? ORDER BY ord, added").all(listId).map((r) => r.book);
    const id = this.store.canonical(bookId);
    const i = rows.findIndex((b) => this.store.canonical(b) === id);
    const j = i + (dir < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= rows.length) return;
    [rows[i], rows[j]] = [rows[j], rows[i]];
    this.db.tx(() => rows.forEach((b, k) => this.db.prepare("UPDATE list_items SET ord = ? WHERE list = ? AND book = ?").run(k, listId, b)));
  }

  // «Зберегти список» / «✓ Збережено»; true when saved now. One's own list is not saved.
  toggleSave(readerId, listId) {
    const l = this.get(listId);
    if (!l || l.reader.id === readerId || l.draft) return null;
    if (this.saved(readerId, listId)) {
      this.db.prepare("DELETE FROM list_saves WHERE reader = ? AND list = ?").run(readerId, listId);
      return false;
    }
    this.db.prepare("INSERT INTO list_saves (reader, list, created) VALUES (?, ?, ?)").run(readerId, listId, new Date().toISOString());
    return true;
  }
  saved(readerId, listId) {
    return !!readerId && !!this.db.prepare("SELECT 1 FROM list_saves WHERE reader = ? AND list = ?").get(readerId, listId);
  }
  savedBy(readerId) {
    return this.db.prepare("SELECT l.* FROM list_saves s JOIN lists l ON l.id = s.list WHERE s.reader = ? AND l.draft = 0 ORDER BY s.created DESC").all(readerId).map((r) => this.view(r)).filter(Boolean);
  }

  // A few covers for a list's card: its first books.
  covers(listId, n = 4) {
    return fanBooks(this.items(listId), n);
  }
  // Every published list with books in it (others see no empty ones or drafts): `popular` by saves, `new` by when made.
  all({ sort = "popular" } = {}) {
    const rows = this.db.prepare("SELECT * FROM lists WHERE draft = 0").all().map((r) => this.view(r)).filter((l) => l && l.count);
    return sort === "new" ? rows.sort((a, b) => (b.created > a.created ? 1 : -1)) : rows.sort((a, b) => b.saves - a.saves || b.count - a.count || (b.updated > a.updated ? 1 : -1));
  }
  // The lists a book is in («У списках» on its page), the most saved first.
  withBook(bookId) {
    const id = this.store.canonical(bookId);
    const ids = new Set([id, ...(this.store.editions?.get(id) || []).map((e) => e.item.id)]);
    const lists = new Set();
    for (const r of this.db.prepare("SELECT list, book FROM list_items").all()) if (ids.has(r.book) || this.store.canonical(r.book) === id) lists.add(r.list);
    return [...lists].map((l) => this.get(l)).filter((l) => l && !l.draft).sort((a, b) => b.saves - a.saves || b.count - a.count);
  }
  // «Схожі списки»: other readers' lists sharing the most books with this one.
  similar(list, limit = 3) {
    const mine = this.ids(list.id);
    return this.all()
      .filter((l) => l.id !== list.id && l.reader.id !== list.reader.id)
      .map((l) => ({ l, n: [...this.ids(l.id)].filter((id) => mine.has(id)).length }))
      .filter((x) => x.n)
      .sort((a, b) => b.n - a.n || b.l.saves - a.l.saves)
      .slice(0, limit)
      .map((x) => x.l);
  }
  // For the Friday letter: books added since `sinceIso` to the lists the reader saved, [{ list, id, book, why }].
  // Only what came after they saved it: the books it had then they have seen.
  newInSaved(readerId, sinceIso) {
    const out = [];
    for (const s of this.db.prepare("SELECT list, created FROM list_saves WHERE reader = ?").all(readerId)) {
      const l = this.get(s.list);
      const from = s.created > sinceIso ? s.created : sinceIso;
      if (l && !l.draft) for (const x of this.items(l.id)) if (x.added > from) out.push({ list: l, ...x });
    }
    return out.sort((a, b) => (b.added > a.added ? 1 : -1));
  }
}

// The books whose covers a list shows (its card, the fan on top, the picture for social networks): the first
// book of each section, then the first of each author, then the rest in order (Max, 2026-11-09: four Fry
// covers in a row «не дуже»).
function fanBooks(items, n = 5) {
  const all = items.filter((x) => x.book.cover);
  const author = (b) => String(b.author || "").split(/[,;]/)[0].trim().toLowerCase();
  const out = [];
  const authors = new Set();
  const take = (x) => out.length < n && !out.includes(x) && (out.push(x), authors.add(author(x.book)));
  for (const x of all) if (x.section && !authors.has(author(x.book))) take(x);
  for (const x of all) if (!authors.has(author(x.book))) take(x);
  for (const x of all) take(x);
  return out.sort((a, b) => all.indexOf(a) - all.indexOf(b)).map((x) => x.book);
}

module.exports = { Lists, EDITORIAL, fanBooks, FAV_MIN };

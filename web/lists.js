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
`;
const TITLE_MAX = 100;
const NOTE_MAX = 600;
const WHY_MAX = 300;
const ITEMS_MAX = 300;

class Lists {
  // `who(readerId)` is the public reader ({ name, username, href }) or null.
  constructor(store, who) {
    this.store = store;
    this.db = store.db;
    this.who = who;
    this.db.exec(SCHEMA);
  }

  // A list as the pages see it: its author, address and how many books and saves it has.
  view(row) {
    if (!row) return null;
    const reader = this.who(row.reader);
    if (!reader) return null;
    const n = this.db.prepare("SELECT COUNT(*) AS n FROM list_items WHERE list = ?").get(row.id).n;
    const saves = this.db.prepare("SELECT COUNT(*) AS n FROM list_saves WHERE list = ?").get(row.id).n;
    return { ...row, reader, href: `${reader.href}/list/${row.slug}`, count: n, saves };
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

  create(readerId, { title, note = "" }) {
    title = String(title || "").replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);
    if (!title) return null;
    const base = slugify(title).slice(0, 60).replace(/-+$/, "") || "spysok";
    let slug = base;
    for (let i = 2; this.db.prepare("SELECT 1 FROM lists WHERE reader = ? AND slug = ?").get(readerId, slug); i++) slug = `${base}-${i}`;
    const id = crypto.randomBytes(6).toString("hex");
    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO lists (id, reader, slug, title, note, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, readerId, slug, title, String(note).trim().slice(0, NOTE_MAX), now, now);
    return this.get(id);
  }
  edit(id, { title, note }) {
    const l = this.get(id);
    if (!l) return null;
    const t = String(title ?? l.title).replace(/\s+/g, " ").trim().slice(0, TITLE_MAX) || l.title;
    this.db.prepare("UPDATE lists SET title = ?, note = ?, updated = ? WHERE id = ?").run(t, String(note ?? l.note).trim().slice(0, NOTE_MAX), new Date().toISOString(), id);
    return this.get(id);
  }
  remove(id) {
    this.db.tx(() => {
      for (const [t, c] of [["list_items", "list"], ["list_saves", "list"], ["lists", "id"]]) this.db.prepare(`DELETE FROM ${t} WHERE ${c} = ?`).run(id);
    });
  }
  // Everything of a reader's goes with the account: their lists and the lists they saved.
  forgetReader(readerId) {
    for (const l of this.db.prepare("SELECT id FROM lists WHERE reader = ?").all(readerId)) this.remove(l.id);
    this.db.prepare("DELETE FROM list_saves WHERE reader = ?").run(readerId);
  }

  // The books of a list in its order: [{ id, book, why, added }]. Books we no longer know are left out,
  // and so are books in Russian unless it is the author looking (store.isRussian: never shown to others).
  items(listId, { own = false } = {}) {
    const out = [];
    const seen = new Set();
    for (const r of this.db.prepare("SELECT book, why, added FROM list_items WHERE list = ? ORDER BY ord, added").all(listId)) {
      const id = this.store.canonical(r.book);
      const book = this.store.book(id);
      if (!book || seen.has(id) || (!own && isRussian(book))) continue;
      seen.add(id);
      out.push({ id, book, why: r.why, added: r.added });
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
    this.touch(listId);
    return true;
  }
  // The rows a book may be stored under (a work merged since keeps its old id there).
  rowsOf(listId, bookId) {
    const id = this.store.canonical(bookId);
    return this.db.prepare("SELECT book FROM list_items WHERE list = ?").all(listId).filter((r) => this.store.canonical(r.book) === id).map((r) => r.book);
  }
  drop(listId, bookId) {
    for (const b of this.rowsOf(listId, bookId)) this.db.prepare("DELETE FROM list_items WHERE list = ? AND book = ?").run(listId, b);
    this.touch(listId);
  }
  setWhy(listId, bookId, why) {
    for (const b of this.rowsOf(listId, bookId)) this.db.prepare("UPDATE list_items SET why = ? WHERE list = ? AND book = ?").run(String(why || "").trim().slice(0, WHY_MAX), listId, b);
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
    if (!l || l.reader.id === readerId) return null;
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
    return this.db.prepare("SELECT l.* FROM list_saves s JOIN lists l ON l.id = s.list WHERE s.reader = ? ORDER BY s.created DESC").all(readerId).map((r) => this.view(r)).filter(Boolean);
  }

  // A few covers for a list's card: its first books.
  covers(listId, n = 4) {
    return this.items(listId).slice(0, n).map((x) => x.book);
  }
  // Every list with books in it (others see no empty ones): `popular` by saves, `new` by when made.
  all({ sort = "popular" } = {}) {
    const rows = this.db.prepare("SELECT * FROM lists").all().map((r) => this.view(r)).filter((l) => l && l.count);
    return sort === "new" ? rows.sort((a, b) => (b.created > a.created ? 1 : -1)) : rows.sort((a, b) => b.saves - a.saves || b.count - a.count || (b.updated > a.updated ? 1 : -1));
  }
  // The lists a book is in («У списках» on its page), the most saved first.
  withBook(bookId) {
    const id = this.store.canonical(bookId);
    const ids = new Set([id, ...(this.store.editions?.get(id) || []).map((e) => e.item.id)]);
    const lists = new Set();
    for (const r of this.db.prepare("SELECT list, book FROM list_items").all()) if (ids.has(r.book) || this.store.canonical(r.book) === id) lists.add(r.list);
    return [...lists].map((l) => this.get(l)).filter(Boolean).sort((a, b) => b.saves - a.saves || b.count - a.count);
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
      if (l) for (const x of this.items(l.id)) if (x.added > from) out.push({ list: l, ...x });
    }
    return out.sort((a, b) => (b.added > a.added ? 1 : -1));
  }
}

module.exports = { Lists };

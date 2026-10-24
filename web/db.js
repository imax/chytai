// The web platform's database: one SQLite file on the Fly volume (DATA_DIR/web/chytai.db), through
// Node's built-in node:sqlite, so there is nothing to install. It holds
//   - catalog items of every shelf, with the day each was first seen (for «нове»),
//   - the library: manual books, readers (accounts: e-mail, username, name), their sessions, entries, subscriptions and whom they follow,
//   - which books each reader has in the reader app (reader_files: titles only, for «Читати» on a book's page),
//   - for the owner's statistics (admin.js): the days each reader opened the site, and page views a day,
//   - book addresses: a slug, once given to a work, stays with it,
//   - the search index (FTS5), rebuilt from the works whenever the shelves change.
// Max (2026-10-19): «база нам знадобиться все одно. Навіть щоб пошук нормально доробити.»
const path = require("path");
const fs = require("fs");

// node:sqlite is "experimental" in Node 22 and says so on every start; keep every other warning.
const emit = process.emitWarning;
process.emitWarning = (w, ...rest) => (String(w).includes("SQLite") ? undefined : emit.call(process, w, ...rest));
const { DatabaseSync } = require("node:sqlite");
process.emitWarning = emit;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS shelves (id TEXT PRIMARY KEY, data TEXT NOT NULL, refreshed_at TEXT);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY, shelf TEXT NOT NULL, data TEXT NOT NULL,
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, ord INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS items_shelf ON items (shelf, ord);
CREATE TABLE IF NOT EXISTS books (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS entries (
  reader TEXT NOT NULL, book TEXT NOT NULL, status TEXT NOT NULL DEFAULT '', rating REAL, year INTEGER,
  note TEXT NOT NULL DEFAULT '', copy TEXT NOT NULL DEFAULT '', ord INTEGER, added TEXT,
  PRIMARY KEY (reader, book)
);
CREATE TABLE IF NOT EXISTS subscriptions (reader TEXT NOT NULL, shelf TEXT NOT NULL, PRIMARY KEY (reader, shelf));
CREATE TABLE IF NOT EXISTS follows (reader TEXT NOT NULL, target TEXT NOT NULL, created TEXT NOT NULL, PRIMARY KEY (reader, target));
CREATE TABLE IF NOT EXISTS follow_mails (reader TEXT NOT NULL, target TEXT NOT NULL, sent TEXT NOT NULL, PRIMARY KEY (reader, target));
CREATE TABLE IF NOT EXISTS slugs (slug TEXT PRIMARY KEY, id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ai_genre (id TEXT PRIMARY KEY, genres TEXT NOT NULL, prompt INTEGER NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ai_answer (pass TEXT NOT NULL, id TEXT NOT NULL, answer TEXT NOT NULL, prompt INTEGER NOT NULL, at TEXT NOT NULL, PRIMARY KEY (pass, id));
CREATE TABLE IF NOT EXISTS ai_lang (id TEXT PRIMARY KEY, lang TEXT NOT NULL, prompt INTEGER NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ai_orig (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, author TEXT NOT NULL, lang TEXT NOT NULL, prompt INTEGER NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS readers (
  id TEXT PRIMARY KEY, email TEXT UNIQUE, username TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  created TEXT NOT NULL, seen TEXT
);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, reader TEXT NOT NULL, created TEXT NOT NULL, seen TEXT);
CREATE INDEX IF NOT EXISTS sessions_reader ON sessions (reader);
CREATE TABLE IF NOT EXISTS login_codes (key TEXT NOT NULL, hash TEXT NOT NULL, expires INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS login_codes_key ON login_codes (key);
CREATE TABLE IF NOT EXISTS reader_files (reader TEXT NOT NULL, name TEXT NOT NULL, title TEXT NOT NULL, authors TEXT NOT NULL DEFAULT '', PRIMARY KEY (reader, name));
CREATE TABLE IF NOT EXISTS visits (day TEXT NOT NULL, reader TEXT NOT NULL, PRIMARY KEY (day, reader));
CREATE TABLE IF NOT EXISTS views (day TEXT PRIMARY KEY, readers INTEGER NOT NULL DEFAULT 0, guests INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS section_views (day TEXT NOT NULL, section TEXT NOT NULL, views INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, section));
CREATE TABLE IF NOT EXISTS arrivals (day TEXT NOT NULL, source TEXT NOT NULL, ref TEXT NOT NULL, landing TEXT NOT NULL, visits INTEGER NOT NULL DEFAULT 0, fresh INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, source, ref, landing));
CREATE TABLE IF NOT EXISTS steps (reader TEXT NOT NULL, step TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (reader, step));
CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5 (id UNINDEXED, title, alt, author, series, extra, tokenize = 'unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE IF NOT EXISTS search_vocab USING fts5vocab (search, 'row');
CREATE VIRTUAL TABLE IF NOT EXISTS search_tri USING fts5 (id UNINDEXED, text, tokenize = 'trigram');
`;

function open(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "chytai.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  db.exec(SCHEMA);
  // When an entry last changed, for the activity feed (added 2026-10-20; older rows have none).
  if (!db.prepare("PRAGMA table_info(entries)").all().some((c) => c.name === "updated")) db.exec("ALTER TABLE entries ADD COLUMN updated TEXT");
  // Whether a reader wants a letter when someone starts following them (Max, 2026-10-20); on by default.
  if (!db.prepare("PRAGMA table_info(readers)").all().some((c) => c.name === "follow_mail")) db.exec("ALTER TABLE readers ADD COLUMN follow_mail INTEGER NOT NULL DEFAULT 1");
  // Whether search engines may list the reader's page (settings, 2026-10-21); yes by default.
  if (!db.prepare("PRAGMA table_info(readers)").all().some((c) => c.name === "noindex")) db.exec("ALTER TABLE readers ADD COLUMN noindex INTEGER NOT NULL DEFAULT 0");
  // «Читаю зараз» (Max, 2026-10-22), a reader's status: JSON { books: [{ id, since }], at }.
  if (!db.prepare("PRAGMA table_info(readers)").all().some((c) => c.name === "now")) db.exec("ALTER TABLE readers ADD COLUMN now TEXT");
  // Where a reader first came from before signing up (/admin, Max 2026-10-24): JSON { source, ref, landing, day }.
  if (!db.prepare("PRAGMA table_info(readers)").all().some((c) => c.name === "came")) db.exec("ALTER TABLE readers ADD COLUMN came TEXT");
  // «Дитяча полиця» (Max, 2026-10-23): a book the reader keeps for their children, out of their own taste.
  if (!db.prepare("PRAGMA table_info(entries)").all().some((c) => c.name === "kids")) db.exec("ALTER TABLE entries ADD COLUMN kids INTEGER NOT NULL DEFAULT 0");
  // A work may have several addresses (an old one redirects to the current): the table once made id
  // UNIQUE, so a second slug for an id was silently dropped and lived only in memory (2026-10-21).
  if (db.prepare("PRAGMA index_list(slugs)").all().some((i) => i.unique && i.origin === "u")) {
    db.exec("CREATE TABLE slugs_new (slug TEXT PRIMARY KEY, id TEXT NOT NULL); INSERT INTO slugs_new (slug, id) SELECT slug, id FROM slugs ORDER BY rowid; DROP TABLE slugs; ALTER TABLE slugs_new RENAME TO slugs;");
  }
  db.exec("CREATE INDEX IF NOT EXISTS slugs_id ON slugs (id)");
  db.tx = (fn) => {
    db.exec("BEGIN");
    try {
      const r = fn();
      db.exec("COMMIT");
      return r;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  db.get = (key) => db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
  db.set = (key, value) => db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
  // The book exchange is gone (Max, 2026-10-22: «прибираємо цю фічу повністю»). Once: every book marked
  // for it goes back to «На папері»; the owner's marked books also get back their copy and date from the
  // 2026-10-21 backup, since marking dated them and they came up in the feed as yesterday's reviews.
  if (!db.get("exchange:removed")) {
    let before = {};
    try {
      before = JSON.parse(fs.readFileSync(path.join(__dirname, "seed", "exchange-undo.json"), "utf8"));
    } catch {}
    const ownerId = "owner"; // store.js OWNER
    db.tx(() => {
      for (const r of db.prepare("SELECT reader, book FROM entries WHERE copy = 'give'").all()) {
        const was = r.reader === ownerId ? before[r.book] : null;
        if (was) db.prepare("UPDATE entries SET copy = ?, updated = ? WHERE reader = ? AND book = ?").run(was[0] === "give" ? "paper" : was[0] || "paper", was[1] ?? null, r.reader, r.book);
        else db.prepare("UPDATE entries SET copy = 'paper' WHERE reader = ? AND book = ?").run(r.reader, r.book);
      }
      db.exec("DROP TABLE IF EXISTS asks");
      for (const col of ["swap", "city", "exchange"]) if (db.prepare("PRAGMA table_info(readers)").all().some((c) => c.name === col)) db.exec(`ALTER TABLE readers DROP COLUMN ${col}`);
      db.set("exchange:removed", new Date().toISOString());
    });
  }
  return db;
}

module.exports = { open };

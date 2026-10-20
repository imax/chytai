// The web platform's database: one SQLite file on the Fly volume (DATA_DIR/web/chytai.db), through
// Node's built-in node:sqlite, so there is nothing to install. It holds
//   - catalog items of every shelf, with the day each was first seen (for «нове»),
//   - the library: manual books, readers (accounts: e-mail, username, name), their sessions, entries and subscriptions,
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
CREATE TABLE IF NOT EXISTS slugs (slug TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS readers (
  id TEXT PRIMARY KEY, email TEXT UNIQUE, username TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  created TEXT NOT NULL, seen TEXT
);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, reader TEXT NOT NULL, created TEXT NOT NULL, seen TEXT);
CREATE INDEX IF NOT EXISTS sessions_reader ON sessions (reader);
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
  return db;
}

module.exports = { open };

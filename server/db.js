// The reader's data in one SQLite file (DATA_DIR/reader.db), through Node's built-in node:sqlite, as on the site
// (web/db.js). Until 2026-11-05 it all lived in state.json, which was written whole on every page turn: with a few
// hundred readers that file would have grown to ~80 MB and each save would have stopped the server for seconds
// (thread «Підготувати базу й файли до сотень читачів», Max: «робимо всі 5 пунктів»).
//
// Two kinds of data:
//   - docs: the small state the server keeps in memory (settings, positions, accounts, sessions, libraries,
//     stats by day, …), one row per account / session / day. persist() writes only the rows that changed.
//   - items: what grows with reading — notes, kept explanations (chats) and paper-book questions (paperChats),
//     one row per note or talk. They are not kept in memory; a request reads the book it needs.
const path = require("path");
const fs = require("fs");

// node:sqlite is "experimental" in Node 22 and says so on every start; keep every other warning.
const emit = process.emitWarning;
process.emitWarning = (w, ...rest) => (String(w).includes("SQLite") ? undefined : emit.call(process, w, ...rest));
const { DatabaseSync } = require("node:sqlite");
process.emitWarning = emit;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS docs (coll TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (coll, id)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS items (
  acct TEXT NOT NULL, kind TEXT NOT NULL, book TEXT NOT NULL, id TEXT NOT NULL, ord INTEGER NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY (acct, kind, book, id)
);
CREATE INDEX IF NOT EXISTS items_kind ON items (kind, acct);
CREATE TABLE IF NOT EXISTS files (sha TEXT NOT NULL, path TEXT NOT NULL, ino INTEGER NOT NULL, size INTEGER NOT NULL, PRIMARY KEY (sha, path)) WITHOUT ROWID;
`;

// Top-level maps of the state kept one row per key; everything else at the top is one row per key in "root".
// stats.days is one row per day ("days"); only the last few days are compared on a save, older ones never change.
const COLLS = ["users", "accounts", "libs", "sessions", "shares", "opds", "legacyUsers"];
const KINDS = ["notes", "chats", "paperChats"];
const RECENT_DAYS = 3;

// A kept talk carries the whole request to Claude (messages) next to its turns; each answer was in both. Stored
// once: an answer in messages that is a turn's answer becomes { role, turn: k } and comes back on reading.
function pack(item) {
  if (!Array.isArray(item?.messages) || !Array.isArray(item.turns)) return JSON.stringify(item);
  const answers = new Map();
  item.turns.forEach((t, k) => t?.a && !answers.has(t.a) && answers.set(t.a, k));
  const messages = item.messages.map((m) => {
    if (m?.role !== "assistant") return m;
    const text = typeof m.content === "string" ? m.content : Array.isArray(m.content) && m.content.length === 1 && m.content[0]?.type === "text" && Object.keys(m.content[0]).length === 2 ? m.content[0].text : null;
    const k = text != null ? answers.get(text) : undefined;
    if (k === undefined) return m;
    const keys = Object.keys(m);
    if (keys.length !== 2) return m; // something besides role and content: keep it whole
    return typeof m.content === "string" ? { role: "assistant", turn: k } : { role: "assistant", turn: k, block: true };
  });
  return JSON.stringify({ ...item, messages });
}
function unpack(s) {
  const item = JSON.parse(s);
  if (Array.isArray(item?.messages) && Array.isArray(item.turns)) {
    item.messages = item.messages.map((m) => {
      if (m?.role !== "assistant" || !Number.isInteger(m.turn) || "content" in m) return m;
      const a = item.turns[m.turn]?.a ?? "";
      return { role: "assistant", content: m.block ? [{ type: "text", text: a }] : a };
    });
  }
  return item;
}
const itemId = (item, i) => (item && typeof item.id === "string" && item.id ? item.id : `_${i}`);

function open(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "reader.db"));
  db.exec("PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  db.exec(SCHEMA);
  const q = {
    metaGet: db.prepare("SELECT value FROM meta WHERE key = ?"),
    metaSet: db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value"),
    docsAll: db.prepare("SELECT coll, id, value FROM docs"),
    docPut: db.prepare("INSERT INTO docs (coll, id, value) VALUES (?, ?, ?) ON CONFLICT (coll, id) DO UPDATE SET value = excluded.value"),
    docDel: db.prepare("DELETE FROM docs WHERE coll = ? AND id = ?"),
    list: db.prepare("SELECT id, ord, value FROM items WHERE acct = ? AND kind = ? AND book = ? ORDER BY ord"),
    books: db.prepare("SELECT book, value FROM items WHERE acct = ? AND kind = ? ORDER BY book, ord"),
    itemPut: db.prepare("INSERT INTO items (acct, kind, book, id, ord, value) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (acct, kind, book, id) DO UPDATE SET ord = excluded.ord, value = excluded.value"),
    itemDel: db.prepare("DELETE FROM items WHERE acct = ? AND kind = ? AND book = ? AND id = ?"),
    ordOf: db.prepare("SELECT ord FROM items WHERE acct = ? AND kind = ? AND book = ? AND id = ?"),
    maxOrd: db.prepare("SELECT max(ord) AS m, count(*) AS n FROM items WHERE acct = ? AND kind = ? AND book = ?"),
    oldest: db.prepare("SELECT id FROM items WHERE acct = ? AND kind = ? AND book = ? ORDER BY ord LIMIT ?"),
    dropBook: db.prepare("DELETE FROM items WHERE acct = ? AND kind = ? AND book = ?"),
    dropAcct: db.prepare("DELETE FROM items WHERE acct = ?"),
    filesOf: db.prepare("SELECT path, ino, size FROM files WHERE sha = ?"),
    fileAdd: db.prepare("INSERT INTO files (sha, path, ino, size) VALUES (?, ?, ?, ?) ON CONFLICT (sha, path) DO UPDATE SET ino = excluded.ino, size = excluded.size"),
    fileDel: db.prepare("DELETE FROM files WHERE sha = ? AND path = ?"),
    noteTimes: db.prepare("SELECT acct, json_extract(value, '$.createdAt') AS at FROM items WHERE kind = 'notes'"),
  };
  const tx = (fn) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      db.exec("COMMIT");
      return r;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };

  // ---- the in-memory state: load once, then write only what changed ----
  const last = new Map(); // "coll\0id" -> the JSON last written
  const key = (coll, id) => `${coll}\0${id}`;
  function loadState() {
    const state = {};
    for (const r of q.docsAll.all()) {
      last.set(key(r.coll, r.id), r.value);
      const v = JSON.parse(r.value);
      if (r.coll === "root") state[r.id] = r.id === "stats" ? { ...v, days: state.stats?.days || {} } : v;
      else if (r.coll === "days") ((state.stats ??= {}).days ??= {})[r.id] = v;
      else (state[r.coll] ??= {})[r.id] = v;
    }
    if (state.stats) state.stats.days ??= {};
    return state;
  }
  function persist(state, { all = false } = {}) {
    const seen = new Set();
    const put = (coll, id, v) => {
      const k = key(coll, id);
      seen.add(k);
      if (v === undefined) return;
      const s = JSON.stringify(v);
      if (last.get(k) !== s) q.docPut.run(coll, id, s), last.set(k, s);
    };
    const keep = (coll, id) => seen.add(key(coll, id));
    tx(() => {
      for (const coll of COLLS) for (const [id, v] of Object.entries(state[coll] || {})) put(coll, id, v);
      const { days, ...stats } = state.stats || {};
      const recent = Object.keys(days || {}).sort().slice(-RECENT_DAYS);
      for (const [id, v] of Object.entries(days || {})) {
        if (all || recent.includes(id) || !last.has(key("days", id))) put("days", id, v);
        else keep("days", id);
      }
      for (const [id, v] of Object.entries(state)) {
        if (COLLS.includes(id)) continue;
        put("root", id, id === "stats" ? stats : v);
      }
      for (const k of [...last.keys()]) {
        if (seen.has(k)) continue;
        const [coll, id] = k.split("\0");
        q.docDel.run(coll, id);
        last.delete(k);
      }
    });
  }

  // ---- notes, kept explanations, paper-book questions: one row each ----
  const items = {
    list(acct, kind, book) {
      return q.list.all(acct, kind, book).map((r) => unpack(r.value));
    },
    // Every book's list for one reader: { book: [item, …] }.
    books(acct, kind) {
      const out = {};
      for (const r of q.books.all(acct, kind)) (out[r.book] ??= []).push(unpack(r.value));
      return out;
    },
    // The book's whole list as it should now be: rows that changed are written, rows gone are deleted.
    save(acct, kind, book, list) {
      tx(() => {
        const had = new Map(q.list.all(acct, kind, book).map((r) => [r.id, r]));
        (list || []).forEach((item, i) => {
          const id = itemId(item, i);
          const s = pack(item);
          const h = had.get(id);
          if (!h || h.ord !== i || h.value !== s) q.itemPut.run(acct, kind, book, id, i, s);
          had.delete(id);
        });
        for (const id of had.keys()) q.itemDel.run(acct, kind, book, id);
      });
    },
    // One note or talk added or replaced; at most `max` kept in the book (the oldest go).
    put(acct, kind, book, item, max = 0) {
      tx(() => {
        const at = q.ordOf.get(acct, kind, book, item.id);
        const { m, n } = q.maxOrd.get(acct, kind, book);
        q.itemPut.run(acct, kind, book, item.id, at ? at.ord : (m ?? -1) + 1, pack(item));
        const count = n + (at ? 0 : 1);
        if (max && count > max) for (const r of q.oldest.all(acct, kind, book, count - max)) q.itemDel.run(acct, kind, book, r.id);
      });
    },
    dropBook(acct, kind, book) {
      q.dropBook.run(acct, kind, book);
    },
    dropAccount(acct) {
      q.dropAcct.run(acct);
    },
    noteTimes() {
      return q.noteTimes.all();
    },
  };

  // ---- book files: one copy on the disk for the same file in several libraries ----
  // A file is written once; the same bytes uploaded again (by anyone) become a hard link to it. A link is
  // shared only while the inode the database remembers is still at that path; a file is never written in place
  // (writeBook removes the path first), so the same inode means the same bytes.
  function writeBook(file, body) {
    fs.rmSync(file, { force: true });
    const sha = require("crypto").createHash("sha256").update(body).digest("hex");
    for (const t of q.filesOf.all(sha)) {
      let st = null;
      try {
        st = fs.statSync(t.path);
      } catch {}
      if (!st || Number(st.ino) !== Number(t.ino) || st.size !== body.length || t.size !== body.length) {
        q.fileDel.run(sha, t.path);
        continue;
      }
      try {
        fs.linkSync(t.path, file);
        q.fileAdd.run(sha, file, Number(st.ino), st.size);
        return { linked: true };
      } catch {
        break; // another disk, or links not allowed: write it
      }
    }
    fs.writeFileSync(file, body);
    const st = fs.statSync(file);
    q.fileAdd.run(sha, file, Number(st.ino), st.size);
    return { linked: false };
  }

  // ---- once: state.json into the database ----
  // The file is read whole, its notes and talks go to items, the rest to docs, all in one transaction. state.json
  // itself stays on the volume as it was and is never written again: an older version of the reader, if ever
  // put back, starts from it instead of from nothing (scripts/reader-db-to-state.js brings it up to date first).
  function migrate(state) {
    tx(() => {
      for (const [acct, u] of Object.entries(state.users || {})) {
        for (const kind of KINDS) {
          for (const [book, list] of Object.entries(u?.[kind] || {})) {
            (list || []).forEach((item, i) => q.itemPut.run(acct, kind, book, itemId(item, i), i, pack(item)));
          }
          if (u) delete u[kind];
        }
      }
      q.metaSet.run("migrated", new Date().toISOString());
    });
    persist(state, { all: true });
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  return {
    db,
    KINDS,
    migrated: () => !!q.metaGet.get("migrated")?.value,
    meta: { get: (k) => q.metaGet.get(k)?.value ?? null, set: (k, v) => q.metaSet.run(k, String(v)) },
    // Books with a quote: a paper book's note marked «Цитата», an e-book's saved passage (not the reader's own «mine:» note).
    quoteBooks: () => db.prepare("SELECT DISTINCT acct, book FROM items WHERE kind = 'notes' AND ((book LIKE 'paper-%' AND json_extract(value, '$.quote') = 1) OR (book NOT LIKE 'paper-%' AND json_extract(value, '$.cfi') NOT LIKE 'mine:%'))").all(),
    loadState,
    persist,
    migrate,
    items,
    writeBook,
    pack,
    unpack,
  };
}

module.exports = { open };

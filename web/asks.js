// «Попросити книжку» (Max, 2026-11-08: «peer 2 peer lending … не питати на сторінці книжки, а в читача напряму …
// щось більше типу чата з кнопкою»). On another reader's shelf: «Попросити книжку» opens a talk of the two of them.
// A request names a book; the one asked shares their e-book file into the asker's reader (Max chose «Копіювати
// будь-яку» 2026-11-08) or just writes.
// An experiment: for now only the owner starts a talk (Max, 2026-11-08); the reader asked answers in it.
// Max then simplified it the same day: no «Позичу паперову» / «Не можу», one button to share the e-book, the rest in words.
const crypto = require("crypto");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ask_talks (id TEXT PRIMARY KEY, a TEXT NOT NULL, b TEXT NOT NULL, created TEXT NOT NULL, active TEXT NOT NULL, UNIQUE (a, b));
CREATE TABLE IF NOT EXISTS ask_msgs (
  id TEXT PRIMARY KEY, talk TEXT NOT NULL, reader TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', book TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '', answer TEXT NOT NULL DEFAULT '', file TEXT NOT NULL DEFAULT '', created TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ask_msgs_talk ON ask_msgs (talk, created);
CREATE TABLE IF NOT EXISTS ask_seen (reader TEXT NOT NULL, talk TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (reader, talk));
`;
const TEXT_MAX = 2000;
// A few people for now, so the limits are only against a runaway script.
const MSGS_A_DAY = 60;
const ASKS_A_DAY = 10;
const now = () => new Date().toISOString();
const newId = () => crypto.randomBytes(6).toString("hex");
const clean = (s) => String(s || "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, TEXT_MAX);

class Asks {
  constructor(store, owner) {
    this.db = store.db;
    this.owner = owner;
    this.db.exec(SCHEMA);
  }
  hasTalks(id) {
    return !!this.db.prepare("SELECT 1 FROM ask_talks WHERE a = ? OR b = ? LIMIT 1").get(id, id);
  }
  // The talk of two readers, one per pair, made on the first message.
  talkOf(x, y, { make = false } = {}) {
    const [a, b] = [x, y].sort();
    const t = this.db.prepare("SELECT * FROM ask_talks WHERE a = ? AND b = ?").get(a, b);
    if (t || !make) return t || null;
    const id = newId();
    this.db.prepare("INSERT INTO ask_talks (id, a, b, created, active) VALUES (?, ?, ?, ?, ?)").run(id, a, b, now(), now());
    return this.db.prepare("SELECT * FROM ask_talks WHERE id = ?").get(id);
  }
  talk(id) {
    return this.db.prepare("SELECT * FROM ask_talks WHERE id = ?").get(id) || null;
  }
  msgs(talk) {
    return this.db.prepare("SELECT * FROM ask_msgs WHERE talk = ? ORDER BY created, rowid").all(talk);
  }
  msg(id) {
    return this.db.prepare("SELECT * FROM ask_msgs WHERE id = ?").get(id) || null;
  }
  // { error } when over the day's limit.
  post(talk, reader, { text = "", book = "", kind = "", file = "" }) {
    const day = now().slice(0, 10);
    const sent = this.db.prepare("SELECT COUNT(*) AS n, SUM(kind = 'ask') AS asks FROM ask_msgs WHERE reader = ? AND created >= ?").get(reader, day);
    if (reader !== this.owner && sent.n >= MSGS_A_DAY) return { error: "На сьогодні досить повідомлень. Завтра можна знову." };
    if (reader !== this.owner && kind === "ask" && sent.asks >= ASKS_A_DAY) return { error: "На сьогодні досить прохань. Завтра можна знову." };
    text = clean(text);
    if (!text && !book && !kind) return { error: "Порожнє повідомлення." };
    const id = newId();
    const at = now();
    this.db.prepare("INSERT INTO ask_msgs (id, talk, reader, text, book, kind, file, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, talk, reader, text, book, kind, file, at);
    this.db.prepare("UPDATE ask_talks SET active = ? WHERE id = ?").run(at, talk);
    this.seen(reader, talk);
    return { id };
  }
  answered(msg, answer) {
    this.db.prepare("UPDATE ask_msgs SET answer = ? WHERE id = ?").run(answer, msg);
  }
  seenAt(reader, talk) {
    return this.db.prepare("SELECT at FROM ask_seen WHERE reader = ? AND talk = ?").get(reader, talk)?.at || "";
  }
  seen(reader, talk) {
    this.db.prepare("INSERT INTO ask_seen (reader, talk, at) VALUES (?, ?, ?) ON CONFLICT (reader, talk) DO UPDATE SET at = excluded.at").run(reader, talk, now());
  }
  // The reader's talks, newest first, each with the other one, the last message and whether it is new to them.
  talksOf(reader) {
    return this.db
      .prepare(
        `SELECT t.*, (SELECT at FROM ask_seen s WHERE s.reader = ? AND s.talk = t.id) AS seen,
          (SELECT json_object('reader', m.reader, 'text', m.text, 'kind', m.kind, 'book', m.book) FROM ask_msgs m WHERE m.talk = t.id ORDER BY m.created DESC, m.rowid DESC LIMIT 1) AS last
         FROM ask_talks t WHERE t.a = ? OR t.b = ? ORDER BY t.active DESC`
      )
      .all(reader, reader, reader)
      .map((t) => ({ ...t, other: t.a === reader ? t.b : t.a, last: t.last ? JSON.parse(t.last) : null, fresh: (!t.seen || t.seen < t.active) && t.last && JSON.parse(t.last).reader !== reader }));
  }
  unread(reader) {
    return this.talksOf(reader).filter((t) => t.fresh).length;
  }
}

module.exports = { Asks };

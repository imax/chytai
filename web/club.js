// «Клуб Chytai» (Max, 2026-11-01: «форум, обговорення, клуб читай … винести в навігацію наверху»): a forum at
// /club. Topics are the owner's («Від Chytai», on top: e.g. one to collect feedback) or any signed-in reader's,
// each with plain-text replies, oldest first. The comments under lists (lists.js) are the Club too: a list
// with comments shows among the topics and leads to its page.
//
// Book things: a topic may be about a book, and its author or the owner may mark it «містить спойлери». Then
// the topic is blurred until the reader says «показати», unless they have that book as read («Прочитано»).
// «@username» in any Club text links the reader and mails them (mentions(), server.js), once per text.
const crypto = require("crypto");
const { slugify } = require("./store");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS club_topics (
  id TEXT PRIMARY KEY, reader TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', book TEXT NOT NULL DEFAULT '',
  spoiler INTEGER NOT NULL DEFAULT 0, official INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL, active TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS club_topics_active ON club_topics (active);
CREATE INDEX IF NOT EXISTS club_topics_book ON club_topics (book);
CREATE TABLE IF NOT EXISTS club_posts (
  id TEXT PRIMARY KEY, topic TEXT NOT NULL, reader TEXT NOT NULL, text TEXT NOT NULL, created TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS club_posts_topic ON club_posts (topic, created);
CREATE TABLE IF NOT EXISTS club_watch (reader TEXT NOT NULL, topic TEXT NOT NULL, on_ INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (reader, topic));
CREATE INDEX IF NOT EXISTS club_watch_topic ON club_watch (topic);
`;
const TITLE_MAX = 120;
const TEXT_MAX = 4000;
const POST_MAX = 2000;
// The same pace as under lists: a few topics and enough replies for a real talk.
const TOPICS_A_DAY = 5;
const POSTS_A_DAY = 40;

// «@username» as typed: letters, digits, «_», «.», «-» (auth.checkUsername), not inside an e-mail address.
const MENTION = /(^|[^\w@.])@([a-z0-9][a-z0-9_.-]{1,30}[a-z0-9])/gi;
const mentionsIn = (text) => [...new Set([...String(text || "").matchAll(MENTION)].map((m) => m[2].toLowerCase()))];

const clean = (s, max) => String(s || "").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
const oneLine = (s, max) => String(s || "").replace(/\s+/g, " ").trim().slice(0, max);
const now = () => new Date().toISOString();
const newId = () => crypto.randomBytes(6).toString("hex");

class Club {
  // `who(readerId)`: the public reader or null; `lists`: lists.js, for the list talks among the topics.
  constructor(store, who, lists) {
    this.store = store;
    this.db = store.db;
    this.who = who;
    this.lists = lists;
    this.db.exec(SCHEMA);
    // The address is the title's, made once (Max, 2026-11-01: no code in it, like books and authors): /club/<slug>.
    if (!this.db.prepare("PRAGMA table_info(club_topics)").all().some((c) => c.name === "slug")) {
      this.db.exec("ALTER TABLE club_topics ADD COLUMN slug TEXT NOT NULL DEFAULT ''");
      for (const r of this.db.prepare("SELECT id, title FROM club_topics ORDER BY created").all()) this.db.prepare("UPDATE club_topics SET slug = ? WHERE id = ?").run(this.newSlug(r.title), r.id);
    }
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS club_topics_slug ON club_topics (slug) WHERE slug != ''");
    // Topics from before the letters (2026-11-01): their authors and those who answered follow them too.
    this.db.exec("INSERT OR IGNORE INTO club_watch (reader, topic, on_) SELECT reader, id, 1 FROM club_topics; INSERT OR IGNORE INTO club_watch (reader, topic, on_) SELECT DISTINCT reader, topic, 1 FROM club_posts;");
  }

  // A free address from a title: «-2», «-3» for a title taken; «new» is the new-topic page.
  newSlug(title) {
    const base = slugify(title).slice(0, 70).replace(/-+$/, "") || "tema";
    let slug = base === "new" ? "new-2" : base;
    for (let i = 2; this.db.prepare("SELECT 1 FROM club_topics WHERE slug = ?").get(slug); i++) slug = `${base}-${i}`;
    return slug;
  }
  bySlug(slug) {
    return this.view(this.db.prepare("SELECT * FROM club_topics WHERE slug = ?").get(String(slug)));
  }
  // A topic as the pages see it: its author, address, book and how many replies.
  view(row) {
    if (!row) return null;
    const reader = this.who(row.reader);
    if (!reader) return null;
    const n = this.db.prepare("SELECT COUNT(*) AS n FROM club_posts WHERE topic = ?").get(row.id).n;
    const book = row.book && this.store.book(row.book) ? this.store.bookPage(row.book) : null;
    return { ...row, spoiler: !!row.spoiler, official: !!row.official, reader, book, replies: n, href: `/club/${row.slug || row.id}` };
  }
  topic(id) {
    return this.view(this.db.prepare("SELECT * FROM club_topics WHERE id = ?").get(String(id)));
  }
  posts(topicId) {
    return this.db.prepare("SELECT * FROM club_posts WHERE topic = ? ORDER BY created").all(topicId).map((p) => ({ ...p, reader: this.who(p.reader) })).filter((p) => p.reader);
  }
  post(id) {
    return this.db.prepare("SELECT * FROM club_posts WHERE id = ?").get(String(id)) || null;
  }

  // /club: the owner's topics first, then every talk (topics and lists with comments) by its last word.
  // [{ kind: "topic"|"list", title, href, by, replies, active, spoiler, book, official }]
  index(limit = 150) {
    const topics = this.db.prepare("SELECT * FROM club_topics ORDER BY active DESC LIMIT ?").all(limit).map((r) => this.view(r)).filter(Boolean).map((t) => ({ kind: "topic", ...t }));
    const listTalks = this.db
      .prepare("SELECT list, COUNT(*) AS n, MAX(created) AS active FROM list_comments GROUP BY list ORDER BY active DESC LIMIT ?")
      .all(limit)
      .map((r) => ({ r, l: this.lists.get(r.list) }))
      .filter(({ l }) => l && !l.draft)
      .map(({ r, l }) => ({ kind: "list", id: l.id, title: l.title, href: `${l.href}#club`, reader: l.editorial ? null : l.reader, by: l.by, replies: r.n, active: r.active, spoiler: false, book: null, official: false, list: l }));
    const all = [...topics, ...listTalks].sort((a, b) => (a.active < b.active ? 1 : -1));
    return { pinned: all.filter((t) => t.kind === "topic" && t.official), rest: all.filter((t) => !(t.kind === "topic" && t.official)).slice(0, limit) };
  }
  // A book page's «У Клубі»: topics about this book, the liveliest first.
  ofBook(bookId) {
    return this.db.prepare("SELECT * FROM club_topics WHERE book = ? ORDER BY active DESC LIMIT 5").all(this.store.canonical(bookId)).map((r) => this.view(r)).filter(Boolean);
  }

  // null when there is nothing to say or the reader has opened enough topics today.
  create(readerId, { title, text, book = "", spoiler = false, official = false }) {
    title = oneLine(title, TITLE_MAX);
    text = clean(text, TEXT_MAX);
    if (!title) return null;
    const day = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    if (!official && this.db.prepare("SELECT COUNT(*) AS n FROM club_topics WHERE reader = ? AND created > ?").get(readerId, day).n >= TOPICS_A_DAY) return null;
    const id = newId();
    const t = now();
    this.db.prepare("INSERT INTO club_topics (id, reader, title, text, book, spoiler, official, created, active, slug) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, readerId, title, text, this.bookId(book), spoiler ? 1 : 0, official ? 1 : 0, t, t, this.newSlug(title));
    this.follow(readerId, id);
    return this.topic(id);
  }
  // `official` is the owner's to change (server.js); undefined leaves it.
  edit(id, { title, text, book, spoiler, official }) {
    const t = this.topic(id);
    if (!t) return null;
    this.db
      .prepare("UPDATE club_topics SET title = ?, text = ?, book = ?, spoiler = ?, official = ? WHERE id = ?")
      .run(oneLine(title ?? t.title, TITLE_MAX) || t.title, clean(text ?? t.text, TEXT_MAX), book === undefined ? t.book?.id || "" : this.bookId(book), (spoiler ?? t.spoiler) ? 1 : 0, (official ?? t.official) ? 1 : 0, t.id);
    return this.topic(id);
  }
  bookId(b) {
    const id = b ? this.store.resolve(String(b)) : null;
    return id ? this.store.canonical(id) : "";
  }
  addPost(topicId, readerId, text) {
    text = clean(text, POST_MAX);
    if (!text || !this.topic(topicId)) return null;
    const day = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    if (this.db.prepare("SELECT COUNT(*) AS n FROM club_posts WHERE reader = ? AND created > ?").get(readerId, day).n >= POSTS_A_DAY) return null;
    const id = newId();
    const t = now();
    this.db.prepare("INSERT INTO club_posts (id, topic, reader, text, created) VALUES (?, ?, ?, ?, ?)").run(id, topicId, readerId, text, t);
    this.db.prepare("UPDATE club_topics SET active = ? WHERE id = ?").run(t, topicId);
    this.follow(readerId, topicId);
    return id;
  }
  // «Відповіді в темі» letters (Max, 2026-11-01: «лист на кожне повідомлення в треді»): the topic's author and everyone
  // who answered follow it, until they untick «Сповіщати про відповіді» in the topic (a row with on_ = 0 stays off).
  follow(readerId, topicId) {
    this.db.prepare("INSERT OR IGNORE INTO club_watch (reader, topic, on_) VALUES (?, ?, 1)").run(readerId, topicId);
  }
  setWatch(readerId, topicId, on) {
    this.db.prepare("INSERT INTO club_watch (reader, topic, on_) VALUES (?, ?, ?) ON CONFLICT (reader, topic) DO UPDATE SET on_ = excluded.on_").run(readerId, topicId, on ? 1 : 0);
  }
  watching(readerId, topicId) {
    return !!this.db.prepare("SELECT 1 FROM club_watch WHERE reader = ? AND topic = ? AND on_ = 1").get(readerId, topicId);
  }
  watchers(topicId) {
    return this.db.prepare("SELECT reader FROM club_watch WHERE topic = ? AND on_ = 1").all(topicId).map((r) => r.reader);
  }
  // The Friday letter's «У Клубі цього тижня»: the topics with the most said in them since `sinceIso`.
  week(sinceIso, limit = 3) {
    return this.db
      .prepare("SELECT t.*, (SELECT COUNT(*) FROM club_posts p WHERE p.topic = t.id AND p.created > ?) AS fresh FROM club_topics t WHERE t.active > ? ORDER BY fresh + (t.created > ?) DESC, t.active DESC LIMIT ?")
      .all(sinceIso, sinceIso, sinceIso, limit)
      .map((r) => ({ ...this.view(r), fresh: r.fresh }))
      .filter((t) => t.reader);
  }
  // The homepage's «Зараз у Клубі»: the liveliest topics now, the owner's pinned ones aside.
  lively(limit = 3) {
    return this.db.prepare("SELECT * FROM club_topics ORDER BY active DESC LIMIT ?").all(limit).map((r) => this.view(r)).filter(Boolean);
  }
  // A reader's page: the topics they started.
  of(readerId, limit = 10) {
    return this.db.prepare("SELECT * FROM club_topics WHERE reader = ? ORDER BY active DESC LIMIT ?").all(readerId, limit).map((r) => this.view(r)).filter(Boolean);
  }
  // The sitemap: topics without spoilers ({ href, active }).
  forSitemap() {
    return this.db.prepare("SELECT * FROM club_topics WHERE spoiler = 0 ORDER BY active DESC").all().map((r) => this.view(r)).filter(Boolean);
  }
  dropPost(id) {
    this.db.prepare("DELETE FROM club_posts WHERE id = ?").run(String(id));
  }
  remove(id) {
    this.db.tx(() => {
      this.db.prepare("DELETE FROM club_posts WHERE topic = ?").run(id);
      this.db.prepare("DELETE FROM club_watch WHERE topic = ?").run(id);
      this.db.prepare("DELETE FROM club_topics WHERE id = ?").run(id);
    });
  }
  // /admin/comments: the newest replies and topics, with the list comments.
  recent(limit = 200) {
    const posts = this.db.prepare("SELECT * FROM club_posts ORDER BY created DESC LIMIT ?").all(limit).map((p) => ({ ...p, reader: this.who(p.reader), topic: this.topic(p.topic) })).filter((p) => p.topic);
    const topics = this.db.prepare("SELECT * FROM club_topics ORDER BY created DESC LIMIT ?").all(limit).map((r) => this.view(r)).filter(Boolean);
    return { posts, topics };
  }
  // The account goes, and its words with it: its topics (with their replies) and its replies elsewhere.
  forgetReader(readerId) {
    for (const t of this.db.prepare("SELECT id FROM club_topics WHERE reader = ?").all(readerId)) this.remove(t.id);
    this.db.prepare("DELETE FROM club_posts WHERE reader = ?").run(readerId);
    this.db.prepare("DELETE FROM club_watch WHERE reader = ?").run(readerId);
  }
}

module.exports = { Club, mentionsIn, MENTION };

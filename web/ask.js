// «Що почитати далі?» on /ask (Max, 2026-11-11, from a Threads post: «Класно зайшли цикли Тесс Ґеррітсен про Ріццолі
// і цикл Саймона Бекетта… Порадьте якісь хороші цикли детективи/трилери»). Anyone, signed in or not, writes in their
// own words what they read and liked; Claude names books, and the answer keeps only the ones our catalog has, each
// with a line on why. Every answer has its own address (/ask/<id>), so Max can ask for someone and send them the link.
// The answer is for the text alone, never the asker's shelf: an answer made by one person reads right for another.
// The same text asked again gets the kept answer, free. Answers nobody opened for half a year are dropped.
const crypto = require("crypto");
const { isRussian, sameAuthor, norm } = require("./store");

const MODEL = "claude-opus-5-5";
// $ per token, for the owner's sums only (server/admin.js PRICES).
const PRICE = { "claude-opus-5-5": [4, 20], "claude-sonnet-5-5": [2, 10] };
const TEXT_MIN = 15;
const TEXT_MAX = 1500;
const SHOW = 8; // books on an answer
const GUEST_DAY = 3; // asks a day from one guest address
const READER_DAY = 10; // asks a day from one reader
const ALL_DAY = 200; // fresh answers a day, everyone together
const KEEP_DAYS = 180; // an answer nobody opened for this long goes

const SCHEMA = `CREATE TABLE IF NOT EXISTS ask_recs (
  id TEXT PRIMARY KEY, text TEXT NOT NULL, key TEXT NOT NULL, reader TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'wait', intro TEXT NOT NULL DEFAULT '', items TEXT NOT NULL DEFAULT '[]',
  missed TEXT NOT NULL DEFAULT '[]', model TEXT NOT NULL DEFAULT '', input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0, ms INTEGER NOT NULL DEFAULT 0, seen TEXT NOT NULL DEFAULT '', views INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ask_recs_key ON ask_recs (key);
CREATE INDEX IF NOT EXISTS ask_recs_created ON ask_recs (created);`;

const SYSTEM = `You are a well-read friend on Chytai, a Ukrainian site about books. Someone tells you, in their own words, what they have read and liked, and often what they would like next. Recommend books for them to read next.

Answer with one JSON object and nothing else:
{"intro": "...", "off": false, "books": [{"title_uk": "...", "author_uk": "...", "title": "...", "author": "...", "series": "...", "why": "..."}]}

- books: 15 books, the best fit first. Each is a real, published book. Name the Ukrainian edition when there is one: title_uk and author_uk exactly as the Ukrainian edition prints them (for example «Чоловіки, які ненавидять жінок», «Стіг Ларссон»); empty strings when you are not sure a Ukrainian edition exists. title and author: the original title and the author's name in the original language.
- Prefer books that have been published in Ukrainian. Ukrainian authors are welcome where they truly fit. Never a Russian author, and never a book that exists only in Russian.
- When they ask for series, or loved a series, recommend series and name the first book of each (series: the series' name in Ukrainian, else in the original). A book outside a series: series is "".
- Never a book or a series they say they have already read, and at most one book by any one author.
- Follow what they actually liked: if it is the people, the mood, the setting or the profession at the centre of it, find that, not just the genre.
- why: one short sentence in Ukrainian, at most 18 words: what this book shares with what they liked or asked for, concretely. No spoilers, no praise words like «неймовірний», «must read», «шедевр».
- intro: one short sentence in Ukrainian, addressed to the reader as «ви», on the thread that runs through the picks. No greeting, no «Ось», no exclamation.
- If the text is not about books or reading at all, answer with an empty intro, no books and "off": true; otherwise "off" is false.`;

const str = { type: "string" };
const OUT_SCHEMA = {
  type: "object",
  properties: {
    intro: str,
    off: { type: "boolean" },
    books: { type: "array", items: { type: "object", properties: { title_uk: str, author_uk: str, title: str, author: str, series: str, why: str }, required: ["title_uk", "author_uk", "title", "author", "series", "why"], additionalProperties: false } },
  },
  required: ["intro", "books", "off"],
  additionalProperties: false,
};
// The second question: a recommended book we lack, and this author's books we have.
const PICK = `Book recommendations were made for a reader, but our catalog lacks the exact books named. For each one, the books our catalog has by the same author are listed. Pick the listed book that serves that recommendation best: for a series, its first book if it is listed, else the earliest listed volume of the same series; for a book outside a series, another listed book by the author only if it would suit the same reader just as well. If no listed book fits, pick 0. Answer with JSON: {"picks": [{"rec": <recommendation number>, "book": <listed book number or 0>}]}.`;
const PICK_SCHEMA = {
  type: "object",
  properties: { picks: { type: "array", items: { type: "object", properties: { rec: { type: "integer" }, book: { type: "integer" } }, required: ["rec", "book"], additionalProperties: false } } },
  required: ["picks"],
  additionalProperties: false,
};
const now = () => new Date().toISOString();
const keyOf = (text) => norm(text).replace(/\s+/g, " ").trim();
const hash = (s) => crypto.createHash("sha256").update(`ask:${s}`).digest("hex").slice(0, 24);
const clean = (s, n) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);

class Ask {
  // store: Store; ukWork(book): its Ukrainian edition; notify(row): a line to the owner about a new ask.
  constructor(store, { apiKey = "", ukWork = (b) => b, notify = () => {}, log = console.log, client = null } = {}) {
    this.store = store;
    this.db = store.db;
    this.db.exec(SCHEMA);
    this.client = client || (apiKey ? new (require("@anthropic-ai/sdk"))({ apiKey }) : null);
    this.ukWork = ukWork;
    this.notify = notify;
    this.log = log;
    this.running = new Set();
  }

  get(id) {
    const r = /^[a-z0-9]{6,16}$/.test(id || "") ? this.db.prepare("SELECT * FROM ask_recs WHERE id = ?").get(id) : null;
    return r ? { ...r, items: JSON.parse(r.items || "[]"), missed: JSON.parse(r.missed || "[]") } : null;
  }
  // An answer was opened: kept for another half year from now.
  opened(id) {
    this.db.prepare("UPDATE ask_recs SET seen = ?, views = views + 1 WHERE id = ?").run(now(), id);
  }

  // ask({ text, reader, ip, owner }) -> { id } or { error }. The answer itself comes a little later (run()).
  ask({ text, reader = "", ip = "", owner = false }) {
    text = String(text || "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
    if (text.length < TEXT_MIN) return { error: "Напишіть трохи більше: що читали і що сподобалось." };
    if (text.length > TEXT_MAX) return { error: `Задовго: до ${TEXT_MAX} знаків.` };
    const key = keyOf(text);
    const kept = this.db.prepare("SELECT id FROM ask_recs WHERE key = ? AND status = 'done' ORDER BY created DESC LIMIT 1").get(key);
    if (kept) return { id: kept.id };
    if (!this.client) return { error: "Порада зараз не працює. Спробуйте пізніше." };
    const day = now().slice(0, 10);
    const ipKey = ip ? hash(ip) : "";
    if (!owner) {
      const count = (where, ...args) => this.db.prepare(`SELECT COUNT(*) AS n FROM ask_recs WHERE created >= ? AND ${where}`).get(day, ...args).n;
      if (count("1 = 1") >= ALL_DAY) return { error: "На сьогодні порад досить. Завтра можна знову." };
      if (reader ? count("reader = ?", reader) >= READER_DAY : count("ip = ? AND reader = ''", ipKey) >= GUEST_DAY) return { error: "На сьогодні порад досить. Завтра можна знову." };
    }
    const id = crypto.randomBytes(5).toString("hex");
    this.db.prepare("INSERT INTO ask_recs (id, text, key, reader, ip, created, seen) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, text, key, reader, ipKey, now(), now());
    this.run(id).catch((e) => this.log(`ask ${id}: ${e.message}`));
    return { id };
  }

  async run(id) {
    if (this.running.has(id)) return;
    this.running.add(id);
    const row = this.get(id);
    const t = Date.now();
    try {
      const out = await this.claude(row.text);
      const { items, missed, extra } = await this.match(out.books, { model: out.model });
      for (const k of ["input", "output", "cost"]) out[k] += extra[k];
      this.db
        .prepare("UPDATE ask_recs SET status = ?, intro = ?, items = ?, missed = ?, model = ?, input_tokens = ?, output_tokens = ?, cost = ?, ms = ? WHERE id = ?")
        .run(out.off ? "off" : items.length ? "done" : "none", clean(out.intro, 400), JSON.stringify(items), JSON.stringify(missed), out.model, out.input, out.output, out.cost, Date.now() - t, id);
      this.log(`ask ${id}: ${items.length} of ${(out.books || []).length} in the catalog, ${Date.now() - t} ms, $${out.cost.toFixed(3)}`);
      this.notify(this.get(id));
    } catch (e) {
      this.db.prepare("UPDATE ask_recs SET status = 'fail', ms = ? WHERE id = ?").run(Date.now() - t, id);
      throw e;
    } finally {
      this.running.delete(id);
    }
  }

  // One call that answers JSON in `schema`: { j, input, output, cost }.
  async json(system, user, schema, model) {
    const res = await this.client.messages.create({
      model,
      max_tokens: 4000,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
      // Valid JSON every time (a «"» inside a title broke a hand-parsed answer); low effort: it is recall, not reasoning.
      output_config: { effort: "low", format: { type: "json_schema", schema } },
    });
    if (res.stop_reason === "refusal") throw new Error(`refusal ${res.stop_details?.category || ""}`);
    const raw = res.content.map((c) => c.text || "").join("");
    const u = res.usage || {};
    const [pi, po] = PRICE[model] || PRICE[MODEL];
    const input = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    return { j: JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)), input, output: u.output_tokens || 0, cost: (input * pi + (u.output_tokens || 0) * po) / 1e6 };
  }

  // What Claude recommends for this text: { intro, books, off, model, input, output, cost }.
  async claude(text, { model = MODEL } = {}) {
    const { j, input, output, cost } = await this.json(SYSTEM, text, OUT_SCHEMA, model);
    return { intro: j.intro || "", books: Array.isArray(j.books) ? j.books.slice(0, 20) : [], off: !!j.off, model, input, output, cost };
  }

  // Claude's books that our catalog has, as { id, why, series }, the Ukrainian edition, one per series and author, in
  // Claude's order; the rest as { title, author } in `missed` (the owner sees them, readers don't). A book we lack by
  // an author we have (Несбьо's «Сніговик», Кеплер's «Ловець») gets a second, short question: which of this author's
  // books here serves the same recommendation (the series' first book, usually). `extra`: what that question cost.
  async match(books, { model = MODEL } = {}) {
    const s = this.store;
    const extra = { input: 0, output: 0, cost: 0 };
    const rows = (books || []).map((b) => {
      const want = { uk: clean(b.title_uk, 200), ua: clean(b.author_uk, 200), en: clean(b.title, 200), ea: clean(b.author, 200) };
      return { b, want, id: this.usable(this.find(want)) };
    });
    const lack = rows.filter((r) => !r.id).map((r) => ({ r, own: this.authorBooks(r.want) })).filter((x) => x.own.length);
    if (lack.length && this.client) {
      const list = lack
        .map((x, i) => [`${i + 1}. «${x.r.want.uk || x.r.want.en}» by ${x.r.want.ua || x.r.want.ea}${x.r.b.series ? `, series «${x.r.b.series}»` : ""}. Why: ${x.r.b.why}`, "Our books by this author:", ...x.own.map((b, k) => `  ${k + 1}) ${b.title}`)].join("\n"))
        .join("\n\n");
      try {
        const out = await this.json(PICK, list, PICK_SCHEMA, model);
        for (const k of ["input", "output", "cost"]) extra[k] += out[k];
        for (const p of out.j.picks || []) {
          const x = lack[p.rec - 1];
          const b = x && x.own[p.book - 1];
          if (b && !x.r.id) x.r.id = this.usable(b.id);
        }
      } catch (e) {
        this.log(`ask: second pass failed: ${e.message}`);
      }
    }
    const items = [];
    const missed = [];
    const used = new Set();
    const authors = [];
    for (const { b, want, id: found } of rows) {
      if (!found) {
        missed.push({ title: want.uk || want.en, author: want.ua || want.ea });
        continue;
      }
      let id = found;
      // A later volume gives way to the series' first one, when we have it.
      const start = s.seriesStart(id);
      if (start && start !== id && s.book(start)) id = start;
      const key = s.cycleKey?.(id) || id;
      if (used.has(key) || used.has(id) || authors.some((a) => sameAuthor(a, s.book(id).author || ""))) continue;
      used.add(key).add(id);
      if (s.book(id).author) authors.push(s.book(id).author);
      items.push({ id, why: clean(b.why, 300), series: clean(b.series, 120) });
      if (items.length >= SHOW) break;
    }
    return { items, missed, extra };
  }

  // The Ukrainian edition's canonical id, or null for a book we can't show (none, Russian).
  usable(id) {
    const book = id && this.ukWork(this.store.book(id));
    return book && !isRussian(book) ? this.store.canonical(book.id) : null;
  }

  // The books of this author that our catalog has (Ukrainian editions, at most 30), for the second question.
  authorBooks({ ua, ea }) {
    const s = this.store;
    const au = (ua && s.authors?.byName(ua)) || (ea && s.authors?.byName(ea));
    const ids = [...new Set((au?.ids || []).map((i) => this.usable(i)).filter(Boolean))];
    const all = ids.map((id) => s.book(id)).filter((b) => b && b.title);
    // An original next to Ukrainian editions is left out («Blood on Snow» beside «Кров на снігу»).
    const cyr = all.filter((b) => /[а-яіїєґ]/i.test(b.title));
    return (cyr.length ? cyr : all).slice(0, 30);
  }

  // The work in our catalog: by the Ukrainian title and author, then the original's; then a search that finds a
  // shop's longer title («Хірург. Книга 1») by the same author.
  find({ uk, ua, en, ea }) {
    const s = this.store;
    const tries = [uk && ua && { title: uk, author: ua }, uk && ea && { title: uk, author: ea }, en && ea && { title: en, author: ea }, en && ua && { title: en, author: ua }].filter(Boolean);
    for (const t of tries) {
      const id = s.findWork(t);
      if (id) return id;
    }
    const t0 = norm(uk || en);
    if (t0.length < 3) return null;
    for (const [title, author] of [[uk, ua || ea], [en, ea || ua]]) {
      if (!title || !author) continue;
      const hit = (s.search(title, { limit: 10 }) || []).map((x) => x.book || x).find((b) => b && b.author && sameAuthor(author, b.author) && norm(b.title).startsWith(norm(title)));
      if (hit) return hit.id;
    }
    return null;
  }

  // Answers nobody opened for half a year go (CLAUDE.md: nothing grows without bound).
  cleanup() {
    const before = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString();
    return this.db.prepare("DELETE FROM ask_recs WHERE seen < ?").run(before).changes;
  }

  // For the owner: how many asks, answers and dollars today and in all.
  stats() {
    const day = now().slice(0, 10);
    return this.db.prepare("SELECT COUNT(*) AS n, SUM(created >= ?) AS today, ROUND(SUM(cost), 2) AS cost, SUM(views) AS views FROM ask_recs").get(day);
  }
}

module.exports = { Ask, SYSTEM, MODEL };

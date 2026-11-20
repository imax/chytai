// «Про книжку» that helps to read (Max 2026-11-18, «Level up your reading»): for a book, what it is and why it is
// worth reading (Opus, once a book, made when the book or «Про книжку» first opens). And «Перед главою» (Max 2026-11-19, in place of the
// recap «де ви зупинилися / що було досі / хто тут хто», which only retold what he had read the day before): a few
// notes for the chapter the reader is in, like a good annotated edition's: the history, customs, references and
// earlier threads it rests on. Never what happens in it or later, never about the reader («самопомічник», not
// «ти міг це пропустити»). The page shows it as a small card when a book opens (renderer.js `intro`).
//
// A chapter is a file of the book's spine; a long one is cut into pieces of PIECE characters. Everything is kept by
// the book's text (same file = same notes, whoever reads it): DATA_DIR/guide/<key>.json
// { key, before, intros: {"<chapter>:<piece>": {v, notes, at}} }. A file not used for 180 days goes.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Anthropic = require("@anthropic-ai/sdk");
const { partsOf } = require("./glossary");
const { epubParts } = require("./content");
const { measure } = require("./aimeter");

const BEFORE_MODEL = "claude-opus-5-5";
const INTRO_MODEL = "claude-opus-5-5";
const PIECE = 24000; // characters: a longer chapter gets notes for each piece
const SHORT = 1500; // a chapter shorter than this (a title page, an epigraph) gets none
const BEHIND = 8000; // characters before the piece that the model sees as read
const INTRO_V = 1; // notes made with an older prompt are made again
const INTROS_MAX = 400; // kept pieces a book
const UNUSED_DAYS = 180;
const PAGE = 1800; // characters of a printed page

const BEFORE = `A reader is about to start a book that may feel hard. Below are its title, author, the publisher's description if there is one, and its opening.
Answer in Ukrainian whatever the book's language, in plain everyday words, as a friend who knows books would. No spoilers: nothing past the first chapter.
If you know this book, use what you know about it; if you don't, judge only from the opening and never invent facts about the author, the year or the book.
Speak about the book, never about the reader: no «ви», no advice how to read it, no «не бійтеся», no «зверніть увагу». Plain statements.
Answer with JSON only:
{"about": "2–3 short sentences: what kind of book it is, who wrote it and when if you know, when and where it takes place", "worth": "1–2 short sentences: what is interesting in it and makes it worth reading (its people, language, idea, its place in literature, why it still matters); nothing the first part already says"}`;
// v2 (Max 2026-11-20): «Про книжку» + «Чому варто читати»; «Як читати», the level and pages went (condescending). A v1 answer
// ({why, how}) shows its `why` as «Про книжку» while the book's v2 is made.
const BEFORE_V = 2;

const INTRO = `A reader is reading a book that may feel hard and is about to read the passage below. Write a few notes that make it easier to read, like the notes of a good annotated edition, read before the passage.
Only what the passage rests on and a reader of today may not know: a real historical person, place or event as it was at that moment, an old custom, institution, object or social rule, a reference to another text (the Bible, a myth, a book), a person or thread from earlier in the book the passage picks up, a change of narrator, time or place.
Never what happens in the passage or later: no events, turns or outcomes, no hints that something will matter («варто помітити», «зверніть увагу», «це ще знадобиться», «має значення»), nothing from history that gives away how the story goes.
Speak about the book, never about the reader: no «ви», no «ви могли не знати», no «пам'ятаєте», no advice how to read. Plain statements, as a footnote would.
Skip what an ordinary adult knows and what the passage itself explains. If nothing is worth a note, answer with an empty list.
Answer in Ukrainian whatever the book's language, in plain everyday words. At most 3 notes, each a heading of 1–4 words (a name or a thing, never a question) and one or two sentences, at most 35 words.
JSON only: {"notes": [["heading", "text"]]}`;

const json = (text) => {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no JSON in the answer");
  return JSON.parse(m[0]);
};
const textOf = (m) => m.content.filter((c) => c.type === "text").map((c) => c.text).join("");
const line = (s, max) => String(s || "").replace(/\s+/g, " ").trim().slice(0, max);
const flat = (s) => s.replace(/\s+/g, " ").trim();
// Without stress marks («ве́рхи»): the page's first words and the book's text compare equal.
const plain = (s) => String(s).normalize("NFD").replace(/\u0301/g, "").normalize("NFC");

class Guide {
  constructor({ dir, apiKey }) {
    this.dir = dir;
    this.apiKey = apiKey;
    this.running = new Map(); // key -> { what, done, of, error }
    this.failed = new Map(); // key + what -> time: not again for 10 minutes
    this.unitsKept = new Map(); // file -> { mtime, units }
    fs.mkdirSync(dir, { recursive: true });
  }
  file(key) {
    return path.join(this.dir, `${key}.json`);
  }
  read(key) {
    try {
      const f = this.file(key);
      const g = JSON.parse(fs.readFileSync(f, "utf8"));
      // Used: the cleanup counts from the last day a reader asked.
      const t = fs.statSync(f).mtimeMs;
      if (Date.now() - t > 86400000) fs.utimesSync(f, new Date(), new Date());
      return g;
    } catch {
      return null;
    }
  }
  write(g) {
    const f = this.file(g.key);
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(g));
    fs.renameSync(`${f}.tmp`, f);
  }
  // Files no reader asked for in UNUSED_DAYS.
  cleanup() {
    let gone = 0;
    for (const n of fs.readdirSync(this.dir)) {
      const f = path.join(this.dir, n);
      try {
        if (Date.now() - fs.statSync(f).mtimeMs > UNUSED_DAYS * 86400000) fs.unlinkSync(f), gone++;
      } catch {}
    }
    return gone;
  }

  // The book's key: its text, so the same file is one guide for every reader who has it.
  async book(file) {
    const p = await partsOf(file);
    if (!p.parts.length) return null;
    const key = crypto.createHash("sha1").update(`${p.total}\n${p.parts[0].slice(0, 4000)}\n${p.parts.at(-1).slice(-2000)}`).digest("hex").slice(0, 24);
    return { ...p, key };
  }

  // The book's chapters as the notes see them: each spine file with its href, cut into pieces of PIECE characters
  // at a sentence's end. Kept for the last few files read (the same as the glossary's parts).
  async units(file) {
    const mtime = fs.statSync(file).mtimeMs;
    const kept = this.unitsKept.get(file);
    if (kept?.mtime === mtime) return kept.units;
    const { chapters, hrefs, meta } = await epubParts(fs.readFileSync(file));
    const units = [];
    units.meta = meta;
    let at = 0;
    chapters.forEach((raw, ch) => {
      const text = plain(raw);
      let from = 0;
      let piece = 0;
      while (from < text.length) {
        let end = Math.min(text.length, from + PIECE);
        if (end < text.length) {
          const cut = Math.max(text.lastIndexOf(". ", end), text.lastIndexOf("! ", end), text.lastIndexOf("? ", end));
          if (cut > from + PIECE / 2) end = cut + 1;
          if (text.length - end < PIECE / 4) end = text.length; // no short tail of its own
        }
        units.push({ ch, piece, href: hrefs?.[ch] || "", text: text.slice(from, end), start: at + from });
        from = end;
        piece++;
      }
      at += text.length;
    });
    if (this.unitsKept.size > 8) this.unitsKept.delete(this.unitsKept.keys().next().value);
    this.unitsKept.set(file, { mtime, units });
    return units;
  }

  // Which piece the reader is in: the chapter's file (the page's href), then the page's first words in it; without
  // the href, the first words near the percentage, else the percentage.
  find(units, { href, snip, pct }) {
    const total = units.length ? units.at(-1).start + units.at(-1).text.length : 0;
    const s = flat(plain(String(snip || ""))).slice(0, 60);
    const name = decodeURIComponent(String(href || "").split("#")[0]).replace(/^\.?\//, "");
    let pool = name ? units.filter((u) => u.href && (u.href === name || u.href.endsWith(`/${name}`) || name.endsWith(`/${u.href}`))) : [];
    if (!pool.length) {
      if (!Number.isFinite(pct)) return null;
      const guess = (Math.min(100, Math.max(0, pct)) / 100) * total;
      pool = units.filter((u) => u.start + u.text.length > guess - total * 0.08 && u.start < guess + total * 0.08);
      if (!pool.length) return units.find((u) => u.start + u.text.length > guess) || units.at(-1) || null;
      if (s.length < 20) return pool.find((u) => u.start + u.text.length > guess) || pool[0];
    }
    if (pool.length > 1 && s.length >= 20) {
      const hit = pool.find((u) => flat(u.text).includes(s));
      if (hit) return hit;
    }
    return pool[0];
  }

  // What «Про книжку» shows: { pages, before, building, capped, error }; «Перед читанням» is made the first time.
  async get(file, { title, authors, blurb, allow = () => true, spend = () => {} }) {
    const p = await this.book(file);
    if (!p) return { none: true };
    const g = this.read(p.key) || { key: p.key };
    const out = { pages: Math.max(1, Math.round(p.total / PAGE)), before: g.before || null };
    if (g.before?.v === BEFORE_V || !this.apiKey) return out;
    const run = this.busy(p.key, "before");
    if (run) return { ...out, building: run };
    if (!this.may(p.key, "before")) return { ...out, error: true };
    if (!allow()) return { ...out, capped: true };
    this.start(p.key, "before", 1, () => this.makeBefore(p, { title, authors, blurb, spend }));
    return { ...out, building: { what: "before", done: 0, of: 1 } };
  }

  // «Перед главою» for the reader's place: { intro: {key, notes} } when made (notes may be [] = nothing worth a note),
  // { building }, { none } (a short chapter, no text), { capped }, { error }. `ahead`: when the place is in the last
  // third of its piece, the next piece is made too (the reader leaving the book near a chapter's end opens the next).
  async intro(file, { href, snip, pct, title, authors, ahead = false, allow = () => true, spend = () => {} }) {
    const p = await this.book(file);
    if (!p) return { none: true };
    const units = await this.units(file);
    const u = this.find(units, { href, snip, pct: Number(pct) });
    if (!u) return { none: true };
    const want = [u];
    if (ahead) {
      const s = flat(plain(String(snip || ""))).slice(0, 60);
      const off = s.length >= 20 ? flat(u.text).indexOf(s) : -1;
      const next = units[units.indexOf(u) + 1];
      if (next && off > flat(u.text).length * 0.66) want.push(next);
    }
    const g = this.read(p.key) || { key: p.key };
    const k = (x) => `${x.ch}:${x.piece}`;
    const kept = g.intros?.[k(u)];
    const missing = want.filter((x) => x.text.length >= SHORT && g.intros?.[k(x)]?.v !== INTRO_V);
    const out = u.text.length < SHORT ? { none: true } : kept?.v === INTRO_V ? { intro: { key: `${p.key}:${k(u)}`, notes: kept.notes } } : {};
    if (!missing.length || !this.apiKey) return out;
    const run = this.busy(p.key, `intro:${k(missing[0])}`);
    if (run) return out.intro ? out : { ...out, building: run };
    if (!this.may(p.key, `intro:${k(missing[0])}`)) return out.intro || out.none ? out : { error: true };
    if (!allow()) return out.intro || out.none ? out : { capped: true };
    for (const x of missing) {
      if (this.busy(p.key, `intro:${k(x)}`)) continue;
      this.start(p.key, `intro:${k(x)}`, 1, () => this.makeIntro(p, units, x, { title, authors, allow, spend }));
    }
    return out.intro || out.none ? out : { building: { what: "intro", done: 0, of: 1 } };
  }
  busy(key, what) {
    const run = this.running.get(`${key}:${what}`);
    return run && !run.done ? { what, done: run.n, of: run.of } : null;
  }
  may(key, what) {
    const t = this.failed.get(`${key}:${what}`);
    return !t || Date.now() - t > 600000;
  }
  start(key, what, of, work) {
    const run = { n: 0, of, done: false };
    const id = `${key}:${what}`;
    this.running.set(id, run);
    work(run)
      .catch((err) => {
        run.error = err.message;
        this.failed.set(id, Date.now());
        console.error(`guide ${what} ${key}: ${err.message}`);
      })
      .finally(() => {
        run.done = true;
        if (this.failed.size > 500) this.failed.clear();
        setTimeout(() => this.running.get(id) === run && this.running.delete(id), 60000);
      });
  }
  client() {
    return new Anthropic({ apiKey: this.apiKey });
  }

  async makeBefore(p, { title, authors, blurb, spend }) {
    blurb = typeof blurb === "function" ? await blurb().catch(() => "") : blurb;
    const head = [`Назва: ${title || "?"}`, `Автор: ${(authors || []).join(", ") || "?"}`, blurb ? `Опис видавця: ${line(blurb, 1500)}` : "", `Обсяг: близько ${Math.round(p.total / PAGE)} сторінок`].filter(Boolean).join("\n");
    const m = await this.client().messages.create({
      model: BEFORE_MODEL,
      max_tokens: 2000,
      system: BEFORE,
      messages: [{ role: "user", content: `${head}\n\nПочаток книжки:\n${p.parts[0].slice(0, 12000)}` }],
      output_config: { effort: "low" },
    });
    spend(measure(m.model, m.usage).cost);
    const a = json(textOf(m));
    const before = { v: BEFORE_V, about: line(a.about, 700), worth: line(a.worth, 500), at: new Date().toISOString() };
    if (!before.about) throw new Error("empty answer");
    const g = this.read(p.key) || { key: p.key };
    g.before = before;
    this.write(g);
  }

  async makeIntro(p, units, u, { title, authors, allow, spend }) {
    const i = units.indexOf(u);
    let behind = "";
    for (let j = i - 1; j >= 0 && behind.length < BEHIND; j--) behind = `${units[j].text}\n\n${behind}`;
    behind = behind.slice(-BEHIND);
    const head = [`Назва: ${title || units.meta?.title || "?"}`, `Автор: ${(authors?.length ? authors : units.meta?.authors || []).join(", ") || "?"}`].join("\n");
    if (!allow()) throw new Error("capped");
    const m = await this.client().messages.create({
      model: INTRO_MODEL,
      max_tokens: 1500,
      system: INTRO,
      messages: [{ role: "user", content: `${head}\n\n${behind ? `Прочитане перед цим (кінець):\n${behind}\n\n` : ""}Уривок, який читач починає:\n${u.text}` }],
      output_config: { effort: "low" },
    });
    spend(measure(m.model, m.usage).cost);
    const a = json(textOf(m));
    const notes = (Array.isArray(a.notes) ? a.notes : []).filter((x) => Array.isArray(x) && x[0] && x[1]).slice(0, 3).map((x) => [line(x[0], 60), line(x[1], 400)]);
    const g = this.read(p.key) || { key: p.key };
    const intros = (g.intros ??= {});
    intros[`${u.ch}:${u.piece}`] = { v: INTRO_V, notes, at: new Date().toISOString() };
    const keys = Object.keys(intros);
    if (keys.length > INTROS_MAX) for (const k of keys.sort((x, y) => (intros[x].at < intros[y].at ? -1 : 1)).slice(0, keys.length - INTROS_MAX)) delete intros[k];
    delete g.recaps; // the recap's leftovers (before 2026-11-19)
    delete g.parts;
    this.write(g);
  }
}

module.exports = { Guide, BEFORE, INTRO, PIECE };

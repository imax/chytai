// «Про книжку» that helps to read (Max 2026-11-18, «Level up your reading»): before a book is started, «Перед
// читанням»: why it is worth it, how to read it, how hard it is (Opus, once a book); once it is started, a recap up to
// the reader's place: where they stopped, what happened before, who is who (Max: «нагадує, де ти зупинився, що було до
// цього, хто тут такі персонажі»). Never a word about what comes after the place.
//
// The recap is made of summaries of the book's parts (the glossary's 15,000-character parts, Sonnet, once a part),
// and one Opus call that turns the parts read plus the current part up to the place into the recap. Everything is
// kept by the book's text (same file = same guide, whoever reads it): DATA_DIR/guide/<key>.json
// { key, of, total, before, parts: {i: summary}, recaps: {"<part>:<step>": recap} }. A file not used for 180 days goes.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Anthropic = require("@anthropic-ai/sdk");
const { partsOf } = require("./glossary");
const { measure } = require("./aimeter");

const BEFORE_MODEL = "claude-opus-5-5";
const PART_MODEL = "claude-sonnet-5-5";
const RECAP_MODEL = "claude-opus-5-5";
const AT_ONCE = 6; // part summaries at the same time
const STEP = 2500; // characters: readers within one step of a part share a recap
const RECAPS_MAX = 120; // kept recaps a book
const UNUSED_DAYS = 180;
const PAGE = 1800; // characters of a printed page

const BEFORE = `A reader is about to start a book that may feel hard. Below are its title, author, the publisher's description if there is one, and its opening.
Answer in Ukrainian whatever the book's language, in plain everyday words, as a friend who knows books would. No spoilers: nothing past the first chapter.
If you know this book, use what you know about it; if you don't, judge only from the opening and never invent facts about the author, the year or the book.
Answer with JSON only:
{"why": "2–3 short sentences: what kind of book it is, who wrote it and when if you know, why it is worth reading", "how": "2–3 short sentences: what may be hard in it (style, language, structure, many people, the era) and one concrete tip how to read it", "level": a whole number 1–10, how hard it is for an ordinary adult reader (1 = a light novel, 5 = a usual classic, 10 = «Улісс»)}`;

const PART = `Below is one passage of a book. Summarise it for a recap that a reader will see when they come back to the book.
Answer in Ukrainian whatever the book's language, in plain words. First, what happens in the passage, in order, 3–6 short sentences, naming who does what (for an essay or non-fiction: its main thoughts). Then a line «Люди:» and each person who appears or is spoken of, one per line: the name as the book writes it, a dash, who they are as far as this passage shows, a few words. Nothing else.`;

const RECAP = `A reader stopped reading a book at some place and comes back to it days later. Below are numbered summaries of the parts they read before, then the text of the current part up to the exact place where they stopped (the text ends there).
Write a recap for someone who forgot the details. Answer in Ukrainian whatever the book's language, in plain everyday words. Never mention or hint at anything after the place where they stopped, even if you know the book.
Answer with JSON only:
{"where": "1–2 short sentences: what is happening right at the place where they stopped, the last scene", "story": "what happened before, 4–8 short sentences in order, the main line only", "people": [["name as the book writes it", "who they are and what matters about them so far, up to 10 words"]]}
"people" has the 3–8 people who matter most so far; for an essay or non-fiction it may be empty, and "story" then gives the main thoughts so far.`;

const json = (text) => {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no JSON in the answer");
  return JSON.parse(m[0]);
};
const textOf = (m) => m.content.filter((c) => c.type === "text").map((c) => c.text).join("");
const line = (s, max) => String(s || "").replace(/\s+/g, " ").trim().slice(0, max);
const flat = (s) => s.replace(/\s+/g, " ").trim();

class Guide {
  constructor({ dir, apiKey }) {
    this.dir = dir;
    this.apiKey = apiKey;
    this.running = new Map(); // key -> { what, done, of, error }
    this.failed = new Map(); // key + what -> time: not again for 10 minutes
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

  // Where the reader is, in characters: the page's first words found near the percentage, else the percentage.
  place(p, pct, snip) {
    const guess = Math.round((Math.min(100, Math.max(0, pct)) / 100) * p.total);
    const s = flat(String(snip || "").normalize("NFD").replace(/\u0301/g, "").normalize("NFC")).slice(0, 60);
    if (s.length >= 20) {
      const starts = [0, ...p.ends.slice(0, -1)];
      const from = guess - p.total * 0.08;
      const to = guess + p.total * 0.08;
      let best = -1;
      for (let i = 0; i < p.parts.length; i++) {
        if (p.ends[i] < from || starts[i] > to) continue;
        const t = flat(p.parts[i]);
        for (let at = t.indexOf(s); at >= 0; at = t.indexOf(s, at + 1)) {
          const pos = starts[i] + at;
          if (best < 0 || Math.abs(pos - guess) < Math.abs(best - guess)) best = pos;
        }
      }
      if (best >= 0) return best;
    }
    return guess;
  }

  // What the page shows now, and the work it starts in the background: { pages, before, recap, building, capped }.
  // `recap`: the reader has started (pct, snip), and «Перед читанням» is not made then; `blurb`: the catalog's
  // description for «Перед читанням».
  async get(file, { title, authors, blurb, pct, snip, recap: wantRecap, allow = () => true, spend = () => {} }) {
    const p = await this.book(file);
    if (!p) return { none: true };
    const g = this.read(p.key) || { key: p.key, of: p.parts.length, total: p.total, parts: {}, recaps: {} };
    const out = { pages: Math.max(1, Math.round(p.total / PAGE)), before: g.before || null };
    if (!wantRecap) {
      if (g.before || !this.apiKey) return out;
      const run = this.busy(p.key, "before");
      if (run) return { ...out, building: run };
      if (!this.may(p.key, "before")) return { ...out, error: true };
      if (!allow()) return { ...out, capped: true };
      this.start(p.key, "before", 1, () => this.makeBefore(p, { title, authors, blurb, spend }));
      return { ...out, building: { what: "before", done: 0, of: 1 } };
    }
    const pos = this.place(p, pct, snip);
    const i = Math.max(0, p.ends.findIndex((e) => e > pos));
    const starts = [0, ...p.ends.slice(0, -1)];
    const off = pos - starts[i];
    const rkey = `${i}:${Math.floor(off / STEP)}`;
    if (g.recaps[rkey]) return { ...out, recap: g.recaps[rkey] };
    if (i === 0 && off < 1500) return { ...out, early: true }; // a page or so in: nothing to recall yet
    // The nearest recap before this place stays on screen while the new one is made.
    const num = (k) => k.split(":").map(Number);
    const older = Object.keys(g.recaps)
      .filter((k) => { const [a, b] = num(k); return a < i || (a === i && b * STEP < off); })
      .sort((x, y) => { const [a, b] = num(x); const [c, d] = num(y); return c - a || d - b; })[0];
    if (older) out.recap = { ...g.recaps[older], older: true };
    if (!this.apiKey) return out;
    const run = this.busy(p.key, "recap");
    if (run) return { ...out, building: run };
    if (!this.may(p.key, "recap")) return { ...out, error: true };
    if (!allow()) return { ...out, capped: true };
    const missing = [];
    for (let k = 0; k < i; k++) if (!g.parts[k]) missing.push(k);
    this.start(p.key, "recap", missing.length + 1, (r) => this.makeRecap(p, { i, off, rkey, missing, allow, spend, run: r }));
    return { ...out, building: { what: "recap", done: 0, of: missing.length + 1 } };
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
    const level = Math.round(Number(a.level));
    const before = { why: line(a.why, 700), how: line(a.how, 700), level: level >= 1 && level <= 10 ? level : null, at: new Date().toISOString() };
    if (!before.why) throw new Error("empty answer");
    const g = this.read(p.key) || { key: p.key, of: p.parts.length, total: p.total, parts: {}, recaps: {} };
    g.before = before;
    this.write(g);
  }

  async makeRecap(p, { i, off, rkey, missing, allow, spend, run }) {
    const client = this.client();
    const got = {};
    let at = 0;
    const worker = async () => {
      while (at < missing.length) {
        const k = missing[at++];
        if (!allow()) throw new Error("capped");
        const m = await client.messages.create({
          model: PART_MODEL,
          max_tokens: 1500,
          system: [{ type: "text", text: PART, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: p.parts[k] }],
          output_config: { effort: "low" },
        });
        spend(measure(m.model, m.usage).cost);
        got[k] = textOf(m).trim().slice(0, 3000);
        run.n++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(AT_ONCE, missing.length) }, worker));
    let g = this.read(p.key) || { key: p.key, of: p.parts.length, total: p.total, parts: {}, recaps: {} };
    Object.assign(g.parts, got);
    this.write(g); // the summaries are paid for: kept even if the last call fails
    const before = Array.from({ length: i }, (_, k) => `${k + 1}. ${g.parts[k] || ""}`).join("\n\n");
    const now = p.parts[i].slice(Math.max(0, off - 14000), off);
    if (!allow()) throw new Error("capped");
    const m = await client.messages.create({
      model: RECAP_MODEL,
      max_tokens: 2500,
      system: RECAP,
      messages: [{ role: "user", content: `${before ? `Прочитані частини:\n\n${before}\n\n` : ""}Поточна частина до місця, де читач зупинився:\n\n${now}` }],
      output_config: { effort: "low" },
    });
    spend(measure(m.model, m.usage).cost);
    const a = json(textOf(m));
    const recap = {
      where: line(a.where, 600),
      story: line(a.story, 1600),
      people: (Array.isArray(a.people) ? a.people : []).filter((x) => Array.isArray(x) && x[0]).slice(0, 10).map((x) => [line(x[0], 60), line(x[1], 140)]),
      pct: Math.round(((p.ends[i] - p.parts[i].length + off) / p.total) * 100),
      at: new Date().toISOString(),
    };
    if (!recap.where && !recap.story) throw new Error("empty answer");
    run.n++;
    g = this.read(p.key) || g;
    g.recaps[rkey] = recap;
    const keys = Object.keys(g.recaps);
    if (keys.length > RECAPS_MAX) for (const k of keys.sort((x, y) => (g.recaps[x].at < g.recaps[y].at ? -1 : 1)).slice(0, keys.length - RECAPS_MAX)) delete g.recaps[k];
    this.write(g);
  }
}

module.exports = { Guide, BEFORE, PART, RECAP, STEP };

// «AI-рекомендація» («Чи варто мені читати?») on a book's page (Max, 2026-10-23): on a click, not by itself, Claude looks at the
// reader's own shelf (what they read, rated, noted, wanted, dropped) and says whether this book is for
// them, comparing it with books they liked or didn't. The answer is kept per reader and book, so a
// second look costs nothing; «Спитати ще раз» after the shelf changed makes a new one.
// Guests and readers with an empty shelf get a line of text instead of the button (pages.js).
const Anthropic = require("@anthropic-ai/sdk");

const MODEL = "claude-opus-5-5";
const DAILY_LIMIT = 30; // fresh answers per reader per day; kept answers are free
const SHELF_MIN = 3; // fewer books than this and there is nothing to compare with

const SCHEMA = `CREATE TABLE IF NOT EXISTS advice (
  reader TEXT NOT NULL, book TEXT NOT NULL, text TEXT NOT NULL, model TEXT NOT NULL, created TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0, cached_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (reader, book)
);`;

const SYSTEM = `You are a well-read friend built into Chytai, a Ukrainian site where people keep shelves of the books they read. A reader is looking at a book's page and asks whether it is worth reading for them. You know their shelf: the books they read with their ratings (1 to 5) and notes, what they are reading, want to read, and gave up on.

Answer in Ukrainian, addressing the reader as «ви». Be honest and specific, not polite for its own sake: if the book doesn't fit what they tend to like, say so plainly, and if their shelf shows nothing relevant, say that too instead of guessing their taste.

Ground the advice in their shelf, but only where it genuinely bears on this book: mention a book of theirs when it is a close match in kind and tells something (how they rated or described it; quote a few words from a note when it helps). That may be one book, or none at all when nothing on the shelf is close, and then say the verdict rests on the book itself; never pad the answer with loose comparisons to reach a number. A book they rated low tells as much as a book they loved. Watch for the author already on their shelf, a translation or original they already read, and books they abandoned.

Be careful with facts about the book itself: use the description and readers' notes given to you plus what you reliably know; if you are unsure what the book is like, say so in a few words rather than inventing. No spoilers.

Length and shape: short, about 50 to 70 words in one paragraph, plain prose, no headings, no bullet lists. The first sentence is the verdict (worth it, probably not, or it depends on what), in bold; then the reason in two or three sentences, nothing more. No preamble, no closing offer, no mention of being an AI.`;

const STATUS = { read: "прочитано", reading: "читаю зараз", want: "хочу прочитати", abandoned: "покинуто" };
const clip = (s, n) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n).replace(/\s+\S*$/, "") + "…";
};
const stripMd = (s) => String(s || "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`>#]+/g, "");

class Advice {
  constructor({ store, social, db, apiKey = "", model = MODEL, log = () => {} }) {
    this.store = store;
    this.social = social;
    this.db = db;
    this.apiKey = apiKey;
    this.model = model;
    this.log = log;
    db.exec(SCHEMA);
    this.client = apiKey ? new Anthropic({ apiKey }) : null;
  }
  get enabled() {
    return !!this.client;
  }

  // The reader's shelf as text, one line a book: «Назва — Автор · прочитано 2021 · 4/5 · «нотатка»».
  // Longest notes first within a status, read books first, so the most telling lines come early.
  shelfText(readerId) {
    const rows = this.store.library(readerId);
    const order = { read: 0, abandoned: 1, reading: 2, want: 3, "": 4 };
    const line = (r) => {
      const b = r.book;
      const bits = [`${b.title}${b.altTitle && b.altTitle !== b.title ? ` (${b.altTitle})` : ""}${b.author ? ` — ${b.author}` : ""}`];
      bits.push((STATUS[r.status] || "на полиці") + (r.status === "read" && r.year ? ` ${r.year}` : ""));
      if (r.rating != null) bits.push(`${r.rating}/5`);
      if (r.note) bits.push(`«${clip(stripMd(r.note), 220)}»`);
      return bits.join(" · ");
    };
    const list = rows.filter((r) => r.book).sort((a, b) => (order[a.status] ?? 4) - (order[b.status] ?? 4) || (b.year ?? 0) - (a.year ?? 0));
    return { count: list.length, text: list.map(line).join("\n") };
  }

  // The book as text: what it is, what the site knows, what other readers said (their notes are public).
  bookText(book) {
    const s = this.social.stats(book.id);
    const bits = [`Title: ${book.title}`];
    if (book.altTitle && book.altTitle !== book.title) bits.push(`Also known as: ${book.altTitle}`);
    if (book.author) bits.push(`Author: ${book.author}`);
    if (book.published) bits.push(`Year: ${book.published}`);
    if (book.pages) bits.push(`Pages: ${book.pages}`);
    if (book.language) bits.push(`Language of this edition: ${book.language}`);
    if (book.tags?.length) bits.push(`Tags: ${book.tags.join(", ")}`);
    if (book.series?.name) bits.push(`Series: ${book.series.name}${book.series.volumes ? ` (${book.series.volumes} volumes)` : ""}`);
    if (book.translations?.length) bits.push(`Other editions (original or translation): ${book.translations.map((t) => `${t.title}${t.author && t.author !== book.author ? ` — ${t.author}` : ""}`).join("; ")}`);
    if (book.blurb) bits.push(`Description: ${clip(book.blurb, 1500)}`);
    if (s.rated) bits.push(`On Chytai: average rating ${s.avg}/5 from ${s.rated} readers; ${s.finished} finished, ${s.dropped} gave up, ${s.want} want to read.`);
    const notes = this.store
      .readersOf(book.id, { all: true })
      .filter((r) => r.entry.note)
      .slice(0, 5)
      .map((r) => `- ${r.entry.rating != null ? `${r.entry.rating}/5: ` : ""}«${clip(stripMd(r.entry.note), 300)}»`);
    if (notes.length) bits.push(`What readers on Chytai wrote (anonymous):\n${notes.join("\n")}`);
    return bits.join("\n");
  }

  kept(readerId, bookId) {
    return this.db.prepare("SELECT text, model, created FROM advice WHERE reader = ? AND book = ?").get(readerId, this.store.canonical(bookId)) || null;
  }
  usedToday(readerId) {
    const day = new Date().toISOString().slice(0, 10);
    return this.db.prepare("SELECT COUNT(*) AS n FROM advice WHERE reader = ? AND created >= ?").get(readerId, day).n;
  }
  // Whether the page shows the block, and in which state (pages.js draws it; server.js answers the click).
  state(user, bookId) {
    if (!this.enabled) return null;
    if (!user) return { kind: "guest" };
    // A book the reader already finished (or gave up on) needs no advice.
    const own = this.store.sharedEntry(user.id, bookId);
    if (own && (own.status === "read" || own.status === "abandoned")) return null;
    const shelf = this.shelfText(user.id);
    if (shelf.count < SHELF_MIN) return { kind: "empty", count: shelf.count };
    const kept = this.kept(user.id, bookId);
    return kept ? { kind: "kept", ...kept } : { kind: "ask" };
  }

  // A fresh answer from Claude; the shelf goes in the system prompt behind a cache breakpoint, so the
  // same reader asking about several books in a row pays for the shelf once.
  async ask(readerId, book, { fresh = false } = {}) {
    if (!this.client) throw new Error("Порада зараз недоступна.");
    const id = this.store.canonical(book.id);
    const old = fresh ? null : this.kept(readerId, id);
    if (old) return { ...old, cached: true };
    if (this.usedToday(readerId) >= DAILY_LIMIT) throw new Error(`На сьогодні порад більше немає: ${DAILY_LIMIT} на день.`);
    const shelf = this.shelfText(readerId);
    if (shelf.count < SHELF_MIN) throw new Error("Додайте кілька прочитаних книжок з оцінками, і буде з чим порівняти.");
    const t0 = Date.now();
    const message = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: 2000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low" },
      system: [
        { type: "text", text: SYSTEM },
        { type: "text", text: `The reader's shelf (${shelf.count} books):\n${shelf.text}`, cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: `The book on the page:\n${this.bookText(book)}\n\nIs this book worth reading for me?` }],
    });
    if (message.stop_reason === "refusal") throw new Error("Claude не зміг відповісти про цю книжку.");
    const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    if (!text) throw new Error("Порожня відповідь, спробуйте ще раз.");
    const u = message.usage || {};
    const row = { text, model: message.model, created: new Date().toISOString() };
    this.db
      .prepare("INSERT INTO advice (reader, book, text, model, created, input_tokens, cached_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (reader, book) DO UPDATE SET text = excluded.text, model = excluded.model, created = excluded.created, input_tokens = excluded.input_tokens, cached_tokens = excluded.cached_tokens, output_tokens = excluded.output_tokens")
      .run(readerId, id, text, row.model, row.created, u.input_tokens || 0, (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), u.output_tokens || 0);
    this.log(`advice: ${book.title} for ${readerId} in ${Date.now() - t0} ms, ${u.input_tokens || 0}+${u.cache_read_input_tokens || 0} cached in, ${u.output_tokens || 0} out, ${message.model}`);
    return { ...row, cached: false };
  }

  // For the owner: how much the feature has been used (tokens are what the bill is made of).
  totals() {
    return this.db.prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT reader) AS readers, SUM(input_tokens) AS input_tokens, SUM(cached_tokens) AS cached_tokens, SUM(output_tokens) AS output_tokens FROM advice").get();
  }
}

module.exports = { Advice, MODEL, DAILY_LIMIT, SHELF_MIN };

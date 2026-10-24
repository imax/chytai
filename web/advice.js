// «AI-рекомендація» («Чи варто мені читати?») on a book's page (Max, 2026-10-23): on a click, not by itself, Claude looks at the
// reader's own shelf (what they read, rated, noted, wanted, dropped) and says whether this book is for
// them, comparing it with books they liked or didn't. The answer is kept per reader and book, so a
// second look costs nothing; «Спитати ще раз» after the shelf changed makes a new one.
// Guests and readers with an empty shelf get a line of text instead of the button (pages.js).
const Anthropic = require("@anthropic-ai/sdk");
const { isRussian } = require("./store");

const MODEL = "claude-opus-5-5";
const DAILY_LIMIT = 30; // fresh answers per reader per day; kept answers are free
const SHELF_MIN = 3; // fewer books than this and there is nothing to compare with

// `mode` is always "shelf" now (a per-reader web mode was tried for an hour on 2026-10-23, then became the per-book overview below).
const SCHEMA = `CREATE TABLE IF NOT EXISTS advice (
  reader TEXT NOT NULL, book TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'shelf', text TEXT NOT NULL, model TEXT NOT NULL, created TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0, cached_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, searches INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (reader, book, mode)
);`;
const OVERVIEW_SCHEMA = `CREATE TABLE IF NOT EXISTS overview (
  book TEXT PRIMARY KEY, text TEXT NOT NULL, model TEXT NOT NULL, created TEXT NOT NULL, by TEXT NOT NULL DEFAULT '',
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, searches INTEGER NOT NULL DEFAULT 0,
  prompt INTEGER NOT NULL DEFAULT 1, sources TEXT NOT NULL DEFAULT ''
);`;
// A reader's word on an overview (Max, 2026-10-23: «кнопки щоб оцінити якість AI summary. похвалити або
// навпаки поскаржитись»): one vote a reader a book; the owner sees the sums on /admin/overviews.
// Since 2026-10-23 15:30 three faces (Max: «три смайлика для оцінки якості опису, і так нам читачі допоможуть
// дебажити промпт»): vote 1 = 🤩 good, 2 = 🙂 so-so, -1 = 🙁 bad (set 2 picked by Max, no words). 1 and -1 keep the old 👍/👎 rows.
// A complaint carries the reader's words on what is wrong (Max: «хай читач напише що саме йому не сподобалось»).
const VOTE_SCHEMA = `CREATE TABLE IF NOT EXISTS overview_vote (
  book TEXT NOT NULL, reader TEXT NOT NULL, vote INTEGER NOT NULL, created TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (book, reader)
);`;
const WEB_SEARCHES = 3;
// Shops and publishers' own sites are not reviews (Max, 2026-10-23: «суцільні магазини … у мене їм довіри
// немає»): kept out of the search. Goodreads, the press, blogs and BookTube stay.
const BLOCKED_DOMAINS = [
  "yakaboo.ua", "nashformat.ua", "laboratory.ua", "laboratoria.pro", "vivat.com.ua", "vivat-book.com.ua", "readeat.com", "book-ye.com.ua", "bookclub.ua",
  "starylev.com.ua", "ranok.com.ua", "bookzone.com.ua", "megogo.net", "abuk.com.ua", "booklya.ua", "grenka.ua", "balka-book.com", "rozetka.com.ua",
  "prom.ua", "knigoland.com.ua", "bookovka.ua", "kmbooks.com.ua", "folio.com.ua", "ababahalamaha.com.ua", "lobster.com.ua", "bukva.ua", "kniga.biz.ua", "artbooks.ua",
];
const OVERVIEW_DAILY = 150; // fresh overviews a day on readers' clicks, all readers together
// Made by itself (Max, 2026-10-23: «запускати її автоматично коли у книжки з'являється хоча б один відгук
// чи оцінка читачів», plus a backfill over the books already rated): a sweep finds every book with a
// reader's rating or note and no overview, and a small queue makes them a couple at a time. Its own
// ceiling a day, so a big Goodreads import or the backfill can't run the bill away in one night.
const AUTO_DAILY = 150; // Max, 2026-10-23: «давай зменшемо до 150 [на] день»
const AUTO_PARALLEL = 2;
// The backfill over books rated before the feature is OFF for now (Max, 2026-10-23 08:09: «давай поки не
// робити авто-backfill … я ще подумаю»); a book gets its overview when a reader rates or notes it from
// now on. Flip to true to let sweep() run at start and daily.
const BACKFILL = false;
// Automatic overviews (first rating/note, «Хочу прочитати») are PAUSED while Max tunes the prompt
// (2026-10-23 15:03: «поки давай вимкнемо backfill»); readers' own clicks and the owner's «Оновити» still work.
const AUTO = false; // paused again 2026-10-24 05:52 (Max: «тормозни backfill для авто-оглядів», more prompt work later)
// The overview prompt's version: rows made with an older one are redone at start, two at a time
// (Max, 2026-10-23 08:09, after the prompt lost its obligatory paragraph of complaints: «старі теж»).
const PROMPT_VERSION = 8; // 3: the site's own notes and ratings no longer go in (2026-10-23 08:35); 4: shops blocked (09:16); 5: shorter, reservations one sentence at most (14:40); 6: like a friend, about what people love, no pros/cons balance (15:05); 7: calmer tone, no blurb language, 40–70 words (15:22); 8: back to v5's neutral base + calm tone, no «friend» framing (15:25)
// Version 4 is redone only for books with a Cyrillic title (Max, 2026-10-23 09:15: «перезапустимо пошук для всіх укр
// книжок»): their searches were all shops. Latin-titled books keep their version-3 overview.
// 2026-10-23 15:43 (Max: «Викладаємо»): every overview below prompt 8 is redone once with the calm prompt (~200, ≈$26).
const REDO_ALL_BELOW = 8;
const REDO_CYR_BELOW = 4;
// Version 5 (shorter, reservations one sentence at most; Max 14:33: a paragraph of complaints «читати не хочеться»)
// redoes nothing by itself: only new overviews and the owner's «Оновити» get it (Max: no mass regeneration).
// «Що пишуть в інтернеті» (Max, 2026-10-23): one summary per book, not per reader, of what readers and
// reviewers say, from the web, kept on the page for everyone. Our own words only: a review's text may
// not be reproduced (Закон 2811-IX), so no quotes, no names, no links.
// No fixed shape (Max, 2026-10-23: «кумарить formulaic формат, де другий параграф завжди про мінуси,
// навіть якщо придумані»): the note follows the actual reception, complaints only where they really recur.
const OVERVIEW_SYSTEM = `You write a short, neutral note for a book's page on Chytai, a Ukrainian site about books, on what people say about this book. Search the web (up to ${WEB_SEARCHES} searches): reviews in the press and on book sites, reader reactions (Goodreads, blogs and booktubers for a Ukrainian edition), the author's standing, awards. For a Ukrainian book, look for English-language press too: a translation may have been reviewed abroad. Online shops and publishers' own pages are not a source: their blurbs and their review sections don't count as reception, even if a search turns them up. Then write, in Ukrainian, what the reception actually is: what readers and critics single out, what kind of reading experience they describe, and who the book tends to find. Facts and the balance of opinion, no verdict of your own, no advice, not addressed to anyone.

Keep it to the essentials a reader wants before opening the book, said matter-of-factly, in a low key: no blurb language, no superlatives, no cheering («тримає до останньої сторінки», «не шкодують», «змушує думати»), no selling; a fact such as a prize or a place on a list is said once, flatly. Reservations get one short sentence at most, and only when they are a real part of the reception (a split between critics and readers, or the same complaint coming up again and again); never list several complaints, never pad a warm reception with a reservation for balance, never invent one. One paragraph.

Write everything in your own words: never quote a review or a reader, never name a reviewer, a site or a channel, no links, no "I searched". If the web says little about the book, say what is known in one or two sentences and stop; never invent reception. No spoilers. 40 to 70 words, plain prose, no headings, lists or bold. Start with the substance, no preamble.`;

const SYSTEM = `You are a well-read friend built into Chytai, a Ukrainian site where people keep shelves of the books they read. A reader is looking at a book's page and wants to know what this book is like for them. You know their shelf: the books they read with their ratings (1 to 5) and notes, what they are reading, want to read, and gave up on.

The decision is theirs: never say whether they should read the book, never give a verdict, score, recommendation or "worth it / not worth it". Give the information they need to decide for themselves: what kind of book it is (pace, tone, length, what it asks of a reader) and how it sits against what they have read. If something is a good sign or a warning sign given their shelf, state the fact and let them draw the conclusion.

Answer in Ukrainian, addressing the reader as «ви». Be honest and specific, not polite for its own sake; if their shelf shows nothing relevant, say so instead of guessing their taste.

Order and proportion: the book first, the shelf second. Open with the book itself, what kind of thing it is and what stands out in the facts (never open with the shelf, and never with a stock phrase like «Найближче на вашій полиці»). Then bring in their shelf only where it genuinely bears on this book: a book of theirs that is a close match in kind and tells something, named in a few words (their rating, or three or four words from a note at most). Don't read their notes back to them at length; they wrote them. That may be one book, or none at all; never pad the answer with loose comparisons or stretch a thin link. A book they rated low tells as much as a book they loved. Watch for the author already on their shelf, a translation or original they already read, and books they abandoned.

Be careful with facts about the book itself: use what is given to you (length, year, genres, the descriptions, readers' notes) plus what you reliably know about the book or the author. When little is known, say what is known and stop: don't speculate about what the book is probably like, and don't spend sentences on what you don't know. No spoilers.

Length follows what there is to say, not a fixed size. When the book is weak, or plainly far from what this reader reads, one to three short sentences are the whole answer. When the book is interesting, and especially when their shelf gives real reasons why it would be interesting for them, take the room to lay them out: up to about 120 words, in one or two paragraphs. Plain prose, no headings, no bullet lists, no bold. No preamble, no closing offer, no mention of being an AI.`;

const STATUS = { read: "прочитано", reading: "читаю зараз", want: "хочу прочитати", abandoned: "покинуто" };
const clip = (s, n) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n).replace(/\s+\S*$/, "") + "…";
};
// No blank before punctuation, no doubled spaces (the seams between cited text blocks).
const tidy = (s) => String(s || "").replace(/[ \t]+([.,;:!?»)])/g, "$1").replace(/[ \t]{2,}/g, " ").trim();
const stripMd = (s) => String(s || "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`>#]+/g, "");

class Advice {
  constructor({ store, social, db, apiKey = "", model = MODEL, log = () => {} }) {
    this.store = store;
    this.social = social;
    this.db = db;
    this.apiKey = apiKey;
    this.model = model;
    this.log = log;
    // Before the web mode the key was (reader, book): rebuild the table once, keeping the answers.
    if (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'advice'").get() && !db.prepare("PRAGMA table_info(advice)").all().some((c) => c.name === "mode")) {
      db.exec("ALTER TABLE advice RENAME TO advice_old");
      db.exec(SCHEMA);
      db.exec("INSERT INTO advice (reader, book, mode, text, model, created, input_tokens, cached_tokens, output_tokens) SELECT reader, book, 'shelf', text, model, created, input_tokens, cached_tokens, output_tokens FROM advice_old; DROP TABLE advice_old");
    }
    db.exec(SCHEMA);
    db.exec(OVERVIEW_SCHEMA);
    for (const [col, def] of [["prompt", "INTEGER NOT NULL DEFAULT 1"], ["sources", "TEXT NOT NULL DEFAULT ''"]])
      if (!db.prepare("PRAGMA table_info(overview)").all().some((c) => c.name === col)) db.exec(`ALTER TABLE overview ADD COLUMN ${col} ${def}`);
    db.exec(VOTE_SCHEMA);
    if (!db.prepare("PRAGMA table_info(overview_vote)").all().some((c) => c.name === "note")) db.exec("ALTER TABLE overview_vote ADD COLUMN note TEXT NOT NULL DEFAULT ''");
    this.client = apiKey ? new Anthropic({ apiKey }) : null;
    this.queue = new Map(); // book id -> { fresh } waiting for an automatic overview
    this.running = 0;
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
    const list = rows.filter((r) => r.book && !r.kids).sort((a, b) => (order[a.status] ?? 4) - (order[b.status] ?? 4) || (b.year ?? 0) - (a.year ?? 0));
    return { count: list.length, text: list.map(line).join("\n") };
  }

  // Everything the site knows about the book, from every edition and source, so the model doesn't have
  // to guess the length or the kind of book (Max, 2026-10-23: «А у нас дійсно немає чого дати моделі?»):
  // the shops' pages, year, original title, translator, publisher and genres live on the raw catalog
  // items (fromShelfItem drops most of them), the descriptions differ from shop to shop, a linked
  // original or translation has its own, and Open Library knows the original's length and year.
  async facts(book) {
    const store = this.store;
    const id = store.canonical(book.id);
    const raw = [];
    const main = store.shelfItems?.get(id);
    if (main) raw.push({ shelf: main.shelf, item: main.item });
    for (const e of store.editions?.get(id) || []) if (e.item.id !== main?.item?.id) raw.push(e);
    const own = store.lib?.books?.[id] || null;
    const first = (k) => raw.map((r) => r.item[k]).find((v) => v && String(v).trim());
    const pages = Number(book.pages) || Number(first("pages")) || Number(own?.pages) || 0;
    const year = Number(book.published) || Number(first("year")) || Number(own?.published) || 0;
    const original = [book.altTitle, first("originalTitle"), first("altTitle")].map((t) => String(t || "").trim()).find((t) => t && t !== book.title) || "";
    const translator = first("translator") || "";
    // The publisher with the two words the site says about it (its shelf's tagline), e.g. «Лабораторія
    // (Київське видавництво нонфікшну: історія, психологія, бізнес, наука)»; a shop that only sells it is named as such.
    const publishers = [];
    for (const r of raw) {
      const sh = store.shelf(r.shelf.id || r.shelf);
      const own = sh?.kind === "publisher" || sh?.kind === "audio";
      const name = (own ? sh.name : r.item.publisher) || sh?.name || "";
      if (!name || publishers.some((p) => p.startsWith(name))) continue;
      publishers.push(own && sh.tagline ? `${name} (${sh.tagline})` : !own && sh ? `${name}${sh.name !== name ? `, sold by ${sh.name}` : " (a shop)"}` : name);
    }
    const genres = [...new Set([...(book.tags || []), ...raw.flatMap((r) => r.item.genres || [])])].filter((g) => g && g !== "українською");
    const formats = [...new Set(raw.map((r) => r.item.format || "").filter(Boolean))];
    const duration = first("duration") || "";
    // Descriptions: the page's own, then other shops' when they say something else, then the original's or the translation's.
    const blurbs = [];
    const seen = new Set();
    const addBlurb = (text, from) => {
      const t = clip(text, 1500);
      const key = t.slice(0, 120).toLowerCase();
      if (t.length < 80 || seen.has(key)) return;
      seen.add(key);
      blurbs.push({ text: t, from });
    };
    addBlurb(book.blurb, book.blurbSource || (book.shelf ? store.shelf(book.shelf)?.name : book.source) || "the catalog");
    for (const r of raw) addBlurb(require("./catalogs").about(r.item.blurb || ""), store.shelf(r.shelf.id || r.shelf)?.name || "a shop");
    const twins = [];
    for (const t of book.translations || []) {
      const tb = store.book(t.id);
      if (!tb) continue;
      twins.push(`${tb.title}${tb.author && tb.author !== book.author ? ` — ${tb.author}` : ""}${tb.pages ? `, ${tb.pages} pages` : ""}${tb.published ? `, ${tb.published}` : ""}`);
      addBlurb(tb.blurb, `the ${/[а-яіїєґ]/i.test(tb.title) ? "Ukrainian edition" : "original"} «${tb.title}»`);
    }
    // Open Library for the original: length, year and a description, once a month per work.
    let ol = null;
    const isbns = [...new Set([...(own?.isbns || []), ...raw.map((r) => r.item.isbn).filter(Boolean)])];
    const latin = (t) => /[a-z]/i.test(t) && !/[а-яіїєґ]/i.test(t);
    const olTitle = latin(book.title) ? book.title : latin(original) ? original : (book.translations || []).map((t) => t.title).find(latin) || "";
    if ((olTitle || isbns.length) && (!pages || !year || blurbs.length < 2)) {
      const key = `advice:ol:${id}`;
      const cached = this.db.get(key);
      const fresh = cached && JSON.parse(cached);
      // A miss (or Open Library down) is asked again after an hour, a hit after a month.
      if (fresh && Date.now() - Date.parse(fresh.at) < (fresh.data ? 30 * 86400000 : 3600000)) ol = fresh.data;
      else {
        try {
          ol = await Promise.race([require("./enrich").lookup({ title: olTitle || book.title, author: book.author, isbns }), new Promise((r) => setTimeout(() => r(null), 4000))]);
        } catch {
          ol = null;
        }
        this.db.set(key, JSON.stringify({ at: new Date().toISOString(), data: ol }));
      }
      if (ol?.blurb) addBlurb(ol.blurb, "Open Library");
    }
    return { pages: pages || ol?.pages || 0, year, firstYear: ol?.published || 0, original, translator, publishers, genres, formats, duration, blurbs, twins, olPages: !pages && ol?.pages ? ol.pages : 0 };
  }

  // The book as text for the prompt: what it is, what the site knows, what other readers said (their notes are public).
  // `site: false` leaves out what Chytai's own readers wrote and rated: the overview is about the web, and
  // a reader's note fed in came back as «частина українських читачів» (Max, 2026-10-23, Chickenhawk).
  async bookText(book, { overview = true, site = true } = {}) {
    const s = site ? this.social.stats(book.id) : { rated: 0 };
    const f = await this.facts(book);
    const bits = [`Title: ${book.title}`];
    if (f.original) bits.push(`Original title: ${f.original}`);
    if (book.author) bits.push(`Author: ${book.author}`);
    if (f.translator) bits.push(`Translator: ${f.translator}`);
    if (f.firstYear && f.firstYear !== f.year) bits.push(`First published: ${f.firstYear}`);
    if (f.year) bits.push(`Year of this edition: ${f.year}`);
    if (f.pages) bits.push(`Pages: ${f.pages}${f.olPages ? " (the original edition)" : ""}`);
    if (f.duration) bits.push(`Audiobook length: ${f.duration}`);
    if (book.language) bits.push(`Language of this edition: ${book.language}`);
    if (f.publishers.length) bits.push(`Publisher: ${f.publishers.join("; ")}`);
    if (f.formats.length) bits.push(`Formats: ${f.formats.join(", ")}`);
    if (f.genres.length) bits.push(`Genres (the shops' shelves): ${f.genres.join(", ")}`);
    if (book.series?.name) bits.push(`Series: ${book.series.name}${book.series.volumes ? ` (${book.series.volumes} volumes)` : ""}`);
    if (f.twins.length) bits.push(`Other editions (original or translation): ${f.twins.join("; ")}`);
    for (const b of f.blurbs) bits.push(`Description (${b.from}): ${b.text}`);
    const ov = overview ? this.overviewOf(book.id) : null;
    if (ov) bits.push(`What readers and critics say (the site's own summary from the web): ${ov.text}`);
    if (s.rated) bits.push(`On Chytai: average rating ${s.avg}/5 from ${s.rated} readers; ${s.finished} finished, ${s.dropped} gave up, ${s.want} want to read.`);
    const notes = (site ? this.store.readersOf(book.id, { all: true }) : [])
      .filter((r) => r.entry.note)
      .slice(0, 5)
      .map((r) => `- ${r.entry.rating != null ? `${r.entry.rating}/5: ` : ""}«${clip(stripMd(r.entry.note), 300)}»`);
    if (notes.length) bits.push(`What readers on Chytai wrote (anonymous):\n${notes.join("\n")}`);
    return bits.join("\n");
  }

  kept(readerId, bookId) {
    return this.db.prepare("SELECT text, model, created FROM advice WHERE reader = ? AND book = ? AND mode = 'shelf'").get(readerId, this.store.canonical(bookId)) || null;
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

  // The work and its translations (Max, 2026-10-23: «для перекладів можна реюзати ту саму відповідь»):
  // one overview serves the original's page and the Ukrainian edition's.
  family(bookId) {
    const id = this.store.canonical(bookId);
    return [id, ...(this.store.translations?.get(id) || [])];
  }
  // Where the family's overview lives (or would): the member that has one, else the book itself.
  homeOf(bookId) {
    const ids = this.family(bookId);
    const row = this.db.prepare(`SELECT book FROM overview WHERE book IN (${ids.map(() => "?").join(",")})`).all(...ids);
    return row.find((r) => r.book === ids[0])?.book || row[0]?.book || ids[0];
  }
  // The book's overview, if one was made for it or a translation of it.
  overviewOf(bookId) {
    return this.db.prepare("SELECT book, text, model, created FROM overview WHERE book = ?").get(this.homeOf(bookId)) || null;
  }
  // The reader's own vote on a book's overview: 1 (good), 2 (so-so), -1 (bad) or null.
  voteOf(bookId, readerId) {
    if (!readerId) return null;
    return this.db.prepare("SELECT vote FROM overview_vote WHERE book = ? AND reader = ?").get(this.homeOf(bookId), readerId)?.vote ?? null;
  }
  // Sets (1, 2, or -1 with the reader's words) or takes back (0) the reader's vote; returns the sums and their vote.
  vote(bookId, readerId, v, note = "") {
    const id = this.homeOf(bookId);
    if (!this.overviewOf(id)) throw new Error("Огляду ще немає.");
    if (v === 0) this.db.prepare("DELETE FROM overview_vote WHERE book = ? AND reader = ?").run(id, readerId);
    else this.db.prepare("INSERT INTO overview_vote (book, reader, vote, created, note) VALUES (?, ?, ?, ?, ?) ON CONFLICT (book, reader) DO UPDATE SET vote = excluded.vote, created = excluded.created, note = excluded.note").run(id, readerId, v, new Date().toISOString(), v === -1 ? clip(note, 1000) : "");
    return { ...this.votesOf(id), vote: v || null };
  }
  // Readers' complaints on a book's overview: [{ reader, note, created }].
  complaintsOf(bookId) {
    return this.db.prepare("SELECT reader, note, created FROM overview_vote WHERE book = ? AND vote = -1 ORDER BY created DESC").all(this.homeOf(bookId));
  }
  votesOf(bookId) {
    const r = this.db.prepare("SELECT SUM(vote = 1) AS up, SUM(vote = 2) AS mid, SUM(vote = -1) AS down FROM overview_vote WHERE book = ?").get(this.homeOf(bookId));
    return { up: r.up || 0, mid: r.mid || 0, down: r.down || 0 };
  }
  // For /admin/overviews: every overview with its votes, the ones readers complained about first.
  overviewList() {
    return this.db
      .prepare("SELECT o.book, o.created, o.by, o.model, o.input_tokens, o.output_tokens, o.searches, o.sources, COALESCE(SUM(v.vote = 1), 0) AS up, COALESCE(SUM(v.vote = 2), 0) AS mid, COALESCE(SUM(v.vote = -1), 0) AS down FROM overview o LEFT JOIN overview_vote v ON v.book = o.book GROUP BY o.book ORDER BY down DESC, up DESC, o.created DESC")
      .all()
      .map((r) => {
        let found = { queries: [], sources: [] };
        try {
          found = r.sources ? JSON.parse(r.sources) : found;
        } catch {
          /* an older row */
        }
        return { ...r, ...found, book: this.store.book(r.book) || { id: r.book, title: r.book, href: "" } };
      });
  }
  // Book titles the overview names in «лапки» become links to their pages when the catalog has them
  // (Max, 2026-10-23: «автоматично додавати лінки на книги, які згадуються у відгуку»). Ukrainian
  // inflects titles («Кривавим меридіаном» for «Кривавий меридіан»), so each word is matched by its
  // stem (the word less its last three letters, four at least) as a prefix in the search index, and
  // only a title with the same number of words, every one starting with its stem, counts. The book's
  // own title and its translations are never linked; one-word titles only by the same author.
  linkTitles(text, book, key = "") {
    text = tidy(text);
    // Linked once per overview per process: a page view costs no search (the index has ~20k rows).
    if (key) {
      const hit = this.linkCache?.get(key);
      if (hit !== undefined) return hit;
    }
    const { norm } = require("./store");
    const own = new Set(this.family(book.id));
    const stem = (w) => (w.length >= 5 ? w.slice(0, Math.max(4, w.length - 3)) : w);
    const fits = (title, stems) => {
      const words = norm(title).split(" ");
      return words.length === stems.length && words.every((w, i) => w.startsWith(stems[i]));
    };
    const cache = new Map();
    const find = (phrase) => {
      if (cache.has(phrase)) return cache.get(phrase);
      let href = "";
      const stems = norm(phrase).split(" ").filter(Boolean).map(stem);
      if (stems.length && stems.every((t) => t.length >= 2)) {
        let rows = [];
        try {
          rows = this.db.prepare("SELECT id FROM search WHERE search MATCH ? LIMIT 20").all(stems.map((t) => `"${t.replace(/"/g, "")}"*`).join(" AND "));
        } catch {
          rows = [];
        }
        const hits = [];
        for (const { id } of rows) {
          const b = this.store.book(id);
          if (!b || own.has(this.store.canonical(b.id)) || isRussian(b)) continue;
          if (!(fits(b.title, stems) || fits(b.altTitle, stems))) continue;
          const authors = (x) => String(x || "").split(/,|&| і | та /).map((n) => norm(n)).filter(Boolean);
          const mine = authors(book.author);
          hits.push({ b, same: authors(b.author).some((n) => mine.includes(n)) });
        }
        const same = hits.filter((h) => h.same);
        const pick = same.length ? same[0] : stems.length > 1 && hits.length === 1 ? hits[0] : null;
        if (pick) href = this.store.href(pick.b.id);
      }
      cache.set(phrase, href);
      return href;
    };
    const out = text.replace(/«([^«»\n]{2,80})»/g, (m, inner) => {
      if (/[\[\]()]/.test(inner)) return m;
      const href = find(inner);
      return href ? `[«${inner}»](${href})` : m;
    });
    if (key) {
      this.linkCache ||= new Map();
      if (this.linkCache.size > 1000) this.linkCache.clear();
      this.linkCache.set(key, out);
    }
    return out;
  }
  // Runs the Claude turn, following pause_turn (a web search can pause it) a few times; returns the text and the usage.
  async turn(params) {
    let message;
    const usage = { input: 0, cached: 0, output: 0, searches: 0 };
    // What the web search asked and found (Max, 2026-10-23: «звідки відгуки він тягне?»): kept with the overview for /admin/overviews.
    const queries = [];
    const sources = [];
    const note = (content) => {
      for (const b of content || []) {
        if (b.type === "server_tool_use" && b.input?.query) queries.push(String(b.input.query));
        if (b.type === "web_search_tool_result" && Array.isArray(b.content)) for (const r of b.content) if (r.type === "web_search_result" && r.url && !sources.some((x) => x.url === r.url)) sources.push({ url: r.url, title: String(r.title || "").slice(0, 120) });
      }
    };
    for (let i = 0; i < 4; i++) {
      message = await this.client.beta.messages.create(params);
      note(message.content);
      const u = message.usage || {};
      usage.input += u.input_tokens || 0;
      usage.cached += (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      usage.output += u.output_tokens || 0;
      usage.searches += u.server_tool_use?.web_search_requests || 0;
      if (message.stop_reason !== "pause_turn") break;
      params = { ...params, messages: [...params.messages, { role: "assistant", content: message.content }] };
    }
    if (message.stop_reason === "refusal") throw new Error("Claude не зміг відповісти про цю книжку.");
    // The answer is the text after the last search; a line the model says to itself between searches
    // («Results are a JSON string.», 2026-10-23, Франкл) is not it.
    const content = message.content || [];
    let from = 0;
    for (const [i, b] of content.entries()) if (b.type === "server_tool_use" || b.type === "web_search_tool_result") from = i + 1;
    // Text with citations comes as several blocks of one answer («…досліджень» + «. Сприйняття…»): glued
    // without a separator, else a space shows before the full stop (Max, 2026-10-23, Endurance).
    let text = tidy(content.slice(from).filter((b) => b.type === "text").map((b) => b.text).join(""));
    if (!text) text = tidy(content.filter((b) => b.type === "text").map((b) => b.text).join(""));
    if (!text) throw new Error("Порожня відповідь, спробуйте ще раз.");
    // A real answer is Ukrainian prose of some length; anything else is not kept.
    // A model's aside before the note («Enough with known context.», 2026-10-23) comes as its own paragraph
    // without a Ukrainian letter: drop such paragraphs, they are never part of the note.
    text = text.split(/\n\n+/).filter((p) => /[а-яіїєґ]/i.test(p)).join("\n\n");
    if (params.tools && (text.length < 120 || !/[а-яіїєґ]/i.test(text))) throw new Error(`Не схоже на огляд: «${clip(text, 60)}»`);
    return { text, model: message.model, usage, queries, sources };
  }
  // Books with a reader's rating or note («Покинуто» doesn't count, as nowhere on the site; nor books in Russian).
  voiced() {
    const ids = new Set();
    for (const [, entries] of this.store.entries)
      for (const [id, e] of Object.entries(entries)) if (e.status !== "abandoned" && (e.rating != null || e.note)) ids.add(this.store.canonical(id));
    return [...ids].filter((id) => this.store.book(id) && !isRussian(this.store.book(id)));
  }
  // Those of them without an overview yet, one per work and its translations (the Cyrillic title first,
  // so the Ukrainian edition's facts go into the prompt).
  missing() {
    const have = new Set(this.db.prepare("SELECT book FROM overview").all().map((r) => r.book));
    const taken = new Set();
    const out = [];
    const cyr = (id) => /[а-яіїєґ]/i.test(this.store.book(id)?.title || "");
    for (const id of this.voiced().sort((a, b) => cyr(b) - cyr(a))) {
      const ids = this.family(id);
      if (ids.some((x) => have.has(x) || taken.has(x))) continue;
      taken.add(id);
      out.push(id);
    }
    return out;
  }
  autoToday() {
    return this.db.prepare("SELECT COUNT(*) AS n FROM overview WHERE by = 'auto' AND created >= ?").get(new Date().toISOString().slice(0, 10)).n;
  }
  // The backfill: queues every book that needs an overview and starts on them. Meant for start and once
  // a day; held back while BACKFILL is off.
  sweep() {
    if (!this.client || !BACKFILL) return 0;
    const ids = this.missing();
    for (const id of ids) if (!this.queue.has(id)) this.queue.set(id, { fresh: false });
    this.pump();
    return ids.length;
  }
  // One book, after a reader rated or noted it: queued if it has no overview (nor its translation).
  want(bookId) {
    if (!this.client || !AUTO) return;
    if (!this.store.book(bookId)) this.store.readBook?.(bookId); // a reader's new book, made in the web process (jobs.js)
    const id = this.store.canonical(bookId);
    if (!this.store.book(id) || isRussian(this.store.book(id)) || this.overviewOf(id) || this.queue.has(id)) return;
    this.queue.set(id, { fresh: false });
    this.pump();
  }
  // Overviews made with an older prompt, redone with the current one; runs once at start, resumes after a restart.
  redo() {
    if (!this.client) return 0;
    const cyr = (id) => /[а-яіїєґ]/i.test(this.store.book(id)?.title || "");
    const ids = this.db
      .prepare("SELECT book, prompt, length(text) AS len FROM overview WHERE prompt < ? OR length(text) < 120 ORDER BY created")
      .all(PROMPT_VERSION)
      .filter((r) => r.prompt < REDO_ALL_BELOW || r.len < 120 || (r.prompt < REDO_CYR_BELOW && this.family(r.book).some(cyr)))
      .map((r) => r.book);
    for (const id of ids) if (!this.queue.has(id)) this.queue.set(id, { fresh: true });
    this.pump();
    return ids.length;
  }
  pump() {
    while (this.running < AUTO_PARALLEL && this.queue.size) {
      const [id, { fresh }] = this.queue.entries().next().value;
      // The daily ceiling is for new overviews; a redo of an existing one is a bounded one-off and passes.
      if (!fresh && this.autoToday() + this.running >= AUTO_DAILY) {
        if (!this.capped) this.log(`overview: ${AUTO_DAILY} made by itself today, ${this.queue.size} wait for tomorrow`);
        this.capped = true;
        return;
      }
      this.capped = false;
      this.queue.delete(id);
      const book = this.store.book(id);
      if (!book) continue;
      this.running++;
      this.overview(book, { by: fresh ? "redo" : "auto", fresh })
        .catch((e) => {
          this.failed = (this.failed || 0) + 1;
          this.lastError = `${book.title}: ${e.message}`.slice(0, 300);
          this.log(`overview failed: ${book.title}: ${e.message}`);
        })
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }
  // For the owner: how many overviews there are, what they cost so far and what waits in the queue.
  overviewStats() {
    const t = this.db.prepare("SELECT COUNT(*) AS n, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(searches) AS searches, SUM(CASE WHEN by IN ('auto', 'redo') THEN 1 ELSE 0 END) AS auto FROM overview").get();
    const today = this.db.prepare("SELECT COUNT(*) AS n FROM overview WHERE created >= ?").get(new Date().toISOString().slice(0, 10)).n;
    const v = this.db.prepare("SELECT SUM(vote = 1) AS up, SUM(vote = 2) AS mid, SUM(vote = -1) AS down FROM overview_vote").get();
    // Opus 5.5 list prices: $4/M in, $20/M out, $10 per 1000 web searches.
    const cost = ((t.input || 0) * 4 + (t.output || 0) * 20) / 1e6 + (t.searches || 0) / 100;
    const current = this.db.prepare("SELECT COUNT(*) AS n FROM overview WHERE prompt = ?").get(PROMPT_VERSION).n;
    return { ...t, today, cost, queue: this.queue.size + this.running, up: v.up || 0, mid: v.mid || 0, down: v.down || 0, current, version: PROMPT_VERSION, failed: this.failed || 0, lastError: this.lastError || "" };
  }

  // A fresh overview of the book from the web, kept for everyone.
  async overview(book, { fresh = false, by = "" } = {}) {
    if (!this.client) throw new Error("Зараз недоступно.");
    const id = this.homeOf(book.id);
    const old = fresh ? null : this.overviewOf(id);
    if (old) return { ...old, cached: true };
    // A ceiling for the day on readers' clicks: each overview is a few web searches and a long Opus turn.
    // Automatic ones have their own ceiling in pump().
    const day = new Date().toISOString().slice(0, 10);
    if (by !== "auto" && by !== "redo" && this.db.prepare("SELECT COUNT(*) AS n FROM overview WHERE by NOT IN ('auto', 'redo') AND created >= ?").get(day).n >= OVERVIEW_DAILY) throw new Error("На сьогодні оглядів більше немає, спробуйте завтра.");
    const t0 = Date.now();
    const { text, model, usage, queries, sources } = await this.turn({
      model: this.model,
      max_tokens: 6000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low" },
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: WEB_SEARCHES, blocked_domains: BLOCKED_DOMAINS }],
      system: OVERVIEW_SYSTEM,
      messages: [{ role: "user", content: `The book:\n${await this.bookText(book, { overview: false, site: false })}\n\nWhat do readers and critics say about it?` }],
    });
    const row = { text, model, created: new Date().toISOString() };
    this.db
      .prepare("INSERT INTO overview (book, text, model, created, by, input_tokens, output_tokens, searches, prompt, sources) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (book) DO UPDATE SET text = excluded.text, model = excluded.model, created = excluded.created, by = excluded.by, input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens, searches = excluded.searches, prompt = excluded.prompt, sources = excluded.sources")
      .run(id, text, model, row.created, by, usage.input + usage.cached, usage.output, usage.searches, PROMPT_VERSION, JSON.stringify({ queries, sources: sources.slice(0, 30) }));
    this.log(`overview: ${book.title} in ${Date.now() - t0} ms, ${usage.input + usage.cached} in, ${usage.output} out, ${usage.searches} searches, ${model}`);
    return { ...row, cached: false };
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
    const { text, model, usage } = await this.turn({
      model: this.model,
      max_tokens: 2000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low" },
      system: [
        { type: "text", text: SYSTEM },
        { type: "text", text: `The reader's shelf (${shelf.count} books):\n${shelf.text}`, cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: `The book on the page:\n${await this.bookText(book)}\n\nWhat is this book like for me, given my shelf? Facts only, no verdict.` }],
    });
    const row = { text, model, created: new Date().toISOString() };
    this.db
      .prepare("INSERT INTO advice (reader, book, mode, text, model, created, input_tokens, cached_tokens, output_tokens) VALUES (?, ?, 'shelf', ?, ?, ?, ?, ?, ?) ON CONFLICT (reader, book, mode) DO UPDATE SET text = excluded.text, model = excluded.model, created = excluded.created, input_tokens = excluded.input_tokens, cached_tokens = excluded.cached_tokens, output_tokens = excluded.output_tokens")
      .run(readerId, id, text, model, row.created, usage.input, usage.cached, usage.output);
    this.log(`advice: ${book.title} for ${readerId} in ${Date.now() - t0} ms, ${usage.input}+${usage.cached} cached in, ${usage.output} out, ${model}`);
    return { ...row, cached: false };
  }

  // For the owner: how much the feature has been used (tokens are what the bill is made of).
  totals() {
    return this.db.prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT reader) AS readers, SUM(input_tokens) AS input_tokens, SUM(cached_tokens) AS cached_tokens, SUM(output_tokens) AS output_tokens FROM advice").get();
  }
}

module.exports = { Advice, MODEL, DAILY_LIMIT, SHELF_MIN };

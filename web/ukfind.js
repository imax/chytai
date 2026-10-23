// Ukrainian editions found by ourselves (Max, 2026-10-23: «чи нам дійсно треба урл чи ми його можемо й самі
// знайти, якщо знаємо що вона існує»). Wikidata tells us a foreign book has a Ukrainian translation and its
// title («Українською: «Егоїстичний ген», у каталогах поки немає»); Claude searches the web for that
// edition's page in a Ukrainian bookstore or at its publisher and names a few addresses; the first one our
// server can read (bookpage.js) and whose title is the Ukrainian one becomes the book, paired with the
// original as its translation, with the store in «Де взяти» (server.js addEdition, as for a reader's tip).
// Every book is asked once (table uk_find); «none» is asked again after a month. A ceiling a day.
const MODEL = "claude-haiku-5-5"; // Sonnet came to ≈ $0.21 a book (2026-10-23), too dear for this
const SEARCHES = 3;
const DAILY = 100;
const MONTH = 30 * 86400000;

const SCHEMA = `CREATE TABLE IF NOT EXISTS uk_find (
  book TEXT PRIMARY KEY, status TEXT NOT NULL, url TEXT NOT NULL DEFAULT '', found TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, searches INTEGER NOT NULL DEFAULT 0
);`;

const SYSTEM = `You find where a Ukrainian translation of a book is sold. Search the web in Ukrainian (up to ${SEARCHES} searches), for example «<Ukrainian title> <author's surname in Ukrainian> купити книгу», then «<Ukrainian title> видавництво». You are looking for the page of this exact book in Ukrainian in a Ukrainian online bookstore or on its Ukrainian publisher's site: vivat.com.ua, ksd.ua, bookclub.ua, laboratory.ua, starylev.com.ua, komubook.com.ua, book.ua, bookchef.ua, folio.com.ua, nashformat.ua, yakaboo.ua, book-ye.com.ua, knigoland, bukva.ua, ababahalamaha.com.ua, artbooks.ua, ranok.com.ua, rozetka.com.ua and others; not readeat.com. A product page of one book, not a search, a category, an article, a review or a library catalog. A Ukrainian edition counts even with a slightly different title or a subtitle. List every such page you saw, the publisher's site and smaller stores first (big marketplaces and Yakaboo often block us).
Answer with one JSON object and nothing else: {"urls": ["https://…", "…"]} with up to 6 addresses, or {"urls": []} if the search shows no Ukrainian edition. Only addresses you saw in the search results; never make one up.`;

const norm = (s) => String(s || "").toLowerCase().replace(/[’'`ʼ"«»]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

class UkFinder {
  constructor({ store, db, apiKey = "", bookpage, addEdition, log = () => {} }) {
    this.store = store;
    this.db = db;
    this.bookpage = bookpage;
    this.addEdition = addEdition;
    this.log = log;
    this.client = apiKey ? new (require("@anthropic-ai/sdk"))({ apiKey }) : null;
    db.exec(SCHEMA);
    this.running = false;
  }

  // Foreign books whose Ukrainian title Wikidata knows and no catalog has, not asked within a month.
  candidates() {
    const asked = new Map(this.db.prepare("SELECT book, status, created FROM uk_find").all().map((r) => [r.book, r]));
    return Object.keys(this.store.ukTitles || {})
      .map((id) => this.store.bookPage(id))
      .filter((b) => b && b.ukTitle)
      .filter((b) => {
        const a = asked.get(b.id);
        return !a || (a.status !== "found" && Date.now() - Date.parse(a.created) > MONTH);
      });
  }
  today() {
    return this.db.prepare("SELECT COUNT(*) AS n FROM uk_find WHERE created >= ?").get(new Date().toISOString().slice(0, 10)).n;
  }
  list() {
    return this.db.prepare("SELECT * FROM uk_find ORDER BY created DESC").all().map((r) => ({ ...r, book: this.store.book(r.book) || { id: r.book, title: r.book, href: "" }, edition: r.found ? this.store.book(r.found) : null }));
  }

  // One book: { status: "found" | "none" | "error", url, edition, note }.
  async find(book) {
    const uk = this.store.ukTitles?.[book.id] || {};
    const usage = { input: 0, output: 0, searches: 0 };
    const save = (status, { url = "", found = "", note = "" } = {}) => {
      this.db
        .prepare("INSERT INTO uk_find (book, status, url, found, note, created, input_tokens, output_tokens, searches) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (book) DO UPDATE SET status = excluded.status, url = excluded.url, found = excluded.found, note = excluded.note, created = excluded.created, input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens, searches = excluded.searches")
        .run(book.id, status, url, found, note.slice(0, 500), new Date().toISOString(), usage.input, usage.output, usage.searches);
      this.log(`ukfind ${book.id}: ${status} ${url} ${note}`.trim());
      return { status, url, edition: found ? this.store.book(found) : null, note };
    };
    let urls = [];
    try {
      let params = {
        model: MODEL,
        max_tokens: 2000,
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: SEARCHES }],
        system: SYSTEM,
        messages: [{ role: "user", content: `The Ukrainian translation: «${uk.uk}»${uk.ukAuthor ? `, ${uk.ukAuthor}` : ""}.\nThe original: «${book.title}»${book.author ? `, ${book.author}` : ""}.` }],
      };
      let message;
      for (let i = 0; i < 4; i++) {
        message = await this.client.messages.create(params);
        usage.input += (message.usage?.input_tokens || 0) + (message.usage?.cache_read_input_tokens || 0);
        usage.output += message.usage?.output_tokens || 0;
        usage.searches += message.usage?.server_tool_use?.web_search_requests || 0;
        if (message.stop_reason !== "pause_turn") break;
        params = { ...params, messages: [...params.messages, { role: "assistant", content: message.content }] };
      }
      const out = message.content.filter((c) => c.type === "text").map((c) => c.text).join("");
      urls = (JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)).urls || []).filter((u) => /^https?:\/\//.test(u) && !/readeat\.com/i.test(u)).slice(0, 6);
    } catch (e) {
      return save("error", { note: `Claude: ${e.message}` });
    }
    if (!urls.length) return save("none", { note: "Claude нічого не знайшов" });
    // The first address we can read whose title is the Ukrainian one (its first words, at least).
    const notes = [];
    const want = norm(uk.uk).split(" ").filter((w) => w.length > 2).slice(0, 2);
    for (const url of urls) {
      const p = await this.bookpage.fromUrl(url, "ukfind");
      if (p.error) {
        notes.push(`${new URL(url).hostname}: ${p.error.split(".")[0]}`);
        continue;
      }
      if (!/[а-яіїєґ]/i.test(p.title) || !want.every((w) => norm(p.title).includes(w))) {
        notes.push(`${new URL(url).hostname}: «${p.title}»`);
        continue;
      }
      const edition = this.addEdition(book, p, null);
      if (edition) return save("found", { url, found: edition.id });
    }
    return save("none", { url: urls[0], note: notes.join("; ") });
  }

  // Up to n books, one at a time; returns what each gave.
  async run(n = 5, { ids } = {}) {
    if (!this.client || this.running) return [];
    this.running = true;
    const done = [];
    try {
      const list = ids ? ids.map((id) => this.store.bookPage(id)).filter((b) => b && b.ukTitle) : this.candidates();
      for (const b of list.slice(0, n)) {
        if (this.today() >= DAILY) break;
        done.push({ book: b, ...(await this.find(b)) });
      }
    } finally {
      this.running = false;
    }
    return done;
  }
}

module.exports = { UkFinder };

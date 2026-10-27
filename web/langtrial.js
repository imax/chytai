// A trial of book languages by Claude (Max, 2026-10-23: «візьмемося за визначення мови книги? особливо
// цікаво рос»). Without a language from the shop, isRussian() guesses from the title and author: letters,
// typical Russian words and endings, a list of Russian writers. A Cyrillic title with none of і/ї/є/ґ and
// ы/э/ъ/ё rests on those word guesses alone. This asks Haiku the language of such editions, for all such
// works, and keeps the answers in meta `langtrial` for /admin/lang-trial. Nothing on the site changes.

const Anthropic = require("@anthropic-ai/sdk");
const { isRussian } = require("./store");

const MODEL = "claude-haiku-5-5";
const SIZE = 400; // the whole pool: 247 doubtful works on 2026-10-23
const PARALLEL = 4;
const PROMPT = 2; // the SYSTEM version below; bump it with every change
const PRICE = { input: 0.1 / 1e6, output: 0.5 / 1e6, cacheRead: 0.01 / 1e6, cacheWrite: 0.125 / 1e6 }; // $ per token, Haiku 5.5
const costOf = (u) => (u.input_tokens || 0) * PRICE.input + (u.cache_read_input_tokens || 0) * PRICE.cacheRead + (u.cache_creation_input_tokens || 0) * PRICE.cacheWrite + (u.output_tokens || 0) * PRICE.output;
const LANGS = ["uk", "ru", "en", "other", "unknown"];

const SYSTEM = `You tell the language of one edition of a book listed on Chytai, a Ukrainian book site. Judge the language this edition is printed in, from its title, the description and the publisher or shop, not the language the book was first written in: a Ukrainian translation of a Russian or English book is «uk». Ukrainian and Russian look alike: Ukrainian uses і, ї, є, ґ and words like «та», «що», «як», «це», «від»; Russian uses ы, э, ъ, ё and words like «и», «что», «как», «это», «от». A short title can be the same in both; then rely on the description and the publisher. The spelling of the title decides first: a title that is correct Russian and not correct Ukrainian («Академия», not «Академія»; «Пассажир», not «Пасажир»; «Возвращение», not «Повернення»; «Зов кукушки») is «ru», even when the description is in Ukrainian, because Ukrainian shops describe Russian editions in Ukrainian. The author's name spelled the Ukrainian way does not make the edition Ukrainian either. Answer «unknown» only when the title is correct in both languages («Дракон») and nothing else tells them apart.`;

// A Cyrillic title with no letter that settles the language: the cases the word guesses decide.
const doubtful = (b) => !b.language && /[а-яА-Я]/.test(b.title || "") && !/[іїєґІЇЄҐыэъёЫЭЪЁ]/.test(b.title || "");

class LangTrial {
  constructor({ store, db, apiKey, log = () => {} }) {
    this.store = store;
    this.db = db;
    this.log = log;
    this.client = apiKey ? new Anthropic({ apiKey }) : null;
    this.running = false;
  }

  state() {
    return JSON.parse(this.db.get("langtrial") || "null");
  }

  // The doubtful works of the whole catalog, in random order.
  pick() {
    const all = [...this.store.workIds()].map((id) => this.store.book(id)).filter((b) => b && doubtful(b));
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [all[i], all[j]] = [all[j], all[i]];
    }
    // The pool is small, so every run asks about all of it: a new prompt is checked on the same books.
    return { books: all.slice(0, SIZE), doubtful: all.length };
  }

  async ask(b) {
    const publishers = [...new Set([...(b.links || []), ...(b.editions || []).flatMap((e) => e.links || [])].map((l) => l.label).filter(Boolean))];
    const facts = [
      `Title: ${b.title}`,
      b.author ? `Author: ${b.author}` : "",
      publishers.length ? `Publisher or shop: ${publishers.slice(0, 4).join(", ")}` : "",
      b.blurb ? `Description: ${String(b.blurb).replace(/\s+/g, " ").slice(0, 700)}` : "",
    ].filter(Boolean);
    const message = await this.client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: { type: "object", properties: { language: { type: "string", enum: LANGS } }, required: ["language"], additionalProperties: false } },
      },
      messages: [{ role: "user", content: facts.join("\n") }],
    });
    if (message.stop_reason === "refusal") throw new Error("refusal");
    const text = message.content.filter((c) => c.type === "text").map((c) => c.text).join("");
    return { language: JSON.parse(text).language, usage: message.usage };
  }

  // Every doubtful work of the catalog not asked yet (Max 2026-10-23 «включаємо»), answers into
  // store.setAiLang; server.js repeats it every six hours for new books. Progress in meta `langall`.
  allState() {
    return JSON.parse(this.db.get("langall") || "null");
  }

  async runAll() {
    if (this.allRunning || !this.client) return false;
    this.allRunning = true;
    const have = this.store.aiLangs();
    const todo = [...this.store.workIds()].filter((id) => !have.has(id)).map((id) => this.store.book(id)).filter((b) => b && doubtful(b));
    const st = { cost: 0, errors: 0, ...this.allState(), at: new Date().toISOString(), prompt: PROMPT, total: todo.length, done: 0, finished: null };
    const save = () => this.db.set("langall", JSON.stringify(st));
    save();
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const b = todo[next++];
        try {
          const { language, usage } = await this.ask(b);
          st.cost += costOf(usage);
          this.store.setAiLang(b.id, language, PROMPT);
        } catch (e) {
          st.errors++;
          this.log(`langall: ${b.id}: ${e.message}`);
        }
        st.done++;
        if (st.done % 20 === 0) save();
      }
    };
    try {
      await Promise.all(Array.from({ length: PARALLEL }, worker));
    } finally {
      st.finished = new Date().toISOString();
      save();
      this.allRunning = false;
      if (st.done) this.store.indexSearch();
    }
    return todo.length > 0; // nothing to ask: no reload of the site, no line on /admin/jobs
  }

  // One new book (newbooks.js), once the whole catalog has been asked: a doubtful title not asked yet.
  async one(b) {
    if (!this.client || !this.allState()?.finished || !doubtful(b) || this.store.aiLangs().has(b.id)) return null;
    const { language, usage } = await this.ask(b);
    this.store.setAiLang(b.id, language, PROMPT);
    return { answer: language, cost: costOf(usage) };
  }

  // Runs in the background; the admin page shows progress from meta `langtrial`.
  async run() {
    if (this.running || !this.client) return false;
    this.running = true;
    const { books, doubtful: pool } = this.pick();
    const st = { prompt: PROMPT, key: require("crypto").randomBytes(12).toString("hex"), at: new Date().toISOString(), model: MODEL, pool, total: books.length, done: 0, cost: 0, items: [], errors: 0 };
    const save = () => this.db.set("langtrial", JSON.stringify(st));
    save();
    let next = 0;
    const worker = async () => {
      while (next < books.length) {
        const b = books[next++];
        const before = isRussian(b) ? "ru" : "не ru";
        try {
          const { language, usage } = await this.ask(b);
          st.cost += costOf(usage);
          st.items.push({ id: b.id, title: b.title, author: b.author || "", before, after: language });
        } catch (e) {
          st.errors++;
          st.items.push({ id: b.id, title: b.title, author: b.author || "", before, after: "", error: String(e.message || e).slice(0, 200) });
          this.log(`langtrial: ${b.id}: ${e.message}`);
        }
        st.done++;
        if (st.done % 10 === 0) save();
      }
    };
    try {
      await Promise.all(Array.from({ length: PARALLEL }, worker));
    } finally {
      st.finished = new Date().toISOString();
      save();
      this.running = false;
    }
    return true;
  }
}

// Whether Haiku's answer disagrees with what the site does now (hide as Russian or not).
const differs = (x) => !x.error && x.after !== "unknown" && (x.after === "ru") !== (x.before === "ru");

module.exports = { LangTrial, differs };

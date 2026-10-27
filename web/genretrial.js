// A trial of genres by Claude (Max, 2026-10-23: «спочатку виберемо пару сотень книжок з полиць читачів,
// прогонимо їх через Haiku і порівняємо. було-стало»). Our genres come from shop shelves, Open Library
// subjects and old tags and are often off («Лоліта» as «любовні романи», a hiking memoir as «біографії»).
// This asks Haiku once per book which one or two of our genres fit, for 200 random works on readers'
// shelves, and keeps the answers in meta `genretrial` for /admin/genres-trial. Nothing on the site changes.

const Anthropic = require("@anthropic-ai/sdk");
const { mainGenres, isRussian } = require("./store");

const MODEL = "claude-haiku-5-5";
const SIZE = 200;
const PARALLEL = 4;
const PARALLEL_ALL = 8;
const PROMPT = 3; // the SYSTEM version below; bump it with every change
const PRICE = { input: 0.1 / 1e6, output: 0.5 / 1e6, cacheRead: 0.01 / 1e6, cacheWrite: 0.125 / 1e6 }; // $ per token, Haiku 5.5
const costOf = (u) => (u.input_tokens || 0) * PRICE.input + (u.cache_read_input_tokens || 0) * PRICE.cacheRead + (u.cache_creation_input_tokens || 0) * PRICE.cacheWrite + (u.output_tokens || 0) * PRICE.output;

const SYSTEM = (genres) => `You sort books into the genres of Chytai, a Ukrainian book site. The genres, in Ukrainian:
${genres.join(", ")}

For the book given, pick the one genre that fits it best. Add a second one only when the whole book is also clearly that, not because of a theme it touches (a satire about a utopia is not «гроші»). Use what you know about the book itself first; the shop shelves and subjects given are noisy hints, not facts.
- «художня» is only for fiction that fits no more specific genre, and never goes together with another fiction genre.
- «класика» is only for the established canon, books read for generations; a recent novel, even one retelling a myth or a classic, is not «класика».
- A memoir or diary goes under «біографії» only when it is about a life; a travel or adventure memoir is «подорожі», a doctor's stories about medicine are «здоров'я».
- A literary classic is «класика», not «любовні романи».
- «фантастика» (science fiction) and «фентезі» (magic, myth) never go together: pick the one the book is; the Witcher is «фентезі».
- Children's and teen books are «дитячі» or «підліткові» whatever else they are; a classic read at school is not a children's book.`;

class GenreTrial {
  constructor({ store, social, db, apiKey, genres, log = () => {} }) {
    this.store = store;
    this.social = social;
    this.db = db;
    this.genres = genres;
    this.log = log;
    this.client = apiKey ? new Anthropic({ apiKey }) : null;
    this.running = false;
  }

  state() {
    const st = JSON.parse(this.db.get("genretrial") || "null");
    // A run from before the share link existed gets its key now.
    if (st && !st.key) {
      st.key = require("crypto").randomBytes(12).toString("hex");
      this.db.set("genretrial", JSON.stringify(st));
    }
    return st;
  }

  // 200 random works from readers' shelves (one per work, no Russian books).
  pick() {
    const ids = [...new Set(this.social.all().map((x) => this.store.canonical(x.id)))];
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    // Books an earlier run already asked about are left for later, so a second run is a fresh sample.
    const prev = this.state();
    const seen = new Set([...(JSON.parse(this.db.get("genretrial:seen") || "[]")), ...(prev?.items || []).map((x) => x.id)]);
    this.db.set("genretrial:seen", JSON.stringify([...seen]));
    const out = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      const b = this.store.book(id);
      if (!b || isRussian(b)) continue;
      out.push(b);
      if (out.length >= SIZE) break;
    }
    return out;
  }

  async ask(b) {
    const raw = this.store.book(b.id, { edited: false }) || b;
    const facts = [
      `Title: ${b.title}`,
      b.altTitle ? `Original title: ${b.altTitle}` : "",
      b.author ? `Author: ${[b.author, b.authorOrig].filter(Boolean).join(" / ")}` : "",
      b.published ? `First published: ${b.published}` : "",
      (raw.tags || []).length ? `Shop shelves and subjects: ${raw.tags.join(", ")}` : "",
      b.blurb ? `Description: ${String(b.blurb).replace(/\s+/g, " ").slice(0, 700)}` : "",
    ].filter(Boolean);
    const message = await this.client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: [{ type: "text", text: SYSTEM(this.genres), cache_control: { type: "ephemeral" } }],
      output_config: {
        effort: "low",
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { genres: { type: "array", items: { type: "string", enum: this.genres } } },
            required: ["genres"],
            additionalProperties: false,
          },
        },
      },
      messages: [{ role: "user", content: facts.join("\n") }],
    });
    if (message.stop_reason === "refusal") throw new Error("refusal");
    const text = message.content.filter((c) => c.type === "text").map((c) => c.text).join("");
    const genres = [...new Set(JSON.parse(text).genres || [])].filter((g) => this.genres.includes(g)).slice(0, 2);
    return { genres, usage: message.usage };
  }

  // The whole catalog (Max 2026-10-23 «вогонь. на все»), after three trials of 200: every work not asked yet,
  // no Russian books. Answers go to store.setAiGenres and show on the site at once; genre pages catch up as the
  // search index is rebuilt every 2000 books and at the end. Progress in meta `genreall`. A restart resumes
  // it (server.js), and later runs only ask about books added since.
  allState() {
    return JSON.parse(this.db.get("genreall") || "null");
  }

  async runAll() {
    if (this.allRunning || !this.client) return false;
    this.allRunning = true;
    this.stopAll = false;
    const have = this.store.aiGenres();
    const todo = [...this.store.workIds()].filter((id) => !have.has(id)).map((id) => this.store.book(id)).filter((b) => b && !isRussian(b));
    const st = { cost: 0, errors: 0, ...this.allState(), at: new Date().toISOString(), prompt: PROMPT, total: todo.length, done: 0, finished: null, stopped: null };
    const save = () => this.db.set("genreall", JSON.stringify(st));
    save();
    let next = 0;
    const worker = async () => {
      while (next < todo.length && !this.stopAll) {
        const b = todo[next++];
        try {
          const { genres, usage } = await this.ask(b);
          st.cost += costOf(usage);
          if (genres.length) this.store.setAiGenres(b.id, genres, PROMPT);
        } catch (e) {
          st.errors++;
          this.log(`genreall: ${b.id}: ${e.message}`);
        }
        st.done++;
        if (st.done % 20 === 0) save();
        if (st.done % 2000 === 0) this.store.indexSearch();
      }
    };
    try {
      await Promise.all(Array.from({ length: PARALLEL_ALL }, worker));
    } finally {
      if (this.stopAll) st.stopped = new Date().toISOString();
      else st.finished = new Date().toISOString();
      save();
      this.allRunning = false;
      if (st.done) this.store.indexSearch();
    }
    return true;
  }

  // One new book (newbooks.js), once the whole catalog has been asked: not Russian, no genres from Haiku yet.
  async one(b) {
    if (!this.client || !this.allState()?.finished || isRussian(b) || this.store.aiGenres().has(b.id)) return null;
    const { genres, usage } = await this.ask(b);
    if (genres.length) this.store.setAiGenres(b.id, genres, PROMPT);
    return { answer: genres.join(", "), cost: costOf(usage) };
  }

  // Runs in the background; the admin page shows progress from meta `genretrial`.
  async run() {
    if (this.running || !this.client) return false;
    this.running = true;
    const books = this.pick();
    const st = { prompt: PROMPT, key: require("crypto").randomBytes(12).toString("hex"), at: new Date().toISOString(), model: MODEL, total: books.length, done: 0, cost: 0, items: [], errors: 0 };
    const save = () => this.db.set("genretrial", JSON.stringify(st));
    save();
    let next = 0;
    const worker = async () => {
      while (next < books.length) {
        const b = books[next++];
        const before = mainGenres(b.tags);
        try {
          const { genres, usage } = await this.ask(b);
          st.cost += costOf(usage);
          st.items.push({ id: b.id, title: b.title, author: b.author || "", before, after: genres });
        } catch (e) {
          st.errors++;
          st.items.push({ id: b.id, title: b.title, author: b.author || "", before, after: [], error: String(e.message || e).slice(0, 200) });
          this.log(`genretrial: ${b.id}: ${e.message}`);
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

module.exports = { GenreTrial };

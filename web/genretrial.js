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
const PRICE = { input: 0.1 / 1e6, output: 0.5 / 1e6 }; // $ per token, Haiku 5.5

const SYSTEM = (genres) => `You sort books into the genres of Chytai, a Ukrainian book site. The genres, in Ukrainian:
${genres.join(", ")}

For the book given, pick the one genre that fits it best, and a second one only when it clearly fits too. Use what you know about the book itself first; the shop shelves and subjects given are noisy hints, not facts. «художня» is for fiction that fits no more specific genre. A memoir or diary goes under «біографії» only when it is about a life; a travel or adventure memoir is «подорожі», a doctor's stories about medicine are «здоров'я». A literary classic is «класика», not «любовні романи». Children's and teen books are «дитячі» or «підліткові» whatever else they are.`;

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
    const out = [];
    for (const id of ids) {
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
      system: SYSTEM(this.genres),
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

  // Runs in the background; the admin page shows progress from meta `genretrial`.
  async run() {
    if (this.running || !this.client) return false;
    this.running = true;
    const books = this.pick();
    const st = { key: require("crypto").randomBytes(12).toString("hex"), at: new Date().toISOString(), model: MODEL, total: books.length, done: 0, cost: 0, items: [], errors: 0 };
    const save = () => this.db.set("genretrial", JSON.stringify(st));
    save();
    let next = 0;
    const worker = async () => {
      while (next < books.length) {
        const b = books[next++];
        const before = mainGenres(b.tags);
        try {
          const { genres, usage } = await this.ask(b);
          st.cost += (usage.input_tokens || 0) * PRICE.input + (usage.output_tokens || 0) * PRICE.output;
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

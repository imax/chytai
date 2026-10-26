// A trial of finding the Ukrainian translation of a foreign book (Max, 2026-10-24: «авто-пошук перекладів, як ми
// робили для оригіналів. тільки в іншу сторону»). Haiku says from what it knows whether a book was published in
// Ukrainian and under what title; the answer counts only when a catalog has a Ukrainian work of that title by
// the same author, so a made-up title never reaches the site. For 200 random foreign works on readers' shelves
// with no Ukrainian edition or translation we know; answers in meta `uktrial` for /admin/uk-trial.
// Nothing on the site changes. (ukfind.js is the other way in: a web search for one book a reader asks about.)

const Anthropic = require("@anthropic-ai/sdk");
const { isRussian } = require("./store");

const MODEL = "claude-haiku-5-5";
const SIZE = 200;
const PARALLEL = 4;
const PROMPT = 1; // the SYSTEM version below; bump it with every change
const PRICE = { input: 0.1 / 1e6, output: 0.5 / 1e6, cacheRead: 0.01 / 1e6, cacheWrite: 0.125 / 1e6 }; // $ per token, Haiku 5.5
const costOf = (u) => (u.input_tokens || 0) * PRICE.input + (u.cache_read_input_tokens || 0) * PRICE.cacheRead + (u.cache_creation_input_tokens || 0) * PRICE.cacheWrite + (u.output_tokens || 0) * PRICE.output;
const CYR = /[а-яіїєґ]/i;

const SYSTEM = `You help Chytai, a Ukrainian book site, find the Ukrainian translation of a foreign book. Given the book's title and author, say whether it has been published in Ukrainian (not Russian), and if so give the Ukrainian title exactly as printed on that edition, the author's name as written in Ukrainian, and the publisher. Answer «no» when you know of no Ukrainian edition, and «unknown» when you are not sure which book this is. Never translate the title yourself: give only a title you know an edition was published under.`;

class UkTrial {
  constructor({ store, social, db, apiKey, log = () => {} }) {
    this.store = store;
    this.social = social;
    this.db = db;
    this.log = log;
    this.client = apiKey ? new Anthropic({ apiKey }) : null;
    this.running = false;
  }

  state() {
    return JSON.parse(this.db.get("uktrial") || "null");
  }

  // A foreign work with no Ukrainian version we know: Latin title, no translation pair, no Cyrillic edition.
  lonely(b) {
    return b && /[a-z]/i.test(b.title || "") && !CYR.test(b.title || "") && !isRussian(b) && !(this.store.translations?.get(b.id)?.size) && !(b.editions || []).some((e) => CYR.test(e.title || ""));
  }

  pick() {
    const ids = [...new Set(this.social.all().map((x) => this.store.canonical(x.id)))];
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    const seen = new Set([...JSON.parse(this.db.get("uktrial:seen") || "[]"), ...(this.state()?.items || []).map((x) => x.id)]);
    this.db.set("uktrial:seen", JSON.stringify([...seen]));
    const all = ids.map((id) => this.store.book(id)).filter((b) => this.lonely(b));
    return { books: all.filter((b) => !seen.has(b.id)).slice(0, SIZE), pool: all.length };
  }

  async ask(b) {
    const facts = [
      `Title: ${b.title}`,
      b.author ? `Author: ${b.author}` : "",
      b.published ? `First published: ${b.published}` : "",
      b.blurb ? `Description: ${String(b.blurb).replace(/\s+/g, " ").slice(0, 400)}` : "",
    ].filter(Boolean);
    const message = await this.client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      output_config: {
        effort: "low",
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              answer: { type: "string", enum: ["yes", "no", "unknown"] },
              title: { type: "string" },
              author: { type: "string" },
              publisher: { type: "string" },
            },
            required: ["answer", "title", "author", "publisher"],
            additionalProperties: false,
          },
        },
      },
      messages: [{ role: "user", content: facts.join("\n") }],
    });
    if (message.stop_reason === "refusal") throw new Error("refusal");
    const text = message.content.filter((c) => c.type === "text").map((c) => c.text).join("");
    return { answer: JSON.parse(text), usage: message.usage };
  }

  // The Ukrainian work in our catalogs that answer names: that title by that author, in Cyrillic, not this book.
  match(b, a) {
    if (a.answer !== "yes" || !CYR.test(a.title || "")) return "";
    const id = this.store.findWork({ title: a.title, author: a.author }) || this.store.findWork({ title: a.title, author: b.author });
    const w = id && this.store.book(id);
    return w && w.id !== b.id && CYR.test(w.title || "") && !isRussian(w) ? w.id : "";
  }

  // Runs in the background; the admin page shows progress from meta `uktrial`.
  async run() {
    if (this.running || !this.client) return false;
    this.running = true;
    const { books, pool } = this.pick();
    const st = { prompt: PROMPT, key: require("crypto").randomBytes(12).toString("hex"), at: new Date().toISOString(), model: MODEL, pool, total: books.length, done: 0, cost: 0, items: [], errors: 0 };
    const save = () => this.db.set("uktrial", JSON.stringify(st));
    save();
    let next = 0;
    const worker = async () => {
      while (next < books.length) {
        const b = books[next++];
        const item = { id: b.id, title: b.title, author: b.author || "" };
        try {
          const { answer, usage } = await this.ask(b);
          st.cost += costOf(usage);
          Object.assign(item, { answer: answer.answer, uk: answer.answer === "yes" ? answer.title : "", ukAuthor: answer.answer === "yes" ? answer.author : "", publisher: answer.answer === "yes" ? answer.publisher : "", found: this.match(b, answer) });
        } catch (e) {
          st.errors++;
          item.error = String(e.message || e).slice(0, 200);
          this.log(`uktrial: ${b.id}: ${e.message}`);
        }
        st.items.push(item);
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

module.exports = { UkTrial };

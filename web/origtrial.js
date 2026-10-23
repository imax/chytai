// A trial of finding the original of a translation (Max, 2026-10-23: «можемо ще й пошук оригіналу додати? за
// тією ж схемою?», on «Продуктивність без турбот» a reader added while «Getting Things Done» is not in our
// catalogs). A translation finds its original by altTitle, Wikidata or a hand pair; a reader's Ukrainian book
// often has none of them. This asks Haiku, from what it knows, whether such a book is a translation and of
// what, for 200 random Ukrainian-titled works on readers' shelves without a known original, and keeps the
// answers in meta `origtrial` for /admin/orig-trial. Nothing on the site changes.

const Anthropic = require("@anthropic-ai/sdk");
const { isRussian, norm } = require("./store");

const MODEL = "claude-haiku-5-5";
const SIZE = 200;
const PARALLEL = 4;
const PROMPT = 1; // the SYSTEM version below; bump it with every change
const PRICE = { input: 0.1 / 1e6, output: 0.5 / 1e6 }; // $ per token, Haiku 5.5
const CYR = /[а-яіїєґ]/i;

const SYSTEM = `You help Chytai, a Ukrainian book site, link a Ukrainian edition to the book it was translated from. Given a book's Ukrainian title, author and description, say whether it is a translation, and if so give the original title as published in the original language (the full main title, without a subtitle unless it is part of the name everyone uses) and the author's name as written in the original. Answer «ukrainian» for a book written in Ukrainian, and «unknown» when you are not sure which book this is: a wrong original is worse than none, so do not guess from the title's words alone.`;

class OrigTrial {
  constructor({ store, social, db, apiKey, log = () => {} }) {
    this.store = store;
    this.social = social;
    this.db = db;
    this.log = log;
    this.client = apiKey ? new Anthropic({ apiKey }) : null;
    this.running = false;
  }

  state() {
    return JSON.parse(this.db.get("origtrial") || "null");
  }

  // A Ukrainian-titled work with no original we know: no altTitle and no paired translation.
  orphan(b) {
    return b && CYR.test(b.title || "") && !isRussian(b) && !b.altTitle && !(this.store.translations?.get(b.id)?.size);
  }

  // 200 random such works on readers' shelves; a second run takes others.
  pick() {
    const ids = [...new Set(this.social.all().map((x) => this.store.canonical(x.id)))];
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    const seen = new Set([...JSON.parse(this.db.get("origtrial:seen") || "[]"), ...(this.state()?.items || []).map((x) => x.id)]);
    this.db.set("origtrial:seen", JSON.stringify([...seen]));
    const all = ids.map((id) => this.store.book(id)).filter((b) => this.orphan(b));
    return { books: all.filter((b) => !seen.has(b.id)).slice(0, SIZE), pool: all.length };
  }

  async ask(b) {
    const facts = [
      `Title: ${b.title}`,
      b.author ? `Author: ${b.author}` : "",
      b.published ? `Published: ${b.published}` : "",
      b.blurb ? `Description: ${String(b.blurb).replace(/\s+/g, " ").slice(0, 700)}` : "",
    ].filter(Boolean);
    const message = await this.client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM,
      output_config: {
        effort: "low",
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["translation", "ukrainian", "unknown"] },
              title: { type: "string" },
              author: { type: "string" },
              language: { type: "string" },
            },
            required: ["kind", "title", "author", "language"],
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

  // Every such book on readers' shelves not asked yet (Max 2026-10-23), answers into store.setAiOrig; then the
  // translations are linked again, so an original already in a catalog pairs at once. server.js repeats it
  // every six hours for books readers add. Progress in meta `origall`.
  allState() {
    return JSON.parse(this.db.get("origall") || "null");
  }

  async runAll() {
    if (this.allRunning || !this.client) return false;
    this.allRunning = true;
    const have = this.store.aiOrigs();
    const ids = [...new Set(this.social.all().map((x) => this.store.canonical(x.id)))].filter((id) => !have.has(id));
    const todo = ids.map((id) => this.store.book(id)).filter((b) => this.orphan(b));
    const st = { cost: 0, errors: 0, ...this.allState(), at: new Date().toISOString(), prompt: PROMPT, total: todo.length, done: 0, finished: null };
    const save = () => this.db.set("origall", JSON.stringify(st));
    save();
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const b = todo[next++];
        try {
          const { answer, usage } = await this.ask(b);
          st.cost += (usage.input_tokens || 0) * PRICE.input + (usage.output_tokens || 0) * PRICE.output;
          this.store.setAiOrig(b.id, answer, PROMPT);
        } catch (e) {
          st.errors++;
          this.log(`origall: ${b.id}: ${e.message}`);
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
      if (st.done) {
        this.store.linkTranslations();
        this.store.indexSearch();
      }
    }
    return true;
  }

  // Runs in the background; the admin page shows progress from meta `origtrial`.
  async run() {
    if (this.running || !this.client) return false;
    this.running = true;
    const { books, pool } = this.pick();
    // Whether the original Haiku names is already a work in our catalogs (then pairing is free).
    const byTitle = new Map();
    for (const id of this.store.workIds()) {
      const w = this.store.book(id);
      if (w && !CYR.test(w.title || "")) byTitle.set(norm(w.title), id);
    }
    const st = { prompt: PROMPT, key: require("crypto").randomBytes(12).toString("hex"), at: new Date().toISOString(), model: MODEL, pool, total: books.length, done: 0, cost: 0, items: [], errors: 0 };
    const save = () => this.db.set("origtrial", JSON.stringify(st));
    save();
    let next = 0;
    const worker = async () => {
      while (next < books.length) {
        const b = books[next++];
        const item = { id: b.id, title: b.title, author: b.author || "" };
        try {
          const { answer, usage } = await this.ask(b);
          st.cost += (usage.input_tokens || 0) * PRICE.input + (usage.output_tokens || 0) * PRICE.output;
          Object.assign(item, { kind: answer.kind, orig: answer.kind === "translation" ? answer.title : "", origAuthor: answer.kind === "translation" ? answer.author : "", lang: answer.language || "" });
          if (item.orig) item.inCatalog = byTitle.get(norm(item.orig)) || "";
        } catch (e) {
          st.errors++;
          item.error = String(e.message || e).slice(0, 200);
          this.log(`origtrial: ${b.id}: ${e.message}`);
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

module.exports = { OrigTrial };

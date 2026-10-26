// One Haiku pass over part of the catalog, tried on a sample first (Max, 2026-10-24: «якісний каталог це дуже
// важливо», «беремо всі»). A pass names its subjects (books, groups of books, authors), what it tells Haiku
// about one, the answer it wants, and how an answer reads next to what the site has now. run() asks about a
// random sample and keeps the answers in meta `aipass:<key>` for /admin/ai/<key>; nothing on the site changes.
// The passes themselves are in catalogpasses.js; genres, language, originals and translations came before
// this and keep their own files.

const Anthropic = require("@anthropic-ai/sdk");

const MODEL = "claude-haiku-5-5";
const PRICE = { input: 0.1 / 1e6, output: 0.5 / 1e6, cacheRead: 0.01 / 1e6, cacheWrite: 0.125 / 1e6 }; // $ per token, Haiku 5.5
const costOf = (u) => (u.input_tokens || 0) * PRICE.input + (u.cache_read_input_tokens || 0) * PRICE.cacheRead + (u.cache_creation_input_tokens || 0) * PRICE.cacheWrite + (u.output_tokens || 0) * PRICE.output;

class AiPass {
  // def: { key, name, what, prompt, system, schema, size, candidates(), facts(s) -> string | content blocks,
  //        item(s, answer) -> { id, title, author, before, after, diff, thumb? }, finish?(st) }
  constructor(def, { db, apiKey, log = () => {} }) {
    Object.assign(this, { size: 200, parallel: 4, prompt: 1, maxTokens: 1024 }, def);
    this.db = db;
    this.log = log;
    this.client = apiKey ? new Anthropic({ apiKey }) : null;
    this.running = false;
  }

  state() {
    return JSON.parse(this.db.get(`aipass:${this.key}`) || "null");
  }

  // A random sample of the candidates; the ones an earlier trial asked about wait, so a second run is fresh.
  pick() {
    const all = this.candidates();
    // Candidates come in the order the pass prefers (readers' books, likely cases); shuffle within halves of it.
    const head = all.slice(0, Math.max(this.size * 3, Math.ceil(all.length / 2)));
    for (let i = head.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [head[i], head[j]] = [head[j], head[i]];
    }
    const seen = new Set([...JSON.parse(this.db.get(`aipass:${this.key}:seen`) || "[]"), ...(this.state()?.items || []).map((x) => x.id)]);
    this.db.set(`aipass:${this.key}:seen`, JSON.stringify([...seen]));
    return { subjects: [...head, ...all.slice(head.length)].filter((s) => !seen.has(s.id)).slice(0, this.size), pool: all.length };
  }

  async ask(s) {
    const content = this.facts(s);
    const message = await this.client.messages.create({
      model: MODEL,
      max_tokens: this.maxTokens,
      // The same system prompt for every book of a pass: cached, so a run of hundreds pays for it once per 5 minutes.
      system: [{ type: "text", text: this.system, cache_control: { type: "ephemeral" } }],
      output_config: { effort: "low", format: { type: "json_schema", schema: this.schema } },
      messages: [{ role: "user", content }],
    });
    if (message.stop_reason === "refusal") throw new Error("refusal");
    const text = message.content.filter((c) => c.type === "text").map((c) => c.text).join("");
    return { answer: JSON.parse(text), usage: message.usage };
  }

  // Runs in the background; the admin page shows progress from meta `aipass:<key>`.
  async run() {
    if (this.running || !this.client) return false;
    this.running = true;
    let st;
    try {
      const { subjects, pool } = this.pick();
      st = { prompt: this.prompt, key: require("crypto").randomBytes(12).toString("hex"), at: new Date().toISOString(), model: MODEL, pool, total: subjects.length, done: 0, cost: 0, items: [], errors: 0 };
      const save = () => this.db.set(`aipass:${this.key}`, JSON.stringify(st));
      save();
      let next = 0;
      const worker = async () => {
        while (next < subjects.length) {
          const s = subjects[next++];
          try {
            const { answer, usage } = await this.ask(s);
            st.cost += costOf(usage);
            st.items.push({ ...this.item(s, answer), answer });
          } catch (e) {
            st.errors++;
            st.items.push({ ...this.item(s, null), error: String(e.message || e).slice(0, 200) });
            this.log(`aipass ${this.key}: ${s.id}: ${e.message}`);
          }
          st.done++;
          if (st.done % 10 === 0) save();
        }
      };
      await Promise.all(Array.from({ length: this.parallel }, worker));
      if (this.finish) this.finish(st);
    } finally {
      if (st) {
        st.finished = new Date().toISOString();
        this.db.set(`aipass:${this.key}`, JSON.stringify(st));
      }
      this.running = false;
    }
    return true;
  }

  // ---- applying (a pass with def.apply) ----
  // Every candidate not answered yet is asked once (table ai_answer); def.apply(items) puts the answers on the
  // site in one go at the end. Once applied, a pass is «live»: server.js runs it again every six hours for
  // new candidates. Progress in meta `aipass:<key>:all`.
  allState() {
    return JSON.parse(this.db.get(`aipass:${this.key}:all`) || "null");
  }

  live() {
    return !!this.allState()?.finished;
  }

  answered() {
    return new Set(this.db.prepare("SELECT id FROM ai_answer WHERE pass = ?").all(this.key).map((r) => r.id));
  }

  async runAll() {
    if (!this.apply || this.allRunning || this.running || !this.client) return false;
    this.allRunning = true;
    const done = this.answered();
    const todo = this.candidates().filter((s) => !done.has(s.id));
    const st = { cost: 0, errors: 0, ...this.allState(), at: new Date().toISOString(), prompt: this.prompt, total: todo.length, done: 0, finished: null };
    const save = () => this.db.set(`aipass:${this.key}:all`, JSON.stringify(st));
    save();
    const put = this.db.prepare("INSERT OR REPLACE INTO ai_answer (pass, id, answer, prompt, at) VALUES (?, ?, ?, ?, ?)");
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const s = todo[next++];
        try {
          const { answer, usage } = await this.ask(s);
          st.cost += costOf(usage);
          put.run(this.key, s.id, JSON.stringify(answer), this.prompt, new Date().toISOString());
        } catch (e) {
          st.errors++;
          this.log(`aipass ${this.key} all: ${s.id}: ${e.message}`);
        }
        st.done++;
        if (st.done % 20 === 0) save();
      }
    };
    try {
      await Promise.all(Array.from({ length: this.parallel }, worker));
      // Every stored answer goes to apply, not only this run's: a run cut by a deploy asked some already, and
      // apply is safe to repeat.
      const saved = new Map(this.db.prepare("SELECT id, answer FROM ai_answer WHERE pass = ?").all(this.key).map((r) => [r.id, JSON.parse(r.answer)]));
      const all = this.candidates().filter((s) => saved.has(s.id)).map((s) => ({ s, answer: saved.get(s.id), item: this.item(s, saved.get(s.id)) }));
      st.applied = this.apply(all) || 0;
    } finally {
      st.finished = new Date().toISOString();
      save();
      this.allRunning = false;
    }
    return true;
  }

  // The results as plain text for the share link.
  text() {
    const st = this.state();
    const line = (x) => `${x.diff ? "*" : " "} ${x.title}${x.author ? ` — ${x.author}` : ""} | зараз: ${x.before || "—"} | Haiku: ${x.error ? `помилка ${x.error}` : x.after || "—"}`;
    return [`${this.name}: промпт v${st.prompt}, ${st.model}, ${st.at}: ${st.done} з ${st.total} (кандидатів ${st.pool}), $${(st.cost || 0).toFixed(3)}${st.finished ? "" : ", ще йде"}`, "* = Haiku пропонує зміну", "", ...st.items.map(line)].join("\n");
  }
}

module.exports = { AiPass };

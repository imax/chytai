// A trial of the overview prompt (Max, 2026-10-27, thread «Покращити огляди „Що кажуть про книжку“»: «так давай
// спробуємо»): the next prompt version run on a fixed set of twenty-one books whose current overview showed a
// weakness (an aside to the editor in the text, no search behind it, shop or Russian sources, the template
// shape), shown on /admin/overviews-trial next to what the page shows now. Nothing on the site changes until
// the owner presses «Поставити ці огляди на сайт», which keeps only these twenty.
const { PROMPT_VERSION, OVERVIEW_PROMPTS } = require("./advice");

const VERSION = Math.max(...Object.keys(OVERVIEW_PROMPTS).map(Number));
const PARALLEL = 2;
// Why each book is in: the weakness its v8 overview showed on 2026-10-27.
const BOOKS = [
  ["ecce-homo", "примітка «я не робив пошук» у тексті"],
  ["stone-257085", "«пошук не спрацював… варто перевірити» у тексті"],
  ["nahliadaty-y-karaty-narodzhennia-viaznytsi", "«(Примітка: пошук не спрацював…)» у тексті"],
  ["bookchef-222040", "починається з «На сторінці книжки має бути таке:»"],
  ["forever-war", "починається з «Пошук не спрацював, тож пишу з того, що знаю»"],
  ["astroliabiia-014203", "без пошуку"],
  ["bohdan-128995", "без пошуку"],
  ["ready-player-one", "без пошуку"],
  ["nashformat-184971", "без пошуку"],
  ["apriori-278259", "7 із 10 джерел — магазини; той самий запит тричі"],
  ["vikhola-943938", "джерела livelib.ru"],
  ["zhorzh-schodennyky-vbyvtsebota-vsi-systemy-nebezpeka", "джерела 4read, ksd, fabulabook"],
  ["starylev-1293", "джерела — магазини й піратки"],
  ["osnovy-142", "джерела livelib.ru"],
  ["kolaps", "джерела ksd, knigogo"],
  ["running-kite", "шаблон: нічого понад анотацію"],
  ["the-talented-mr-ripley", "шаблон"],
  ["a-walk-in-the-woods", "шаблон, вигадана аудиторія"],
  ["nashformat-349361", "лише англійські джерела"],
  ["potsilunok-u-niu-yorku", "шаблон, починається з «Здебільшого читачі…»"],
  ["team-topologies-organizing-business-and-technology-teams-for", "шаблон"],
];
// Opus 5.5 list prices, as in advice.overviewStats().
const costOf = (u) => ((u.input + u.cached) * 4 + u.output * 20) / 1e6 + u.searches / 100;

class OverviewTrial {
  constructor({ store, advice, db, log = () => {} }) {
    this.store = store;
    this.advice = advice;
    this.db = db;
    this.log = log;
    this.running = false;
  }
  get version() {
    return VERSION;
  }
  get live() {
    return PROMPT_VERSION;
  }
  state() {
    return JSON.parse(this.db.get("overviewtrial") || "null");
  }
  // The twenty with what the page shows now.
  items() {
    return BOOKS.map(([id, why]) => {
      const book = this.store.book(id);
      const old = book ? this.advice.overviewOf(id) : null;
      return { id, why, title: book?.title || id, author: book?.author || "", href: book ? this.store.href(id) : "", old: old?.text || "", oldPrompt: old ? this.db.prepare("SELECT prompt, searches FROM overview WHERE book = ?").get(old.book) : null };
    });
  }
  async run() {
    if (this.running || !this.advice.enabled) return false;
    this.running = true;
    const st = { version: VERSION, key: require("crypto").randomBytes(12).toString("hex"), at: new Date().toISOString(), total: BOOKS.length, done: 0, cost: 0, errors: 0, items: [] };
    const save = () => this.db.set("overviewtrial", JSON.stringify(st));
    save();
    let next = 0;
    const worker = async () => {
      while (next < BOOKS.length) {
        const [id] = BOOKS[next++];
        const book = this.store.book(id);
        const item = { id };
        if (!book) item.error = "немає в каталозі";
        else {
          try {
            const r = await this.advice.overview(book, { by: "trial", version: VERSION, keep: false });
            Object.assign(item, { text: r.text, model: r.model, queries: r.queries, sources: r.sources.slice(0, 30), searches: r.usage.searches, cost: costOf(r.usage) });
            st.cost += item.cost;
          } catch (e) {
            st.errors++;
            item.error = String(e.message || e).slice(0, 200);
            this.log(`overviewtrial: ${id}: ${e.message}`);
          }
        }
        st.items.push(item);
        st.done++;
        save();
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
  // The owner liked them: the trial's texts become these books' overviews (prompt VERSION), nothing else changes.
  keep() {
    const st = this.state();
    if (!st?.finished) return 0;
    let n = 0;
    for (const x of st.items) {
      if (!x.text || !this.store.book(x.id)) continue;
      const id = this.advice.homeOf(x.id);
      this.db
        .prepare("INSERT INTO overview (book, text, model, created, by, input_tokens, output_tokens, searches, prompt, sources) VALUES (?, ?, ?, ?, 'trial', 0, 0, ?, ?, ?) ON CONFLICT (book) DO UPDATE SET text = excluded.text, model = excluded.model, created = excluded.created, by = excluded.by, searches = excluded.searches, prompt = excluded.prompt, sources = excluded.sources")
        .run(id, x.text, x.model || "", new Date().toISOString(), x.searches || 0, st.version, JSON.stringify({ queries: x.queries || [], sources: x.sources || [] }));
      this.advice.linkCache?.clear();
      n++;
    }
    st.kept = new Date().toISOString();
    this.db.set("overviewtrial", JSON.stringify(st));
    return n;
  }
}

module.exports = { OverviewTrial };

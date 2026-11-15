// «Словничок» (Max, 2026-11-15, after a friend's daughter read «Чорна рада» for school: «половина тексту незрозуміла
// їй»): the free shelf's classics get, once per book, a list of the words a reader of 12–16 today would not know
// (old, dialect, historical), each with a few words of plain Ukrainian. The reader underlines them in the text and a
// tap shows the meaning (renderer.js `Gloss`). Made by Sonnet chapter by chapter, kept as
// DATA_DIR/glossary/<book>.json { book, model, at, calls, cost, forms: { form: gloss } }; one small file a book, at
// most one a free-shelf book. Only on a thread's or Max's request (/agent/glossary): never for every book at once.
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");
const { epubParts } = require("./content");
const { measure } = require("./aimeter");

const MODEL = "claude-sonnet-5-5";
const CHUNK = 15000; // characters of text a call
const AT_ONCE = 3;

const PROMPT = `You make a reading glossary for a Ukrainian classic that school students aged 12–16 read today, often for the first time and without help. The reader taps an underlined word and sees your explanation, so each one has to make the sentence clear at a glance.

Read the passage and list the words and short expressions that would actually stop such a reader, so the sentence makes no sense without help:
- archaic and obsolete words and Church Slavonic ones;
- dialect words and old spellings or forms that hide a familiar word (оддалеки → здалеку, ції → цієї, теє → те, ізнов → знову);
- historical things a teenager does not know: clothes, ranks and offices, weapons, money, measures, customs, church words;
- a word whose usual modern meaning would mislead here (по́лудень meaning a midday meal, not noon), when it has that old sense throughout the book.

Leave out:
- words a teenager knows or easily guesses from the sentence (козак, гетьман, шабля, бандура, кобзар, хата, степ, любо, гай, віти, травиця, мов, хіба, зараз);
- prepositions, conjunctions, particles and pronouns, unless their form itself is old or dialect (од, ізнов, тії, теє go in);
- names of people, places and peoples, nicknames included;
- the meaning an ordinary word has in one sentence only (an idiom of the moment): the reader sees the same explanation wherever the word appears.

When in doubt, leave it out: a page full of underlines is no help. A passage this long usually has 15 to 40 such items; never pad the list. A word that is offensive today gets «(застаріле, образливе)» after its meaning.

Answer with one line per item and nothing else: the word or expression exactly as written in the passage (same case and ending, without stress marks), a tab, then the explanation in modern Ukrainian: a plain synonym, or at most ten words for a thing that needs explaining. No full stop at the end, no examples, no comments. An expression may be two or three words when only together they mean something. List each form once.`;

// The key a form is looked up by: lower case, no stress marks, one kind of apostrophe. The page does the same.
// Only the stress marks go: й and ї carry marks of their own in NFD.
const key = (s) => String(s || "").normalize("NFD").replace(/[\u0300\u0301]/g, "").normalize("NFC").toLowerCase().replace(/['’`ʼ]/g, "ʼ").replace(/\s+/g, " ").trim();

// The book's text in pieces of about CHUNK characters, cut between sentences.
function chunks(chapters) {
  const out = [];
  for (const ch of chapters) {
    const text = ch.normalize("NFD").replace(/\u0301/g, "").normalize("NFC");
    let at = 0;
    while (at < text.length) {
      let end = Math.min(text.length, at + CHUNK);
      if (end < text.length) {
        const cut = Math.max(text.lastIndexOf(". ", end), text.lastIndexOf("! ", end), text.lastIndexOf("? ", end));
        if (cut > at + CHUNK / 2) end = cut + 1;
      }
      out.push(text.slice(at, end).trim());
      at = end;
    }
  }
  return out.filter((t) => t.length > 200);
}

function parse(answer) {
  const out = [];
  for (const line of String(answer || "").split("\n")) {
    const [w, g] = line.split("\t");
    const form = (w || "").replace(/^[-*•\d.\s]+/, "").trim();
    const gloss = (g || "").trim().replace(/\.$/, "");
    if (!form || !gloss || form.length > 40 || gloss.length > 140 || form.split(/\s+/).length > 3) continue;
    out.push([form, gloss]);
  }
  return out;
}

class Glossary {
  constructor({ dir, apiKey = process.env.ANTHROPIC_API_KEY }) {
    this.dir = dir;
    this.apiKey = apiKey;
    this.cache = new Map(); // book -> file contents, while the file is unchanged
    this.running = new Map(); // book -> { at, done, of, error }
  }
  file(book) {
    return path.join(this.dir, `${path.basename(book)}.json`);
  }
  get(book) {
    const f = this.file(book);
    let mtime;
    try {
      mtime = fs.statSync(f).mtimeMs;
    } catch {
      return null;
    }
    const kept = this.cache.get(book);
    if (kept?.mtime === mtime) return kept.data;
    try {
      const data = JSON.parse(fs.readFileSync(f, "utf8"));
      this.cache.set(book, { mtime, data });
      return data;
    } catch {
      return null;
    }
  }
  // The books that have one (for the page's settings).
  books() {
    try {
      return fs.readdirSync(this.dir).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5));
    } catch {
      return [];
    }
  }
  status() {
    return {
      made: this.books().map((b) => {
        const g = this.get(b);
        return { book: b, forms: Object.keys(g?.forms || {}).length, calls: g?.calls, cost: g?.cost, at: g?.at, model: g?.model };
      }),
      running: Object.fromEntries(this.running),
    };
  }
  // Makes the book's glossary in the background; a second call for the same book while it runs does nothing.
  start(book, file) {
    if (this.running.get(book)?.done === false) return false;
    const run = { at: new Date().toISOString(), done: false, chunks: 0, of: 0 };
    this.running.set(book, run);
    this.build(book, file, run)
      .catch((err) => (run.error = err.message))
      .finally(() => (run.done = true));
    return true;
  }
  async build(book, file, run = {}) {
    if (!this.apiKey) throw new Error("no ANTHROPIC_API_KEY");
    const { chapters } = await epubParts(fs.readFileSync(file));
    const parts = chunks(chapters);
    run.of = parts.length;
    const client = new Anthropic({ apiKey: this.apiKey });
    const answers = new Array(parts.length);
    let cost = 0;
    let next = 0;
    const work = async () => {
      while (next < parts.length) {
        const i = next++;
        const m = await client.messages.create({
          model: MODEL,
          max_tokens: 8000,
          system: [{ type: "text", text: PROMPT, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: parts[i] }],
          output_config: { effort: "medium" },
        });
        cost += measure(m.model, m.usage).cost;
        answers[i] = m.content.filter((b) => b.type === "text").map((b) => b.text).join("");
        run.chunks = (run.chunks || 0) + 1;
      }
    };
    await Promise.all(Array.from({ length: Math.min(AT_ONCE, parts.length) }, work));
    // The first meaning a form got stays: later chapters mostly repeat it.
    const forms = {};
    for (const a of answers) for (const [form, gloss] of parse(a)) forms[key(form)] ??= gloss;
    const data = { book, model: MODEL, at: new Date().toISOString(), calls: parts.length, cost: Math.round(cost * 1000) / 1000, forms };
    fs.mkdirSync(this.dir, { recursive: true });
    const f = this.file(book);
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(data));
    fs.renameSync(`${f}.tmp`, f);
    run.forms = Object.keys(forms).length;
    run.cost = data.cost;
    return data;
  }
}

module.exports = { Glossary, key, chunks, parse, PROMPT, MODEL };

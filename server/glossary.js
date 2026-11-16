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

// A second, stricter look at the whole list (Max, 2026-11-16: «досить прості і знайомі слова теж відмічає», e.g.
// «їх», «зблизька», «сказать би»): the model sees only word and meaning and keeps the ones a teenager would really stop at.
const STRICT = `Below is a reading glossary for a Ukrainian classic that school students aged 12–16 read today. Each line is a word or expression as it appears in the book, a tab, and its explanation. The reader sees every listed word underlined in the text, so each extra one is noise.

Too many entries are words such a reader already knows or understands at once from the sentence: plain words in an old spelling that is easy to read (їх, зблизька, сказать би, войни, послі), ordinary words (хутір, верхи, гай), simple diminutives and forms of a known word.

Keep only the entries a modern teenager would really not understand or would misread: words that are gone from today's language, dialect words, old forms that hide a different-looking word (оддалеки → здалеку), historical things unknown today (ranks, clothes, money, customs), and old senses of familiar words.

Answer with the kept words only, one per line, exactly as given before the tab, nothing else.`;
const STRICT_BATCH = 300;

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

// Common words the model lists now and then although a teenager knows them; a sense they have in one sentence only
// came out as their meaning everywhere («один — один раз»).
const COMMON = new Set(["хіба", "тим", "ото", "лиш", "лише", "мов", "скоро", "отже", "таки", "куди", "один", "зараз", "тепер", "трохи"]);

// What the model gave, tidied with the book's text: a name (capitalised in the middle of sentences: «Пугач — велика
// сова»), a common word, or a meaning that only repeats the word goes.
function clean(forms, chapters) {
  const text = chapters.join(" ").normalize("NFD").replace(/[\u0300\u0301]/g, "").normalize("NFC");
  const caps = {};
  for (const m of text.matchAll(/(^|[^.!?…»"“”—–:\s]\s+)([\p{L}]+(?:['’ʼ-][\p{L}]+)*)/gu)) {
    const k = key(m[2]);
    if (!forms[k]) continue;
    const c = (caps[k] ??= [0, 0]);
    c[1]++;
    if (m[2][0] !== m[2][0].toLowerCase()) c[0]++;
  }
  const out = {};
  for (const [k, gloss] of Object.entries(forms)) {
    const c = caps[k];
    if (c && c[1] >= 2 && c[0] / c[1] > 0.6) continue;
    if (COMMON.has(k)) continue;
    if (key(gloss.split(/[\s,(]/)[0]) === k) continue;
    out[k] = gloss;
  }
  return out;
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
  // `maxCalls`: a longer book is not made (readers' uploads: a whole collected works would cost dollars).
  constructor({ dir, apiKey = process.env.ANTHROPIC_API_KEY, maxCalls = 0 }) {
    this.dir = dir;
    this.apiKey = apiKey;
    this.maxCalls = maxCalls;
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
  // A reader's upload replaced or gone for good: its list goes too.
  drop(book) {
    fs.rmSync(this.file(book), { force: true });
    this.cache.delete(book);
  }
  // Another book's list stands for this one: { same: "<free-shelf book>" } (an upload of a classic the shelf has).
  link(book, same) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file(book), JSON.stringify({ book, same, at: new Date().toISOString(), forms: {} }));
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
  // The kept list tidied again (clean() changed), with no model call.
  async retidy(book, file) {
    const data = this.get(book);
    if (!data) return null;
    const { chapters } = await epubParts(fs.readFileSync(file));
    const forms = clean(data.forms, chapters);
    const out = { ...data, forms, tidied: new Date().toISOString() };
    const f = this.file(book);
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(out));
    fs.renameSync(`${f}.tmp`, f);
    return { before: Object.keys(data.forms).length, after: Object.keys(forms).length, dropped: Object.keys(data.forms).filter((k) => !forms[k]) };
  }
  // The kept list through STRICT (a few cheap calls, no book text). Returns what went.
  async strict(book) {
    const data = this.get(book);
    if (!data) return null;
    if (!this.apiKey) throw new Error("no ANTHROPIC_API_KEY");
    const client = new Anthropic({ apiKey: this.apiKey });
    const entries = Object.entries(data.forms);
    const kept = new Set();
    let cost = 0;
    const batches = [];
    for (let i = 0; i < entries.length; i += STRICT_BATCH) batches.push(entries.slice(i, i + STRICT_BATCH));
    await Promise.all(
      batches.map(async (b) => {
        const m = await client.messages.create({
          model: MODEL,
          max_tokens: 8000,
          system: [{ type: "text", text: STRICT, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: b.map(([k, g]) => `${k}\t${g}`).join("\n") }],
          output_config: { effort: "medium" },
        });
        cost += measure(m.model, m.usage).cost;
        const text = m.content.filter((x) => x.type === "text").map((x) => x.text).join("");
        for (const line of text.split("\n")) kept.add(key(line.split("\t")[0]));
      }),
    );
    const forms = Object.fromEntries(entries.filter(([k]) => kept.has(k)));
    // An answer that kept almost nothing is a broken answer, not a verdict.
    if (Object.keys(forms).length < entries.length / 10) throw new Error(`strict kept only ${Object.keys(forms).length}`);
    const out = { ...data, forms, strict: new Date().toISOString(), cost: Math.round(((data.cost || 0) + cost) * 1000) / 1000 };
    const f = this.file(book);
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(out));
    fs.renameSync(`${f}.tmp`, f);
    return { before: entries.length, after: Object.keys(forms).length, cost: Math.round(cost * 1000) / 1000, dropped: entries.filter(([k]) => !kept.has(k)).map(([k]) => k) };
  }
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
    if (this.maxCalls && parts.length > this.maxCalls) throw new Error(`too long: ${parts.length} calls`);
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
    const data = { book, model: MODEL, at: new Date().toISOString(), calls: parts.length, cost: Math.round(cost * 1000) / 1000, forms: clean(forms, chapters) };
    fs.mkdirSync(this.dir, { recursive: true });
    const f = this.file(book);
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(data));
    fs.renameSync(`${f}.tmp`, f);
    await this.strict(book).catch((err) => (run.strictError = err.message));
    run.forms = Object.keys(this.get(book)?.forms || {}).length;
    run.cost = this.get(book)?.cost;
    return this.get(book);
  }
}

// Readers' own uploads get one too, by themselves, when the book is by an author school reads (Max, 2026-11-16: a
// school gave a friend's daughter an abridged PDF: «автоматом для певних книжок чи авторів»). The first word of a
// name is the first name (or the pseudonym's first half), the rest its surname; both must be in the book's author.
const CLASSICS = [
  "Пантелеймон Куліш", "Іван Котляревський", "Григорій Квітка-Основʼяненко", "Тарас Шевченко", "Марко Вовчок",
  "Іван Нечуй-Левицький", "Панас Мирний", "Іван Франко", "Леся Українка", "Михайло Коцюбинський", "Василь Стефаник",
  "Ольга Кобилянська", "Михайло Старицький", "Іван Карпенко-Карий", "Марко Кропивницький", "Леонід Глібов",
  "Микола Хвильовий", "Валерʼян Підмогильний", "Микола Куліш", "Остап Вишня", "Олександр Довженко", "Іван Багряний",
  "Улас Самчук", "Олесь Гончар", "Ліна Костенко", "Борис Грінченко", "Степан Васильченко", "Володимир Винниченко",
  "Архип Тесленко", "Григорій Сковорода", "Євген Гребінка", "Олександр Олесь", "Адріан Кащенко", "Іван Рудченко",
  "Василь Королів-Старий", "Юрій Яновський", "Григір Тютюнник", "Павло Тичина", "Максим Рильський", "Богдан-Ігор Антонич",
  "Михайль Семенко", "Володимир Сосюра", "Василь Стус", "Василь Симоненко", "Іван Драч", "Євген Маланюк", "Олена Теліга",
  "Олег Ольжич", "Валерій Шевчук", "Микола Вінграновський", "Юрій Федькович", "Маркіян Шашкевич", "Іван Вишенський",
];
const letters = (s) => key(s).replace(/[^\p{L}]+/gu, " ").trim();
const CLASSIC_NAMES = CLASSICS.map((n) => {
  const [first, ...rest] = letters(n).split(" ");
  return { first, last: rest.join(" ") };
});
// The authors of a book (["Куліш П.", "Пантелеймон Куліш"]) -> whether one is a school classic. An initial counts
// as the first name («П. Куліш»), the surname must be whole.
function classic(authors) {
  return (authors || []).some((a) => {
    const words = ` ${letters(a)} `;
    return CLASSIC_NAMES.some(({ first, last }) => words.includes(` ${last} `) && (words.includes(` ${first} `) || words.includes(` ${first[0]} `)));
  });
}

module.exports = { Glossary, key, chunks, parse, clean, classic, PROMPT, STRICT, MODEL };

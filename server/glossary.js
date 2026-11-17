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
// «Словничок 2» underlines a form everywhere with one meaning. A form that is also a common word with another meaning
// (Max 2026-11-17: «стіл» = престол at «та й за стіл!», «знай» = раз у раз at «знай, не боюсь тебе») misleads where
// it is meant the usual way. HOMO_FIND names such forms; HOMO_FIT then reads up to 4 of each one's sentences in the
// book, and a form whose meaning fits fewer than half of them goes.
const HOMO_FIND = `Below is a reading glossary for a Ukrainian classic. Each line is a word form as it appears in the book, a tab, and the meaning the glossary gives it. The reader sees the form underlined everywhere it occurs, always with this meaning.

List only the forms spelled exactly like a common everyday modern Ukrainian word or form whose usual meaning is different from the glossary's (стіл: table, not throne; знай: know!, not keep doing; пробував: tried, not stayed). Do not list words that are rare or gone today, dialect words, or forms that look unlike any common word.

Answer with those forms only, one per line, exactly as given before the tab, nothing else.`;
const HOMO_FIT = `Each line: a number, a tab, a word form, a tab, a meaning, a tab, a sentence from a Ukrainian classic where the form occurs. Does the form mean that in this sentence? Answer one line per input line: the number, a tab, 1 if yes or 0 if no. Nothing else.`;

// «Словничок 2» (Max, 2026-11-17: «іноді пропускає неочевидні слова, іноді підкреслює очевидні»).
// Opus reads the text (it catches false friends: «пробував» = перебував, «видав» = бачив, which Sonnet left out, and
// leaves out what a teenager knows) and gives each word a level: 1 the sentence is unclear without it, 2 a hint
// helps. «Аа» → «Менше» underlines level 1, «Більше» both. Then sweep() finds the other forms of each word in the
// book (the misses were mostly forms: «сердюка» listed, «сердюк» 7 times not). Kept apart, in DATA_DIR/glossary-v2/,
// as { v: 2, forms: { form: [meaning, level, word] } }; the first list stays for everyone else.
const MODEL_V2 = "claude-opus-5-5";
const SWEEP_MODEL = "claude-haiku-5-5";
const PROMPT_V2 = `You make a reading glossary for a Ukrainian classic that school students aged 12–16 read today, often alone. The reader taps an underlined word and sees your explanation, so it must make the sentence clear at a glance.

Go through the passage sentence by sentence and list every word or short expression that such a reader might not understand here. For each, decide how much it would stop them:

1 — without help the sentence is unclear: words gone from today's language, dialect words, Church Slavonic, old forms that hide a different-looking word (оддалеки → здалеку, ції → цієї, ізнов → знову), historical things unknown today (ranks and offices, clothes, weapons, money, measures, customs, church words), and familiar words used in an old sense that misleads (пробував meaning перебував, видав meaning бачив, полудень meaning a midday meal).
2 — the reader half-guesses from the sentence but is unsure: rarer bookish or folk words, less known historical words, idioms whose sense is not literal.

Leave out what a modern teenager knows or reads at once, even when it looks old:
- ordinary words: козак, гетьман, шабля, бандура, кобзар, хата, степ, ряса, пасіка, чабан, хвіртка, світлиця, гай, верхи, могила, труна, ворота, піп;
- an old spelling, ending or sound of a word the reader recognises at once: пришов, войни, їх, сказать, послі, зблизька, ходім, оддав, лічить, знать, хотя;
- plain diminutives and augmentatives of known words (шаблюка, фірточка, дідуган);
- names of people, places and peoples; prepositions, conjunctions and particles unless their form itself hides the word (ізнов, теє, ції go in; од goes out).
When unsure whether a teenager knows a word, leave it out: an underline on a word one knows is noise.

Answer with one line per item and nothing else, four fields separated by tabs:
the word or expression exactly as written in the passage (same case and ending, no stress marks), its dictionary form, its meaning in this sentence in modern Ukrainian (a plain synonym, or at most ten words for a thing; no full stop), and 1 or 2.
List each form once. Check every meaning against its sentence: a wrong meaning is worse than none.`;
const SWEEP = `Each line has a word from a Ukrainian classic, a tab, and one to three glossary entries (word = meaning) that look similar. Say for each line whether the word is a grammatical form of one of those glossary words with the same meaning (another case, number, gender, tense or person, or a spelling variant of the same word), so the reader should see the same explanation. A different word that only starts the same way (броварі ≠ бровами, староста ≠ старосвітщину) is not.
Answer only the lines where it is: the word, a tab, the glossary word it belongs to. Nothing else.`;
const SWEEP_BATCH = 250;

function parseV2(answer) {
  const out = [];
  for (const line of String(answer || "").split("\n")) {
    const [w, word, g, l] = line.split("\t");
    const form = (w || "").replace(/^[-*•\d.\s]+/, "").trim();
    const gloss = (g || "").trim().replace(/\.$/, "");
    const level = Number(String(l || "").trim()) === 2 ? 2 : Number(String(l || "").trim()) === 1 ? 1 : 0;
    if (!form || !gloss || !level || form.length > 40 || gloss.length > 140 || form.split(/\s+/).length > 3) continue;
    out.push([form, gloss, level, (word || form).trim().slice(0, 60)]);
  }
  return out;
}

// The book's words that look like another form of a listed one (the same start but for the last two letters, five
// letters at least), as lines for SWEEP.
function sweepLines(forms, chapters) {
  const text = key(chapters.join(" "));
  const seen = new Set(text.match(/[\p{L}]+(?:ʼ[\p{L}]+)*/gu) || []);
  const stems = new Map();
  for (const k of Object.keys(forms)) if (!k.includes(" ") && k.length >= 6) (stems.get(k.slice(0, -2)) || stems.set(k.slice(0, -2), []).get(k.slice(0, -2))).push(k);
  const lines = [];
  for (const t of seen) {
    if (forms[t]) continue;
    for (let n = t.length; n >= 5; n--) {
      const near = stems.get(t.slice(0, n));
      if (!near) continue;
      lines.push(`${t}\t${near.slice(0, 3).map((k) => `${k} = ${forms[k][0]}`).join(" ; ")}`);
      break;
    }
  }
  return lines;
}

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
  constructor({ dir, apiKey = process.env.ANTHROPIC_API_KEY, maxCalls = 0, v2 = false }) {
    this.dir = dir;
    this.v2 = v2;
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
  // v2 only: forms that are a common word meant the usual way in most of their places go (HOMO_FIND, HOMO_FIT).
  async homographs(book, file, { save = true } = {}) {
    const data = this.get(book);
    if (!data?.forms) return null;
    if (!this.apiKey) throw new Error("no ANTHROPIC_API_KEY");
    const client = new Anthropic({ apiKey: this.apiKey });
    const forms = data.forms;
    const entries = Object.entries(forms);
    const textOf = (m) => m.content.filter((x) => x.type === "text").map((x) => x.text).join("");
    let cost = 0;
    const cand = new Set();
    const batches = [];
    for (let i = 0; i < entries.length; i += STRICT_BATCH) batches.push(entries.slice(i, i + STRICT_BATCH));
    await Promise.all(
      batches.map(async (b) => {
        const m = await client.messages.create({ model: MODEL, max_tokens: 8000, system: HOMO_FIND, messages: [{ role: "user", content: b.map(([k, v]) => `${k}\t${v[0]}`).join("\n") }], output_config: { effort: "medium" } });
        cost += measure(m.model, m.usage).cost;
        for (const l of textOf(m).split("\n")) if (forms[key(l)]) cand.add(key(l));
      }),
    );
    const { chapters } = await epubParts(fs.readFileSync(file));
    const sentences = chapters.join("\n").replace(/\u0301/g, "").split(/(?<=[.!?…])\s+|\n/);
    const lines = [];
    for (const k of cand) {
      const re = new RegExp(`(^|[^\\p{L}\\p{M}'’ʼ])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^\\p{L}\\p{M}'’ʼ])`, "iu");
      for (const sentence of sentences.filter((x) => re.test(x)).slice(0, 4)) lines.push({ k, sentence: sentence.slice(0, 300) });
    }
    const fits = {};
    const groups = [];
    for (let i = 0; i < lines.length; i += 150) groups.push(i);
    await Promise.all(
      groups.map(async (i) => {
        const part = lines.slice(i, i + 150);
        const m = await client.messages.create({ model: MODEL, max_tokens: 4000, system: HOMO_FIT, messages: [{ role: "user", content: part.map((x, j) => `${i + j}\t${x.k}\t${forms[x.k][0]}\t${x.sentence}`).join("\n") }], output_config: { effort: "low" } });
        cost += measure(m.model, m.usage).cost;
        for (const l of textOf(m).split("\n")) {
          const [n, v] = l.split("\t");
          const x = lines[Number(n)];
          if (x && /^[01]$/.test(String(v).trim())) (fits[x.k] ||= []).push(String(v).trim() === "1");
        }
      }),
    );
    // A form met once keeps Opus's reading of that very place.
    const dropped = [...cand].filter((k) => fits[k]?.length >= 2 && fits[k].filter(Boolean).length * 2 < fits[k].length);
    if (dropped.length > entries.length / 4) throw new Error(`homographs would drop ${dropped.length}`);
    cost = Math.round(cost * 1000) / 1000;
    if (save && dropped.length) {
      const out = { ...data, forms: Object.fromEntries(entries.filter(([k]) => !dropped.includes(k))), homographs: { at: new Date().toISOString(), dropped }, cost: Math.round(((data.cost || 0) + cost) * 1000) / 1000 };
      const f = this.file(book);
      fs.writeFileSync(`${f}.tmp`, JSON.stringify(out));
      fs.renameSync(`${f}.tmp`, f);
    }
    return { candidates: cand.size, sentences: lines.length, dropped: dropped.map((k) => [k, forms[k][0], (fits[k] || []).map(Number).join("")]), cost };
  }
  // At start: v2 builds a restart cut off go on (their kept answers cost nothing again); a week-old one is dropped.
  resume(fileOf) {
    let names = [];
    try {
      names = fs.readdirSync(this.dir).filter((n) => n.endsWith(".json.parts"));
    } catch {}
    for (const n of names) {
      const dir = path.join(this.dir, n);
      const book = n.slice(0, -".json.parts".length);
      if (Date.now() - fs.statSync(dir).mtimeMs > 7 * 864e5) fs.rmSync(dir, { recursive: true, force: true });
      else if (fs.existsSync(fileOf(book))) this.start(book, fileOf(book));
    }
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
    if (this.v2) return this.buildV2(book, file, run);
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

Glossary.prototype.buildV2 = async function (book, file, run = {}) {
  const { chapters } = await epubParts(fs.readFileSync(file));
  const parts = chunks(chapters);
  if (this.maxCalls && parts.length > this.maxCalls) throw new Error(`too long: ${parts.length} calls`);
  run.of = parts.length;
  const client = new Anthropic({ apiKey: this.apiKey });
  const answers = new Array(parts.length);
  let cost = 0;
  // Each answer is kept on disk as it comes (`<book>.parts/<n>-<hash>.txt`): a restart (another thread's deploy cut
  // «Чорна рада» at 18 of 28 on 2026-11-17) loses nothing paid for, and `resume()` at start goes on from there.
  const partsDir = `${this.file(book)}.parts`;
  fs.mkdirSync(partsDir, { recursive: true });
  const partFile = (i) => path.join(partsDir, `${i}-${require("crypto").createHash("sha1").update(parts[i]).digest("hex").slice(0, 10)}.txt`);
  for (let i = 0; i < parts.length; i++)
    try {
      answers[i] = fs.readFileSync(partFile(i), "utf8");
      run.chunks = (run.chunks || 0) + 1;
    } catch {}
  let next = 0;
  const work = async () => {
    while (next < parts.length) {
      const i = next++;
      if (answers[i] != null) continue;
      const m = await client.messages.create({
        model: MODEL_V2,
        max_tokens: 20000,
        system: [{ type: "text", text: PROMPT_V2, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: parts[i] }],
        output_config: { effort: "medium" },
      });
      cost += measure(m.model, m.usage).cost;
      answers[i] = m.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      fs.writeFileSync(partFile(i), answers[i]);
      run.chunks = (run.chunks || 0) + 1;
    }
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, parts.length) }, work));
  // The first meaning a form got stays; a form one passage calls level 1 is level 1.
  const all = {};
  for (const a of answers)
    for (const [form, gloss, level, word] of parseV2(a)) {
      const k = key(form);
      if (!all[k]) all[k] = [gloss, level, key(word)];
      else if (level === 1) all[k][1] = 1;
    }
  const kept = clean(Object.fromEntries(Object.entries(all).map(([k, v]) => [k, v[0]])), chapters);
  const forms = Object.fromEntries(Object.entries(all).filter(([k]) => kept[k]));
  run.sweep = "running";
  const swept = await this.sweep(forms, chapters).catch((err) => ((run.sweepError = err.message), { added: 0, cost: 0 }));
  run.sweep = swept.added;
  cost += swept.cost;
  const data = { book, v: 2, model: MODEL_V2, at: new Date().toISOString(), calls: parts.length, swept: swept.added, cost: Math.round(cost * 1000) / 1000, forms };
  fs.mkdirSync(this.dir, { recursive: true });
  const f = this.file(book);
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(data));
  fs.renameSync(`${f}.tmp`, f);
  fs.rmSync(partsDir, { recursive: true, force: true });
  run.homographs = "running";
  const homo = await this.homographs(book, file).catch((err) => ({ error: err.message }));
  run.homographs = homo?.error || homo?.dropped?.length;
  run.forms = Object.keys(this.get(book)?.forms || forms).length;
  run.cost = data.cost;
  return data;
};
// Other forms of the listed words, by a cheap model; adds them to `forms` in place.
Glossary.prototype.sweep = async function (forms, chapters) {
  const lines = sweepLines(forms, chapters);
  const client = new Anthropic({ apiKey: this.apiKey });
  let cost = 0;
  let added = 0;
  for (let i = 0; i < lines.length; i += SWEEP_BATCH) {
    const m = await client.messages.create({ model: SWEEP_MODEL, max_tokens: 8000, system: SWEEP, messages: [{ role: "user", content: lines.slice(i, i + SWEEP_BATCH).join("\n") }] });
    cost += measure(m.model, m.usage).cost;
    const text = m.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    for (const line of text.split("\n")) {
      const [w, of] = line.split("\t").map((x) => key(x || ""));
      if (w && of && forms[of] && !forms[w]) {
        forms[w] = [...forms[of]];
        added++;
      }
    }
  }
  return { added, cost };
};

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

module.exports = { Glossary, key, chunks, parse, parseV2, sweepLines, clean, classic, PROMPT, PROMPT_V2, STRICT, MODEL, MODEL_V2 };

// Words ahead (Max, 2026-11-17: «як плейліст… наступний трек завантажує, не чекаючи»): while a reader reads, the page
// sends the passage on screen and the next one (~5,000 characters each), and Sonnet names the words in it a reader
// may select, with their meaning here. A selected word that is in the list shows at once, with no call. Trial on
// «Чорна рада» and Kelly's «Out of Control»: 43–56 words a passage, ~9 s, $0.011–0.014 (Haiku was slower, wordy and
// wrong more often). Kept on disk by the passage's hash, so the same passage of the same book costs once for all
// readers; a file nobody asked for in 90 days goes.
const Anthropic = require("@anthropic-ai/sdk");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MODEL = "claude-sonnet-5-5";
const KEEP_DAYS = 90;
const PROMPT = `A reader is reading this passage of a book. Guess which single words in it they may select to see what they mean: rare, old, dialect, bookish or specialised words, words used in an unusual sense here, and names of people, places or things a reader may not know. Leave out words every adult reader of the book's language knows. If the text is not in Ukrainian, the reader is Ukrainian reading it in the original with good but not native knowledge: include the words such a reader may look up. One line per word: the word exactly as written in the text, a tab, its dictionary form (for a name, the name as written), a tab, 1 if a reader of this book likely does not know it and the sentence is unclear without it, else 2, a tab, its meaning as used here in Ukrainian in everyday words, never another rare or bookish word (a plain synonym or at most ten words; for a word that is not Ukrainian, its Ukrainian translation as used here; for a name, who or what it is in a few words; for a character of this book only what you are sure of, else «персонаж книжки»). Never notes, doubts or reasoning. No other text, no numbering. At most 60 lines.`;

// A word as the page and the list both see it: lower case, no stress marks, one kind of apostrophe.
const norm = (w) =>
  String(w || "")
    .normalize("NFC")
    .replace(/́/g, "")
    .replace(/[’ʼ`]/g, "'")
    .trim()
    .toLowerCase();

// One clean meaning: its first line, without what a model sometimes adds after it (Max's «Кирило», 2026-11-17: a
// Ukrainian answer, then «Actually I need to be careful: in "Чорна рада"…»). Ukrainian answer, so four Latin words
// in a row are notes, not meaning.
function tidy(text, max = 160) {
  let t = String(text || "").split("\n").map((x) => x.trim()).find(Boolean) || "";
  if (/[\u0400-\u04FF]/.test(t)) {
    const note = t.search(/\s(?=(?:Actually|Wait|Hmm|Note|However|But|Let me|Okay|I need|I think|In ["«])\b)/);
    if (note > 0) t = t.slice(0, note);
    const latin = t.search(/(?:\b[A-Za-z][A-Za-z'’-]*[\s,.:;"»«()]+){4,}/);
    if (latin > 0) t = t.slice(0, latin);
  }
  return t.replace(/\*\*|__|`/g, "").replace(/^[\s*_/\\#>—-]+/, "").replace(/[\s.,;:—*_/\\#-]+$/, "").slice(0, max);
}

// A meaning with a star or slash glued to a word is broken output (Max 2026-11-17, «indolently — лінив*/»): better none,
// the card then asks for that one word.
const broken = (m) => /[\p{L}][*/\\]|[*/\\][\p{L}]/u.test(String(m || "").replace(/\*\*/g, ""));
// A meaning that starts with the word itself (Max 2026-11-17, «жалем — жалем, горем»): the word goes, the rest stays;
// nothing else left = no meaning.
function unrepeat(word, m) {
  const parts = String(m || "").split(/\s*[,;]\s*/);
  const rest = parts.filter((p) => norm(p) !== norm(word));
  return rest.length === parts.length ? m : rest.join(", ");
}
const clean = (words) => Object.fromEntries(Object.entries(words || {}).filter(([, m]) => !broken(m)).map(([w, m]) => [w, unrepeat(norm(w), tidy(m))]).filter(([, m]) => m));

// { words: {word: meaning}, base: {word: dictionary form}, level: {word: 1 | 2} }. Only level 1 is underlined in
// «Менше» (Max 2026-11-17: «ліки», «демони» underlined were «тупі»). The dictionary form lets «Більше не показувати» take every form of
// it (Max 2026-11-17: the prepared words are «Словничок» too); an older answer has two fields and no form.
function parse(answer) {
  const words = {};
  const base = {};
  const level = {};
  for (const line of String(answer || "").split("\n")) {
    const f = line.split("\t");
    const k = norm(f[0]);
    const m = f[f.length - 1];
    const meaning = f.length < 2 || broken(m) ? "" : unrepeat(k, tidy(m));
    if (!k || !meaning || k.length > 60 || words[k]) continue;
    words[k] = meaning;
    const b = f.length > 2 ? norm(f[1]) : "";
    if (b && b !== k && b.length <= 60) base[k] = b;
    if (f.length > 3) level[k] = f[2].trim() === "1" ? 1 : 2;
  }
  return { words, base, level };
}

class Ahead {
  constructor({ dir }) {
    this.dir = dir;
    this.asking = new Map(); // hash -> promise
  }
  hash(text) {
    return crypto.createHash("sha1").update(text).digest("hex");
  }
  file(h) {
    return path.join(this.dir, `${h}.json`);
  }
  kept(h) {
    try {
      const f = this.file(h);
      const data = JSON.parse(fs.readFileSync(f, "utf8"));
      const now = new Date();
      fs.utimesSync(f, now, now); // asked again: kept longer
      return data;
    } catch {
      return null;
    }
  }
  // { words, kept } — `kept` = no call was made.
  async words(apiKey, { text, title, author }) {
    const h = this.hash(text);
    const have = this.kept(h);
    if (have) return { words: clean(have.words), base: have.base || {}, level: have.level || {}, kept: true };
    if (this.asking.has(h)) {
      const r = await this.asking.get(h);
      return { words: r.words, base: r.base, level: r.level, kept: true };
    }
    const p = (async () => {
      const client = new Anthropic({ apiKey });
      const m = await client.messages.create({
        model: MODEL,
        max_tokens: 4000,
        system: PROMPT,
        messages: [{ role: "user", content: `Книжка: «${title || ""}»${author ? `, ${author}` : ""}\n\n${text}` }],
        output_config: { effort: "low" },
      });
      const { words, base, level } = parse(m.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
      fs.mkdirSync(this.dir, { recursive: true });
      const f = this.file(h);
      fs.writeFileSync(`${f}.tmp`, JSON.stringify({ at: new Date().toISOString(), title, words, base, level }));
      fs.renameSync(`${f}.tmp`, f);
      return { words, base, level, model: m.model, usage: m.usage };
    })();
    this.asking.set(h, p);
    try {
      return { ...(await p), kept: false };
    } finally {
      this.asking.delete(h);
    }
  }
  // Files nobody asked for in KEEP_DAYS go (each hit renews its time).
  prune() {
    let names = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return 0;
    }
    const old = Date.now() - KEEP_DAYS * 864e5;
    let gone = 0;
    for (const n of names) {
      const f = path.join(this.dir, n);
      try {
        if (fs.statSync(f).mtimeMs < old) fs.rmSync(f, { force: true }), gone++;
      } catch {}
    }
    return gone;
  }
  find(word) {
    const k = norm(word);
    const out = [];
    for (const n of (() => { try { return fs.readdirSync(this.dir); } catch { return []; } })()) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(this.dir, n), "utf8"));
        if (d.words?.[k] != null) out.push({ file: n, title: d.title, meaning: d.words[k] });
      } catch {}
    }
    return out;
  }
  status() {
    let n = 0;
    try {
      n = fs.readdirSync(this.dir).length;
    } catch {}
    return { passages: n, asking: this.asking.size };
  }
}

module.exports = { Ahead, parse, norm, tidy, clean, PROMPT, MODEL };

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
const PROMPT = `A reader is reading this passage of a book. Guess which single words in it they may select to see what they mean: rare, old, dialect, bookish or specialised words, words used in an unusual sense here, and names of people, places or things a reader may not know. Leave out words every adult reader of the book's language knows. If the text is not in Ukrainian, the reader is Ukrainian reading it in the original with good but not native knowledge: include the words such a reader may look up. One line per word: the word exactly as written in the text, a tab, its meaning as used here in Ukrainian (a plain synonym or at most ten words; for a word that is not Ukrainian, its Ukrainian translation as used here; for a name, who or what it is in a few words). No other text, no numbering. At most 60 lines.`;

// A word as the page and the list both see it: lower case, no stress marks, one kind of apostrophe.
const norm = (w) =>
  String(w || "")
    .normalize("NFC")
    .replace(/́/g, "")
    .replace(/[’ʼ`]/g, "'")
    .trim()
    .toLowerCase();

function parse(answer) {
  const words = {};
  for (const line of String(answer || "").split("\n")) {
    const [w, m] = line.split("\t");
    const k = norm(w);
    const meaning = String(m || "").trim().replace(/\.$/, "").slice(0, 160);
    if (k && meaning && k.length <= 60 && !words[k]) words[k] = meaning;
  }
  return words;
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
    if (have) return { words: have.words, kept: true };
    if (this.asking.has(h)) return { words: (await this.asking.get(h)).words, kept: true };
    const p = (async () => {
      const client = new Anthropic({ apiKey });
      const m = await client.messages.create({
        model: MODEL,
        max_tokens: 4000,
        system: PROMPT,
        messages: [{ role: "user", content: `Книжка: «${title || ""}»${author ? `, ${author}` : ""}\n\n${text}` }],
        output_config: { effort: "low" },
      });
      const words = parse(m.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
      fs.mkdirSync(this.dir, { recursive: true });
      const f = this.file(h);
      fs.writeFileSync(`${f}.tmp`, JSON.stringify({ at: new Date().toISOString(), title, words }));
      fs.renameSync(`${f}.tmp`, f);
      return { words, model: m.model, usage: m.usage };
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
  status() {
    let n = 0;
    try {
      n = fs.readdirSync(this.dir).length;
    } catch {}
    return { passages: n, asking: this.asking.size };
  }
}

module.exports = { Ahead, parse, norm, PROMPT, MODEL };

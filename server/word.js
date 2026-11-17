// One word, fast (Max, 2026-11-17: «ти натискаєш на слово і зразу тобі щось показується»): a reader
// selects a single word and the selection's card shows its meaning in this sentence in a second, instead of the
// panel's long explanation. Sonnet at low effort, a few words back.
// One word has one meaning in a book (Max 2026-11-17: «кармазини» got two different ones half a page apart, «слово ж
// те саме»): the first answer is kept by book and word, for every reader, and given again in any sentence. Kept in
// memory and in `file` (setFile, DATA_DIR/word-kept.json), WORD_KEEP at most, the oldest go first.
const fs = require("fs");
const Anthropic = require("@anthropic-ai/sdk");

const MODEL = "claude-sonnet-5-5";
const WORD_KEEP = 5000;
let kept = new Map(); // `${title}|${author}|${word}` -> text
let file = null;
let saving = null;
function setFile(f) {
  file = f;
  try {
    kept = new Map(Object.entries(JSON.parse(fs.readFileSync(f, "utf8"))));
  } catch {}
}
function save() {
  if (!file || saving) return;
  saving = setTimeout(() => {
    saving = null;
    try {
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(Object.fromEntries(kept)));
      fs.renameSync(`${file}.tmp`, file);
    } catch (err) {
      console.error("word kept:", err.message);
    }
  }, 30000);
  saving.unref?.();
}
// The word as kept: no stress marks; small letters, but a name mid-sentence keeps its capital («Шрам» ≠ «шрам»).
const keyOf = (word, sentence) => {
  const w = String(word).normalize("NFD").replace(/[\u0300\u0301]/g, "").normalize("NFC").replace(/['’`ʼ]/g, "ʼ");
  return midName(word, sentence) ? w : w.toLowerCase();
};

const PROMPT = `A reader of a book selected one word and wants to know at once what it means here. Answer in Ukrainian with only the meaning as used in this sentence: a plain synonym, or at most ten words. Use only everyday words a 12-year-old knows, never another rare or bookish word (паливода is «безтурботний веселун», not «гульвіса, шибайголова»). For a word that is not Ukrainian, give its Ukrainian translation as used here, with a few words more only when one word is not enough. For a name of a person, place or thing, say in a few words who or what it is; for a character of this book say only what you are sure of, and if you are not sure, only «персонаж книжки». One line only: no notes, no doubts, no reasoning, no preamble, no quotes, no repeating the word, no full stop.`;

// A capitalised word may be a character's name, and Sonnet at low effort makes up who they are (Max 2026-11-17:
// «Кирило» came back as «брат Петра Шрама» and then English second thoughts). For one, it says only what the sentence
// shows, or what a well-known place or person is.
const NAME = `A reader of a book selected one capitalised word and wants to know at once what it means here. If it is the name of a character of this book, answer in Ukrainian with only what this sentence itself shows about them, in a few words, or just «персонаж книжки»; never guess family ties, ranks or roles. If it is a well-known real place, person or thing, say in a few words what it is. If it is not a name, give its meaning as used in this sentence: a plain synonym, or at most ten words. One line only: no notes, no doubts, no reasoning, no preamble, no quotes, no repeating the word, no full stop.`;

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

// A capital in the middle of a sentence is a name; at its start (after a dash or a quote too) it is any word, and
// NAME made «Кармазини!» (rich lords in red coats) into «червоне сукно» while the same word small got it right (Max
// 2026-11-17).
function midName(word, sentence) {
  if (!/^\p{Lu}/u.test(word)) return false;
  const at = String(sentence || "").indexOf(word);
  return at > 0 && /[\p{L}\d,;]\s+$/u.test(sentence.slice(0, at));
}

async function meaning(apiKey, { word, sentence, title, author }) {
  const k = `${title}|${author || ""}|${keyOf(word, sentence)}`;
  if (kept.has(k)) return { text: kept.get(k), kept: true };
  const client = new Anthropic({ apiKey });
  const m = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: midName(word, sentence) ? NAME : PROMPT,
    messages: [{ role: "user", content: `Книжка: «${title}»${author ? `, ${author}` : ""}\nРечення: ${sentence}\nСлово: ${word}` }],
    output_config: { effort: "low" },
  });
  const text = tidy(m.content.filter((b) => b.type === "text").map((b) => b.text).join(""), 200);
  if (text) {
    kept.set(k, text);
    if (kept.size > WORD_KEEP) kept.delete(kept.keys().next().value);
    save();
  }
  return { text, model: m.model, usage: m.usage };
}

module.exports = { meaning, tidy, midName, setFile, keyOf, PROMPT, MODEL };

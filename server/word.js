// One word, fast (Max, 2026-11-17: «ти натискаєш на слово і зразу тобі щось показується»): a reader
// selects a single word and the selection's card shows its meaning in this sentence in a second, instead of the
// panel's long explanation. Sonnet at low effort, a few words back. Answers are kept in memory by word and sentence
// (WORD_KEEP at most), so the same word in the same place costs nothing the second time.
const Anthropic = require("@anthropic-ai/sdk");

const MODEL = "claude-sonnet-5-5";
const WORD_KEEP = 3000;
const kept = new Map(); // `${word}|${sentence}` -> text

const PROMPT = `A reader of a book selected one word and wants to know at once what it means here. Answer in Ukrainian with only the meaning as used in this sentence: a plain synonym, or at most ten words. For a word that is not Ukrainian, give its Ukrainian translation as used here, with a few words more only when one word is not enough. For a name of a person, place or thing, say in a few words who or what it is; for a character of this book say only what you are sure of, and if you are not sure, only «персонаж книжки». One line only: no notes, no doubts, no reasoning, no preamble, no quotes, no repeating the word, no full stop.`;

// A capitalised word may be a character's name, and Sonnet at low effort makes up who they are (Max 2026-11-17:
// «Кирило» came back as «брат Петра Шрама» and then English second thoughts). For one, it says only what the sentence
// shows, or what a well-known place or person is.
const NAME = `A reader of a book selected one capitalised word and wants to know at once what it means here. If it is the name of a character of this book, answer in Ukrainian with only what this sentence itself shows about them, in a few words, or just «персонаж книжки»; never guess family ties, ranks or roles. If it is a well-known real place, person or thing, say in a few words what it is. If it is not a name, give its meaning as used in this sentence: a plain synonym, or at most ten words. One line only: no notes, no doubts, no reasoning, no preamble, no quotes, no repeating the word, no full stop.`;

async function meaning(apiKey, { word, sentence, title, author }) {
  const k = `${word.toLowerCase()}|${sentence}`;
  if (kept.has(k)) return { text: kept.get(k), kept: true };
  const client = new Anthropic({ apiKey });
  const m = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: /^\p{Lu}/u.test(word) ? NAME : PROMPT,
    messages: [{ role: "user", content: `Книжка: «${title}»${author ? `, ${author}` : ""}\nРечення: ${sentence}\nСлово: ${word}` }],
    output_config: { effort: "low" },
  });
  const text = require("./wordahead").tidy(m.content.filter((b) => b.type === "text").map((b) => b.text).join(""), 200);
  if (text) {
    kept.set(k, text);
    if (kept.size > WORD_KEEP) kept.delete(kept.keys().next().value);
  }
  return { text, model: m.model, usage: m.usage };
}

module.exports = { meaning, PROMPT, MODEL };

// The homepage box takes both a search («Дюна», «Кідрук») and a request in one's own words («щось як Мураками, але
// коротше»), which goes to /ask (Max, 2026-11-13). Telling them apart costs nothing: words, not a model. A request
// says so: «щось», «схоже», «в стилі», «порадьте», «хочу», «сподобалось», a question… Whether the catalog answers the
// words decides the rest (server.js searchAll `outside`): a title that happens to have such a word is found and stays
// a search. No word like that but many words and no book answers them: the request is offered, not assumed.
const fold = (s) => ` ${String(s || "").toLowerCase().replace(/[’'`ʼ]/g, "").replace(/є/g, "е").replace(/ґ/g, "г").replace(/[^\p{L}\p{N}?]+/gu, " ").trim()} `;

// Word starts (after a space), folded as above. Short and plain: what people write when they ask for a book.
const CUES = [
  "щось", "що-небудь", "щонебудь", "схож", "подібн", "в стилі", "у стилі", "в дусі", "у дусі", "на кшталт", "типу ",
  "порад", "посовіт", "рекоменд", "хочу", "хочеться", "хотілось", "хотілося", "хотів би", "хотіла б", "шукаю книж",
  "сподоба", "зайшл", "зайшов", "зайшло", "подобаєть", "подобаютьс", "люблю", "прочитав", "прочитала", "читав ", "читала ",
  "що почитати", "що прочитати", "для дитини", "для сина", "для доньки", "для дочки", "на подарунок", "як у ", "як в ", "але корот",
  "але легш", "але сучасн", "аналог", "книжки як", "книги як", "книжку як", "книгу як", "книжки про", "книги про", "something", "similar", "recommend", "books like", "book like",
];
const FOLDED = CUES.map((c) => ` ${fold(c).trim()}${c.endsWith(" ") ? " " : ""}`);
const words = (s) => fold(s).trim().split(" ").filter(Boolean);

// "ask": a request, said so in words; "maybe": many words no book answers, could be either; "": a search.
// answered: some book, author, list or shelf has every word typed (searchAll's `outside` is false).
function intent(text, { answered = false } = {}) {
  const t = String(text || "").trim();
  if (t.length < 15 || /:\/\//.test(t)) return "";
  const f = fold(t);
  const n = words(t).length;
  if (n < 3) return "";
  const cue = FOLDED.some((c) => f.includes(c)) || /\?\s*$/.test(t);
  // A book has every word («Чому я не хочу вертатись до СРСР?»): it stays a search, the button only offered.
  if (cue) return answered ? "maybe" : "ask";
  if (!answered && n >= 4) return "maybe";
  return "";
}

module.exports = { intent, CUES };

// Prompt variants for the glossary trial (bug reports №29: «Бойня №5», «Про мишей і людей»). A = what runs now.
const g = require("../../server/glossary");

// Names: what the card says of a selected capitalised word.
const NAMES_HEAD = `You read a whole book above: often a Ukrainian classic, sometimes a modern or a foreign one in translation. Answer in Ukrainian whatever its language. A reader of this book selects a capitalised word in it and sees a short card about who or what it is. The list after the book has every capitalised word form found in the middle of its sentences, with how often it occurs.

For each person, place, people, river, institution or other named thing in that list, answer one line, three fields separated by tabs:
1. the name as the book usually gives it in full (Кирило Тур, Біллі Пілґрим, Київ);
2. every form from the list that refers to it, separated by commas (Шрам, Шрама, Шрамові, Шрамом), exactly as listed;
3. the card.`;

const NAMES_TAIL = `Only what you are sure of from the text; never guess kinship or roles.
A form that in this book means different people or places (Петре said to two different Петри, Іван for several Івани) goes on no line: leave it out. So does a word that names something only together with another word (Великий of Великий Луг, Чорна of Чорна Гора, Золоті of Золоті ворота, Старий): list only forms that name it by themselves.
Leave out what is not a name: God, the Lord, saints' titles used as words, a common word that starts a line of verse or a quote, chapter headings.
Nothing else in the answer: no headings, no notes.`;

// B: the card starts with the thing's place in this book and ties it to the main people; then one fact.
const NAMES_B = `${NAMES_HEAD}

The card is at most twelve plain everyday Ukrainian words, no full stop. It answers the reader's real question: «who is this to the story?».
- Start with its place in this book: «головний герой», «оповідач, сам автор», «дружина Біллі», «друг і опікун Ленні», «місто, де живе Біллі», «планета, куди викрадають Біллі», «ранчо, де працюють Джордж і Ленні».
- Tie every minor person, place and thing to the main people: whose it is, where they meet it, what happens to them there. A bare fact cut off from the story («далека планета», «місто у штаті Нью-Йорк», «персонаж книжки») is the card we don't want.
- Then, if words are left, the one fact that helps most to follow the story: job, side, town, kinship.
- A real place, person or event: what it is in two or three words, then why it is in this book (місто в Німеччині, де Біллі пережив бомбардування).
Spoilers: never how a person's story ends (death, betrayal, marriage) or the book's last events, unless the book itself tells it in its first chapters. What the book reveals early is fine to say.

${NAMES_TAIL}`;

// C: role only, as short as a margin note.
const NAMES_C = `${NAMES_HEAD}

The card is at most eight plain everyday Ukrainian words, no full stop: only who or what this is to the story, the way a friend who has read the book would whisper it. «головний герой», «дружина Біллі», «планета, куди викрадають Біллі», «друг Джорджа й Ленні на ранчо». No biography, no list of facts. For a real place or person not central to the story, what it is plus its link to the people (місто, де Біллі був у полоні).
Never how a person's story ends or the book's last events, unless the book tells it in its first chapters.

${NAMES_TAIL}`;

// A as a variant: today's NAMES, moved after the book so all three variants share the cached book.
const NAMES_A = g.NAMES.replace("You read a whole book below", "You read a whole book above").replace("The list after the book", "The list after the book");

// Words: PROMPT_ANY (now) and B.
const WORDS_B = `You make a reading glossary for a book that a Ukrainian reader finds hard: a classic, an old, foreign or demanding modern book, in Ukrainian or in another language, often a translation. The reader taps an underlined word or expression and sees your explanation in a small card under the sentence, so it must make this sentence clear at a glance.

Go through the passage sentence by sentence and list every word or short expression that a well-read adult may not understand here:
- a rare, old, dialect, regional or slang word, or a familiar word used in an unusual sense;
- a term from a trade, science, law, philosophy, the church, the army or the sea;
- a foreign, Latin or Greek word or phrase;
- a thing of another time or country that the reader may not know: brands, foods, ranks, institutions, customs, events (Пелл-Мелл, Тейсті-Фріз, Арденнська операція);
- an allusion to a myth, the Bible, history, a song or another book;
- an idiom, a pun or a figure of speech whose sense is not literal.
For each, decide how much it would stop the reader: 1 — without help the sentence is unclear; 2 — the reader half-guesses from the sentence but is unsure.

The explanation answers «what does it mean here and why is it here», not a dictionary entry:
- for a word: its sense in this sentence (a synonym, or a few words);
- for a thing of another time or country: what it is, and when it matters, what it says about the scene or the person (марка дешевих цигарок; табличка з написом, що висміює ...);
- for an allusion or a quote: whose words or what story, and what the author means by it here.
At most twelve plain everyday words, no full stop, never words harder than the one explained.

Leave out what an educated adult reads at once: ordinary words, coarse or slang words whose sense is plain, plain old spellings of known words, the names of the book's own people and places (they have a list of their own), anything the text explains next to it, and anything a footnote explains (a number in brackets like [6] after it). When unsure whether the reader knows it, leave it out: an underline on a word one knows is noise.

Answer with one line per item and nothing else, four fields separated by tabs: the word or expression exactly as written in the passage (same case and ending, no stress marks), its dictionary form, its explanation in plain modern Ukrainian whatever the book's language, and 1 or 2.
List each form once. Check every explanation against its sentence: a wrong one is worse than none.`;

module.exports = { names: { A: NAMES_A, B: NAMES_B, C: NAMES_C }, words: { A: g.PROMPT_ANY, B: WORDS_B } };

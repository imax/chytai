// Import of a list typed or pasted as text (Max, 2026-10-22: «текстаріа для імпорту ручками або копіпасти з
// існуючого списка»): one book per line, in whatever shape a reader keeps their lists: «Автор — Назва»,
// «Назва — Автор», «Автор. Назва», «Назва (Автор)», «Назва, Автор», a bare title, with or without a bullet
// or a number in front, a year or a rating at the end. Each line becomes a row for the same preview as the
// Goodreads import (goodreads.plan): a row joins a book of the catalog by title and author, the rest become
// the reader's own books. Which side of the line is the author is decided by the catalog first (the
// ordering that finds a book wins), then by what looks like a person's name.

const BULLET = /^\s*(?:[-•*–—·]|\d{1,3}[.)]|\(\d{1,3}\))\s+/;
const STARS = /\s*[(\[]?\s*(★{1,5}|⭐{1,5}|(\d(?:[.,]\d)?)\s*\/\s*5)\s*[)\]]?\s*$/u;
// A year at the end only when it is set off: «(2019)», «, 2019», «2019 р.», or after the second part of a
// dashed line; a bare «Орвелл. 1984» keeps its number as the title.
const YEAR = /(?:\s*[(\[]\s*((?:19|20)\d\d)\s*(?:р\.?|рік)?\s*[)\]]|\s*[,;]\s*((?:19|20)\d\d)\s*(?:р\.?|рік)?|\s+((?:19|20)\d\d)\s*(?:р\.|рік)|(?<=\s[—–-]\s[^—–]{2,})\s+((?:19|20)\d\d))\s*$/;
// «Назва» or "Назва" anywhere in the line: the title, with the rest as the author.
const QUOTED = /[«"“]([^»"”]{2,})[»"”]/;

const clean = (s) => String(s || "").replace(/\s+/g, " ").replace(/^[\s.,;:—–-]+/, "").replace(/(?<!\s\p{Lu})[\s.,;:—–-]+$/u, "").trim();
// A person's name: up to four words, each starting with a capital or an initial («Дж. Р. Р. Толкін»), no digits.
const looksLikeName = (s) => {
  const words = clean(s).split(" ");
  return words.length >= 1 && words.length <= 4 && words.every((w) => /^(\p{Lu}[\p{L}'’-]*\.?|\p{Lu}\.)$/u.test(w)) && !/\d/.test(s);
};

// One line -> { title, author, alt, year, rating } or null for an empty line. `alt` is the other reading of
// the line (author and title swapped), when the line has two parts and either could be the author.
function parseLine(raw) {
  let line = String(raw || "").replace(/\t/g, " ").replace(BULLET, "").trim();
  if (!line) return null;
  let rating = null;
  let year = null;
  const r = STARS.exec(line);
  if (r) {
    rating = r[2] ? Number(r[2].replace(",", ".")) : [...r[1]].length;
    if (!(rating >= 1 && rating <= 5)) rating = null;
    line = line.slice(0, r.index).trim();
  }
  const y = YEAR.exec(line);
  if (y && y.index > 0) {
    year = Number(y[1] || y[2] || y[3] || y[4]);
    line = line.slice(0, y.index).trim();
  }
  line = clean(line);
  if (!line) return null;
  const q = QUOTED.exec(line);
  if (q) {
    const author = clean(line.replace(q[0], " "));
    return { title: clean(q[1]), author, alt: null, year, rating };
  }
  // Two parts: a spaced dash, « - », « / », a bracket at the end, a comma, or «Прізвище І. Назва».
  let parts = null;
  for (const sep of [/\s+[—–]\s+/, /\s+-\s+/, /\s+\/\s+/]) {
    const m = sep.exec(line);
    if (m) {
      parts = [clean(line.slice(0, m.index)), clean(line.slice(m.index + m[0].length))];
      break;
    }
  }
  if (!parts) {
    const b = /^(.{2,})\s+\(([^()]{2,})\)$/.exec(line);
    if (b) parts = [clean(b[1]), clean(b[2])];
  }
  if (!parts) {
    const c = /^([^,]{2,}),\s+(.{2,})$/.exec(line);
    if (c) parts = [clean(c[1]), clean(c[2])];
  }
  if (!parts) {
    // «Шевченко Т. Кобзар», «Толкін Дж. Р. Р. Володар перснів»: initials, then the title.
    const i = /^((?:\p{Lu}[\p{L}'’-]+\s+)+(?:\p{Lu}\.\s*)+)\s*(.{2,})$/u.exec(line);
    if (i) parts = [clean(i[1]), clean(i[2])];
  }
  if (!parts) {
    // «Автор. Назва»: a sentence-like first part of one to four capitalised words.
    const d = /^(.{3,}?)\.\s+(.{2,})$/.exec(line);
    if (d && looksLikeName(d[1])) parts = [clean(d[1]), clean(d[2])];
  }
  if (!parts || parts.some((p) => !p)) return { title: line, author: "", alt: null, year, rating };
  const [first, second] = parts;
  const firstName = looksLikeName(first);
  const secondName = looksLikeName(second);
  // Author first unless only the second part is a name («Кобзар — Тарас Шевченко»); when both could be
  // one («Дюна, Френк Герберт»), the part with more words is the person.
  const words = (s) => s.split(" ").length;
  const authorFirst = firstName && secondName ? words(first) >= words(second) : firstName || !secondName;
  const main = authorFirst ? { author: first, title: second } : { author: second, title: first };
  return { ...main, alt: { author: main.title, title: main.author }, year, rating };
}

// The whole text -> { books, error }. `status` applies to every row; rows that name a year keep it.
function parseList(text, { status = "read" } = {}) {
  const books = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const p = parseLine(raw);
    if (!p) continue;
    books.push({ line: raw.trim().slice(0, 200), title: p.title, author: p.author, alt: p.alt, isbns: [], status, rating: p.rating, year: status === "read" ? p.year : null, note: "", copy: "", added: "", read: "" });
  }
  if (!books.length) return { error: "Список порожній: по одній книжці на рядок." };
  if (books.length > 1000) return { error: "Забагато рядків: до тисячі за раз." };
  return { books };
}

// Which side is the author: the catalog decides when it can (store.findWork), else the guess from
// parseLine stays. A row of a pasted list is history, not news: its entry is dated to the first of the
// year it names (or of this year), so a list of fifty books does not fill the feed as «сьогодні».
function resolve(store, books) {
  const thisYear = new Date().getFullYear();
  return books.map((b) => {
    let { title, author, alt, ...rest } = b;
    if (alt && !store.findWork({ title, author }) && store.findWork(alt)) ({ title, author } = alt);
    // No separator at all («Тигролови Іван Багряний»): try every place the line could split into a title and
    // an author, either way round, and keep the first the catalog knows (Max, 2026-10-22: the example list
    // goes without dashes).
    if (!author && !store.findWork({ title })) {
      const w = title.split(" ");
      for (let k = 1; k < w.length && w.length <= 12; k++) {
        const [a1, a2] = [w.slice(0, k).join(" "), w.slice(k).join(" ")];
        const hit = [{ title: a1, author: a2 }, { title: a2, author: a1 }].find((x) => looksLikeName(x.author) && store.findWork(x));
        if (hit) {
          ({ title, author } = hit);
          break;
        }
      }
    }
    // Nothing known: a name of two or three capitalised words at the end is the author («… Іван Іванов»).
    if (!author && !store.findWork({ title })) {
      const w = title.split(" ");
      for (const n of [3, 2]) {
        if (w.length > n && looksLikeName(w.slice(-n).join(" "))) {
          [title, author] = [w.slice(0, -n).join(" "), w.slice(-n).join(" ")];
          break;
        }
      }
    }
    return { ...rest, title, author, touched: `${b.year || thisYear}-01-01T00:00:00.000Z` };
  });
}

module.exports = { parseLine, parseList, resolve, looksLikeName };

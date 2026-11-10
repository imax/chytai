// A book a reader uploads to the reader (app.chytai.org.ua) that the catalog lacks gets its page here by itself
// (Max, 2026-11-10: «якщо користувач завантажує книжку собі в читалку, то автоматом додавати її на сайт теж»),
// instead of «Цієї книжки ще немає в каталозі» and a link to /add.
// The reader tells the site its list of files after every change (POST /api/reader-library); a file that is new
// in that list and was uploaded in the last two days comes here. It becomes a book only when:
//   - its title and author came from the file (or the reader typed them), not from the file's name, and look like
//     a book's («10970_ДЖером_Трое_сдача», «Object20260223151018518 0» don't);
//   - the file is in Ukrainian or English, and the book is not Russian (store.isRussian: letters, Russian authors);
//   - the catalog has no such book (the reader's own match, then store.findWork);
//   - Google Books or Open Library know it: same title (before a subtitle) and the same author, as in /add
//     (listimport.lookOutside). So a reader's own document or an article never becomes a public page, and the
//     book comes with that source's title, author, cover, ISBNs and year.
// The new book then goes through the same checks as any reader's book (store.addBook → book_queue: language,
// genres, the original of a translation, dupes, covers). The page never says who uploaded it.
// At most 20 new books a day from one reader and 200 from all, one at a time. The owner hears of each batch.

const { isRussian, norm, sameAuthor } = require("./store");

const DAY = 24 * 3600 * 1000;
const FRESH = 2 * DAY; // a file older than this is not «just uploaded»: a reader's first list, a re-sync
const PER_READER = 20;
const PER_DAY = 200;
const LANGUAGE = { uk: "українська", en: "англійська" };

// A title that is a file's name or a scanner's, not a book's.
const JUNK_TITLE = [
  /_/, // «10970_ДЖером_Трое_сдача»
  /\d{5,}/, // «Object20260223151018518»
  /\.(epub|pdf|fb2|mobi|azw3?|docx?|txt|rtf)\b/i,
  /^(object|document|untitled|unknown|book|file|scan|img|image|новий документ|документ|без назви)\b/i,
  /^(ebook|e-book|ebooksclub|libgen|flibusta|litres)\b/i,
];
// A bracketed or trailing note on an author, a site's name in the authors' list («chenjin5.com»), a word for «nobody».
const NOT_AUTHOR = /^(unknown|anonymous|невідомий|невідомо|автор|author|n\/a|admin|calibre|user)$/i;
const SITE = /\b[\w-]+\.(com|net|org|ru|ua|info|me|io|to)\b|https?:|www\./i;
// The rest of a title after «. » or «: » that only says what kind of book it is: «Надзахідне сонце. Повість і
// коротка проза». Such a title is the book before it (readerMatch); «Дюна. Месія Дюни» is not.
const KIND_WORDS = /^(казк\p{L}*|роман\p{L}*|повіст\p{L}*|оповідан\p{L}*|новел\p{L}*|проз\p{L}*|коротк\p{L}*|мал\p{L}*|велик\p{L}*|есе\p{L}*|вірш\p{L}*|поез\p{L}*|збірк\p{L}*|вибран\p{L}*|твор\p{L}*|нарис\p{L}*|спогад\p{L}*|п[’']єс\p{L}*|і|й|та|й|a|and|novel|novella|stories|short|essays?|poems|selected|collected|tales)$/iu;
const kindOnly = (rest) => {
  const words = norm(rest).split(" ").filter(Boolean);
  return words.length > 0 && words.length <= 6 && words.every((w) => KIND_WORDS.test(w));
};

const titleCase = (w) => w.charAt(0) + w.slice(1).toLowerCase();
// «ПЛОХІЙ Сергій» → «Сергій Плохій», «Meadows, Donella H.» → «Donella H. Meadows», «Jerome K.Jerome» →
// «Jerome K. Jerome», «W. Timothy Gallwey [Gallwey, W. Timothy]» → «W. Timothy Gallwey».
function cleanAuthor(a) {
  let s = String(a || "").replace(/\[[^\]]*\]|\([^)]*\)/g, " ").replace(/\s+/g, " ").replace(/[,;]+$/, "").trim();
  s = s.replace(/,?\s+(PhD|Ph\.D\.|MD|M\.D\.|Jr\.?|Sr\.?|Dr\.?)$/i, "").trim();
  if (!s || NOT_AUTHOR.test(s) || SITE.test(s) || /\d/.test(s)) return "";
  const comma = /^([^,]+),\s*([^,]+)$/.exec(s);
  if (comma) s = `${comma[2]} ${comma[1]}`;
  s = s.replace(/(\p{Lu}\.)(?=\p{Lu}\p{Ll})/gu, "$1 ");
  const words = s.split(" ");
  // A surname in capitals, as Ukrainian publishers print it: last, in its usual case.
  const caps = words.filter((w) => w.length > 2 && w === w.toUpperCase() && /\p{L}/u.test(w));
  if (caps.length && caps.length < words.length) s = [...words.filter((w) => !caps.includes(w)), ...caps.map(titleCase)].join(" ");
  else if (caps.length === words.length) s = words.map((w) => (/^\p{Lu}\.$/u.test(w) ? w : titleCase(w))).join(" ");
  return s.split(" ").length <= 5 ? s : "";
}

// The file as the reader sent it ({ name, title, authors, lang, fromName, added }) → { title, author, language }
// for the lookups, or { skip } with the reason (kept in the log and /admin/jobs' words).
function candidate(file) {
  const lang = String(file.lang || "").toLowerCase();
  if (file.fromName) return { skip: "назва з імені файлу" };
  if (file.gift) return { skip: "подарунок" };
  if (!LANGUAGE[lang]) return { skip: lang === "ru" ? "російською" : `мова ${lang || "?"}` };
  const authors = [...new Set((Array.isArray(file.authors) ? file.authors : String(file.authors || "").split(";")).map(cleanAuthor).filter(Boolean))].slice(0, 3);
  const author = authors.join(", ");
  let title = String(file.title || "").replace(/\s+/g, " ").trim();
  if (!author) return { skip: "без автора" };
  // «Ken Follett - World without end», «Роджер Желязны. Ніч у самотньому жовтні»: the author's name in front.
  const lead = /^(.{3,60}?)(?:\s+[-–—]\s+|\.\s+|:\s+)(.+)$/.exec(title);
  if (lead && authors.some((a) => sameAuthor(a, lead[1]))) title = lead[2].trim();
  if (title.length < 2 || title.length > 200 || JUNK_TITLE.some((re) => re.test(title)) || !(/\p{L}{3,}/u.test(title) || /^\d{1,4}$/.test(title))) return { skip: "назва схожа на ім'я файлу" };
  const book = { title, author, language: LANGUAGE[lang] };
  if (isRussian(book) || /[ыэъё]/i.test(`${title} ${author}`)) return { skip: "російська книжка" };
  return book;
}

// What Google Books or Open Library say of the book, when it is the same book: the first hit whose title before a
// subtitle is the file's and whose author is the file's author. `search(q)` → [{ title, author, cover, isbns, … }].
async function confirm(book, search) {
  const head = (t) => norm(String(t || "").split(/[:(]|\.\s|\s[-–—]\s/)[0]);
  const want = head(book.title);
  if (want.length < 2) return null;
  const q = `${book.title.split(/[:(]|\.\s/)[0]} ${book.author.split(",")[0]}`.trim();
  for (const hit of await search(q)) {
    if (!hit?.title || head(hit.title) !== want || !sameAuthor(book.author, hit.author || "")) continue;
    // Another language's edition under the same name is not the reader's book (Google's «Worm» in German).
    if (/[ыэъё]/i.test(hit.title) || (hit.language && hit.language !== book.language)) continue;
    return hit;
  }
  return null;
}

class ReaderBooks {
  // match(file) → a catalog book id or null; search(q) → Google Books and Open Library hits; made(reader, books)
  // after a batch is added; on(readerId) → whether this is switched on for that reader (flag reader-books).
  constructor({ store, match, search, made = () => {}, on = () => true, log = console.log }) {
    Object.assign(this, { store, match, search, made, on, log });
    this.chain = Promise.resolve();
  }

  // Files new in a reader's list (not there before): the ones uploaded lately are looked at, in the background.
  take(reader, files, { now = Date.now() } = {}) {
    if (!this.on(reader)) return null;
    const fresh = files.filter((f) => f && f.title && Number(f.added) > now - FRESH);
    if (!fresh.length) return null;
    const run = this.chain.then(() => this.run(reader, fresh)).catch((e) => (this.log(`reader books: ${e.message}`), null));
    this.chain = run;
    return run;
  }

  counts() {
    const day = new Date().toISOString().slice(0, 10);
    let c = {};
    try {
      c = JSON.parse(this.store.db.get("readerbooks:count") || "{}");
    } catch {}
    return c.day === day ? c : { day, all: 0, by: {} };
  }

  // The files already in readers' lists (reader_files), for the owner: `dry` says what would be made, without it
  // they are made (Max's OK first: a one-off backfill of books uploaded before this existed). A file the reader has
  // not described yet (no language: its reader has not synced since 2026-11-10) is guessed from its letters on a
  // dry run and skipped on a real one.
  async backfill({ dry = true, reader = "" } = {}) {
    const rows = this.store.db.prepare(`SELECT reader, name, title, authors, lang, from_name FROM reader_files${reader ? " WHERE reader = ?" : ""}`).all(...(reader ? [reader] : []));
    const by = new Map();
    for (const r of rows) {
      const lang = r.lang || (dry ? (/[ыэъё]/i.test(r.title) ? "ru" : /[а-яіїєґ]/i.test(r.title) ? "uk" : /[a-z]/i.test(r.title) ? "en" : "") : "");
      if (!by.has(r.reader)) by.set(r.reader, []);
      by.get(r.reader).push({ name: r.name, title: r.title, authors: r.authors.split(";").map((a) => a.trim()).filter(Boolean), lang, fromName: !!r.from_name, guessed: !r.lang });
    }
    const out = { made: [], skipped: [] };
    for (const [id, files] of by) {
      const r = await this.run(id, files, { dry, limits: false });
      out.made.push(...r.made.map((b) => ({ reader: id, title: b.title, author: b.author, file: b.file, from: b.from, id: b.id })));
      out.skipped.push(...r.skipped.map(([t, why]) => ({ reader: id, file: t, why })));
    }
    return out;
  }

  async run(reader, files, { dry = false, limits = true } = {}) {
    const made = [];
    const skipped = [];
    for (const f of files) {
      const c = this.counts();
      if (limits && (c.all >= PER_DAY || (c.by[reader] || 0) >= PER_READER)) {
        skipped.push([f.title, "ліміт на день"]);
        continue;
      }
      const book = candidate(f);
      if (book.skip) {
        skipped.push([f.title, book.skip]);
        continue;
      }
      if (this.match({ ...f, title: book.title, authors: [book.author] }) || this.match(f) || this.store.findWork(book)) {
        skipped.push([f.title, "уже є"]);
        continue;
      }
      const hit = await confirm(book, this.search).catch(() => null);
      if (!hit) {
        skipped.push([f.title, "не знайшли в Google Books і Open Library"]);
        continue;
      }
      // The source's own record may be a book we have under its ISBN or its exact title.
      if (this.store.findWork({ title: hit.title, author: hit.author || book.author, isbns: hit.isbns || [] })) {
        skipped.push([f.title, "уже є"]);
        continue;
      }
      // The reader's own title, which names their edition («Seductive Interaction Design», where Open Library has
      // «Seductive interaction design»), without a series note in brackets; the source's when the file shouts.
      const own = book.title.replace(/\s*[(\[][^)\]]*\b(book|series|vol\.?|volume|#|том|книга|серія)\b[^)\]]*[)\]]\s*$/iu, "").trim();
      const title = own === own.toUpperCase() ? hit.title : own;
      const author = hit.author || book.author;
      if (dry) {
        made.push({ title, author, file: f.title, from: hit.from || "", cover: hit.cover || "" });
        continue;
      }
      const links = [];
      if (/^https:\/\/(books\.google\.[a-z.]+|play\.google\.com)\//.test(hit.google || "")) links.push({ label: "Google Books", url: hit.google });
      const b = this.store.addBook({
        title,
        author,
        cover: /^https:\/\/(covers\.openlibrary\.org|books\.google\.[a-z.]+|books\.googleusercontent\.com)\//.test(hit.cover || "") ? hit.cover : "",
        links,
        source: "reader",
        language: book.language,
        ...(hit.isbns?.length ? { isbns: hit.isbns.slice(0, 20) } : {}),
        ...(/^\/works\/OL\w+$/.test(hit.ol || "") ? { ol: hit.ol } : {}),
        ...(Number(hit.published) ? { published: Number(hit.published) } : {}),
      });
      made.push({ ...b, file: f.title, from: hit.from || "" });
      c.all++;
      c.by[reader] = (c.by[reader] || 0) + 1;
      this.store.db.set("readerbooks:count", JSON.stringify(c));
    }
    if (dry) return { made, skipped };
    for (const [t, why] of skipped) this.log(`reader books: «${String(t).slice(0, 80)}» not added: ${why}`);
    if (made.length) this.log(`reader books: ${made.length} new from a reader's uploads: ${made.map((b) => b.id).join(", ")}`), this.made(reader, made);
    return { made, skipped };
  }
}

module.exports = { ReaderBooks, candidate, confirm, cleanAuthor, kindOnly, FRESH };

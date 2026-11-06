// Covers for the readers' own books that still have none (Max, 2026-10-28: Ukrainian books stayed bare after
// Readeat and Open Library's search). Two more places, asked after those:
//   1. Goodreads, for a book imported from there: the page of the very edition the reader shelved
//      (/book/show/<id>, which robots.txt allows) names its cover in og:image. For a Ukrainian book that is
//      the Ukrainian edition. The picture is kept here at once (Goodreads' own address is Amazon's).
//      A throttled answer (202, 429, 503) ends the run: the rest another time, never around it.
//   2. Open Library's cover of an ISBN the book has (covers.openlibrary.org/b/isbn), Ukrainian ISBNs
//      included; server.js keepOlCovers keeps it here like the others.
// A cover Open Library gave a Cyrillic title is the original's (readeat.js foreignCover): Goodreads' replaces it.
// Every book is asked once a month at most (meta covers:<id>), one request every 3 s, 300 books a day.
const { isRussian, fromOpenLibrary } = require("./store");

const MONTH = 30 * 86400000;
const DAILY = 300;
const OWN = new Set(["manual", "goodreads", "apple-books", "office", "list", "tip", "chat", "search", "books.md"]);
const HEADERS = { "User-Agent": "Chytai/1.0 (https://chytai.org.ua; cover lookup)" };
const GR_COVER = /^https:\/\/[^"]*photo\.goodreads\.com\/books\/[^"]+$/; // not the «no photo» or site pictures
const cleanIsbn = (s) => String(s || "").replace(/[^0-9Xx]/g, "").toUpperCase();

const foreign = (b) => fromOpenLibrary(b) && /[а-яіїєґ]/i.test(b.title || "");
function wanting(store, ids) {
  const all = ids ? ids.map((id) => store.lib.books[id]).filter(Boolean) : Object.values(store.lib.books);
  return all.filter((b) => {
    if (!OWN.has(b.source) || store.canonical(b.id) !== b.id) return false;
    const shown = store.book(b.id); // with Haiku's language: a Russian book stays bare
    if (!shown || isRussian(shown)) return false;
    return !shown.cover || (b.goodreads && foreign(shown));
  });
}

// The words of a title or a name, for comparing: «The Lord of the Rings (…, #1)» -> "the lord of the rings".
const words = (s) =>
  String(s || "")
    .replace(/&amp;/g, "&").replace(/&#39;|&apos;|&#x27;/g, "'").replace(/&quot;/g, '"')
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
// Is the Goodreads page the reader's book? Its title or its author's surname must be on the page's title
// (Max, 2026-11-06: an import's made-up Book Ids gave «10x Org» and six more books Tolkien's and Rowling's covers).
function samePage(book, page) {
  const on = ` ${words(page)} `;
  const title = words(String(book.title || "").split(/[:(]|\.\s/)[0]);
  const surname = words(String(book.author || "").split(/,|\band\b|&/)[0]).split(" ").filter((w) => w.length >= 3).pop() || "";
  return (title.length >= 2 && on.includes(` ${title} `)) || (!!surname && on.includes(` ${surname} `));
}

// goodreads(id, fetchImpl, book) -> the cover's address, "" when the page has none, null when the page is another book's.
async function goodreads(id, fetchImpl, book) {
  const r = await fetchImpl(`https://www.goodreads.com/book/show/${encodeURIComponent(id)}`, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
  if (r.status === 404) return "";
  if (r.status !== 200) throw Object.assign(new Error(`Goodreads HTTP ${r.status}`), { stop: true });
  const html = await r.text();
  if (book) {
    // A page without a book's title on it (a check page, a changed layout) proves nothing either way.
    const og = html.match(/<meta property="og:title" content="([^"]*)"/)?.[1];
    if (!og) return "";
    if (!samePage(book, `${og} ${html.match(/<title[^>]*>([^<]*)<\/title>/)?.[1] || ""}`)) return null;
  }
  const m = html.match(/<meta property="og:image" content="([^"]+)"/);
  return m && GR_COVER.test(m[1]) ? m[1] : "";
}

async function openLibrary(isbns, fetchImpl, wait) {
  for (const i of isbns) {
    const url = `https://covers.openlibrary.org/b/isbn/${i}-L.jpg`;
    const r = await fetchImpl(`${url}?default=false`, { method: "HEAD", headers: HEADERS, redirect: "manual", signal: AbortSignal.timeout(20000) });
    await wait();
    if (r.status === 200 || r.status === 302) return url;
  }
  return "";
}

function take(store) {
  const day = new Date().toISOString().slice(0, 10);
  const [d, n] = String(store.db.get("covers:day") || "").split(" ");
  const used = d === day ? Number(n) || 0 : 0;
  if (used >= DAILY) return false;
  store.db.set("covers:day", `${day} ${used + 1}`);
  return true;
}

// find(store, { ids, keep }) -> { asked, found }. keep(url) -> { url, error } keeps a picture here (server.js keepCover).
async function find(store, { ids, keep, max = DAILY, log = () => {}, fetchImpl = fetch, pause = 3000 } = {}) {
  const t0 = Date.now();
  const wait = () => new Promise((ok) => setTimeout(ok, pause));
  const books = wanting(store, ids)
    .filter((b) => Date.now() - Number(store.db.get(`covers:${b.id}`) || 0) > MONTH)
    .slice(0, max);
  let asked = 0;
  let found = 0;
  let stopped = "";
  for (const b of books) {
    if (!take(store)) break;
    try {
      let cover = "";
      let from = "";
      if (b.goodreads) {
        from = await goodreads(b.goodreads, fetchImpl, b);
        await wait();
        if (from === null) {
          // Not this book's id: it and the row's ISBNs are not to be trusted, so the book stays bare.
          log(`covers: ${b.id} «${b.title}»: Goodreads ${b.goodreads} is another book`);
          store.updateBook(b.id, { goodreads: "", goodreadsWrong: b.goodreads, isbns: [], isbnsWrong: b.isbns || [] });
          store.db.set(`covers:${b.id}`, String(Date.now()));
          asked++;
          continue;
        }
        if (from) {
          const k = keep ? await keep(from) : { url: from };
          if (!k.error) cover = k.url;
        }
      }
      const isbns = [...new Set((b.isbns || []).map(cleanIsbn).filter((x) => x.length === 10 || x.length === 13))].slice(0, 3);
      if (!cover && !store.book(b.id)?.cover && isbns.length) cover = await openLibrary(isbns, fetchImpl, wait);
      store.db.set(`covers:${b.id}`, String(Date.now()));
      asked++;
      if (!cover) continue;
      store.updateBook(b.id, from && cover !== from ? { cover, coverFrom: from, coverKept: cover } : { cover });
      found++;
    } catch (e) {
      stopped = `${b.id}: ${e.name === "TimeoutError" ? "timeout" : e.cause?.code || e.message}`;
      if (e.stop) break; // Goodreads asks us to slow down: the rest next run
    }
  }
  const line = `${new Date().toISOString()}: ${found} covers for ${asked} of ${books.length} books in ${Math.round((Date.now() - t0) / 1000)} s${stopped ? `; stopped at ${stopped}` : ""}`;
  if (books.length) log(`covers ${line}`);
  if (asked) store.db.set("covers:log", line);
  return { asked, found };
}

// The Goodreads covers taken before samePage() was there, each checked once, the newest books first (a
// made-up Book Id on an import, Max 2026-11-06). A page of another book takes the cover, the id and the
// row's ISBNs off the book (kept aside as goodreadsWrong/isbnsWrong). Same pace and daily cap as find().
async function recheck(store, { max = DAILY, log = () => {}, fetchImpl = fetch, pause = 3000 } = {}) {
  const wait = () => new Promise((ok) => setTimeout(ok, pause));
  const books = Object.values(store.lib.books)
    .filter((b) => OWN.has(b.source) && b.goodreads && b.cover && b.coverFrom && /media-amazon|goodreads|gr-assets/.test(b.coverFrom) && !store.db.get(`grcheck:${b.id}`))
    .reverse()
    .slice(0, max);
  let asked = 0;
  let wrong = 0;
  for (const b of books) {
    if (!take(store)) break;
    try {
      const from = await goodreads(b.goodreads, fetchImpl, b);
      await wait();
      asked++;
      store.db.set(`grcheck:${b.id}`, String(Date.now()));
      if (from !== null) continue;
      log(`covers: ${b.id} «${b.title}»: Goodreads ${b.goodreads} is another book, cover taken off`);
      store.updateBook(b.id, { cover: "", coverFrom: "", coverKept: "", goodreads: "", goodreadsWrong: b.goodreads, isbns: [], isbnsWrong: b.isbns || [] });
      wrong++;
    } catch (e) {
      log(`covers: recheck stopped at ${b.id}: ${e.name === "TimeoutError" ? "timeout" : e.cause?.code || e.message}`);
      if (e.stop) break;
    }
  }
  if (books.length) log(`covers: rechecked ${asked} Goodreads covers of ${books.length}, ${wrong} wrong`);
  return { asked, wrong };
}

// A book from a shop's catalog that a reader just put on a shelf (mcp.js), when the shop gave no picture (MEGOGO's
// record of Наш Формат's «Берлінський щоденник», Max 2026-11-02: «було б класно щоб обкладинка швидше
// зʼявлялась»). Readeat's Ukrainian edition first, then Open Library by ISBN. The picture is kept here and goes in
// as an edit, so the next catalog refresh doesn't take it away. The readers' own books go through find() above.
async function shelved(store, { ids, keep, log = () => {}, fetchImpl = fetch, pause = 1500 } = {}) {
  const wait = () => new Promise((ok) => setTimeout(ok, pause));
  const readeat = require("./readeat");
  let found = 0;
  for (const id of [...new Set(ids.map((i) => store.canonical(i)))]) {
    const b = store.book(id);
    if (!b || b.cover || store.lib.books[id] || isRussian(b)) continue; // own books: find()
    if (Date.now() - Number(store.db.get(`covers:${id}`) || 0) < MONTH || !take(store)) continue;
    store.db.set(`covers:${id}`, String(Date.now()));
    const isbns = [...new Set([b.isbn, ...(b.isbns || [])].map(cleanIsbn).filter((x) => x.length === 10 || x.length === 13))].slice(0, 3);
    try {
      let from = (await readeat.findBook({ title: b.title, author: b.author, isbns }, { fetchImpl, pause }))?.cover || "";
      if (!from && isbns.length) from = await openLibrary(isbns, fetchImpl, wait);
      if (!from) continue;
      const k = keep ? await keep(from) : { url: from };
      if (k.error) continue;
      if (store.book(id)?.cover) continue; // someone set one meanwhile
      store.editBook(id, { ...(store.edits()[id] || {}), cover: k.url });
      found++;
      log(`covers: ${id} got a cover from ${from}`);
    } catch (e) {
      log(`covers: ${id}: ${e.name === "TimeoutError" ? "timeout" : e.cause?.code || e.message}`);
    }
  }
  return { found };
}

module.exports = { find, shelved, recheck, wanting, goodreads, openLibrary, samePage };

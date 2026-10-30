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

async function goodreads(id, fetchImpl) {
  const r = await fetchImpl(`https://www.goodreads.com/book/show/${encodeURIComponent(id)}`, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
  if (r.status === 404) return "";
  if (r.status !== 200) throw Object.assign(new Error(`Goodreads HTTP ${r.status}`), { stop: true });
  const m = (await r.text()).match(/<meta property="og:image" content="([^"]+)"/);
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
        from = await goodreads(b.goodreads, fetchImpl);
        await wait();
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

module.exports = { find, wanting, goodreads, openLibrary };

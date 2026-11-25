// BookFlow (bookflow.com.ua), «спільна бібліотека, створена читачами»: readers lend their own books through it,
// a book is taken for a price, and comes back (Max, 2026-11-17: «запропонував BookFlow інтеграцію в наш блок Де
// взяти»). Vlad from BookFlow made one public address for us, no key: the whole catalog and the prices.
//   { generated_at, prices: { currency, one_time, subscription_month }, books: [{ isbn, title, authors, url, available }] }
// The price is one for every book: `one_time` reads one book, `subscription_month` is a month's subscription.
// `available` false = every copy is with a reader now; the book is still shown («зараз усі в читачів»).
// Every hour the jobs process reads it (~0.5 MB, 2 s) and matches its books with ours: by ISBN, else by title
// (its part before «.»/«:») and the same author. What is kept: meta `bookflow:links` (book id -> [url, free]) and
// the prices, rewritten each time, so nothing grows. The book page shows one row «Прокат» (pages.js where()).
const { norm, sameAuthor, isRussian } = require("./store");

const URL_EXPORT = "https://api.bookflow.com.ua/api/books/export/";
const UA = "Chytai/1.0 (https://chytai.org.ua; book pages link to BookFlow)";
const head = (t) => norm(String(t || "").split(/[.:(]/)[0]);

class BookFlow {
  constructor({ store, fetchImpl = fetch, log = () => {} }) {
    Object.assign(this, { store, fetchImpl, log, db: store.db });
    this.running = false;
    this.cache = null;
  }

  // The «Прокат» row's data for a book page, or null. The web process reads the map again every ten minutes.
  linkFor(book) {
    if (!book) return null;
    if (!this.cache || Date.now() - this.cache.at > 10 * 60 * 1000) {
      const st = JSON.parse(this.db.get("bookflow:links") || "null");
      this.cache = { at: Date.now(), links: st?.links || {}, prices: st?.prices || null };
    }
    const l = this.cache.links[this.store.canonical(book.id)] || this.cache.links[book.id];
    if (!l) return null;
    const p = this.cache.prices || {};
    return { name: "BookFlow", url: l[0], free: !!l[1], once: Number(p.one_time) || 0, month: Number(p.subscription_month) || 0 };
  }

  // Our work for one of its books, or null: the ISBN, else the same title head by the same author (a title alone
  // could be the English original, whose page is not the Ukrainian book's).
  match(b) {
    const s = this.store;
    const byIsbn = s.workIndex().byIsbn;
    const isbn = String(b.isbn || "").replace(/[^0-9X]/gi, "");
    if (isbn.length >= 10 && byIsbn.has(isbn)) return byIsbn.get(isbn);
    if (!b.title || !b.authors) return null;
    const id = s.findWork({ title: b.title, author: b.authors });
    const w = id && s.book(id);
    if (!w || isRussian(w) || !sameAuthor(w.author || "", b.authors) || head(w.title) !== head(b.title)) return null;
    return id;
  }

  async run() {
    if (this.running) return null;
    this.running = true;
    try {
      const r = await this.fetchImpl(URL_EXPORT, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(60000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const feed = await r.json();
      const books = Array.isArray(feed?.books) ? feed.books : [];
      // A broken or empty answer keeps yesterday's links.
      if (books.length < 100) throw new Error(`only ${books.length} books in the export`);
      const links = {};
      let byIsbn = 0;
      for (const b of books) {
        if (!/^https:\/\/(www\.)?bookflow\.com\.ua\//.test(String(b.url || ""))) continue;
        const id = this.match(b);
        if (!id) continue;
        if (this.store.workIndex().byIsbn.get(String(b.isbn || "").replace(/[^0-9X]/gi, "")) === id) byIsbn++;
        // Two of its editions of one work: the one with a free copy.
        if (!links[id] || (!links[id][1] && b.available)) links[id] = [b.url, b.available ? 1 : 0];
      }
      const p = feed.prices || {};
      const prices = p.currency === "UAH" ? { one_time: Number(p.one_time) || 0, subscription_month: Number(p.subscription_month) || 0 } : null;
      const n = Object.keys(links).length;
      this.db.set("bookflow:links", JSON.stringify({ at: Date.now(), generated: feed.generated_at || "", books: books.length, matched: n, byIsbn, prices, links }));
      this.cache = null;
      this.log(`bookflow: ${n} of our books (${books.length} in BookFlow, ${byIsbn} by ISBN)`);
      return n;
    } finally {
      this.running = false;
    }
  }
}

module.exports = { BookFlow, URL_EXPORT };

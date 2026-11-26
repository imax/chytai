// Книгарня «Сенс» (sens.in.ua) in «Де взяти» (Max 2026-11-26: they gave us their Google Merchant Center feed). One
// XML of ~19 thousand products, ~58 MB: per product its page, ISBN (gtin), price and sale price, in stock or not,
// publisher (brand), and the authors after the title's last «. », name first («Каста. Витоки наших невдоволень.
// Елізабет Вілкерсон»). The feed's address carries their key, so it is not in this public repository: meta
// `sens:feed` (POST /agent/sens {"feed": …}), or the Fly secret SENS_FEED.
// The jobs process reads it every 6 hours, leaves out their merch and gift cards, matches the books with ours by ISBN,
// else by the same title and author (megogo.js `match`), and keeps only meta `sens:links` (book id -> [url, price,
// status, publisher]), rewritten each time. Out-of-stock books are kept too («Улюблені книгарні» reads the stock), but
// only a book in stock gets the row: one more paper shop «Сенс» in «Де взяти», on the book page and in the reader's
// «Хочу прочитати», sorted with the other shops (after the publisher's own, pubshops.js).
const { ent } = require("./catalogs");
const megogo = require("./megogo");

const NAME = "Сенс";
const SKIP = /^(Мерч Сенсу|Подарункові сертифікати|Автори)/;
const STATUS = { "in stock": "є", "out of stock": "немає", preorder: "передзамовлення", backorder: "очікується" };
const RANK = { є: 0, передзамовлення: 1, очікується: 2, немає: 3 };
const clean = (s) => ent(String(s || "")).replace(/\s+/g, " ").trim();

// The feed's books: { url, isbn, title, author, price, status, brand }.
function parse(xml) {
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const f = {};
    for (const x of m[1].matchAll(/<g:(\w+)>([^<]*)<\/g:\1>/g)) f[x[1]] = x[2];
    if (SKIP.test(clean(f.product_type)) || f.adult === "yes" || f.adult === "True") continue;
    const url = clean(f.link);
    if (!/^https:\/\/sens\.in\.ua\//.test(url) || !STATUS[f.availability]) continue;
    const num = (v) => Number(String(v || "").replace(/[^\d.]/g, "")) || 0;
    out.push({ url, isbn: String(f.gtin || "").replace(/[^\dX]/gi, ""), ...megogo.split(f.title, { nameFirst: true }), price: Math.round(num(f.sale_price) || num(f.price)), status: STATUS[f.availability], brand: clean(f.brand) });
  }
  return out;
}

// Their ISBN on another book (2026-11-26: «Беджерс-Дрифт» carried «Взаємодія з ворогом»'s, «Аннапурна» a management
// book's): two Ukrainian titles with no word in common are not one book. A Ukrainian title on an English work is
// its translation's ISBN, kept.
const CYR = /[а-яіїєґ]/i;
const words = (s) => new Set(String(s || "").toLowerCase().replace(/ґ/g, "г").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4));
function wrongIsbn(b, w) {
  if (!w || !CYR.test(b.title) || !CYR.test(w.title || "")) return false;
  const a = words(b.title);
  const t = words(`${w.title} ${w.altTitle || ""}`);
  return a.size > 0 && t.size > 0 && ![...a].some((x) => t.has(x));
}

class Sens {
  constructor({ store, fetchImpl = fetch, log = () => {} }) {
    Object.assign(this, { store, fetchImpl, log, db: store.db });
    this.running = false;
    this.cache = null;
    // Its matching is megogo.js's: the ISBN, else the whole title by the same author, never a Russian edition.
    this.matcher = new megogo.Megogo({ store });
  }

  feed() {
    return this.db.get("sens:feed") || process.env.SENS_FEED || "";
  }

  // The shop's entry for a book, or null. The web process reads the map again every ten minutes.
  linkFor(book) {
    if (!book) return null;
    if (!this.cache || Date.now() - this.cache.at > 10 * 60 * 1000) this.cache = { at: Date.now(), links: JSON.parse(this.db.get("sens:links") || "null")?.links || {} };
    const l = this.cache.links[this.store.canonical(book.id)] || this.cache.links[book.id];
    return l ? { url: l[0], price: l[1], status: l[2], brand: l[3] || "" } : null;
  }

  // The book with Сенс among its shops when they have it in stock.
  withShop(book) {
    const l = this.linkFor(book);
    if (!l || l.status !== "є") return book;
    const row = { id: `sens-${l.url}`, shelf: { id: "sens", name: NAME, kind: "shop" }, links: [{ label: NAME, url: l.url }], format: "папір", price: l.price ? `${l.price} ₴` : "", status: l.status, edition: l.brand };
    return { ...book, shops: [...(book.shops || book.editions || []), row] };
  }

  async run({ force = false } = {}) {
    if (this.running) return null;
    const url = this.feed();
    if (!url) return null;
    this.running = true;
    try {
      const was = JSON.parse(this.db.get("sens:links") || "null");
      const headers = { "User-Agent": "Chytai/1.0 (+https://chytai.org.ua)" };
      if (was?.etag && !force) headers["If-None-Match"] = was.etag;
      const r = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(180000) });
      if (r.status === 304) return was.matched;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const books = parse(await r.text());
      // A broken or empty answer keeps the last links.
      if (books.length < 1000) throw new Error(`only ${books.length} books in the feed`);
      const links = {};
      let byIsbn = 0;
      let stock = 0;
      for (const b of books) {
        const id = this.matcher.match(b);
        if (!id || wrongIsbn(b, this.store.book(id))) continue;
        if (this.store.workIndex().byIsbn.get(b.isbn) === id) byIsbn++;
        // Several of its editions of one work: in stock first, then the cheapest.
        const old = links[id];
        if (!old || RANK[b.status] < RANK[old[2]] || (RANK[b.status] === RANK[old[2]] && b.price && (!old[1] || b.price < old[1]))) links[id] = [b.url, b.price, b.status, b.brand];
      }
      for (const l of Object.values(links)) if (l[2] === "є") stock++;
      const n = Object.keys(links).length;
      this.db.set("sens:links", JSON.stringify({ at: Date.now(), etag: r.headers.get("etag") || "", books: books.length, matched: n, stock, byIsbn, links }));
      this.cache = null;
      this.log(`sens: ${n} of our books, ${stock} in stock (${books.length} books in the feed, ${byIsbn} by ISBN)`);
      return n;
    } finally {
      this.running = false;
    }
  }
}

module.exports = { Sens, parse, NAME };

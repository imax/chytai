// MEGOGO BOOKS (mbooks.com.ua) in «Де взяти» (Max 2026-11-25: their content director gave us their Google Merchant
// Center feed, «Є от такий готовий»). The feed is paper books only (their e-books may come later as another feed:
// then a second address here with its own `format`). One XML of ~26 thousand products, ~60 MB, remade every
// morning (~08:00 Kyiv): per product its page, ISBN (gtin), price and sale price, stock, publisher (brand), and the
// authors after the title's last «. », surname first («Тиха місцина. Фіцджеральд Френсіс Скотт»).
// The jobs process reads it every 6 hours (a conditional request: an unchanged feed is not downloaded again),
// leaves out stationery, notebooks, games, textbooks and magazines, and matches the books with ours by ISBN, else by
// the same title and author (as bookflow.js). Kept: meta `megogo:links` (book id -> [url, price, status,
// publisher]), rewritten each time, ~10 thousand books, ~0.8 MB. Not shelf items: 20 thousand more of those cost
// the site 2 s and 140 MB at every start (2026-11-25, test DB).
// The book page and the reader's «Хочу прочитати» get one more paper edition (withShop); the 51 publisher shelves
// read from mbooks.com.ua's pages (catalogs.js mbooks) link to the same pages, and their row gives way to this one,
// so the shop is named and the price is today's.
const { norm, sameAuthor, isRussian } = require("./store");
const { ent } = require("./catalogs");

const FEED = "https://i.mbooks.com.ua/media/merchant_center_feed.xml";
const UA = "Chytai/1.0 (https://chytai.org.ua; book pages link to MEGOGO BOOKS)";
const NAME = "MEGOGO BOOKS";
const SKIP = /^(Канцтовари|Блокноти|Розваги|Шкільні підручники|Періодичні)/;
// «backorder» is mbooks.com.ua's «Очікується»: orders taken, the book comes later.
const STATUS = { in_stock: "є", preorder: "передзамовлення", backorder: "очікується" };
const RANK = { є: 0, передзамовлення: 1, очікується: 2 };
const CYR = /[а-яіїєґ]/i;
const clean = (s) => ent(String(s || "")).replace(/\s+/g, " ").trim();

// «Ґабрієле Меттью, Перрі Девід М.» is names: each part a few capitalised words or initials, no other dots.
const namesOnly = (s) => s.split(/\s*,\s*/).every((p) => /^[\p{Lu}][\p{L}'’ʼ-]*\.?(?:\s+[\p{Lu}][\p{L}'’ʼ-]*\.?){0,3}$/u.test(p) && !/\p{L}{2,}\.(?!$)/u.test(p));
// The title and the authors (name first) of «Назва. Підзаголовок. Прізвище Ім'я, Прізвище Ім'я».
function split(s) {
  s = clean(s).replace(/(?<!(?:^|\s)\p{Lu})\.$/u, ""); // «Олег Сенцов. »: no author, the dot goes; «Перрі Девід М.» keeps its initial
  for (const m of s.matchAll(/\.\s+/g)) {
    const rest = s.slice(m.index + m[0].length);
    if (!namesOnly(rest)) continue;
    const flip = (a) => ((w) => (w.length > 1 ? [...w.slice(1), w[0]].join(" ") : a))(a.split(/\s+/));
    return { title: s.slice(0, m.index).trim(), author: rest.split(/\s*,\s*/).map(flip).join(", ") };
  }
  return { title: s.trim(), author: "" };
}

// The feed's books: { url, isbn, title, author, price, status, brand }.
function parse(xml) {
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const f = {};
    for (const x of m[1].matchAll(/<g:(\w+)>([^<]*)<\/g:\1>/g)) f[x[1]] = x[2];
    if (SKIP.test(clean(f.product_type)) || f.is_bundle === "True" || f.adult === "True") continue;
    const url = clean(f.link);
    if (!/^https:\/\/mbooks\.com\.ua\/book\/\d+/.test(url) || !STATUS[f.availability]) continue;
    const num = (v) => Number(String(v || "").replace(/[^\d.]/g, "")) || 0;
    out.push({ url, isbn: String(f.gtin || "").replace(/[^\dX]/gi, ""), ...split(f.title), price: Math.round(num(f.sale_price) || num(f.price)), status: STATUS[f.availability], brand: clean(f.brand) });
  }
  return out;
}

class Megogo {
  constructor({ store, fetchImpl = fetch, log = () => {} }) {
    Object.assign(this, { store, fetchImpl, log, db: store.db });
    this.running = false;
    this.cache = null;
  }

  // The shop's row for a book, or null. The web process reads the map again every ten minutes.
  linkFor(book) {
    if (!book) return null;
    if (!this.cache || Date.now() - this.cache.at > 10 * 60 * 1000) this.cache = { at: Date.now(), links: JSON.parse(this.db.get("megogo:links") || "null")?.links || {} };
    const l = this.cache.links[this.store.canonical(book.id)] || this.cache.links[book.id];
    return l ? { url: l[0], price: l[1], status: l[2], brand: l[3] || "" } : null;
  }

  // The book with the shop as one more paper edition, a copy (store.bookPage's object is shared). An edition of
  // another shelf with the same address (a publisher shelf read from mbooks.com.ua) gives way to it.
  withShop(book) {
    const l = this.linkFor(book);
    if (!l) return book;
    const ed = { id: `megogo-${(l.url.match(/\/book\/(\d+)/) || [])[1]}`, shelf: { id: "megogo", name: NAME, kind: "shop" }, links: [{ label: NAME, url: l.url }], format: "папір", price: l.price ? `${l.price} ₴` : "", status: l.status, edition: l.brand };
    return { ...book, editions: [...(book.editions || []).filter((e) => e.links?.[0]?.url !== l.url), ed] };
  }

  // Our work for one of its books, or null: the ISBN, else the same title by the same author.
  match(b) {
    const s = this.store;
    const byIsbn = s.workIndex().byIsbn;
    if (b.isbn.length >= 10 && byIsbn.has(b.isbn)) return byIsbn.get(b.isbn);
    if (!b.title || !b.author) return null;
    const id = s.findWork({ title: b.title, author: b.author });
    const w = id && s.book(id);
    // The whole title, not its head: «Дюна. Дім Атрідів. Книга 3» by Браян Герберт is not «Дюна»; and a Ukrainian
    // edition is not the English original's page («1984» by George Orwell).
    if (!w || isRussian(w) || !sameAuthor(w.author || "", b.author) || norm(w.title) !== norm(b.title)) return null;
    if (CYR.test(b.author) && !CYR.test(w.author || "")) return null;
    return id;
  }

  async run({ force = false } = {}) {
    if (this.running) return null;
    this.running = true;
    try {
      const was = JSON.parse(this.db.get("megogo:links") || "null");
      const headers = { "User-Agent": UA };
      if (was?.etag && !force) headers["If-None-Match"] = was.etag;
      const r = await this.fetchImpl(FEED, { headers, signal: AbortSignal.timeout(180000) });
      if (r.status === 304) return was.matched;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const books = parse(await r.text());
      // A broken or empty answer keeps the last links.
      if (books.length < 1000) throw new Error(`only ${books.length} books in the feed`);
      const links = {};
      let byIsbn = 0;
      for (const b of books) {
        const id = this.match(b);
        if (!id) continue;
        if (this.store.workIndex().byIsbn.get(b.isbn) === id) byIsbn++;
        // Several of its editions of one work: in stock first, then the cheapest.
        const old = links[id];
        if (!old || RANK[b.status] < RANK[old[2]] || (RANK[b.status] === RANK[old[2]] && b.price && (!old[1] || b.price < old[1]))) links[id] = [b.url, b.price, b.status, b.brand];
      }
      const n = Object.keys(links).length;
      this.db.set("megogo:links", JSON.stringify({ at: Date.now(), etag: r.headers.get("etag") || "", modified: r.headers.get("last-modified") || "", books: books.length, matched: n, byIsbn, links }));
      this.cache = null;
      this.log(`megogo: ${n} of our books (${books.length} books in the feed, ${byIsbn} by ISBN)`);
      return n;
    } finally {
      this.running = false;
    }
  }
}

module.exports = { Megogo, parse, split, FEED, NAME };

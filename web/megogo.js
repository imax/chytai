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
// read from mbooks.com.ua's pages (catalogs.js mbooks) link to the same shop, so all those rows become one «MEGOGO BOOKS»
// row per format.
const { norm, sameAuthor, isRussian } = require("./store");
const { ent, about } = require("./catalogs");

const FEED = "https://i.mbooks.com.ua/media/merchant_center_feed.xml";
// No User-Agent of our own for now: their Cloudflare answers 403 to «Chytai/1.0 (…)» (2026-11-25). Max has MEGOGO's
// consent to use the feed and asks them to let «Chytai» through; then it goes back to a named one.
const NAME = "MEGOGO BOOKS";
const SKIP = /^(Канцтовари|Блокноти|Розваги|Шкільні підручники|Періодичні)/;
// «backorder» is mbooks.com.ua's «Очікується»: orders taken, the book comes later.
const STATUS = { in_stock: "є", preorder: "передзамовлення", backorder: "очікується" };
const RANK = { є: 0, передзамовлення: 1, очікується: 2 };
const CYR = /[а-яіїєґ]/i;
const MBOOKS = /^https?:\/\/(www\.)?mbooks\.com\.ua\//;
const clean = (s) => ent(String(s || "")).replace(/\s+/g, " ").trim();

// «Ґабрієле Меттью, Перрі Девід М.» is names: each part a few capitalised words or initials, no other dots.
const namesOnly = (s) => s.split(/\s*,\s*/).every((p) => /^[\p{Lu}][\p{L}'’ʼ-]*\.?(?:\s+[\p{Lu}][\p{L}'’ʼ-]*\.?){0,3}$/u.test(p) && !/\p{L}{2,}\.(?!$)/u.test(p));
// The title and the authors (name first) of «Назва. Підзаголовок. Прізвище Ім'я, Прізвище Ім'я».
// `nameFirst`: the names come «Ім'я Прізвище» (Сенс's feed, sens.js), so nothing is turned round.
function split(s, { nameFirst = false } = {}) {
  s = clean(s).replace(/(?<!(?:^|\s)\p{Lu})\.$/u, ""); // «Олег Сенцов. »: no author, the dot goes; «Перрі Девід М.» keeps its initial
  for (const m of s.matchAll(/\.\s+/g)) {
    const rest = s.slice(m.index + m[0].length);
    if (!namesOnly(rest)) continue;
    // A one-word pen name comes with «None» as the first name («Мокумокурен None»): the word goes.
    const flip = (a) => ((w) => (w.length > 1 && !nameFirst ? [...w.slice(1), w[0]].join(" ") : w.join(" ")))(a.split(/\s+/).filter((x) => x !== "None"));
    return { title: s.slice(0, m.index).trim(), author: rest.split(/\s*,\s*/).map(flip).join(", ") };
  }
  return { title: s.trim(), author: "" };
}

// Their categories in words store.js's genre guesses read rightly: «Класична література» is a classic, and «Воєнна
// проза і поезія» is about the war, not poetry.
const CATS = { "Класична література": "класика", "Воєнна проза і поезія": "війна" };
// The feed's books: { url, isbn, title, author, price, status, brand, date, about, cats, image, labels }: `date` = when a book
// on order comes (YYYY-MM-DD), `about` = the publisher's description (escaped HTML), `cats` = its category path,
// `image` = the cover, `labels` = their marks («Новинка»; megogofill.js).
function parse(xml) {
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const f = {};
    for (const x of m[1].matchAll(/<g:(\w+)>([^<]*)<\/g:\1>/g)) f[x[1]] = x[2];
    if (SKIP.test(clean(f.product_type)) || f.is_bundle === "True" || f.adult === "True") continue;
    const url = clean(f.link);
    if (!/^https:\/\/mbooks\.com\.ua\/book\/\d+/.test(url) || !STATUS[f.availability]) continue;
    const num = (v) => Number(String(v || "").replace(/[^\d.]/g, "")) || 0;
    out.push({ url, isbn: String(f.gtin || "").replace(/[^\dX]/gi, ""), ...split(f.title), price: Math.round(num(f.sale_price) || num(f.price)), status: STATUS[f.availability], brand: clean(f.brand), date: /^\d{4}-\d\d-\d\d/.test(f.availability_date || "") ? f.availability_date.slice(0, 10) : "", about: f.description || "", cats: clean(f.product_type).split(/\s*>\s*/).map((c) => CATS[c] || c), image: clean(f.image_link), labels: [f.custom_label_0, f.custom_label_1].map(clean).filter(Boolean) });
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
    return l ? { url: l[0], price: l[1], status: l[2], brand: l[3] || "", date: l[4] || "" } : null;
  }

  // The book with its shops for «Де взяти» as `shops` (its `editions` stay as they are: the publisher block reads
  // them). Every row that leads to mbooks.com.ua is one shop «MEGOGO BOOKS» (Megogo until 2026-11-26: MEGOGO asked for the full name, not the video service), one row per format (Max 2026-11-25: the 51
  // publisher shelves read from mbooks.com.ua showed as «Апріорі», «Фабула»… and all went to Megogo: «один лінк, а не
  // 10»): in stock first, then the cheapest; the feed's row stands for the paper ones, its price is today's.
  withShop(book) {
    if (!book) return book;
    const l = this.linkFor(book);
    const feed = l && { id: `megogo-${(l.url.match(/\/book\/(\d+)/) || [])[1]}`, shelf: { id: "megogo", name: NAME, kind: "shop" }, links: [{ label: NAME, url: l.url }], format: "папір", price: l.price ? `${l.price} ₴` : "", status: l.status, edition: l.brand, ...(l.date && l.status !== "є" ? { from: l.date } : {}) };
    const eds = book.editions || [];
    const ours = (e) => MBOOKS.test(e.links?.[0]?.url || "");
    const relabel = (e) => ({ ...e, shelf: { id: "megogo", name: NAME, kind: "shop" }, links: [{ label: NAME, url: e.links[0].url }], edition: e.edition || e.shelf?.name || "" });
    const kind = (e) => (e.adapted ? "комікс" : e.format || "папір");
    const mb = [...eds.filter(ours).map(relabel).filter((e) => !(feed && kind(e) === "папір")), ...(feed ? [feed] : [])];
    if (!mb.length) return book;
    const cost = (e) => Number(String(e.price || "").replace(/[^\d]/g, "")) || Infinity;
    const best = new Map();
    for (const e of mb) {
      const o = best.get(kind(e));
      if (!o || (RANK[e.status] ?? 3) < (RANK[o.status] ?? 3) || ((RANK[e.status] ?? 3) === (RANK[o.status] ?? 3) && cost(e) < cost(o))) best.set(kind(e), e);
    }
    // The book's own link to one of the folded rows would come back under «Інше».
    return { ...book, shops: [...eds.filter((e) => !ours(e)), ...best.values()], links: (book.links || []).filter((x) => !MBOOKS.test(x.url || "")) };
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

  // What store.book() takes from the feed (meta `megogo:info`, work id -> [description, categories]; Max
  // 2026-11-26): the publisher's description for a work that has none of its own, its editions' or its
  // translation's (Haiku's short one gives way to it), and the categories, for a work with no genre but «художня»
// (~5 thousand works, 2026-11-26 test DB).
  // Only a description the book page would show is kept (~1 thousand, ~1.5 MB); categories for all, a few words each.
  info(mine, links) {
    const out = {};
    for (const [id, bs] of mine) {
      const best = bs.find((b) => b.url === links[id][0]) || bs[0];
      // Only what all its editions there agree on: a children's edition of «Ніч перед Різдвом» doesn't make Гоголь's
      // story a children's book.
      const cats = bs.map((b) => b.cats.slice(1)).reduce((x, y) => x.filter((c) => y.includes(c)));
      const w = this.store.book(id);
      let text = "";
      if (w && (!w.blurb || /^(Claude|Megogo|MEGOGO)/.test(w.blurbSource || ""))) {
        for (const b of [best, ...bs]) if (!text && b.about) text = about(b.about, 3000);
        // An English description on a Ukrainian book is not shown (store.book), so it is not kept either.
        if (CYR.test(w.title || "") && !CYR.test(text.slice(0, 300))) text = "";
      }
      if (text || cats.length) out[id] = [text, cats];
    }
    return out;
  }

  async run({ force = false } = {}) {
    if (this.running) return null;
    this.running = true;
    try {
      const was = JSON.parse(this.db.get("megogo:links") || "null");
      const headers = {};
      // No `megogo:info` yet (it came after the links): the whole feed once more.
      if (was?.etag && !force && this.db.get("megogo:info")) headers["If-None-Match"] = was.etag;
      const r = await this.fetchImpl(FEED, { headers, signal: AbortSignal.timeout(180000) });
      if (r.status === 304) return was.matched;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const books = parse(await r.text());
      // A broken or empty answer keeps the last links.
      if (books.length < 1000) throw new Error(`only ${books.length} books in the feed`);
      const links = {};
      const mine = new Map(); // work id -> its books in the feed
      let byIsbn = 0;
      for (const b of books) {
        const id = this.match(b);
        if (!id) continue;
        if (this.store.workIndex().byIsbn.get(b.isbn) === id) byIsbn++;
        (mine.get(id) || mine.set(id, []).get(id)).push(b);
        // Several of its editions of one work: in stock first, then the cheapest.
        const old = links[id];
        if (!old || RANK[b.status] < RANK[old[2]] || (RANK[b.status] === RANK[old[2]] && b.price && (!old[1] || b.price < old[1]))) links[id] = [b.url, b.price, b.status, b.brand, b.date];
      }
      const n = Object.keys(links).length;
      const info = this.info(mine, links);
      this.db.set("megogo:links", JSON.stringify({ at: Date.now(), etag: r.headers.get("etag") || "", modified: r.headers.get("last-modified") || "", books: books.length, matched: n, byIsbn, links }));
      this.db.set("megogo:info", JSON.stringify(info));
      this.store.megogoChanged?.();
      this.cache = null;
      const blurbs = Object.values(info).filter((x) => x[0]).length;
      this.log(`megogo: ${n} of our books (${books.length} books in the feed, ${byIsbn} by ISBN), ${blurbs} descriptions`);
      return n;
    } finally {
      this.running = false;
    }
  }
}

module.exports = { Megogo, parse, split, FEED, NAME };

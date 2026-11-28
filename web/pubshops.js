// Publishers' own web shops in «Де взяти» (Max 2026-11-26, after Лабораторія's founder: a bookshop pays a year later,
// a sale on the publisher's own site is the best for them). The 51 shelves read from mbooks.com.ua all lead to
// Megogo; for the publishers whose own shop lets our robot in and shows the ISBN on a book's page, the book page
// and the reader's «Хочу прочитати» get one more paper (or e-book) row named by the publisher, always first in its
// line (Max chose «Завжди першим»), Megogo stays.
// The jobs process reads each shop's sitemap once a day (its book pages), opens every new page once, one at a time
// per shop with a pause, and keeps what the page says: ISBN, price, in stock, paper or e-book (table `pub_pages`).
// A page of a book of ours is read again after a day (price, stock; Max 2026-11-28, a Black Friday sale showed the
// old price); one of no book of ours after two months. A shop
// sells other publishers' books too (BookChef, Наш Формат): only ISBNs of the publisher's own shelf get its row.
// Pages that look like our titles go first, so a big shop gives its matches in the first days.
// Kept for the site: meta `pubshops:links` (book id -> [[shop, url, price, status, format], …]), ~6 thousand books.
// Shops that refuse us (Stone, Віхола, Yakaboo, Жупанський, Кафедра, Залізний тато): Max asks them for a
// feed (the Claude Doc «Сайти видавництв: прямі лінки в «Де взяти»», linked from CLAUDE.md).
const zlib = require("zlib");
const { slugify } = require("./store");
const { ent } = require("./catalogs");

const UA = "Mozilla/5.0 (Chytai catalog refresh; chytai.org.ua)";
const DAY = 86400000;
// id = the row's shop id; shelves = our shelves of the publisher (their ISBNs are the books the row may name);
// page = which sitemap addresses are books (the rest are authors, news, categories).
const SHOPS = [
  { id: "folio", name: "Фоліо", base: "https://folio.com.ua", shelves: ["folio"], page: /\/books\/[^/?#]+$/ },
  { id: "bookchef", name: "BookChef", base: "https://bookchef.ua", shelves: ["bookchef"], page: /^https:\/\/bookchef\.ua\/[^/?#]+$/ },
  { id: "nashformat", name: "Наш Формат", base: "https://nashformat.ua", shelves: ["nashformat"], page: /\/products\/[^/?#]+$/ },
  { id: "knyholav", name: "#книголав", base: "https://knigolove.ua", shelves: ["knyholav"], page: /\/(book|ebook)\/[^/?#]+$/ },
  { id: "ranok", name: "Ранок", base: "https://www.ranok.com.ua", shelves: ["fabula", "shcheodnu", "readberry"], page: /\/info-[^/?#]+-\d+\.html$/, maps: /sitemap_products_/ },
  { id: "ababahalamaha", name: "А-БА-БА-ГА-ЛА-МА-ГА", base: "https://store.ababahalamaha.com.ua", shelves: ["ababahalamaha"], page: /^https:\/\/store\.ababahalamaha\.com\.ua\/[^/?#]+$/ },
  { id: "vyd21", name: "Видавництво 21", base: "https://books-xxi.com.ua", shelves: ["vyd21", "chornivivtsi"], page: /\/products\/[^/?#]+$/ },
  { id: "arthuss", name: "ArtHuss", base: "https://www.arthuss.com.ua", shelves: ["arthuss"], page: /\/shop\/[^/?#]+$/ },
  { id: "burlaka", name: "Видавництво Ростислава Бурлаки", base: "https://vrb.com.ua", shelves: ["burlaka"], page: /^https:\/\/vrb\.com\.ua\/[^/?#]+$/ },
  { id: "astroliabiia", name: "Астролябія", base: "https://astrolabium.com.ua", shelves: ["astroliabiia"], page: /^https:\/\/astrolabium\.com\.ua\/(?!en\/)[^/?#]+\.html$/ },
  { id: "portal", name: "Портал", base: "https://portalbooks.com.ua", shelves: ["portal"], page: /\/product\/[^/?#]+\/?$/ },
  { id: "litopys", name: "Літопис", base: "https://litopys.lviv.ua", shelves: ["litopys"], page: /\/product\/[^/?#]+\/?$/ },
  { id: "safran", name: "Сафран", base: "https://safranbook.com", shelves: ["safran"], page: /\/catalog\/[^/?#]+\/?$/ },
  { id: "cwp", name: "Creative Women Publishing", base: "https://www.creativewomenpublishing.com.ua", shelves: ["cwp"], page: /\/(product|shop)\/[^/?#]+\/?$/ },
  { id: "klio", name: "Кліо", base: "https://clio.in.ua", shelves: ["klio"], page: /-detail$/ },
];
const PAUSE = 1500; // ms between two pages of one shop
const RUN_MS = 25 * 60 * 1000; // one run's time; the next run goes on where it stopped

const num = (v) => Number(String(v ?? "").replace(/\s/g, "").replace(",", ".").replace(/[^\d.]/g, "")) || 0;
const isbnOf = (s) => String(s || "").replace(/[^0-9X]/gi, "");
const ldOf = (html) =>
  [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].flatMap((m) => {
    try {
      const j = JSON.parse(m[1].replace(/[\u0000-\u001f]+/g, " "));
      return [].concat(j, ...[].concat(j).map((x) => x?.["@graph"] || []));
    } catch {
      return [];
    }
  });
const STATUS = (s) => (/InStock|LimitedAvailability|OnlineOnly/i.test(s) ? "є" : /PreOrder|PreSale/i.test(s) ? "передзамовлення" : /OutOfStock|SoldOut|Discontinued/i.test(s) ? "немає" : "");

// What a book's page says: { isbn, price, status, format, title } (isbn "" = not a book page, or no ISBN on it).
function parsePage(html, url = "") {
  const prod = ldOf(html).find((x) => /Product|Book/.test([].concat(x?.["@type"] || []).join(" ")));
  const offer = [].concat(prod?.offers || [])[0] || {};
  const plain = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/\s+/g, " ");
  const text = plain(html);
  // The book's own part of the page: from its title on (the header has «доставка від 1500 ₴», the foot other books).
  const at = Math.max(0, html.search(/<h1[\s>]|<h[1-3][^>]*class="[^"]*product_title/i));
  // A sale shows the old price crossed out first (WooCommerce's <del>): only the price one pays counts.
  const main = html.slice(at, at + 20000).replace(/<del\b[\s\S]*?<\/del>/gi, " ");
  const mainText = plain(main).slice(0, 3000);
  // A page has the book's ISBN once; «ISBN 978-…» near the word, else the structured data's.
  const isbn = [prod?.isbn, prod?.gtin13, prod?.gtin, offer?.gtin13, (html.match(/itemprop="isbn"[^>]*>(?:\s*<[^>]+>)*\s*(97[89][\d\- ]{9,16}\d)/i) || [])[1], (text.match(/ISBN[^0-9]{0,60}(97[89][\d\- ]{9,16}\d)/i) || [])[1], (html.match(/"(?:isbn|gtin13)"\s*:\s*"(97[89][\d-]{10,14})"/) || [])[1]]
    .map(isbnOf)
    .find((x) => /^97[89]\d{10}$/.test(x)) || "";
  const price =
    num(offer.price || offer.lowPrice) ||
    num((html.match(/property="(?:product:price:amount|og:price:amount)"\s+content="([\d.,\s]+)"/) || [])[1]) ||
    num((html.match(/itemprop="price"[^>]*content="([\d.,]+)"/) || [])[1]) ||
    num((html.match(/id="product-price"[^>]*value="([\d.,]+)"|value="([\d.,]+)"[^>]*id="product-price"/) || []).slice(1).find(Boolean)) ||
    num((main.match(/woocommerce-Price-amount[^>]*>(?:\s*<[^>]+>)*\s*([\d\s]+(?:[.,]\d{1,2})?)/) || [])[1]) ||
    num((mainText.match(/(\d[\d ]{0,6}(?:[.,]\d{2})?)\s*(?:₴|грн)/) || [])[1]);
  let status = STATUS(offer.availability || "") || STATUS((main.match(/itemprop="availability"[^>]*(?:href|content)="([^"]+)"/) || [])[1] || "");
  if (!status) status = /немає в наявності|нема в наявності|розпродано|закінчився|out of stock/i.test(mainText) ? "немає" : /передзамовлення|предзамовлення/i.test(mainText) ? "передзамовлення" : price ? "є" : "";
  const title = ent(String(prod?.name || (main.match(/^<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/) || [])[1] || "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
  const format = /(^|[-/])e-?book|електронн/i.test(url + " " + title) ? "e-book" : "папір";
  return { isbn, price: Math.round(price), status, format, title };
}

// Every address of a sitemap and its children (gzip too), at most 200 files; `maps` = which child sitemaps to read.
async function sitemapUrls(base, get, maps0 = null) {
  const robots = await get(`${base}/robots.txt`).catch(() => "");
  const maps = [...String(robots).matchAll(/^sitemap:\s*(\S+)/gim)].map((m) => m[1].trim());
  if (!maps.length) maps.push(`${base}/sitemap.xml`);
  const out = new Set();
  const seen = new Set();
  while (maps.length && seen.size < 200) {
    const m = maps.shift();
    if (seen.has(m)) continue;
    seen.add(m);
    const xml = await get(m).catch(() => "");
    const locs = [...String(xml).matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)/g)].map((x) => ent(x[1]).trim());
    if (/<sitemapindex/i.test(xml)) maps.push(...locs.filter((l) => !maps0 || maps0.test(l)));
    else for (const l of locs) out.add(l);
  }
  return [...out];
}

class PubShops {
  constructor({ store, fetchImpl = fetch, log = () => {}, shops = SHOPS, pause = PAUSE }) {
    Object.assign(this, { store, fetchImpl, log, db: store.db, shops, pause });
    this.db.exec("CREATE TABLE IF NOT EXISTS pub_pages (shop TEXT NOT NULL, url TEXT NOT NULL, isbn TEXT NOT NULL DEFAULT '', price INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT '', format TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', checked INTEGER NOT NULL DEFAULT 0, pri INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (shop, url))");
    this.running = false;
    this.cache = null;
  }

  async get(url) {
    const r = await this.fetchImpl(url, { headers: { "User-Agent": UA, "Accept-Language": "uk" }, redirect: "follow", signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
    let buf = Buffer.from(await r.arrayBuffer());
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
    return buf.toString("utf8");
  }

  // The publisher's own books: ISBN -> our work id, and words of their titles (to read likely pages first).
  own(shop) {
    const isbns = new Map();
    const words = new Set();
    for (const id of shop.shelves) {
      for (const it of this.store.shelf(id)?.items || []) {
        const i = isbnOf(it.isbn);
        if (i.length >= 10) isbns.set(i, this.store.canonical(it.id));
        for (const w of slugify(it.title || "").split("-")) if (w.length >= 5) words.add(w);
      }
    }
    return { isbns, words };
  }

  // The shop's book pages from its sitemap, once a day: new ones added, gone ones dropped.
  async list(shop, words) {
    const key = `pubshops:listed:${shop.id}`;
    if (Number(this.db.get(key) || 0) > Date.now() - DAY) return;
    const urls = (await sitemapUrls(shop.base, (u) => this.get(u), shop.maps)).filter((u) => shop.page.test(u));
    if (!urls.length) throw new Error(`${shop.id}: no book pages in the sitemap`);
    const db = this.db;
    const had = new Set(db.prepare("SELECT url FROM pub_pages WHERE shop = ?").all(shop.id).map((r) => r.url));
    const now = new Set(urls);
    // Words of our titles in the address: such a page is read first.
    const pri = (u) => decodeURIComponent(u).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => words.has(w)).length;
    db.tx(() => {
      const add = db.prepare("INSERT OR IGNORE INTO pub_pages (shop, url, pri) VALUES (?, ?, ?)");
      for (const u of urls) if (!had.has(u)) add.run(shop.id, u, pri(u));
      const del = db.prepare("DELETE FROM pub_pages WHERE shop = ? AND url = ?");
      // A sitemap read only in part (a child file failed) drops nothing.
      if (now.size >= had.size / 2) for (const u of had) if (!now.has(u)) del.run(shop.id, u);
    });
    db.set(key, String(Date.now()));
  }

  // One shop's run, in this order: unread pages whose address has words of our titles; other unread pages (all of a
  // small shop, 150 a run of a big one: Наш Формат lists 44 thousand, BookChef 15 thousand, mostly other publishers');
  // pages of our books read over a day ago (price, stock: a sale shows the next day); any other page over 60 days ago,
  // 100 a run.
  async readShop(shop, until) {
    const { isbns, words } = this.own(shop);
    const db = this.db;
    // A sitemap that fails today (Ранок's answered 404 on 2026-11-26) leaves the pages we know being read.
    await this.list(shop, words).catch((e) => {
      if (!db.prepare("SELECT 1 FROM pub_pages WHERE shop = ? LIMIT 1").get(shop.id)) throw e;
      this.log(`pubshops: ${shop.id} sitemap: ${e.message}; reading the pages we have`);
    });
    const all = db.prepare("SELECT COUNT(*) n FROM pub_pages WHERE shop = ?").get(shop.id).n;
    const q = (where, limit, ...args) => db.prepare(`SELECT url, isbn FROM pub_pages WHERE shop = ? AND ${where} ORDER BY pri DESC, checked LIMIT ${limit}`).all(shop.id, ...args);
    // All of them: a big shop has more pages of others' books with an ISBN than the limits above.
    const old = q("checked > 0 AND checked < ? AND isbn != ''", 100000, Date.now() - DAY);
    const due = [
      ...q("checked = 0 AND pri > 0", 5000),
      ...q("checked = 0 AND pri = 0", all <= 3000 ? 3000 : 150),
      ...old.filter((r) => isbns.has(r.isbn)),
      ...q("checked > 0 AND checked < ? ", 5000, Date.now() - 60 * DAY).filter((r) => !isbns.has(r.isbn)).slice(0, 100),
    ];
    const save = db.prepare("UPDATE pub_pages SET isbn = ?, price = ?, status = ?, format = ?, title = ?, checked = ? WHERE shop = ? AND url = ?");
    let n = 0;
    let fails = 0;
    for (const r of due) {
      if (Date.now() > until) break;
      try {
        const p = parsePage(await this.get(r.url), r.url);
        save.run(p.isbn, p.price, p.status, p.format, p.title.slice(0, 200), Date.now(), shop.id, r.url);
        fails = 0;
      } catch (e) {
        // A page gone (404) is no book until the next 60-day look; a shop that keeps failing is left for this run.
        if (e.status === 404 || e.status === 410) save.run("", 0, "", "", "", Date.now(), shop.id, r.url);
        if (++fails >= 10) throw new Error(`${shop.id}: ${e.message} ×10`);
      }
      n++;
      await new Promise((ok) => setTimeout(ok, this.pause));
    }
    return n;
  }

  // The links for the site: our books the publisher sells on its own site.
  build() {
    const links = {};
    let n = 0;
    for (const shop of this.shops) {
      const { isbns } = this.own(shop);
      for (const r of this.db.prepare("SELECT url, isbn, price, status, format FROM pub_pages WHERE shop = ? AND isbn != ''").all(shop.id)) {
        const id = isbns.get(r.isbn);
        if (!id || !r.status) continue;
        const list = (links[id] ||= []);
        if (list.some((x) => x[1] === r.url)) continue;
        list.push([shop.id, r.url, r.price, r.status, r.format]);
        n++;
      }
    }
    this.db.set("pubshops:links", JSON.stringify({ at: Date.now(), books: Object.keys(links).length, links }));
    this.cache = null;
    return n;
  }

  async run({ ms = RUN_MS } = {}) {
    if (this.running) return null;
    this.running = true;
    try {
      const until = Date.now() + ms;
      const read = {};
      const errors = [];
      // Rows from pages read before a restart cut a run short, and every 5 minutes while it goes on: a deploy
      // restarts the jobs process, and a run that only built at its end left the rows empty for hours.
      this.build();
      const tick = setInterval(() => {
        try { this.build(); } catch (e) { this.log(`pubshops: build: ${e.message}`); }
      }, 5 * 60 * 1000);
      // The shops side by side, each at its own pace.
      await Promise.all(
        this.shops.map((s) =>
          this.readShop(s, until)
            .then((n) => (read[s.id] = n))
            .catch((e) => errors.push(`${s.id}: ${e.message}`))
        )
      ).finally(() => clearInterval(tick));
      const n = this.build();
      this.db.set("pubshops:last", JSON.stringify({ at: new Date().toISOString(), read, errors }));
      this.log(`pubshops: ${n} rows for ${JSON.parse(this.db.get("pubshops:links")).books} books; read ${Object.entries(read).map(([k, v]) => `${k} ${v}`).join(", ")}${errors.length ? `; failed: ${errors.join("; ")}` : ""}`);
      return n;
    } finally {
      this.running = false;
    }
  }

  // The rows for a book: [{ id, shelf, links, format, price, status, edition, own }].
  rowsFor(book) {
    if (!book) return [];
    if (!this.cache || Date.now() - this.cache.at > 10 * 60 * 1000) this.cache = { at: Date.now(), links: JSON.parse(this.db.get("pubshops:links") || "null")?.links || {} };
    const list = this.cache.links[this.store.canonical(book.id)] || this.cache.links[book.id] || [];
    return list.map(([sid, url, price, status, format]) => {
      const shop = this.shops.find((s) => s.id === sid);
      return { id: `pub-${sid}-${url}`, shelf: { id: `pub-${sid}`, name: shop?.name || sid, kind: "publisher" }, links: [{ label: shop?.name || sid, url }], format, price: price ? `${price} ₴` : "", status, own: true };
    });
  }

  // The book with its publisher's rows in `shops` (after megogo.withShop).
  withOwn(book) {
    const rows = this.rowsFor(book);
    if (!rows.length) return book;
    return { ...book, shops: [...rows, ...(book.shops || book.editions || [])] };
  }

  // For /agent: per shop pages known, read, with an ISBN, ours.
  status() {
    return this.shops.map((s) => {
      const { isbns } = this.own(s);
      const rows = this.db.prepare("SELECT isbn, checked FROM pub_pages WHERE shop = ?").all(s.id);
      return { id: s.id, pages: rows.length, read: rows.filter((r) => r.checked).length, isbn: rows.filter((r) => r.isbn).length, ours: rows.filter((r) => isbns.has(r.isbn)).length, shelf: isbns.size };
    });
  }
}

module.exports = { PubShops, SHOPS, parsePage, sitemapUrls };

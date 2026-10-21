// The public catalogs behind the Discovery shelves: how each source is fetched from its public API,
// how its products become shelf items, and the daily refresh that keeps the shelves (in the database,
// see db.js) current.
//
// Lobster and Видавництво run WooCommerce, whose Store API is public JSON:
//   https://<site>/wp-json/wc/store/v1/products?per_page=100&page=N
// A site without an API can be read the way search engines read it (sitemapProducts below): the product
// URLs from its sitemap, then each book's page, a new URL right away and the rest once a week. Only for
// sites that allow it: Віхола (tried 2026-10-19) answers robots with a JavaScript challenge and HTTP 429,
// so it is not a source; we do not get around bot checks.
// Старий Лев's site reads its catalog from its own public JSON API (28 products a page, Laravel paging):
//   https://api-k8s.starylev.com.ua/api/v1.1/products?page=N
// The raw products are normalised to a small shape (kept in web/catalogs/*.json for the seed), then
// turned into shelf items by toItem(). Max (2026-10-19):
// use feeds where a source has them, scrape where it does not; the shelves must refresh daily.

const uah = (n) => (n ? `${Math.round(n)} ₴` : "");
// WooCommerce leaves HTML entities in names («Ми &#8211; Легіон»), MEGOGO Books hex ones («П&#x27;ятий ризик»).
// Pages built on the Лабораторія/Наш Формат engine encode them twice («&amp;laquo;»).
const NAMED = { nbsp: " ", ndash: "–", mdash: "—", laquo: "«", raquo: "»", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", hellip: "…", quot: '"', apos: "'", amp: "&" };
const ent1 = (s) => s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&([a-z]+);/g, (m, n) => NAMED[n] ?? m);
const ent = (s) => ent1(ent1(String(s || "")));
const text = (h) => ent(String(h || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&#8217;|&rsquo;/g, "’")).replace(/\s+/g, " ").trim();
// A book's description for its page (Max, 2026-10-20: «Про книжку» showed shop copy cut mid-word).
// Shops wrap the publisher's annotation in their own copy: MEGOGO Books writes a promo paragraph,
// «Купуй … на MEGOGO BOOKS», then «Про що книжка?», «Чому варто прочитати», «Для кого». So: when there
// is a «Про що» heading only its section is kept; otherwise the text before the first heading. Lists and
// buy calls go, paragraphs stay, and it ends on a whole sentence within `max` characters.
// Takes the shop's HTML or a description kept by an older refresh (plain text, maybe cut at 600).
const BUY = /(^|[\s«"(])(купу[йв]\p{L}*|купити|придба[йт]\p{L}*|замовля[йт]\p{L}*|замовте|обирай\p{L}*)(?=[\s,.!:]|$)|megogo|mbooks|у нашому (магазині|інтернет)|на нашому сайті/iu;
const ABOUT_HEAD = /^про що (ця |цей |це )?(книжк|книг|роман|історі|збірк|видання|комікс|аудіокниг)/i;
const sentences = (p) => p.split(/(?<=[.!?…»"])(?<!(?:^|\s)\p{Lu}\.)\s+(?=[«"„(—–\-\p{Lu}\d])/u);
const whole = (s) => /[.!?…»")]$/.test(s);
function about(h, max = 1000) {
  const raw = String(h || "");
  const lines = ent(
    raw
      .replace(/<h\d[^>]*>([\s\S]*?)<\/h\d>/gi, "\n\u0001$1\n")
      .replace(/<li[^>]*>/gi, "\n\u0002")
      .replace(/<\/(p|div|li|ul|ol|blockquote)>|<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .split(/\n/)
    .map((l) => l.replace(/[ \t \r]+/g, " ").trim())
    .filter((l) => l && l !== "\u0001" && l !== "\u0002");
  const head = lines.findIndex((l) => l[0] === "\u0001" && ABOUT_HEAD.test(l.slice(1).trim()) && lines[lines.indexOf(l) + 1]?.[0] !== "\u0001");
  let body = head >= 0 ? lines.slice(head + 1) : lines;
  const end = body.findIndex((l) => l[0] === "\u0001");
  if (end >= 0 && (end > 0 || head >= 0)) body = body.slice(0, end);
  else body = body.filter((l) => l[0] !== "\u0001");
  const cutOff = !/<\/?[a-z]/i.test(raw) && raw.length >= 595 && !whole(raw.trim()); // an older refresh's text cut at 600
  const paras = body
    .filter((l) => l[0] !== "\u0002")
    .map((l, i, all) => {
      let s = sentences(l).filter((s) => !BUY.test(s) && !ABOUT_HEAD.test(s) && !/^(чому варто|для кого)(?=\s).*\?$/i.test(s));
      if (cutOff && i === all.length - 1 && s.length > 1 && !whole(s[s.length - 1])) s = s.slice(0, -1);
      return s;
    })
    .filter((s) => s.length);
  const out = [];
  let len = 0;
  for (const p of paras) {
    const keep = [];
    for (const s of p) {
      if (len + s.length + 1 > max) break;
      keep.push(s), (len += s.length + 1);
    }
    if (keep.length) out.push(keep.join(" "));
    if (keep.length < p.length) break;
  }
  if (!out.length && paras.length) {
    const s = paras[0].join(" ");
    return s.length <= max ? s : `${s.slice(0, s.lastIndexOf(" ", max - 1))}…`;
  }
  const res = out.join("\n\n");
  return cutOff && !whole(res) ? `${res}…` : res;
}

const attr = (p, n) => ((p.attributes || []).find((a) => a.name === n) || { terms: [] }).terms.map((t) => t.name).join(", ") || "";

// «Коли завмирає серце, том шостий», «Серпанка. Том 2. Ліс зниклих духів», «Світ Едени, книга перша»:
// the series name and the volume number, so a shelf can fold the volumes into one card.
const ORD = { перший: 1, перша: 1, другий: 2, друга: 2, третій: 3, третя: 3, четвертий: 4, четверта: 4, "п’ятий": 5, "п'ятий": 5, "п’ята": 5, шостий: 6, шоста: 6, сьомий: 7, сьома: 7, восьмий: 8, восьма: 8, "дев’ятий": 9, десятий: 10 };
function volumeOf(title) {
  const m = title.match(/^(.+?)[,.]?\s+(?:(?:том|книга|частина)\s+|кн\.\s*)(\d+|[\p{L}’']+)(?=[.:\s]|$)[.:]?\s*(.*)$/iu); // «Експансія. Кн.6. У попелі Вавилону»
  if (!m) return null;
  const n = /^\d+$/.test(m[2]) ? Number(m[2]) : ORD[m[2].toLowerCase()];
  return n ? { series: m[1].trim(), volume: n, subtitle: m[3].trim() } : null;
}

// The common part of a WooCommerce product.
const woo = (p) => ({
  id: p.id,
  categories: (p.categories || []).map((c) => c.name),
  tags: (p.tags || []).map((t) => t.name),
  price: Number(p.prices?.price || 0) / 100,
  regularPrice: Number(p.prices?.regular_price || 0) / 100,
  inStock: !!p.is_in_stock,
  purchasable: !!p.is_purchasable,
  url: p.permalink,
  image: (p.images?.[0] || {}).src || "",
  blurb: about(p.short_description),
});

// Старий Лев: statuses come as labels. E-books are separate products with the same
// title, sometimes without the subtitle or the authors; joinEbooks() gives them the paper book's title
// and author so they become its editions.
const SL_STATUS = (labels) => (labels.includes("pre_sale") ? "передзамовлення" : labels.includes("available") ? "є" : labels.includes("expected") ? "очікується" : "немає");
function joinEbooks(items) {
  const paper = items.filter((it) => it.format === "папір");
  for (const e of items.filter((it) => it.format === "e-book")) {
    const t = e.title.toLowerCase();
    const p = paper.find((p) => (p.title.toLowerCase() === t || p.title.toLowerCase().startsWith(`${t}.`)) && (!e.author || p.author === e.author));
    if (p) (e.title = p.title), (e.author ||= p.author), (e.altTitle ||= p.altTitle);
  }
  return items;
}

// ---- sitemap + product pages ----
const HEADERS = { "User-Agent": "Mozilla/5.0 (Chytai catalog refresh; chytai.org.ua)" };
const meta = (html, prop) => ent((html.match(new RegExp(`<meta[^>]+property=["']${prop.replace(/[.:]/g, "\\$&")}["'][^>]*content=["']([^"']*)`, "i")) || [])[1] || "");
const h1 = (html) => text((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || "");
const dayOfWeek = () => Math.floor(Date.now() / 86400000) % 7;
const bucket = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 7919, 0) % 7;

async function sitemapProducts(src, opts) {
  const { fetchImpl = fetch } = opts;
  const res = await fetchImpl(src.sitemap, { headers: HEADERS, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`${src.id}: HTTP ${res.status} on the sitemap`);
  const urls = [...(await res.text()).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, "&")).filter(src.isProduct || (() => true));
  if (!urls.length) throw new Error(`${src.id}: empty sitemap`);
  return pageProducts(src, urls, opts);
}

// The product URLs of a publisher's catalog pages (`src.listing(n)`, until a page is missing or adds
// nothing). Links found on most pages are the site's own banners, not the catalog, and are left out.
async function listingProducts(src, opts) {
  const { fetchImpl = fetch, log = () => {} } = opts;
  const found = new Map(); // url -> pages it was on
  let pages = 0;
  let idle = 0; // pages in a row that added nothing
  for (let n = 1; n <= (src.maxPages || 200); n++) {
    const res = await fetchImpl(src.listing(n), { headers: HEADERS, signal: AbortSignal.timeout(60000) }).catch((e) => {
      throw new Error(`${src.id}: ${e.cause?.code || e.message}`);
    });
    if (res.status === 404 && n > 1) break;
    if (!res.ok) throw new Error(`${src.id}: HTTP ${res.status} on catalog page ${n}`);
    const links = new Set([...(await res.text()).matchAll(src.linkRe || /href="\s*((?:https?:\/\/[^/"]+)?\/?products\/[^"\s]+)\s*"/g)].map((m) => new URL(m[1], src.listing(n)).href)); // relative to the shop, not the publisher
    const before = found.size;
    for (const u of links) found.set(u, (found.get(u) || 0) + 1);
    pages++;
    if (found.size === before && ++idle >= 2) break;
    if (found.size > before) idle = 0;
  }
  const urls = [...found].filter(([, k]) => pages < 4 || k < 3).map(([u]) => u);
  log(`${src.id}: ${pages} catalog pages, ${urls.length} products`);
  if (!urls.length) throw new Error(`${src.id}: empty catalog`);
  return pageProducts(src, urls, opts);
}

// Product pages fetched a few at a time: a new URL right away, the rest once a week (a seventh of the
// catalog a day); `previous` (url -> item from the last refresh) is reused for the rest. A page that is
// not a book of this publisher (parsePage gives null) is remembered in `skip` so it is not fetched daily.
async function pageProducts(src, urls, { fetchImpl = fetch, log = () => {}, previous = new Map(), skip = new Set(), checkpoint = () => {}, fresh = new Set() }) {
  const today = dayOfWeek();
  urls = urls.filter((u) => !skip.has(u) || bucket(u) === today);
  const due = urls.filter((u) => !previous.has(u) || (bucket(u) === today && !fresh.has(u)));
  const out = urls.filter((u) => !due.includes(u)).map((u) => previous.get(u)).filter(Boolean);
  const got = urls.filter((u) => fresh.has(u)).map((u) => previous.get(u)); // read this run or the cut-short one
  let failed = 0;
  let skipped = 0;
  // A shop that answers 429 (Абук did, 2026-10-20) is asked one page at a time with a pause (`src.pace`);
  // after a 429 we wait a minute and go on, and after three in a row the rest wait for the next refresh
  // while the books read so far are kept, so a first fill can grow over a few days instead of failing.
  const [batch, pause] = src.pace ? [1, src.pace] : [4, 0];
  let throttled = 0; // 429s in a row
  let gaveUp = false;
  const one = async (url) => {
    try {
      if (gaveUp) throw Object.assign(new Error("HTTP 429"), { later: true });
      let r = await fetchImpl(src.fetchUrl ? src.fetchUrl(url) : url, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
      while (r.status === 429 && src.pace && ++throttled < 3) {
        log(`${src.id}: HTTP 429, waiting a minute`);
        await new Promise((res) => setTimeout(res, 60000));
        r = await fetchImpl(src.fetchUrl ? src.fetchUrl(url) : url, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
      }
      if (r.status === 429) gaveUp = true;
      else throttled = 0;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const html = src.charset ? new TextDecoder(src.charset).decode(await r.arrayBuffer()) : await r.text(); // Богдан is windows-1251
      // A copy: V8 keeps a whole page alive for any substring cut from it, and a few hundred
      // MEGOGO Books pages filled the 256 MB machine (2026-10-19).
      const item = JSON.parse(JSON.stringify(src.parsePage(html, url)));
      if (item) out.push(item), got.push(item), skip.delete(url);
      else if ((skip.add(url), !skipped++)) log(`${src.id}: not a book page: ${url} ${html.replace(/\s+/g, " ").slice(0, 160)}`);
    } catch (e) {
      if (!failed && !e.later) log(`${src.id}: ${url}: ${e.cause?.code || e.message}`);
      failed++;
      if (previous.has(url)) out.push(previous.get(url));
    }
  };
  for (let i = 0; i < due.length; i += batch) {
    if (pause && !gaveUp) await new Promise((r) => setTimeout(r, pause));
    // A page that never answers (the refresh stood still on BookChef for an hour, 2026-10-20) fails after 90 s.
    await Promise.all(due.slice(i, i + batch).map((u) => Promise.race([one(u), new Promise((res) => setTimeout(res, 90000))])));
    if (i % 100 < batch && i) checkpoint(got), log(`${src.id}: ${i} of ${due.length} pages read`); // a restart half-way resumes from here
  }
  log(`${src.id}: ${urls.length} product pages, ${due.length} due${failed ? `, ${failed} failed` : ""}${gaveUp ? " (the shop kept answering 429; the rest next time)" : ""}${skipped ? `, ${skipped} not its books` : ""}, ${out.length} books`);
  if (!out.length || (!gaveUp && failed > due.length / 3 && failed > 10)) throw new Error(`${src.id}: ${failed} of ${due.length} pages failed`);
  return out;
}

// Лабораторія and Наш Формат run the same shop engine: every book page carries JSON-LD (a Product with
// the price and the publisher as `brand`, and a Book with authors, translators, ISBN, the original title).
// `brands` keeps only that publisher's books (the shops sell others' too).
const ldOf = (html) =>
  [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].flatMap((m) => {
    try {
      return [].concat(JSON.parse(m[1].replace(/[\u0000-\u001f]+/g, " "))); // raw line breaks inside descriptions
    } catch {
      return [];
    }
  });
// «Stolen Focus. Why You Can't Pay Attention by Johann Hari» -> the title only; none when it is the title.
const alt = (a, title) => ((a = a.replace(/\s+by\s+(\p{Lu}[\p{L}.'’-]*\s*)+$/u, "").trim()) === title ? "" : a);
const names = (v) => [].concat(v || []).map((x) => ent(x.name || x).trim()).filter(Boolean).join(", ");
function ldBookPage(src, brands) {
  return (html, url) => {
    const ld = ldOf(html);
    const book = ld.find((x) => [].concat(x["@type"]).includes("Book"));
    const prod = ld.find((x) => [].concat(x["@type"]).includes("Product")) || {};
    if (!book) return null;
    const brand = ent(prod.brand?.name || book.brand?.name || book.publisher?.name || "").trim();
    if (!brands.includes(brand)) return null;
    const title = ent(book.name || prod.name).trim();
    if (/сертифікат/i.test(title)) return null;
    const offers = prod.offers || book.offers || {};
    const avail = String(offers.availability || "");
    const fmt = String(book.bookFormat || "");
    return {
      id: `${src.id}-${url.replace(/\/$/, "").split("/").pop()}`,
      title,
      author: names(book.author),
      translator: names(book.translator),
      altTitle: alt(ent(book.alternateName || ""), title),
      isbn: String(book.isbn || prod.sku || "").replace(/[^\dX]/gi, ""),
      format: /EBook/i.test(fmt) ? "e-book" : /Audio/i.test(fmt) ? "аудіо" : "папір",
      series: volumeOf(title)?.series || "",
      volume: volumeOf(title)?.volume || 0,
      bundle: /^комплект/i.test(title),
      cover: String(prod.image || book.image || ""), // the Product's is the small one
      url,
      price: uah(Number(offers.price || offers.lowPrice)),
      status: /PreOrder/i.test(avail) ? "передзамовлення" : /InStock/i.test(avail) ? "є" : "немає",
      isNew: false,
      genres: String(ent(book.genre || "")).split(/,\s*/).filter(Boolean),
      blurb: about(prod.description || book.description),
      pages: String(book.numberOfPages || ""),
      year: String(book.datePublished || "").slice(0, 4),
      language: "українська",
    };
  };
}

// Основи and Комора run WooCommerce but keep the author and the ISBN only on the book's page: those are
// read from the page when a book is new and once a week after that, and kept from the last refresh otherwise.
function pageDetails(parse) {
  return async (products, { previous, fetchImpl = fetch, log = () => {}, id, keep = () => true }) => {
    const today = dayOfWeek();
    const due = [];
    for (const p of products.filter(keep)) {
      const old = previous.get(p.url);
      if (old && bucket(p.url) !== today) Object.assign(p, { author: old.author, isbn: old.isbn, translator: old.translator });
      else due.push(p);
    }
    let got = 0;
    for (let i = 0; i < due.length; i += 4)
      await Promise.all(
        due.slice(i, i + 4).map(async (p) => {
          try {
            const r = await fetchImpl(p.url, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
            if (!r.ok) return;
            Object.assign(p, parse(await r.text()));
            if (p.author) got++;
          } catch {
            /* next refresh tries again */
          }
        })
      );
    log(`${id}: ${due.length} book pages read, ${got} with an author`);
  };
}
const isbnIn = (s) => ((s || "").match(/97[89][\d\s\-–]{10,16}/) || [""])[0].replace(/\D/g, "");
// «ТІРЦА» -> «Тірца»: Комора writes titles in capitals.
const unshout = (s) => (s === s.toUpperCase() && /\p{Lu}{3}/u.test(s) ? s.charAt(0) + s.slice(1).toLowerCase() : s);
const wooBook = (src, p, extra = {}) => ({
  id: `${src.id}-${p.id}`,
  title: p.title,
  author: p.author || "",
  translator: p.translator || "",
  isbn: p.isbn || "",
  series: volumeOf(p.title)?.series || "",
  volume: volumeOf(p.title)?.volume || 0,
  bundle: /^комплект/i.test(p.title),
  cover: p.image,
  url: p.url,
  price: uah(p.price),
  status: !p.inStock ? "немає" : /передзамовлення/i.test(p.title + p.categories.join()) ? "передзамовлення" : "є",
  isNew: false,
  genres: p.categories.filter((c) => !/передзамовлення|розпродаж|акції|новинки|без категорії|комплекти|серії/i.test(c)),
  blurb: about(p.blurb || p.desc),
  language: "українська",
  ...extra,
});

// MEGOGO Books (mbooks.com.ua) sells many publishers' books, each with a page per format: JSON-LD
// Product (ISBN as gtin, price, availability, publisher as brand), the format at the start of <title>
// («Книга», «Електронна книга», «Аудіокнига»), the authors linked to /authors/ above the <h1>, and the
// original title in the line under it. Publishers whose own sites give no data come from here
// (Max, 2026-10-19, starting with Stone Publishing).
// A book not on sale has no Product: then the publisher is the /publishers/ link on the page, the
// ISBN is in the <title>, and the book counts as out of stock.
function mbooksPage(src, brand, slug) {
  return (html, url) => {
    let prod = ldOf(html).find((x) => [].concat(x["@type"]).includes("Product"));
    if (!prod && html.includes(`href="/publishers/${slug}/"`)) {
      const head = (html.match(/<title>([^<]*)/) || [])[1] || "";
      prod = { name: h1(html), brand: { name: brand }, gtin: (head.match(/ISBN ([\d\-X]+)/) || [])[1] || "", image: meta(html, "og:image"), offers: {} };
    }
    if (!prod || ent(prod.brand?.name || "").trim().toLowerCase() !== brand.toLowerCase()) return null;
    const head = (html.match(/<title>([^<]*)/) || [])[1] || "";
    const top = html.slice(0, html.indexOf('data-cy="book-title"'));
    const authors = [...top.matchAll(/href="\/authors\/[^"]+"[^>]*>([^<]+)</g)].map((m) => ent(m[1]).trim());
    const title = ent(prod.name || h1(html)).trim();
    const orig = text((html.match(/data-cy="book-title"[^>]*>[\s\S]*?<\/h1>\s*<p[^>]*>([\s\S]*?)<\/p>/) || [])[1] || "");
    const offers = prod.offers || {};
    const avail = String(offers.availability || "");
    return {
      id: `${src.id}-${(url.match(/\/book\/(\d+)/) || [])[1] || url}`,
      title,
      author: [...new Set(authors)].join(", "),
      altTitle: orig && orig !== title && !/^\d/.test(orig) ? orig : "",
      isbn: String(prod.gtin || "").replace(/[^\dX]/gi, ""),
      format: /^\s*Електронна/i.test(head) ? "e-book" : /^\s*Аудіо/i.test(head) ? "аудіо" : "папір",
      series: volumeOf(title)?.series || "",
      volume: volumeOf(title)?.volume || 0,
      bundle: /^комплект/i.test(title),
      cover: [].concat(prod.image || [])[0] || "",
      url,
      price: uah(Number(offers.price || offers.lowPrice)),
      status: /PreOrder/i.test(avail) ? "передзамовлення" : /InStock/i.test(avail) ? "є" : "немає",
      isNew: false,
      genres: [],
      blurb: about(prod.description),
      language: "українська",
    };
  };
}
const mbooks = ({ id, slug, brand, name, tagline, url, draft = true }) => ({
  id,
  kind: "publisher",
  name,
  tagline: `${tagline}. Книжки з MEGOGO Books`,
  url,
  draft,
  listing: (n) => `https://mbooks.com.ua/publishers/${slug}/${n > 1 ? `page-${n}/` : ""}`,
  linkRe: /href="\s*((?:https:\/\/mbooks\.com\.ua)?\/book\/\d+[^"\s]*)\s*"/g,
  fetchAll: (src, opts) => listingProducts(src, opts),
  parsePage: (html, u) => mbooksPage(SOURCES.find((s) => s.id === id), brand, slug)(html, u),
  normalize: (p) => p,
  keep: () => true,
  toItem: (p) => p,
  finish: joinEbooks,
});

// Навчальна книга – Богдан (bohdan-books.com, Тернопіль; Max 2026-10-20, for «Експансія» and the rest of
// its fantasy) runs Bitrix in windows-1251. Its sitemap lists all 6 thousand products, most of them school
// workbooks: only the fiction, children's and non-fiction sections (the first breadcrumb) are kept, and a
// page with no breadcrumb unless its title looks like schoolwork. The page's JSON-LD Product is often
// empty, so the name and price come from the product block's data attributes (an e-book's name starts with «eBook»), the ISBN from its
// characteristics, the authors (written «Желязни Роджер») from the author links.
const BOHDAN_SECTIONS = ["ХУДОЖНЯ ЛІТЕРАТУРА", "ДИТЯЧА ЛІТЕРАТУРА", "НЕХУДОЖНЯ ЛІТЕРАТУРА"];
const SCHOOLWORK = /клас|зошит|НУШ|ЗНО|НМТ|ДПА|підручник|посібник|хрестоматі|тренажер|атестаці|диктант|прописи|грамот|диплом|тест/i;
const initial = (w) => /^\p{Lu}\.$/u.test(w);
function bohdanPage(html, url) {
  const crumbs = [...((html.match(/table_breadcrumb[\s\S]*?<\/div>/) || [""])[0]).matchAll(/title="([^"]*)"/g)].map((m) => ent(m[1])).slice(2);
  const wrap = (html.match(/<div class="detail-page-wrap"[^>]*>/) || [""])[0]; // the page's book, not the ones in the sidebar
  const name = ent((wrap.match(/data-product-name="([^"]*)"/) || [])[1] || "").trim();
  if (!name) return null;
  if (crumbs.length ? !BOHDAN_SECTIONS.includes(crumbs[0]) : SCHOOLWORK.test(name)) return null;
  const ebook = /^eBook\s+/i.test(name);
  const title = name.replace(/^eBook\s+/i, "").replace(/\s+:\s+[\p{Ll}\s.,-]+$/u, "").trim(); // «Снотворець : роман»
  const prod = ldOf(html).find((x) => [].concat(x["@type"]).includes("Product")) || {};
  const spec = (k) => text((html.match(new RegExp(`<b class="koala_title">${k}:?</b>([\\s\\S]*?)<br`)) || [])[1] || "");
  const author = [...html.matchAll(/product-author-link[^>]*>([\s\S]*?)<\/a>/g)]
    .map((m) => text(m[1]).split(" "))
    .map((w) => (w.length > 1 && !w.some(initial) ? [...w.slice(1), w[0]] : w).join(" ")) // «Джеймс С. А. Корі» stays
    .filter((a, i, all) => a && all.indexOf(a) === i)
    .join(", ");
  const isbn = spec("ISBN").replace(/[^\dX]/gi, "");
  if (!/^97[89]/.test(isbn)) return null; // stationery and crafts kits have shop barcodes
  const avail = String(prod.offers?.availability || "");
  return {
    id: `bohdan-${(url.match(/\/book\/(\d+)/) || [])[1]}`,
    title,
    author,
    translator: "",
    isbn,
    format: ebook ? "e-book" : "папір",
    series: volumeOf(title)?.series || "",
    volume: volumeOf(title)?.volume || 0,
    bundle: /^комплект/i.test(title),
    cover: String(prod.image || meta(html, "og:image")),
    url,
    price: uah(Number((wrap.match(/data-price="([\d.]+)"/) || [])[1])),
    status: /InStock/i.test(avail) ? "є" : /PreOrder/i.test(avail) ? "передзамовлення" : avail ? "немає" : /Немає в наявності/i.test(html) ? "немає" : "є",
    isNew: false,
    genres: crumbs.slice(1, 2),
    blurb: about(prod.description || meta(html, "og:description")),
    pages: spec("Кількість сторінок"),
    year: "",
    language: "українська",
    parser: 2,
  };
}
// Items read before 2026-10-20 evening turned «Джеймс С. А. Корі» into «С. А. Корі Джеймс»: put the name back.
function bohdanFinish(items) {
  for (const it of items)
    if (it.parser !== 2) {
      const w = it.author.split(" ");
      if (w.some(initial) && !it.author.includes(",")) it.author = [w.at(-1), ...w.slice(0, -1)].join(" ");
      it.parser = 2;
    }
  return joinEbooks(items);
}

// Абук (abuk.com.ua), the Ukrainian audiobook shop (Max, 2026-10-20: a shelf of its own and a line in
// «Де взяти»). Its site reads each book from a public JSON API, /api/web/books/<id>/ (a few KB: authors,
// narrators, duration in seconds, price, publisher); the book ids come from its sitemap. The whole catalog
// is also one call (/api/web/books), but that is 20 MB, too much for our machine. Only the page link and
// the description are kept: the API also names the audio files, which are not ours to touch.
const abukDuration = (s) => {
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return s ? [h ? `${h} год` : "", m ? `${m} хв` : ""].filter(Boolean).join(" ") : "";
};
function abukBook(json, url) {
  const b = JSON.parse(json).book;
  if (!b || !b.published || !b.title) return null;
  const title = String(b.title).trim();
  return {
    id: `abuk-${b.id}`,
    title,
    author: names(b.authors),
    narrator: names(b.narrators),
    duration: abukDuration(Number(b.duration) || 0),
    subscription: b.subscription_type === "subscription_and_paid",
    isbn: "",
    format: "аудіо",
    series: volumeOf(title)?.series || "",
    volume: volumeOf(title)?.volume || 0,
    bundle: false,
    cover: b.picture_urls?.main || b.picture_urls?.small || "",
    url,
    price: Number(b.price_uah) ? uah(Number(b.price_uah)) : "безкоштовно",
    status: "є",
    isNew: false,
    genres: (b.genre || []).map((g) => String(g.name || "").trim()).filter((g) => g && !/абук/i.test(g)),
    blurb: about(b.description),
    year: String(b.year || ""),
    language: "українська",
  };
}

const SOURCES = [
  {
    id: "lobster",
    kind: "publisher",
    name: "Lobster",
    tagline: "Незалежне видавництво: фантастика та історичний нонфікшн",
    url: "https://www.lobster.net.ua/",
    api: "https://www.lobster.net.ua/wp-json/wc/store/v1/products",
    normalize: (p) => ({ ...woo(p), title: text(p.name), author: attr(p, "Автор"), originalTitle: attr(p, "Оригінальна назва"), translator: attr(p, "Перекладач"), series: attr(p, "Серія"), year: attr(p, "Рік видання"), pages: attr(p, "Кількість сторінок"), isbn: attr(p, "ISBN") }),
    keep: () => true,
    // An announced book (tag «Анонси») says when to expect it only on its page: «Орієнтовно: Грудень 2026»
    // (Max, 2026-10-20). There are few of them, so their pages are read on every refresh.
    enrich: async (products, { previous, fetchImpl = fetch, log = () => {} }) => {
      const due = products.filter((p) => p.tags.includes("Анонси") && !p.inStock);
      for (const p of due) {
        try {
          const r = await fetchImpl(p.url, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
          const m = r.ok && (await r.text()).match(/lbc-announcement-date[^>]*>\s*(?:Орієнтовно:\s*)?([^<]+?)\s*</);
          p.expected = m ? JSON.parse(JSON.stringify(ent(m[1]))) : previous.get(p.url)?.expected || ""; // a copy, not a slice that keeps the page alive
        } catch {
          p.expected = previous.get(p.url)?.expected || "";
        }
      }
      log(`lobster: ${due.length} announced, ${due.filter((p) => p.expected).length} with a date`);
    },
    toItem: (p) => ({
      id: `lobster-${p.id}`,
      title: ent(p.title),
      author: ent(p.author),
      altTitle: ent(p.originalTitle),
      translator: p.translator,
      isbn: p.isbn || "",
      series: p.series || "",
      bundle: /комплект/i.test(p.title),
      cover: p.image,
      url: p.url,
      price: uah(p.price),
      status: p.tags.includes("Анонси") && !p.inStock ? "анонс" : !p.inStock ? "немає" : p.tags.includes("Передзамовлення") || p.categories.includes("Передзамовлення") ? "передзамовлення" : "є",
      expected: p.expected || "",
      isNew: p.tags.includes("Новинки"),
      genres: p.categories.filter((c) => c !== "Lobster"),
      blurb: ent(p.blurb),
      pages: p.pages,
      year: p.year,
      language: "українська",
    }),
  },
  {
    id: "starylev",
    kind: "publisher",
    name: "Старий Лев",
    tagline: "Львівське видавництво і його книгарня: свої книжки, e-book і книжки партнерів",
    url: "https://starylev.com.ua/",
    api: "https://api-k8s.starylev.com.ua/api/v1.1/products",
    page: (n) => `https://api-k8s.starylev.com.ua/api/v1.1/products?page=${n}`,
    list: (json) => ({ items: json.data, more: json.meta && json.meta.current_page < json.meta.last_page }),
    maxPages: 400,
    normalize: (p) => ({
      id: p.id,
      name: p.name,
      slug: p.slug,
      type: p.type,
      price: p.price,
      isbn: p.isbn || "",
      publisher: p.edition_name || "",
      authors: (p.authors || []).filter((a) => a.types.some((t) => t.label === "author")).map((a) => a.name),
      translators: (p.authors || []).filter((a) => a.types.some((t) => t.label === "translator")).map((a) => a.name),
      statuses: (p.statuses || []).map((s) => s.label),
      image: p.image?.url || "",
      genres: (p.sub_categories || []).map((c) => c.name),
      blurb: about(p.description),
    }),
    keep: (p) => p.type === "book" || p.type === "ebook",
    toItem: (p) => ({
      id: `starylev-${p.id}`,
      title: ent(p.name).trim(),
      author: p.authors.join(", "),
      translator: p.translators.join(", "),
      isbn: p.isbn,
      edition: p.publisher && p.publisher !== "Видавництво Старого Лева" ? p.publisher : "", // the format is its own field
      format: p.type === "ebook" ? "e-book" : "папір",
      series: volumeOf(ent(p.name))?.series || "",
      volume: volumeOf(ent(p.name))?.volume || 0,
      bundle: /^комплект/i.test(p.name),
      cover: p.image ? `https://img.imageboss.me/sl/width/400/format:webp/${p.image}` : "",
      url: `https://starylev.com.ua/${p.slug}`,
      price: uah(p.price),
      status: p.type === "ebook" ? "є" : SL_STATUS(p.statuses),
      isNew: p.statuses.includes("new"),
      genres: p.genres,
      blurb: p.blurb,
      language: "українська",
    }),
    finish: joinEbooks,
    // The list has no descriptions; each book's own record does (/products/<slug>). Descriptions are
    // kept from the last refresh, and up to 1200 missing ones are fetched per refresh.
    enrich: async (products, { previous, fetchImpl = fetch, log = () => {} }) => {
      const missing = [];
      for (const p of products) {
        const old = previous.get(`https://starylev.com.ua/${p.slug}`);
        if (old?.blurb) p.blurb = ent(old.blurb); // older refreshes kept entities like &ndash;
        else if (p.type === "book" || p.type === "ebook") missing.push(p);
      }
      let got = 0;
      const todo = missing.slice(0, 1200);
      for (let i = 0; i < todo.length; i += 4)
        await Promise.all(
          todo.slice(i, i + 4).map(async (p) => {
            try {
              const r = await fetchImpl(`https://api-k8s.starylev.com.ua/api/v1.1/products/${encodeURIComponent(p.slug)}`, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
              if (!r.ok) return;
              const j = await r.json();
              p.blurb = about((j.data || j).description);
              if (p.blurb) got++;
            } catch {
              /* next refresh tries again */
            }
          })
        );
      log(`starylev: ${got} descriptions fetched, ${missing.length - got} still missing`);
    },
  },
  {
    // Product names look like «Author, «Title» (note)»; merch and returns are left out.
    id: "vydavnytstvo",
    kind: "publisher",
    name: "Видавництво",
    tagline: "Київське видавництво: комікси, фентезі, квірліт і нонфікшн",
    url: "https://vydavnytstvo.com/",
    api: "https://vydavnytstvo.com/wp-json/wc/store/v1/products",
    normalize: (p) => ({ ...woo(p), name: text(p.name), attrs: Object.fromEntries((p.attributes || []).map((a) => [a.name, a.terms.map((t) => t.name).join(", ")])), desc: about(p.description), type: p.type }),
    keep: (p) => !["Сувеніри", "Повернення з крамниць", "Гаражний розпродаж"].some((c) => p.categories.includes(c)),
    toItem: (p) => {
      let author = "", title = ent(p.name), note = "";
      const m = title.match(/^(.*?)«(.+?)»(.*)$/);
      const bundle = /(^|[\s,])(сексталогія|трилогія|комплект)(?=[\s,]|$)/i.test(m ? m[1] : "");
      if (m) {
        author = m[1].replace(/(^|[\s,])(сексталогія|трилогія|комплект)(?=[\s,]|$)/i, "$1").replace(/[,\s]+$/, "").trim();
        let rest = m[3];
        const n = rest.match(/\((.*)\)/);
        if (n) (note = n[1].trim()), (rest = rest.replace(n[0], ""));
        title = (m[2] + rest).replace(/\s+,/g, ",").replace(/[,\s]+$/, "").trim();
      }
      const pre = p.categories.includes("Передзамовлення") || /передзамовлення|відправка/i.test(note);
      // The note mixes the edition («англійська мова», «лімітоване видання») with shipping dates; keep the edition part.
      const edition = note.split(/,\s*/).filter((t) => t && !/передзамовлення|відправка|\d{4}/i.test(t)).join(", ");
      return {
        id: `vydavnytstvo-${p.id}`,
        title,
        author,
        isbn: p.attrs?.ISBN || "",
        edition,
        series: bundle ? title : volumeOf(title)?.series || "",
        volume: volumeOf(title)?.volume || 0,
        bundle,
        cover: p.image,
        url: p.url,
        price: uah(p.price),
        status: !p.inStock ? "немає" : pre ? "передзамовлення" : "є",
        isNew: pre,
        note,
        genres: p.categories.filter((c) => !["Передзамовлення", "Розпродаж"].includes(c)),
        blurb: about(p.blurb || p.desc),
        pages: p.attrs?.["Кількість сторінок"] || "",
        language: "українська",
      };
    },
  },
  {
    id: "laboratoriya",
    kind: "publisher",
    name: "Лабораторія",
    tagline: "Київське видавництво нонфікшну: історія, психологія, бізнес, наука",
    url: "https://laboratory.ua/",
    listing: (n) => `https://laboratory.ua/catalog/books/brand-laboratoriya${n > 1 ? `/page-${n}` : ""}`,
    fetchAll: (src, opts) => listingProducts(src, opts),
    parsePage: (html, url) => ldBookPage(SOURCES.find((s) => s.id === "laboratoriya"), ["Лабораторія"])(html, url),
    normalize: (p) => p,
    keep: () => true,
    toItem: (p) => p,
    finish: joinEbooks,
  },
  // Наш Формат's own shop answers our server with 403 (2026-10-19), so its books come from MEGOGO Books.
  mbooks({ id: "nashformat", slug: "nash-format", brand: "Наш Формат", name: "Наш Формат", tagline: "Видавництво нонфікшну: бізнес, саморозвиток, історія, наука", url: "https://nashformat.ua/", draft: false }),
  {
    id: "osnovy",
    kind: "publisher",
    name: "Основи",
    tagline: "Київське видавництво: нонфікшн, есеїстика, художня література",
    url: "https://osnovypublishing.com/",
    api: "https://osnovypublishing.com/wp-json/wc/store/v1/products",
    normalize: (p) => ({ ...woo(p), title: text(p.name), desc: about(p.description) }),
    // Stickers, postcards and other merch have no category.
    keep: (p) => p.categories.some((c) => c !== "Без категорії") && !/стікер|листівк|сертифікат/i.test(p.title),
    toItem: (p) => wooBook({ id: "osnovy" }, p, { bundle: p.categories.includes("Комплекти") }),
    // The author is a link to the author's page; the ISBN is in the book's details.
    enrich: pageDetails((html) => ({
      author: [...new Set([...html.matchAll(/href="https:\/\/osnovypublishing\.com\/authors\/[^"\/]+\/?"[^>]*>([^<]+)</g)].map((m) => ent(m[1]).trim()))].join(", "),
      isbn: isbnIn(html.match(/ISBN[\s\S]{0,200}/)?.[0]),
    })),
  },
  {
    id: "komora",
    kind: "publisher",
    name: "Комора",
    tagline: "Київське видавництво: перекладна й українська проза, есеї, спогади",
    url: "https://komorabooks.com/",
    api: "https://komorabooks.com/wp-json/wc/store/v1/products",
    normalize: (p) => ({ ...woo(p), title: unshout(text(p.name).replace(/\s*\(розпродаж\)$/i, "")), desc: about(p.description) }),
    keep: (p) => !/сертифікат|листівк|торб|стікер/i.test(p.title),
    toItem: (p) => wooBook({ id: "komora" }, p),
    // The book's details are «key: value» rows (Автор, Переклад, ISBN…).
    enrich: pageDetails((html) => {
      const rows = Object.fromEntries([...html.matchAll(/info-item-key">([\s\S]*?)<\/div>\s*<div class="single-page-info-item-value">([\s\S]*?)<\/div>/g)].map((m) => [text(m[1]).replace(/:$/, ""), text(m[2])]));
      return { author: rows["Автор"] || rows["Авторка"] || "", translator: rows["Переклад"] || "", isbn: isbnIn(rows["ISBN"]) };
    }),
  },
  {
    id: "nebo",
    kind: "publisher",
    name: "Nebo Booklab Publishing",
    tagline: "Харківське видавництво: фентезі, фантастика, класика. Книжки з книгарні Лабораторії",
    url: "https://nebopublishing.com.ua/",
    listing: (n) => `https://laboratory.ua/brands/nebobooklabpublishing${n > 1 ? `/page-${n}` : ""}`,
    fetchAll: (src, opts) => listingProducts(src, opts),
    parsePage: (html, url) => ldBookPage(SOURCES.find((s) => s.id === "nebo"), ["Nebo Booklab Publishing"])(html, url),
    normalize: (p) => p,
    keep: () => true,
    toItem: (p) => p,
    finish: joinEbooks,
  },
  {
    id: "zhorzh",
    kind: "publisher",
    name: "Жорж",
    tagline: "Видавництво: фентезі, фантастика, детективи. Книжки з книгарні Лабораторії",
    url: "https://zhorzh.com.ua/",
    listing: (n) => `https://laboratory.ua/brands/zhorzh${n > 1 ? `/page-${n}` : ""}`,
    fetchAll: (src, opts) => listingProducts(src, opts),
    parsePage: (html, url) => ldBookPage(SOURCES.find((s) => s.id === "zhorzh"), ["Жорж"])(html, url),
    normalize: (p) => p,
    keep: () => true,
    toItem: (p) => p,
    finish: joinEbooks,
  },
  mbooks({ id: "stone", slug: "stone-publishing", brand: "Stone Publishing", name: "Stone Publishing", tagline: "Фантастика, детективи й сучасна проза в перекладі", url: "https://stonepublishing.com.ua/", draft: false }),
  mbooks({ id: "vikhola", slug: "vikhola", brand: "Віхола", name: "Віхола", tagline: "Нонфікшн і сучасна проза", url: "https://vikhola.com/", draft: false }),
  mbooks({ id: "artbooks", slug: "artbooks", brand: "ARTBOOKS", name: "ARTBOOKS", tagline: "Сучасна проза, фантастика й підліткова література", url: "https://artbooks.ua/", draft: false }),
  mbooks({ id: "arthuss", slug: "arthuss", brand: "Видавництво ArtHuss", name: "ArtHuss", tagline: "Нонфікшн про мистецтво, науку й суспільство", url: "https://arthuss.com.ua/", draft: false }),
  mbooks({ id: "zhupanskyi", slug: "vydavnytstvo-zhupanskoho", brand: "Видавництво Жупанського", name: "Видавництво Жупанського", tagline: "Класика й сучасна світова проза в нових перекладах", url: "https://zhupansky.com/", draft: false }),
  mbooks({ id: "meridian", slug: "meridian-czernowitz", brand: "Meridian Czernowitz", name: "Meridian Czernowitz", tagline: "Сучасна українська та світова література", url: "https://meridiancz.com/", draft: false }),
  // More publishers from MEGOGO Books (2026-10-20, after «На схід від Едему» by BookChef was missing). Open to everyone since 2026-10-21.
  mbooks({ id: "bookchef", slug: "bookchef", brand: "BookChef", name: "BookChef", tagline: "Світова класика й сучасна проза в перекладі, нонфікшн", url: "https://bookchef.ua/", draft: false }),
  mbooks({ id: "vivat", slug: "vivat", brand: "Vivat", name: "Vivat", tagline: "Харківське видавництво: проза, нонфікшн, дитячі книжки", url: "https://vivat.com.ua/", draft: false }),
  mbooks({ id: "yakaboo-publishing", slug: "yakaboo-publishing", brand: "Yakaboo Publishing", name: "Yakaboo Publishing", tagline: "Нонфікшн і проза в перекладі", url: "https://mbooks.com.ua/publishers/yakaboo-publishing/", draft: false }),
  mbooks({ id: "ababahalamaha", slug: "a-ba-ba-ha-la-ma-ha", brand: "А-БА-БА-ГА-ЛА-МА-ГА", name: "А-БА-БА-ГА-ЛА-МА-ГА", tagline: "Дитячі книжки, класика й «Гаррі Поттер» українською", url: "https://ababahalamaha.com.ua/", draft: false }),
  mbooks({ id: "apriori", slug: "apriori", brand: "Апріорі", name: "Апріорі", tagline: "Львівське видавництво: класика, філософія, історія", url: "https://mbooks.com.ua/publishers/apriori/", draft: false }),
  mbooks({ id: "astroliabiia", slug: "astroliabiia", brand: "Астролябія", name: "Астролябія", tagline: "Львівське видавництво: Толкін, світова класика, нонфікшн", url: "https://mbooks.com.ua/publishers/astroliabiia/", draft: false }),
  mbooks({ id: "antonenko", slug: "vydavnytstvo-anetty-antonenko", brand: "Видавництво Анетти Антоненко", name: "Видавництво Анетти Антоненко", tagline: "Сучасна українська й світова проза", url: "https://mbooks.com.ua/publishers/vydavnytstvo-anetty-antonenko/", draft: false }),
  mbooks({ id: "urbino", slug: "urbino", brand: "Видавництво Урбіно", name: "Урбіно", tagline: "Сучасна світова проза в перекладі", url: "https://mbooks.com.ua/publishers/urbino/", draft: false }),
  mbooks({ id: "readberry", slug: "readberry", brand: "READBERRY", name: "Readberry", tagline: "Нонфікшн і проза в перекладі", url: "https://mbooks.com.ua/publishers/readberry/", draft: false }),
  mbooks({ id: "vyd21", slug: "vydavnytstvo-21", brand: "Видавництво 21", name: "Видавництво 21", tagline: "Чернівецьке видавництво: сучасна українська проза й есеїстика", url: "https://mbooks.com.ua/publishers/vydavnytstvo-21/", draft: false }),
  {
    id: "bohdan",
    kind: "publisher",
    name: "Навчальна книга – Богдан",
    tagline: "Тернопільське видавництво: фантастика й світова класика в перекладах, дитячі книжки",
    url: "https://bohdan-books.com/",
    sitemap: "https://bohdan-books.com/sitemap-custom-products.xml",
    isProduct: (u) => /\/catalog\/book\/\d+\/$/.test(u),
    charset: "windows-1251",
    fetchAll: (src, opts) => sitemapProducts(src, opts),
    parsePage: bohdanPage,
    normalize: (p) => p,
    keep: () => true,
    toItem: (p) => p,
    finish: bohdanFinish,
  },
  {
    id: "abuk",
    kind: "audio",
    name: "Абук",
    tagline: "Українська аудіокнигарня: класика, сучасна проза, нонфікшн, для дітей",
    url: "https://abuk.com.ua/",
    sitemap: "https://abuk.com.ua/sitemap.xml",
    isProduct: (u) => /\/catalog\/books\/\d+$/.test(u),
    fetchUrl: (u) => `https://abuk.com.ua/api/web/books/${u.split("/").pop()}/`,
    pace: 1500, // one book at a time: four at once got HTTP 429
    fetchAll: (src, opts) => sitemapProducts(src, opts),
    parsePage: abukBook,
    normalize: (p) => p,
    keep: (p) => !p.genres.includes("Подкасти, лекції"), // podcasts are not books
    toItem: (p) => p,
  },
];

// All products of one source, normalised. Pages until a short page; a failed page fails the source.
// A source may page its own way (page(n) and list(json)); the default is the WooCommerce Store API.
const wooPage = (src) => (n) => `${src.api}?per_page=100&page=${n}`;
const wooList = (json) => ({ items: json, more: Array.isArray(json) && json.length === 100 });
async function fetchSource(src, { fetchImpl = fetch, log = () => {} } = {}) {
  const out = [];
  const pageUrl = src.page || wooPage(src);
  const list = src.list || wooList;
  for (let page = 1; page <= (src.maxPages || 20); page++) {
    const res = await fetchImpl(pageUrl(page), { headers: { "User-Agent": "Mozilla/5.0 (Chytai catalog refresh; chytai.org.ua)", Accept: "application/json" }, signal: AbortSignal.timeout(60000) }).catch((e) => {
      throw new Error(`${src.id}: ${e.cause?.code || e.message}`);
    });
    if (!res.ok) throw new Error(`${src.id}: HTTP ${res.status} on page ${page}`);
    const { items, more } = list(await res.json());
    if (!Array.isArray(items)) throw new Error(`${src.id}: unexpected response on page ${page}`);
    out.push(...items.map(src.normalize));
    if (page % 20 === 1 || !more) log(`${src.id}: page ${page}, ${out.length} products so far`);
    if (!more) break;
  }
  if (!out.length) throw new Error(`${src.id}: empty catalog`);
  return out;
}

// Shelves from the normalised catalogs: { sourceId: [products] } -> { fetched, shelves }.
// `seen` (item id -> first seen date) makes «нове» mean "appeared since the shelf was first built":
// a source's own "new" tag counts too, and an item stops being new after 30 days.
function buildShelves(raw, { seen = {}, today = new Date().toISOString().slice(0, 10), baseline = "" } = {}) {
  const limit = new Date(Date.parse(today) - 30 * 86400000).toISOString().slice(0, 10);
  const shelves = [];
  for (const src of SOURCES) {
    const products = raw[src.id];
    if (!products) continue;
    let items = products.filter(src.keep).map(src.toItem);
    if (src.finish) items = src.finish(items);
    // A source added today is not all «нове»: its first catalog counts as already seen.
    const firstTime = !items.some((it) => it.id in seen);
    for (const it of items) {
      if (src.fetchAll) it.isNew = false; // items reused from the last refresh carry its flag
      seen[it.id] ??= firstTime ? baseline || today : today;
      if (baseline && seen[it.id] > baseline && seen[it.id] >= limit) it.isNew = true;
    }
    shelves.push({ id: src.id, kind: src.kind, name: src.name, tagline: src.tagline, url: src.url, ...(src.draft ? { draft: true } : {}), items });
  }
  return { fetched: today, shelves };
}

// The daily refresh: fetch every source, rebuild its shelf and write it to the database. Each source is
// saved as soon as it is fetched, so a deploy that restarts the server half-way keeps what was done
// (other threads deploy often, 2026-10-20). A source that fails keeps its previous items, so one site
// being down loses nothing. `only` refreshes one source (POST /api/refresh?only=<id>).
async function refresh({ store, log = console.log, fetchImpl, only }) {
  const sources = only ? SOURCES.filter((s) => s.id === only) : SOURCES;
  if (!sources.length) return { ok: false, errors: [`no source ${only}`] };
  const errors = [];
  const seen = store.seen();
  let done = 0;
  for (const src of sources) {
    try {
      // Books read by a refresh that a restart cut short (`partial:<id>`) count as read: a slow source
      // (Абук, one book every 1.5 s) would otherwise never finish between two deploys.
      const partial = JSON.parse(store.db.get(`partial:${src.id}`) || "[]");
      const previous = new Map([...(store.shelf(src.id)?.items || []), ...partial].map((it) => [it.url, it]));
      const fresh = new Set(partial.map((it) => it.url));
      const skip = new Set(JSON.parse(store.db.get(`skip:${src.id}`) || "[]"));
      const checkpoint = (items) => store.db.set(`partial:${src.id}`, JSON.stringify(items));
      const products = src.fetchAll ? await src.fetchAll(src, { fetchImpl, log, previous, skip, checkpoint, fresh }) : await fetchSource(src, { fetchImpl, log });
      if (src.fetchAll) store.db.set(`skip:${src.id}`, JSON.stringify([...skip]));
      if (src.enrich) await src.enrich(products, { previous, fetchImpl, log, id: src.id, keep: src.keep });
      const built = buildShelves({ [src.id]: products }, { seen, baseline: store.baseline });
      store.saveShelves(built.shelves, { fetched: built.fetched, seen });
      store.db.set(`partial:${src.id}`, "[]");
      done++;
    } catch (e) {
      errors.push(e.message);
      log(`refresh: ${e.message}; keeping the previous ${src.id} catalog`);
    }
  }
  if (!done) return { ok: false, errors }; // nothing fetched: the shelves stay as they were
  if (!only) store.db.set("refreshed_at", new Date().toISOString());
  store.loadShelves();
  const counts = store.shelves.map((s) => [s.id, s.items.length]);
  // How many audiobooks found their print or e-book edition (Абук gives no ISBN, so it is by author and title).
  for (const s of store.shelves.filter((s) => s.kind === "audio")) log(`${s.id}: ${s.items.filter((it) => (it.editions || 1) > 1 || store.aliases.has(it.id)).length} of ${s.items.length} joined with another edition`);
  log(`refresh: shelves rebuilt, ${counts.map(([id, n]) => `${id} ${n}`).join(", ")}${errors.length ? `; failed: ${errors.join("; ")}` : ""}`);
  return { ok: true, errors, counts };
}

module.exports = { SOURCES, fetchSource, buildShelves, refresh, volumeOf, ent, about, pageProducts, ldBookPage };

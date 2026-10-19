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
// WooCommerce leaves HTML entities in names («Ми &#8211; Легіон»).
// Pages built on the Лабораторія/Наш Формат engine encode them twice («&amp;laquo;»).
const NAMED = { nbsp: " ", ndash: "–", mdash: "—", laquo: "«", raquo: "»", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", hellip: "…", quot: '"', apos: "'", amp: "&" };
const ent1 = (s) => s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(n)).replace(/&([a-z]+);/g, (m, n) => NAMED[n] ?? m);
const ent = (s) => ent1(ent1(String(s || "")));
const text = (h) => ent(String(h || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&#8217;|&rsquo;/g, "’")).replace(/\s+/g, " ").trim();
const attr = (p, n) => ((p.attributes || []).find((a) => a.name === n) || { terms: [] }).terms.map((t) => t.name).join(", ") || "";

// «Коли завмирає серце, том шостий», «Серпанка. Том 2. Ліс зниклих духів», «Світ Едени, книга перша»:
// the series name and the volume number, so a shelf can fold the volumes into one card.
const ORD = { перший: 1, перша: 1, другий: 2, друга: 2, третій: 3, третя: 3, четвертий: 4, четверта: 4, "п’ятий": 5, "п'ятий": 5, "п’ята": 5, шостий: 6, шоста: 6, сьомий: 7, сьома: 7, восьмий: 8, восьма: 8, "дев’ятий": 9, десятий: 10 };
function volumeOf(title) {
  const m = title.match(/^(.+?)[,.]?\s+(?:том|книга|частина)\s+(\d+|[\p{L}’']+)(?=[.:\s]|$)[.:]?\s*(.*)$/iu);
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
  blurb: text(p.short_description).slice(0, 600),
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
async function pageProducts(src, urls, { fetchImpl = fetch, log = () => {}, previous = new Map(), skip = new Set() }) {
  const today = dayOfWeek();
  urls = urls.filter((u) => !skip.has(u) || bucket(u) === today);
  const due = urls.filter((u) => !previous.has(u) || bucket(u) === today);
  const out = urls.filter((u) => !due.includes(u)).map((u) => previous.get(u)).filter(Boolean);
  let failed = 0;
  let skipped = 0;
  for (let i = 0; i < due.length; i += 4) {
    await Promise.all(
      due.slice(i, i + 4).map(async (url) => {
        try {
          const r = await fetchImpl(url, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const html = await r.text();
          const item = src.parsePage(html, url);
          if (item) out.push(item), skip.delete(url);
          else if ((skip.add(url), !skipped++)) log(`${src.id}: not a book page: ${url} ${html.replace(/\s+/g, " ").slice(0, 160)}`);
        } catch (e) {
          if (!failed) log(`${src.id}: ${url}: ${e.cause?.code || e.message}`);
          failed++;
          if (previous.has(url)) out.push(previous.get(url));
        }
      })
    );
  }
  log(`${src.id}: ${urls.length} product pages, ${due.length} fetched${failed ? `, ${failed} failed` : ""}${skipped ? `, ${skipped} not its books` : ""}, ${out.length} books`);
  if (!out.length || (failed > due.length / 3 && failed > 10)) throw new Error(`${src.id}: ${failed} of ${due.length} pages failed`);
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
      blurb: text(prod.description || book.description).slice(0, 600),
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
  blurb: ent(p.blurb || p.desc),
  language: "українська",
  ...extra,
});

// MEGOGO Books (mbooks.com.ua) sells many publishers' books, each with a page per format: JSON-LD
// Product (ISBN as gtin, price, availability, publisher as brand), the format at the start of <title>
// («Книга», «Електронна книга», «Аудіокнига»), the authors linked to /authors/ above the <h1>, and the
// original title in the line under it. Publishers whose own sites give no data come from here
// (Max, 2026-10-19, starting with Stone Publishing).
function mbooksPage(src, brand) {
  return (html, url) => {
    const prod = ldOf(html).find((x) => [].concat(x["@type"]).includes("Product"));
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
      blurb: text(prod.description).slice(0, 600),
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
  parsePage: (html, u) => mbooksPage(SOURCES.find((s) => s.id === id), brand)(html, u),
  normalize: (p) => p,
  keep: () => true,
  toItem: (p) => p,
  finish: joinEbooks,
});

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
      status: !p.inStock ? "немає" : p.tags.includes("Передзамовлення") || p.categories.includes("Передзамовлення") ? "передзамовлення" : "є",
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
      blurb: text(p.description).slice(0, 600),
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
              p.blurb = text((j.data || j).description).slice(0, 600);
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
    normalize: (p) => ({ ...woo(p), name: text(p.name), attrs: Object.fromEntries((p.attributes || []).map((a) => [a.name, a.terms.map((t) => t.name).join(", ")])), desc: text(p.description).slice(0, 400), type: p.type }),
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
        blurb: ent(p.blurb || p.desc),
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
  mbooks({ id: "nashformat", slug: "nash-format", brand: "Наш Формат", name: "Наш Формат", tagline: "Видавництво нонфікшну: бізнес, саморозвиток, історія, наука", url: "https://nashformat.ua/" }),
  {
    id: "osnovy",
    kind: "publisher",
    name: "Основи",
    tagline: "Київське видавництво: нонфікшн, есеїстика, художня література",
    url: "https://osnovypublishing.com/",
    api: "https://osnovypublishing.com/wp-json/wc/store/v1/products",
    normalize: (p) => ({ ...woo(p), title: text(p.name), desc: text(p.description).slice(0, 600) }),
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
    normalize: (p) => ({ ...woo(p), title: unshout(text(p.name).replace(/\s*\(розпродаж\)$/i, "")), desc: text(p.description).slice(0, 600) }),
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
  mbooks({ id: "stone", slug: "stone-publishing", brand: "Stone Publishing", name: "Stone Publishing", tagline: "Фантастика, детективи й сучасна проза в перекладі", url: "https://stonepublishing.com.ua/" }),
  mbooks({ id: "vikhola", slug: "vikhola", brand: "Віхола", name: "Віхола", tagline: "Нонфікшн і сучасна проза", url: "https://vikhola.com/" }),
  mbooks({ id: "artbooks", slug: "artbooks", brand: "ARTBOOKS", name: "ARTBOOKS", tagline: "Сучасна проза, фантастика й підліткова література", url: "https://artbooks.ua/" }),
  mbooks({ id: "arthuss", slug: "arthuss", brand: "Видавництво ArtHuss", name: "ArtHuss", tagline: "Нонфікшн про мистецтво, науку й суспільство", url: "https://arthuss.com.ua/" }),
  mbooks({ id: "zhupanskyi", slug: "vydavnytstvo-zhupanskoho", brand: "Видавництво Жупанського", name: "Видавництво Жупанського", tagline: "Класика й сучасна світова проза в нових перекладах", url: "https://zhupansky.com/" }),
  mbooks({ id: "meridian", slug: "meridian-czernowitz", brand: "Meridian Czernowitz", name: "Meridian Czernowitz", tagline: "Сучасна українська та світова література", url: "https://meridiancz.com/" }),
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

// The daily refresh: fetch every source, rebuild its shelf and write it to the database. A source that
// fails keeps its previous items, so one site being down loses nothing.
async function refresh({ store, log = console.log, fetchImpl }) {
  const raw = {};
  const errors = [];
  for (const src of SOURCES) {
    try {
      const previous = new Map((store.shelf(src.id)?.items || []).map((it) => [it.url, it]));
      const skip = new Set(JSON.parse(store.db.get(`skip:${src.id}`) || "[]"));
      raw[src.id] = src.fetchAll ? await src.fetchAll(src, { fetchImpl, log, previous, skip }) : await fetchSource(src, { fetchImpl, log });
      if (src.fetchAll) store.db.set(`skip:${src.id}`, JSON.stringify([...skip]));
      if (src.enrich) await src.enrich(raw[src.id], { previous, fetchImpl, log, id: src.id, keep: src.keep });
    } catch (e) {
      errors.push(e.message);
      log(`refresh: ${e.message}; keeping the previous ${src.id} catalog`);
    }
  }
  if (errors.length === SOURCES.length) return { ok: false, errors }; // nothing fetched: leave the shelves as they were
  const seen = store.seen();
  const built = buildShelves(raw, { seen, baseline: store.baseline });
  store.saveShelves(built.shelves, { fetched: built.fetched, refreshedAt: new Date().toISOString(), seen });
  store.loadShelves();
  const counts = store.shelves.map((s) => [s.id, s.items.length]);
  log(`refresh: shelves rebuilt, ${counts.map(([id, n]) => `${id} ${n}`).join(", ")}${errors.length ? `; failed: ${errors.join("; ")}` : ""}`);
  return { ok: true, errors, counts };
}

module.exports = { SOURCES, fetchSource, buildShelves, refresh, volumeOf, ent, pageProducts, ldBookPage };

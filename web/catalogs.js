// The public catalogs behind the Discovery shelves: how each source is fetched from its public API,
// how its products become shelf items, and the daily refresh that keeps the shelves (in the database,
// see db.js) current.
//
// Lobster and Видавництво run WooCommerce, whose Store API is public JSON:
//   https://<site>/wp-json/wc/store/v1/products?per_page=100&page=N
// Віхола has no API and challenges bots on its catalog pages, so it is read the way search engines
// read it: the product URLs from its sitemap, then each book's page (Open Graph product tags, the
// «Author «Title»» heading, the ISBN in the cover's alt text). A page is fetched when its URL is new and
// otherwise once a week (a seventh of the catalog a day), so the daily refresh stays light.
// Старий Лев's site reads its catalog from its own public JSON API (28 products a page, Laravel paging):
//   https://api-k8s.starylev.com.ua/api/v1.1/products?page=N
// The raw products are normalised to a small shape (kept in web/catalogs/*.json for the seed), then
// turned into shelf items by toItem(). Max (2026-10-19):
// use feeds where a source has them, scrape where it does not; the shelves must refresh daily.

const uah = (n) => (n ? `${Math.round(n)} ₴` : "");
// WooCommerce leaves HTML entities in names («Ми &#8211; Легіон»).
const ent = (s) => String(s || "").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(n)).replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'");
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

// Старий Лев: statuses come as labels. E-books (here and at Віхола) are separate products with the same
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

// Pages fetched a few at a time; `previous` (url -> item from the last refresh) is reused for the rest.
async function sitemapProducts(src, { fetchImpl = fetch, log = () => {}, previous = new Map() }) {
  const res = await fetchImpl(src.sitemap, { headers: HEADERS, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`${src.id}: HTTP ${res.status} on the sitemap`);
  const urls = [...(await res.text()).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, "&")).filter(src.isProduct || (() => true));
  if (!urls.length) throw new Error(`${src.id}: empty sitemap`);
  const today = dayOfWeek();
  const due = urls.filter((u) => !previous.has(u) || bucket(u) === today);
  const out = urls.filter((u) => !due.includes(u)).map((u) => previous.get(u)).filter(Boolean);
  let failed = 0;
  for (let i = 0; i < due.length; i += 4) {
    await Promise.all(
      due.slice(i, i + 4).map(async (url) => {
        try {
          const r = await fetchImpl(url, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const item = src.parsePage(await r.text(), url);
          if (item) out.push(item);
        } catch {
          failed++;
          if (previous.has(url)) out.push(previous.get(url));
        }
      })
    );
  }
  log(`${src.id}: ${urls.length} pages in the sitemap, ${due.length} fetched${failed ? `, ${failed} failed` : ""}, ${out.length} books`);
  if (failed > due.length / 2 && failed > 10) throw new Error(`${src.id}: ${failed} of ${due.length} pages failed`);
  return out;
}

// Віхола: «Author «Title»» headings, «… Е-книжка» for e-books, the ISBN in the cover's alt text.
function vikholaPage(html, url) {
  if (meta(html, "og:type") !== "product") return null;
  let name = h1(html) || meta(html, "og:title");
  if (/сертифікат/i.test(name)) return null;
  const ebook = /\s+е-книжка$/i.test(name) || meta(html, "product:category") === "Електронні книжки";
  name = name.replace(/\s+е-книжка$/i, "");
  const m = name.match(/^(.*?)\s*«(.+)»\s*(.*)$/);
  const author = m ? m[1].replace(/[,\s]+$/, "").trim() : "";
  const title = m ? (m[2] + (m[3] ? ` ${m[3]}` : "")).trim() : name;
  const avail = meta(html, "product:availability");
  const isbn = (html.match(/alt=["'][^"']*?(97[89]\d{10})[^"']*["']/) || [])[1] || "";
  return {
    id: `vikhola-${(url.match(/\/(\d+)\/?$/) || [])[1] || url.replace(/^https?:\/\/[^/]+\//, "").replace(/\/$/, "")}`,
    title,
    author,
    isbn,
    format: ebook ? "e-book" : "папір",
    series: volumeOf(title)?.series || "",
    volume: volumeOf(title)?.volume || 0,
    bundle: /^комплект/i.test(title),
    cover: meta(html, "og:image"),
    url,
    price: uah(Number(meta(html, "product:price:amount"))),
    status: /pre-?order/i.test(avail) ? "передзамовлення" : /in ?stock/i.test(avail) ? "є" : "немає",
    isNew: false,
    genres: [meta(html, "product:category")].filter((g) => g && g !== "Електронні книжки"),
    blurb: text(meta(html, "og:description")).slice(0, 600),
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
    id: "vikhola",
    kind: "publisher",
    name: "Віхола",
    tagline: "Київське видавництво: українська класика, нонфікшн і сучасна проза",
    url: "https://vikhola.com/",
    sitemap: "https://vikhola.com/content/export/vikhola.com/catalog-sitemap.xml",
    isProduct: (u) => !/\/(katalog|blog|novyny|podii)\b/.test(u),
    fetchAll: (src, opts) => sitemapProducts(src, opts),
    parsePage: vikholaPage,
    normalize: (p) => p,
    keep: () => true,
    toItem: (p) => p,
    finish: (items) => joinEbooks(items),
    draft: true, // seen only by the signed-in owner until Max has looked at it
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
      raw[src.id] = src.fetchAll ? await src.fetchAll(src, { fetchImpl, log, previous }) : await fetchSource(src, { fetchImpl, log });
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

module.exports = { SOURCES, fetchSource, buildShelves, refresh, volumeOf, ent };

// The public catalogs behind the Discovery shelves: how each source is fetched from its public API,
// how its products become shelf items, and the daily refresh that keeps the shelves current.
//
// Both sources run WooCommerce, whose Store API is public JSON:
//   https://<site>/wp-json/wc/store/v1/products?per_page=100&page=N
// The raw products are normalised to a small shape (kept in web/catalogs/*.json for the seed and in
// DATA_DIR/web/catalogs/ after a refresh), then turned into shelf items by toItem(). Max (2026-10-19):
// use feeds where a source has them, scrape where it does not; the shelves must refresh daily.
const fs = require("fs");
const path = require("path");

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
async function fetchSource(src, { fetchImpl = fetch, log = () => {} } = {}) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const res = await fetchImpl(`${src.api}?per_page=100&page=${page}`, { headers: { "User-Agent": "Mozilla/5.0 (Chytai catalog refresh; chytai.org.ua)", Accept: "application/json" }, signal: AbortSignal.timeout(60000) }).catch((e) => {
      throw new Error(`${src.id}: ${e.cause?.code || e.message}`);
    });
    if (!res.ok) throw new Error(`${src.id}: HTTP ${res.status} on page ${page}`);
    const list = await res.json();
    if (!Array.isArray(list)) throw new Error(`${src.id}: unexpected response on page ${page}`);
    out.push(...list.map(src.normalize));
    log(`${src.id}: page ${page}, ${list.length} products`);
    if (list.length < 100) break;
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
    const items = products.filter(src.keep).map(src.toItem);
    for (const it of items) {
      seen[it.id] ??= today;
      if (baseline && seen[it.id] > baseline && seen[it.id] >= limit) it.isNew = true;
    }
    shelves.push({ id: src.id, kind: src.kind, name: src.name, tagline: src.tagline, url: src.url, items });
  }
  return { fetched: today, shelves };
}

// The daily refresh: fetch every source, rebuild the shelves, keep them under dataDir and hand them to
// the store. A source that fails keeps its previous products, so one site being down loses nothing.
async function refresh({ dataDir, store, log = console.log, fetchImpl }) {
  const dir = path.join(dataDir, "catalogs");
  fs.mkdirSync(dir, { recursive: true });
  const readJson = (f, fallback) => {
    try {
      return JSON.parse(fs.readFileSync(f, "utf8"));
    } catch {
      return fallback;
    }
  };
  const seenFile = path.join(dataDir, "catalog-seen.json");
  const seen = readJson(seenFile, null) || Object.fromEntries(store.shelves.flatMap((s) => s.items.map((it) => [it.id, store.shelvesFetched])));
  const raw = {};
  const errors = [];
  for (const src of SOURCES) {
    const file = path.join(dir, `${src.id}.json`);
    try {
      raw[src.id] = await fetchSource(src, { fetchImpl, log });
      fs.writeFileSync(file, JSON.stringify(raw[src.id]));
    } catch (e) {
      errors.push(e.message);
      log(`refresh: ${e.message}; keeping the previous ${src.id} catalog`);
      raw[src.id] = readJson(file, null) || readJson(path.join(__dirname, "catalogs", `${src.id}.json`), null);
    }
  }
  const built = buildShelves(raw, { seen, baseline: store.baseline });
  if (errors.length === SOURCES.length) return { ok: false, errors }; // nothing fetched: leave the shelves as they were
  fs.writeFileSync(seenFile, JSON.stringify(seen));
  fs.writeFileSync(path.join(dataDir, "shelves.json"), JSON.stringify({ ...built, baseline: store.baseline }));
  store.setShelves({ ...built, baseline: store.baseline });
  log(`refresh: shelves rebuilt, ${built.shelves.map((s) => `${s.id} ${s.items.length}`).join(", ")}${errors.length ? `; failed: ${errors.join("; ")}` : ""}`);
  return { ok: true, errors, counts: built.shelves.map((s) => [s.id, s.items.length]) };
}

module.exports = { SOURCES, fetchSource, buildShelves, refresh, volumeOf, ent };

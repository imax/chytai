// Readeat (readeat.com) as a source of book data (Max, 2026-10-23: «readeat краще за сенс. і роботів не блочить і
// є апі»; «можемо брати»; links to it are fine on the site now). Its shop answers JSON searches at
// /api/products/search?keyword= (a title, «title author» or an ISBN), and a book's page carries a schema.org
// Book (ISBN, language, year, pages, translator, cover) and the shop's own record of it (the annotation, the
// original's title as english_name). It sells Ukrainian editions, so it fills what Open Library and Google
// Books don't know: covers and details of books readers typed in Ukrainian, and Ukrainian editions of
// foreign books (ukfind.js asks here before paying Claude to search the web).
// Starts off (meta readeat:on): /admin/readeat shows the owner what a run would fill and switches it on.
// Every book is asked once a month at most (meta readeat:<id>), one request every 1.5 s, 200 books a day.

const BASE = "https://readeat.com";
const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; Chytai/1.0; +https://chytai.org.ua)", Accept: "application/json, text/html", "Accept-Language": "uk" };
const MONTH = 30 * 86400000;
const PAPER = 6;
const EBOOK = 4;
const OWN = new Set(["manual", "goodreads", "apple-books", "office", "list", "tip"]);

const norm = (s) => String(s || "").toLowerCase().replace(/[’'`ʼ"«»]/g, "").replace(/ё/g, "е").replace(/ґ/g, "г").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const mainTitle = (t) => String(t || "").replace(/\s*\(.*?\)\s*/g, " ").split(/[:.]/)[0].trim();
const firstAuthor = (a) => String(a || "").split(/\s+(?:and|і|та)\s+|\s*[,&;]\s*/)[0].replace(/\s+/g, " ").trim();
const surname = (a) => norm(firstAuthor(a)).split(" ").filter((w) => w.length > 1).pop() || "";
const isCyrillic = (t) => /[а-яіїєґ]/i.test(t);
const russian = (t) => /[ыэъё]/i.test(t);
const cleanIsbn = (s) => String(s || "").replace(/[^0-9Xx]/g, "").toUpperCase();
const ukIsbn = (s) => /^978(617|966)/.test(s); // Ukrainian publishers' ISBN prefixes
const strip = (html) =>
  String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(nbsp|amp|quot|laquo|raquo|mdash|ndash|hellip|#39|apos|lt|gt);/gi, (m, e) => ({ nbsp: " ", amp: "&", quot: '"', laquo: "«", raquo: "»", mdash: "—", ndash: "–", hellip: "…", "#39": "'", apos: "'", lt: "<", gt: ">" })[e.toLowerCase()])
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

async function get(url, fetchImpl, type) {
  const r = await fetchImpl(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return type === "json" ? r.json() : r.text();
}

// search(q) -> [{ id, title, author, publisher, cover, url, ebook }]: books only (no certificates or sets).
async function search(q, { fetchImpl = fetch } = {}) {
  q = String(q || "").trim().slice(0, 120);
  if (q.length < 2) return [];
  const j = await get(`${BASE}/api/products/search?keyword=${encodeURIComponent(q)}`, fetchImpl, "json");
  return (j?.products || [])
    .filter((p) => (p.type === PAPER || p.type === EBOOK) && p.link && p.name)
    .map((p) => ({ id: p.id, title: String(p.name).trim(), author: String(p.author || "").trim(), publisher: p.publisher || "", cover: /^https:\/\//.test(p.image || "") ? p.image : "", url: BASE + p.link, ebook: p.type === EBOOK }));
}

// The shop's record of the book from the page's React data (self.__next_f), the object around "meta_description".
function record(html) {
  const chunks = [];
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
    try {
      chunks.push(JSON.parse(m[1]));
    } catch {}
  }
  const f = chunks.join("");
  const at = f.indexOf('"meta_description":');
  if (at < 0) return null;
  const s = f.lastIndexOf('"data":{', at) + 7;
  if (s < 7) return null;
  let depth = 0;
  let e = s;
  for (; e < f.length; e++) {
    const c = f[e];
    if (c === '"') {
      for (e++; e < f.length && f[e] !== '"'; e++) if (f[e] === "\\") e++;
    } else if (c === "{") depth++;
    else if (c === "}" && !--depth) break;
  }
  try {
    return JSON.parse(f.slice(s, e + 1));
  } catch {
    return null;
  }
}

// parse(html, url) -> { title, author, cover, isbns, published, pages, language, translator, original, blurb, publisher, url, site } | null
function parse(html, url) {
  let ld = null;
  for (const m of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      const j = JSON.parse(m[1]);
      if ([].concat(j["@type"] || []).includes("Book")) ld = j;
    } catch {}
  }
  const rec = record(html) || {};
  if (!ld && !rec.title) return null;
  const feature = (name) => (rec.features || []).find((x) => x.name === name)?.value || "";
  const name = (x) => (typeof x === "string" ? x : x?.name || "");
  const lang = ld?.inLanguage || { Українська: "uk", Російська: "ru", Англійська: "en" }[feature("Мова")] || "";
  const isbn = cleanIsbn(ld?.isbn || rec.isbn);
  const year = Number(ld?.datePublished || feature("Рік видання")) || null;
  const pages = Number(ld?.numberOfPages || rec.pages_count) || null;
  const blurb = strip(rec.text);
  // english_name is often «<title>: A Memoir by <author>»: the title alone.
  const original = String(rec.english_name || "").replace(/^(.+?:.+?)\s+by\s+[^:]+$/i, "$1").replace(/\s*:\s*(a|an)\s+(memoir|biography|novel)$/i, "").trim();
  return {
    title: String(ld?.name || rec.title || "").replace(/\s*\((електронна книга|аудіокнига)\)\s*$/i, "").trim(),
    author: [].concat(ld?.author || []).map(name).filter(Boolean).join(", ") || (rec.authors || []).map((a) => a.name).join(", "),
    cover: /^https:\/\//.test(ld?.image || "") ? ld.image : "",
    isbns: /^(\d{9}[\dX]|\d{13})$/.test(isbn) ? [isbn] : [],
    published: year > 1400 && year <= new Date().getFullYear() + 1 ? year : null,
    pages: pages > 0 && pages < 10000 ? pages : null,
    language: { uk: "українська", ru: "російська", en: "англійська" }[lang] || "",
    lang,
    translator: [].concat(ld?.translator || []).map(name).filter(Boolean).join(", ") || String(rec.translater || ""),
    original: original && !isCyrillic(original) ? original : "",
    blurb: blurb.length >= 80 ? blurb.slice(0, 3000) : "",
    publisher: name(ld?.publisher) || rec.publisher?.name || "",
    url: ld?.url || url,
    site: "Readeat",
  };
}

async function product(url, { fetchImpl = fetch } = {}) {
  const html = await get(url, fetchImpl, "text");
  return html ? parse(html, url) : null;
}

// Is a search hit this book? The main title the same (or one starts with the other) and the author's surname among
// the hit's authors when we know an author. A hit found by ISBN is trusted.
function same(book, hit) {
  const a = norm(mainTitle(book.title));
  const b = norm(mainTitle(hit.title));
  const full = norm(hit.title);
  if (!a || !(a === b || a === full || full.startsWith(a + " ") || norm(book.title) === full)) return false;
  // «Шерлок Голмс. Том 2» is not «… у 2 томах. Том 1»: the same volume numbers.
  const vols = (t) => [...norm(t).matchAll(/(?:том|книга|кн|частина|ч|випуск|вип|сезон)\s+(\d+)/g)].map((m) => m[1]).join();
  if (vols(book.title) !== vols(hit.title)) return false;
  const s = surname(book.author);
  return !s || !hit.author || norm(hit.author).split(" ").some((w) => w === s || (s.length > 4 && w.startsWith(s.slice(0, -1))));
}

const sameTitle = (x, y) => {
  const a = norm(mainTitle(x).replace(/^(the|a|an)\s+/i, ""));
  const b = norm(mainTitle(y).replace(/^(the|a|an)\s+/i, ""));
  return !!a && (a === b || a.startsWith(b + " ") || b.startsWith(a + " "));
};

// findBook({ title, author, isbns }, { original }) -> the Ukrainian edition's details from Readeat | null. Paper before e-book;
// Russian-language editions never.
async function findBook(book, { fetchImpl = fetch, pause = 1500, original = "" } = {}) {
  const wait = () => pause && new Promise((r) => setTimeout(r, pause));
  const isbns = (book.isbns || []).map(cleanIsbn).filter(ukIsbn);
  let hits = [];
  let byIsbn = false;
  for (const isbn of isbns.slice(0, 2)) {
    hits = await search(isbn, { fetchImpl });
    await wait();
    if (hits.length === 1) {
      byIsbn = true;
      break;
    }
    hits = [];
  }
  if (!hits.length) {
    if (!isCyrillic(book.title) || russian(book.title)) return null;
    hits = (await search(`${mainTitle(book.title)} ${firstAuthor(book.author)}`.trim(), { fetchImpl })).filter((h) => same(book, h));
    await wait();
    if (!hits.length && book.author) {
      hits = (await search(mainTitle(book.title), { fetchImpl })).filter((h) => same(book, h));
      await wait();
    }
  }
  hits.sort((x, y) => x.ebook - y.ebook);
  for (const h of hits.slice(0, 2)) {
    const p = await product(h.url, { fetchImpl });
    await wait();
    if (!p || p.lang === "ru" || russian(p.title)) continue;
    if (!byIsbn && p.lang && p.lang !== "uk") continue;
    // A Ukrainian edition of a known original: the shop's english_name must be that original when it has one, and
    // without an author to compare it must have one.
    if (original && (p.original ? !sameTitle(original, p.original) : !book.author)) continue;
    return { ...p, cover: p.cover || h.cover, author: p.author || h.author };
  }
  return null;
}

// What a book takes from Readeat: nothing the reader or a catalog set is overwritten.
function patchFor(book, info) {
  const patch = {};
  if ((!book.cover || foreignCover(book)) && info.cover) patch.cover = info.cover;
  const isbns = [...new Set([...(book.isbns || []), ...info.isbns])];
  if (isbns.length > (book.isbns || []).length) patch.isbns = isbns;
  if (!book.published && info.published) patch.published = info.published;
  if (!book.pages && info.pages) patch.pages = info.pages;
  if (!book.language && info.language) patch.language = info.language;
  if (!book.blurb && info.blurb) (patch.blurb = info.blurb), (patch.blurbSource = "Readeat");
  if (!book.altTitle && info.original) patch.altTitle = info.original;
  if (!(book.links || []).some((l) => /readeat\.com/i.test(l.url))) patch.links = [...(book.links || []), { label: "Readeat", url: info.url }];
  return patch;
}

// The readers' own books worth asking: typed in Ukrainian (or with a Ukrainian ISBN) and missing a cover, a
// description or an ISBN.
// An Open Library cover on a Ukrainian book is the original's (often an old first edition, «Фундація», Max
// 2026-10-24): Readeat's cover of the Ukrainian edition replaces it.
const foreignCover = (b) => /^https:\/\/covers\.openlibrary\.org\//.test(b.cover || "") && isCyrillic(b.title);
function wanting(store, ids) {
  const all = ids ? ids.map((id) => store.lib.books[id]).filter(Boolean) : Object.values(store.lib.books);
  const { isRussian } = require("./store");
  return all.filter((b) => OWN.has(b.source) && !isRussian(b) && ((isCyrillic(b.title) && !russian(b.title)) || (b.isbns || []).some((x) => ukIsbn(cleanIsbn(x)))) && !(b.cover && !foreignCover(b) && b.blurb && (b.isbns || []).length));
}

const on = (store) => store.db.get("readeat:on") === "1";
// At most DAILY books a day are asked about, every way together (Max, 2026-10-23: «давай сильно їх не грузити.
// 200 книжок за день нам має вистачити»). take(store) counts one and says whether it is still allowed.
const DAILY = 200;
function take(store) {
  const day = new Date().toISOString().slice(0, 10);
  const [d, n] = String(store.db.get("readeat:day") || "").split(" ");
  const used = d === day ? Number(n) || 0 : 0;
  if (used >= DAILY) return false;
  store.db.set("readeat:day", `${day} ${used + 1}`);
  return true;
}

// enrich(store, { ids, dry }) -> { asked, found, rows: [{ book, info, patch }], ms }. A dry run writes nothing and
// asks again books asked before (the owner's sample on /admin/readeat).
async function enrich(store, { ids, dry = false, max = 200, log = () => {}, fetchImpl = fetch, pause = 1500, force = false } = {}) {
  if (!dry && !on(store)) return { asked: 0, found: 0, rows: [], ms: 0 };
  const t0 = Date.now();
  const books = wanting(store, ids)
    .filter((b) => dry || force || Date.now() - Number(store.db.get(`readeat:${b.id}`) || 0) > MONTH)
    .slice(0, max);
  const rows = [];
  const view = (b) => ({ id: b.id, title: b.title, author: b.author, href: store.href ? store.href(b.id) : "" });
  let failed = 0;
  const errors = [];
  for (const b of books) {
    if (!dry && !take(store)) break; // the day's ceiling: the rest tomorrow
    if (!dry) store.db.set(`readeat:${b.id}`, String(Date.now()));
    try {
      const info = await findBook(b, { fetchImpl, pause });
      if (!info) {
        if (dry) rows.push({ book: view(b), info: null, patch: {} });
        continue;
      }
      const patch = patchFor(b, info);
      rows.push({ book: view(b), info, patch });
      if (!dry && Object.keys(patch).length) store.updateBook(b.id, patch);
    } catch (e) {
      const why = `${e.name === "TimeoutError" ? "timeout " : ""}${e.cause?.code || e.message}`;
      errors.push(`${b.id}: ${why}`);
      if (dry) rows.push({ book: view(b), info: null, patch: {}, error: why });
      if (++failed >= 3) break; // Readeat is away or refuses us: the rest another time
    }
  }
  const found = rows.filter((r) => r.info).length;
  if (!dry && found) {
    store._works = null;
    store.linkEditions?.();
    store.indexSearch();
  }
  const line = `${new Date().toISOString()}: ${dry ? "trial, " : ""}${found} of ${books.length} books found on Readeat in ${Math.round((Date.now() - t0) / 1000)} s${errors.length ? `; errors: ${errors.slice(0, 5).join(", ")}` : ""}`;
  log(`readeat ${line}`);
  if (!dry) store.db.set("readeat:log", line);
  return { asked: books.length, found, rows, ms: Date.now() - t0, errors };
}

module.exports = { search, product, parse, findBook, patchFor, wanting, enrich, on, take, same, BASE };

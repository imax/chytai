// Details for the readers' own books from Open Library (Max, 2026-10-20: «знаходити ASIN та деталі для
// книжок типу Rubicon», which came from an Apple Books import with nothing but a title and an author).
// A book that no catalog has (added by hand or by an import) gets, when Open Library knows it: a cover,
// its ISBNs, the year it first came out, the usual page count, the language and a description. The
// ISBN-10 of a print edition doubles as Amazon's ASIN, so it becomes an Amazon link. Open Library sees
// only titles and authors, never who reads them; its covers are loaded by the reader's browser from
// covers.openlibrary.org. Each book is asked about once a month at most (meta `enrich:<id>`), a run after
// every import for the books it created and a weekly pass over everything, about one request a second.
// Open Library knows little about books in Ukrainian or Russian, so only Latin-script titles are asked
// there; with a Google Books API key (GOOGLE_BOOKS_KEY, Max made one 2026-10-21) Google Books is asked
// about every book Open Library did not cover, Cyrillic titles included, and fills what is still missing.

const SEARCH = "https://openlibrary.org/search.json";
const HEADERS = { "User-Agent": "Chytai/1.0 (https://chytai.org.ua; book details lookup)", Accept: "application/json" };
const FIELDS = "key,title,subtitle,author_name,cover_i,isbn,first_publish_year,number_of_pages_median,language,id_amazon";
const MONTH = 30 * 86400000;
const WEEK = 7 * 86400000;
const OWN = new Set(["manual", "goodreads", "apple-books", "office", "list", "tip"]);
const LANG = { eng: "англійська", ukr: "українська", rus: "російська", pol: "польська", ger: "німецька", fre: "французька", spa: "іспанська", ita: "італійська" };
const GLANG = { en: "англійська", uk: "українська", ru: "російська", pl: "польська", de: "німецька", fr: "французька", es: "іспанська", it: "італійська" };
const GOOGLE = "https://www.googleapis.com/books/v1/volumes";
// Our genres (the tags «Читали це, сподобалось і це» matches books by) from Open Library's subjects and
// Google's categories, so a book a reader added gets neighbours before anyone rates it (Max, 2026-10-23).
const GENRE_OF = [
  ["фантастика", /science fiction|fantasy|dystopia/i],
  ["детективи", /detective|mystery|crime fiction/i],
  ["трилери", /thriller|suspense/i],
  ["художня", /^(?!.*non-?fiction).*\bfiction\b|\bnovels?\b/i],
  ["біографії", /biograph|memoir|diaries|diarists/i],
  ["історія", /\bhistory\b|historical/i],
  ["війна", /\bwar\b|military/i],
  ["бізнес", /business|entrepreneur|start-?ups?/i],
  ["менеджмент", /management|leadership/i],
  ["гроші", /finance|investment|investing|\bmoney\b/i],
  ["розробка", /programming|software|computer science/i],
  ["наука", /^(?!.*fiction).*(science|physics|biology|mathematics|neuroscien|evolution)/i],
  ["саморозвиток", /self-help|personal (development|growth)|self-improvement|^habits?$|^success$/i],
  ["суспільство", /sociology|social science|political science|politics|economics/i],
];
// Subjects are many and noisy: a genre counts when one of the first twenty says so.
const genresOf = (subjects) => GENRE_OF.filter(([, re]) => (subjects || []).slice(0, 20).some((x) => re.test(String(x)))).map(([g]) => g).slice(0, 3);
// Bumped when a source is added or fixed, so every book is asked again: the per-book memory is enrich:<GEN>:<id>.
const GEN = 3; // 3: genres (2026-10-23)

const norm = (s) => String(s || "").toLowerCase().replace(/^(the|a|an)\s+/, "").replace(/[’'`]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const mainTitle = (t) => String(t || "").replace(/\s*\(.*?\)\s*/g, " ").split(/[:]/)[0].trim();
const isLatin = (t) => /[a-z]/i.test(t) && !/[а-яіїєґ]/i.test(t);
const firstAuthor = (a) => String(a || "").split(/\s+and\s+|\s*[,&;]\s*/)[0].replace(/\s+/g, " ").trim();
const surname = (a) => norm(firstAuthor(a)).split(" ").filter((w) => w.length > 1).pop() || "";
const isbn10 = (s) => /^\d{9}[\dX]$/.test(s);
const cleanIsbns = (list) => [...new Set((list || []).map((x) => String(x).replace(/[^0-9Xx]/g, "").toUpperCase()).filter((x) => x.length === 10 || x.length === 13))];

// Does a search hit really mean this book? The title (or its main part) must match and the author's
// surname must be among the hit's authors; a hit found by ISBN is trusted on the ISBN alone.
function same(book, doc, byIsbn) {
  if (byIsbn) return true;
  const titles = new Set([norm(doc.title), norm(mainTitle(doc.title)), norm(`${doc.title} ${doc.subtitle || ""}`)]);
  const mine = [norm(book.title), norm(mainTitle(book.title))];
  if (!mine.some((t) => t && titles.has(t))) return false;
  const s = surname(book.author);
  if (!s) return false;
  return (doc.author_name || []).some((a) => norm(a).split(" ").includes(s));
}

// What the description text of a work looks like once Open Library's markup and source notes are gone.
function descriptionText(d) {
  let s = typeof d === "string" ? d : d?.value || "";
  s = s
    .replace(/\r/g, "")
    .replace(/\[([^\]]+)\]\[\d+\]/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\(\[?source\]?[^)]*\)/gi, "")
    .replace(/^\s*-{3,}.*$/gm, "")
    .replace(/^\s*\[\d+\]:\s*\S+.*$/gm, "")
    .replace(/^\s*(Also contained in|Contains|See also|From the publisher)\b.*$/gim, "")
    .replace(/\*\*?|__?/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (s.length > 1000) {
    const cut = s.slice(0, 1000);
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(".\n"), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    s = end > 300 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, "") + "…";
  }
  return s;
}

// Google answers Fly's shared IPv4 addresses with 503 «backendFailed» whatever the key (2026-10-21), but
// over IPv6 it works, so Google is reached by a plain https request pinned to IPv6.
function fetchV6(url, { headers = {}, timeout = 12000 } = {}) {
  const https = require("https");
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const rq = https.request({ host: u.hostname, family: 6, path: u.pathname + u.search, headers, timeout }, (r) => {
      let body = "";
      r.setEncoding("utf8");
      r.on("data", (c) => (body += c));
      r.on("end", () => resolve({ ok: r.statusCode >= 200 && r.statusCode < 300, status: r.statusCode, text: async () => body, json: async () => JSON.parse(body) }));
    });
    rq.on("timeout", () => rq.destroy(Object.assign(new Error("timeout"), { name: "TimeoutError" })));
    rq.on("error", reject);
    rq.end();
  });
}

async function getJson(url, fetchImpl) {
  const r = await fetchImpl(url, { headers: HEADERS, signal: AbortSignal.timeout(12000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 160)}`);
  return r.json();
}

// lookup(book) -> { cover, isbns, published, pages, language, blurb, ol } | null, from one or two requests.
async function lookup(book, { fetchImpl = fetch } = {}) {
  const isbns = cleanIsbns(book.isbns);
  const queries = [];
  if (isbns.length) queries.push({ q: `isbn:${isbns.slice(0, 5).join(" OR isbn:")}`, byIsbn: true });
  if (isLatin(book.title) && firstAuthor(book.author)) {
    queries.push({ title: mainTitle(book.title), author: firstAuthor(book.author) });
  }
  let doc = null;
  let byIsbn = false;
  for (const q of queries) {
    const params = new URLSearchParams({ fields: FIELDS, limit: "5" });
    if (q.q) params.set("q", q.q);
    else (params.set("title", q.title), params.set("author", q.author));
    const data = await getJson(`${SEARCH}?${params}`, fetchImpl);
    const hits = (data?.docs || []).filter((d) => d.title && same(book, d, q.byIsbn));
    // The best-known edition set first: a cover, then a year, then more ISBNs.
    hits.sort((a, b) => (b.cover_i ? 1 : 0) - (a.cover_i ? 1 : 0) || (a.first_publish_year || 9999) - (b.first_publish_year || 9999) || (b.isbn?.length || 0) - (a.isbn?.length || 0));
    if (hits.length) {
      doc = hits[0];
      byIsbn = !!q.byIsbn;
      break;
    }
  }
  if (!doc) return null;
  const out = { ol: doc.key };
  if (doc.cover_i) out.cover = `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`;
  const found = cleanIsbns(doc.isbn);
  if (found.length) out.isbns = found.slice(0, 40);
  if (doc.first_publish_year) out.published = doc.first_publish_year;
  if (doc.number_of_pages_median) out.pages = doc.number_of_pages_median;
  const langs = (doc.language || []).filter((l) => LANG[l]);
  // Open Library knows the original, not the Ukrainian edition: a Cyrillic-titled book keeps its own language.
  if (langs.length === 1 && !book.language && isLatin(book.title)) out.language = LANG[langs[0]];
  // The description lives on the work, one more request; a short one is worth nothing.
  try {
    const work = await getJson(`https://openlibrary.org${doc.key}.json`, fetchImpl);
    const text = descriptionText(work?.description);
    if (text.length >= 80) out.blurb = text;
    const tags = genresOf(work?.subjects);
    if (tags.length) out.tags = tags;
  } catch {}
  return out;
}

// The same from Google Books: by ISBN, else by title and author, in any script. The thumbnail link is
// turned into the larger cover image; the description comes as HTML.
async function lookupGoogle(book, key, { fetchImpl = fetchV6 } = {}) {
  const isbns = cleanIsbns(book.isbns);
  const author = firstAuthor(book.author);
  const queries = [];
  if (isbns.length) queries.push({ q: `isbn:${isbns[0]}`, byIsbn: true });
  // A plain «title author» first (the form that answers from the server), the field query as a second try.
  if (book.title && author) queries.push({ q: `${mainTitle(book.title)} ${author}` }, { q: `intitle:"${mainTitle(book.title)}" inauthor:"${author}"` });
  let lastError = null;
  for (const q of queries) {
    const params = new URLSearchParams({ q: q.q, maxResults: "5", printType: "books", key });
    let data;
    try {
      data = await getJson(`${GOOGLE}?${params}`, fetchImpl);
    } catch (e) {
      lastError = e; // one form refused, the next may answer
      continue;
    }
    const items = (data?.items || []).map((it) => it.volumeInfo || {}).filter((v) => v.title && same(book, { title: v.title, subtitle: v.subtitle, author_name: v.authors || [] }, q.byIsbn));
    items.sort((a, b) => (b.imageLinks ? 1 : 0) - (a.imageLinks ? 1 : 0) || (b.description ? 1 : 0) - (a.description ? 1 : 0));
    const v = items[0];
    if (!v) continue;
    lastError = null;
    const out = {};
    const thumb = v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail;
    if (thumb) out.cover = thumb.replace(/^http:/, "https:").replace(/&edge=curl/, "").replace(/zoom=1/, "zoom=2");
    const found = cleanIsbns((v.industryIdentifiers || []).filter((i) => /^ISBN/.test(i.type)).map((i) => i.identifier));
    if (found.length) out.isbns = found;
    const year = Number(String(v.publishedDate || "").slice(0, 4));
    if (year > 1400) out.published = year;
    if (v.pageCount > 20) out.pages = v.pageCount;
    if (GLANG[v.language]) out.language = GLANG[v.language];
    const text = descriptionText(String(v.description || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n\n").replace(/<[^>]+>/g, "").replace(/&(#\d+|#x[\da-f]+|quot|amp|nbsp|mdash|ndash|laquo|raquo|hellip|lt|gt|#39|apos);/gi, (m, e) => ({ quot: '"', amp: "&", nbsp: " ", mdash: "—", ndash: "–", laquo: "«", raquo: "»", hellip: "…", lt: "<", gt: ">", "#39": "'", apos: "'" })[e.toLowerCase()] ?? String.fromCodePoint(/^#x/i.test(e) ? parseInt(e.slice(2), 16) : Number(e.slice(1)))));
    if (text.length >= 80) out.blurb = text;
    const tags = genresOf((v.categories || []).flatMap((c) => String(c).split(/\s*\/\s*/)));
    if (tags.length) out.tags = tags;
    if (v.canonicalVolumeLink || v.infoLink) out.google = (v.canonicalVolumeLink || v.infoLink).replace(/^http:/, "https:");
    return out;
  }
  if (lastError) throw lastError;
  return null;
}

// The book as it should be after the lookup: nothing the reader or a catalog set is overwritten.
function apply(book, info) {
  const patch = {};
  if (!book.cover && info.cover) patch.cover = info.cover;
  const isbns = cleanIsbns([...(book.isbns || []), ...(info.isbns || [])]);
  if (isbns.length > (book.isbns || []).length) patch.isbns = isbns;
  if (!book.published && info.published) patch.published = info.published;
  if (!book.pages && info.pages) patch.pages = info.pages;
  if (!book.language && info.language) patch.language = info.language;
  if (!(book.tags || []).length && info.tags?.length) patch.tags = info.tags;
  if (!book.blurb && info.blurb) (patch.blurb = info.blurb), (patch.blurbSource = info.blurbSource || "Open Library");
  const links = [...(book.links || [])];
  const has = (re) => links.some((l) => re.test(l.url));
  // The ISBN-10 of a print edition is its ASIN, so this is the book's Amazon page; the oldest ISBN-10 Open
  // Library lists is usually the original hardcover.
  const ten = isbns.find(isbn10);
  if (ten && !has(/amazon\./)) links.push({ label: "Amazon", url: `https://www.amazon.com/dp/${ten}` });
  if (info.ol && !has(/openlibrary\.org/)) links.push({ label: "Open Library", url: `https://openlibrary.org${info.ol}` });
  if (info.google && !has(/books\.google\./)) links.push({ label: "Google Books", url: info.google });
  if (links.length > (book.links || []).length) patch.links = links;
  if (info.ol && book.ol !== info.ol) patch.ol = info.ol;
  return patch;
}

// Which of the library's own books are worth asking about: no catalog behind them, a Latin title or an
// ISBN to ask by, and something still missing.
function wanting(store, ids, { google = false } = {}) {
  const all = ids ? ids.map((id) => store.lib.books[id]).filter(Boolean) : Object.values(store.lib.books);
  return all.filter((b) => OWN.has(b.source) && (cleanIsbns(b.isbns).length || ((google || isLatin(b.title)) && firstAuthor(b.author))) && !(b.cover && b.published && b.blurb && (b.tags || []).length && cleanIsbns(b.isbns).length));
}

// enrich(store, { ids, log, fetchImpl, force }) -> { asked, found }: looks up the books not asked within a month.
async function enrich(store, { ids, log = () => {}, fetchImpl = fetch, force = false, pause = 1000, max = 300, googleKey = "" } = {}) {
  const books = wanting(store, ids, { google: !!googleKey }).filter((b) => force || Date.now() - Number(store.db.get(`enrich:${GEN}:${b.id}`) || 0) > MONTH).slice(0, max);
  let found = 0;
  let touched = false;
  let failed = 0;
  let googleFailed = 0;
  const errors = [];
  for (const b of books) {
    store.db.set(`enrich:${GEN}:${b.id}`, String(Date.now()));
    try {
      let info = isLatin(b.title) || cleanIsbns(b.isbns).length ? await lookup(b, { fetchImpl }) : null;
      // Google Books fills what Open Library left out, and is the only source for Cyrillic titles.
      if (googleKey && !(info?.cover && info?.blurb && info?.published)) {
        // Google refusing (it answers Fly's servers 503 with a key, 2026-10-21) must not stop Open Library.
        const g = await lookupGoogle(b, googleKey, fetchImpl === fetch ? {} : { fetchImpl }).catch((e) => {
          const why = `${e.name === "TimeoutError" ? "timeout" : ""}${e.cause?.code || e.message}`;
          errors.push(`${b.id} (Google): ${why.slice(0, 80)}`);
          if (++googleFailed >= 3) (log("enrich: Google Books is not answering, going on with Open Library alone"), (googleKey = ""));
          return null;
        });
        if (g) info = { ...g, ...Object.fromEntries(Object.entries(info || {}).filter(([, v]) => v != null)), blurbSource: info?.blurb ? "Open Library" : "Google Books", isbns: cleanIsbns([...(info?.isbns || []), ...(g.isbns || [])]) };
      }
      if (info) {
        const patch = apply(b, info);
        if (Object.keys(patch).length) {
          store.updateBook(b.id, patch);
          touched = true;
          found++;
        }
      }
    } catch (e) {
      const why = `${e.name === "TimeoutError" ? "timeout" : ""}${e.cause?.code || e.message}`;
      log(`enrich ${b.id}: ${why}`);
      errors.push(`${b.id}: ${why}`);
      if (/timeout|HTTP 429|HTTP 5\d\d|ENOTFOUND|ECONNREFUSED|fetch failed/.test(why) && ++failed >= 3) break; // Open Library is away: the rest another time
    }
    if (pause) await new Promise((r) => setTimeout(r, pause));
  }
  if (touched) {
    store._works = null; // new ISBNs: imports and catalog items can find these books now
    store.linkEditions?.();
    store.indexSearch();
  }
  const own = Object.values(store.lib.books).filter((b) => OWN.has(b.source));
  const line = `${new Date().toISOString()}: ${found} of ${books.length} books got details from Open Library${googleKey ? " and Google Books" : ""}; own books ${own.length}, with cover ${own.filter((b) => b.cover).length}, never asked ${wanting(store, null, { google: !!googleKey }).filter((b) => !store.db.get(`enrich:${GEN}:${b.id}`)).length}${errors.length ? `; errors: ${errors.slice(0, 5).join(", ")}` : ""}`;
  log(`enrich ${line}`);
  store.db.set("enrich:log", line); // shown on /refresh-status
  return { asked: books.length, found, errors };
}

// The weekly pass, like wikidata.refreshUk: at most one attempt a week, even when it fails.
async function refresh(store, opts = {}) {
  const at = Number(store.db.get("enrich:at") || 0);
  // Books never asked about (a pass that hit its 300 cap or was cut short by a deploy left them) go at
  // the next tick; otherwise everything is asked again once a week.
  const fresh = wanting(store, null, { google: !!opts.googleKey }).some((b) => !store.db.get(`enrich:${GEN}:${b.id}`));
  if (!fresh && Date.now() - at < WEEK) return false;
  if (!fresh) store.db.set("enrich:at", String(Date.now()));
  await enrich(store, opts);
  return true;
}

// «Шукати» on /add (Max, 2026-10-22: «пошук по зовнішніх каталогах … напів-мануальне наповнення бази»): what
// Open Library has for typed words, as books a reader can put on the shelf: { title, author, cover, isbns,
// published, ol }. Answers are kept for an hour; a failure is an empty list.
const found = new Map();
async function searchOpenLibrary(q, { fetchImpl = fetch, limit = 6 } = {}) {
  q = String(q || "").trim().slice(0, 100);
  if (q.length < 2) return [];
  const hit = found.get(q.toLowerCase());
  if (hit && Date.now() - hit.at < 3600e3) return hit.list;
  let list = [];
  try {
    const params = new URLSearchParams({ q, fields: FIELDS, limit: String(limit * 2) });
    const data = await getJson(`${SEARCH}?${params}`, fetchImpl);
    const seen = new Set();
    for (const d of data?.docs || []) {
      if (!d.title) continue;
      const author = (d.author_name || []).slice(0, 2).join(", ");
      const key = `${norm(d.title)}|${surname(author)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({ title: [d.title, d.subtitle].filter(Boolean).join(": ").slice(0, 200), author, cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : "", isbns: cleanIsbns(d.isbn).slice(0, 20), published: d.first_publish_year || null, ol: d.key || "" });
      if (list.length >= limit) break;
    }
    list.sort((a, b) => (b.cover ? 1 : 0) - (a.cover ? 1 : 0));
  } catch {
    return [];
  }
  if (found.size > 500) found.clear();
  found.set(q.toLowerCase(), { at: Date.now(), list });
  return list;
}

module.exports = { enrich, refresh, lookup, genresOf, searchOpenLibrary, lookupGoogle, apply, wanting, descriptionText, same };

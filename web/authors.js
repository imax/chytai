// Author pages (Max, 2026-10-19: «сторінки авторів… підтягувати їх роботи навіть якщо цих книжок
// немає зараз в продажу чи в перекладі»). An author is every spelling our books use for one person:
// «Stanisław Lem» in a library and «Станіслав Лем» on a shelf are one Wikidata person (Q6530), found by
// name weekly (meta `authors:wd`); a name Wikidata doesn't know stays an author of its own. The page lists
// the person's works from Wikidata (fetched when the page is first opened, kept 30 days in meta
// `authorworks:<qid>`), each linked to our book of it when we have one, then every book of theirs we have.

const ENDPOINT = "https://query.wikidata.org/sparql";
const HEADERS = { "User-Agent": "Chytai/1.0 (https://chytai.org.ua; author pages)", Accept: "application/sparql-results+json" };
const DAY = 86400000;

const norm = (s) => String(s || "").toLowerCase().replace(/^(the|a)\s+/, "").replace(/[’'ʼ`]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const CYR = /[а-яіїєґ]/i;
// «Hunter S. Thompson and Ralph Steadman», «Остап Українець, Мар'ям Найєм» -> each name
const splitAuthors = (a) => String(a || "").split(/\s*[,;]\s*|\s+(?:and|та|&)\s+/).map((s) => s.replace(/\s+/g, " ").trim()).filter((s) => s.length > 2 && !/^(та )?ще \d+$/.test(s));
// «Жадан Сергій» is also looked up as «Сергій Жадан»
const forms = (name) => {
  const w = name.split(" ");
  return w.length === 2 ? [name, `${w[1]} ${w[0]}`] : [name];
};

async function sparql(query, fetchImpl) {
  // POST: thirty names make a URL too long for a GET.
  const r = await fetchImpl(ENDPOINT, { method: "POST", headers: { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ query, format: "json" }), signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()).results.bindings;
}

// Every author name of every work we have -> its Wikidata person: { name: { qid, uk, en } }, weekly.
// A person must have written something on Wikidata, and of namesakes the one with most works wins.
async function refresh(store, { fetchImpl = fetch, log = () => {} } = {}) {
  const at = Number(store.db.get("authors:checked") || 0);
  if (Date.now() - at < 7 * DAY || refresh.running) return false;
  refresh.running = true;
  const names = [...new Set(allWorks(store).flatMap((b) => splitAuthors(b.author)))];
  const found = {};
  let errors = 0;
  let lastError = "";
  for (let i = 0; i < names.length; i += 30) {
    const batch = names.slice(i, i + 30);
    const values = batch.flatMap(forms).map((f) => `${JSON.stringify(f)}@uk ${JSON.stringify(f)}@en`).join(" ");
    try {
      const rows = await sparql(`SELECT ?name ?a (SAMPLE(?uk_) AS ?uk) (SAMPLE(?en_) AS ?en) (COUNT(DISTINCT ?w) AS ?works) WHERE { VALUES ?name { ${values} } { ?a rdfs:label ?name } UNION { ?a skos:altLabel ?name } ?a wdt:P31 wd:Q5. ?w wdt:P50 ?a. OPTIONAL { ?a rdfs:label ?uk_ FILTER(lang(?uk_) = "uk") } OPTIONAL { ?a rdfs:label ?en_ FILTER(lang(?en_) = "en") } } GROUP BY ?name ?a`, fetchImpl);
      for (const name of batch) {
        const best = rows.filter((r) => forms(name).includes(r.name.value)).sort((a, b) => b.works.value - a.works.value)[0];
        if (best) found[name] = { qid: best.a.value.split("/").pop(), uk: best.uk?.value || "", en: best.en?.value || "" };
      }
    } catch (e) {
      errors++;
      lastError = e.cause?.code || e.message;
    }
  }
  const line = `${new Date().toISOString()}: ${Object.keys(found).length} of ${names.length} names found on Wikidata${errors ? `, ${errors} batches failed (${lastError})` : ""}`;
  log(`authors: ${line}`);
  store.db.set("authors:log", line);
  refresh.running = false;
  const batches = Math.ceil(names.length / 30);
  if (errors > batches / 2) return false; // try again at the next round (every 6 hours) instead of in a week
  store.db.set("authors:checked", String(Date.now()));
  store.db.set("authors:wd", JSON.stringify(found));
  store.linkTranslations(); // rebuilds the author index too
  return true;
}

// Works of every kind we know, as { id, author } only (the libraries and each shelf's works; editions
// fold into their work). Kept light: this runs after every catalog refresh on a 256 MB machine.
function allWorks(store) {
  const out = new Map();
  for (const b of store.seedBooks) out.set(b.id, { id: b.id, author: b.author });
  for (const b of Object.values(store.lib.books)) out.set(b.id, { id: b.id, author: b.author });
  for (const [id, { shelf, item }] of store.shelfItems) if (!out.has(id) && store.canonical(id) === id && !store.hidden.has(id) && !shelf.draft) out.set(id, { id, author: item.author });
  return [...out.values()];
}
const authorOf = (store, id) => store.lib.books[id]?.author ?? store.seedBooks.find((b) => b.id === id)?.author ?? store.shelfItems.get(id)?.item.author ?? "";

// The author index: { list, bySlug, byName(name) -> author, ofWork(id) -> [author] }.
function build(store) {
  const { slugify } = require("./store");
  const wd = JSON.parse(store.db.get("authors:wd") || "{}");
  const groups = new Map(); // key -> { key, qid, names: Map(name -> count), ids: Set }
  const keyOfName = new Map();
  const works = allWorks(store);
  const keyOf = (name) => (wd[name] ? `q:${wd[name].qid}` : `n:${norm(forms(name).sort()[0])}`);
  for (const b of works) {
    for (const name of splitAuthors(b.author)) {
      const key = keyOf(name);
      const g = groups.get(key) || groups.set(key, { key, qid: wd[name]?.qid || "", wd: wd[name] || null, names: new Map(), ids: new Set() }).get(key);
      g.names.set(name, (g.names.get(name) || 0) + 1);
      g.ids.add(b.id);
      keyOfName.set(name, key);
    }
  }
  // A translator's spelling Wikidata doesn't know («Мадлен Міллер») joins the person whose book this
  // one translates, when the book has a single author.
  for (const g of [...groups.values()].filter((g) => !g.qid)) {
    const qids = new Set();
    for (const id of g.ids) for (const t of store.translations?.get(id) || []) for (const n of splitAuthors(authorOf(store, t))) if (wd[n]) qids.add(`q:${wd[n].qid}`);
    if (qids.size !== 1 || ![...g.ids].every((id) => splitAuthors(authorOf(store, id)).length === 1)) continue;
    const into = groups.get([...qids][0]);
    for (const [n, c] of g.names) into.names.set(n, (into.names.get(n) || 0) + c), keyOfName.set(n, into.key);
    for (const id of g.ids) into.ids.add(id);
    groups.delete(g.key);
  }
  const bySlug = new Map();
  const list = [];
  for (const g of [...groups.values()].sort((a, b) => b.ids.size - a.ids.size || a.key.localeCompare(b.key))) {
    // Shown as our most used spelling, Cyrillic first; Wikidata's English name as the second line.
    const spellings = [...g.names].sort((a, b) => CYR.test(b[0]) - CYR.test(a[0]) || b[1] - a[1]);
    const name = spellings[0][0];
    const other = [g.wd?.en, ...spellings.map(([n]) => n)].find((n) => n && norm(n) !== norm(name) && !CYR.test(n)) || "";
    let slug = slugify(name);
    while (bySlug.has(slug)) slug += "-2";
    const a = { key: g.key, qid: g.qid, name, other, slug, href: `/author/${slug}`, ids: [...g.ids] };
    bySlug.set(slug, a);
    list.push(a);
  }
  const byKey = new Map(list.map((a) => [a.key, a]));
  return {
    list,
    bySlug,
    byName: (name) => byKey.get(keyOfName.get(name)) || null,
  };
}

// The person's works from Wikidata, newest knowledge kept 30 days: [{ qid, uk, en, orig, year }].
// Editions and translations are left out, and so are works no Wikipedia writes about unless they have a
// Ukrainian name.
async function wikidataWorks(store, qid, { fetchImpl = fetch, log = () => {} } = {}) {
  const key = `authorworks:${qid}`;
  const cached = JSON.parse(store.db.get(key) || "null");
  if (cached && Date.now() - cached.at < 30 * DAY) return cached.works;
  try {
    const rows = await sparql(`SELECT ?w (SAMPLE(?uk_) AS ?uk) (SAMPLE(?en_) AS ?en) (SAMPLE(?orig_) AS ?orig) (MIN(YEAR(?date_)) AS ?year) (SAMPLE(?sl_) AS ?sl) WHERE { ?w wdt:P50 wd:${qid}; wikibase:sitelinks ?sl_. FILTER NOT EXISTS { ?w wdt:P31 wd:Q3331189 } OPTIONAL { ?w rdfs:label ?uk_ FILTER(lang(?uk_) = "uk") } OPTIONAL { ?w rdfs:label ?en_ FILTER(lang(?en_) = "en") } OPTIONAL { ?w wdt:P1476 ?orig_ } OPTIONAL { ?w wdt:P577 ?date_ } } GROUP BY ?w`, fetchImpl);
    const works = rows
      .map((r) => ({ qid: r.w.value.split("/").pop(), uk: r.uk?.value || "", en: r.en?.value || "", orig: r.orig?.value || "", year: Number(r.year?.value) || 0, sl: Number(r.sl?.value) || 0 }))
      .filter((w) => (w.uk || w.en || w.orig) && (w.sl >= 2 || w.uk))
      .sort((a, b) => (a.year || 9999) - (b.year || 9999) || b.sl - a.sl);
    store.db.set(key, JSON.stringify({ at: Date.now(), works }));
    return works;
  } catch (e) {
    log(`authors: works of ${qid}: ${e.cause?.code || e.message}`);
    return cached?.works || [];
  }
}

// Each work with our books of it: the same title in any language, a part of a collection's title
// («Едем. Соларіс. Повернення з зірок»), or a spelling one letter off («Соларіс» / «Соляріс»).
// One letter changed, added or dropped.
function near(a, b) {
  if (Math.abs(a.length - b.length) > 1 || a.length < 6) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return a.slice(i + 1) === b.slice(i + 1) || a.slice(i + 1) === b.slice(i) || a.slice(i) === b.slice(i + 1);
}

function matchWorks(store, author, works) {
  const books = author.ids.map((id) => store.book(id)).filter(Boolean);
  const titles = (b) => {
    const all = [b.title, b.altTitle, store.ukTitles?.[b.id]?.uk, ...(b.editions || []).flatMap((e) => [e.title, e.altTitle])].filter(Boolean);
    return new Set(all.flatMap((t) => [t, t.replace(/\s*\(.*?\)\s*/g, " "), ...t.split(/\.\s+|\s*\(|\)\s*/)]).map(norm).filter((t) => t.length >= 3));
  };
  const index = books.map((b) => ({ b, t: titles(b) }));
  return works.map((w) => {
    const names = [w.uk, w.en, w.orig].map(norm).filter(Boolean);
    const hits = index.filter(({ t }) => names.some((n) => t.has(n) || (n.length >= 6 && [...t].some((x) => near(x, n))))).map(({ b }) => b);
    return { ...w, books: hits };
  });
}

module.exports = { refresh, build, wikidataWorks, matchWorks, splitAuthors };

// Ukrainian titles of the readers' foreign books, from Wikidata (Max, 2026-10-19: «було б класно
// знаходити ці переклади»). One SPARQL query per 40 authors lists their works that have a Ukrainian
// label, with the author's own Ukrainian name; a book whose English title is one of those works gets
// { uk, ukAuthor }. The store then links it to a catalog book of that title and author, or the book
// page names the Ukrainian title when no catalog has it yet. Kept in meta `wikidata:uk`, redone weekly.

const ENDPOINT = "https://query.wikidata.org/sparql";
const HEADERS = { "User-Agent": "Chytai/1.0 (https://chytai.org.ua; translations lookup)", Accept: "application/sparql-results+json" };
const WEEK = 7 * 86400000;

const norm = (s) => String(s || "").toLowerCase().replace(/^(the|a)\s+/, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const firstAuthor = (a) => String(a || "").split(/\s+and\s+|\s*[,&]\s*/)[0].replace(/\s+/g, " ").trim();
// «Wool (Silo)» -> «Wool», «Children of Time: …» -> «Children of Time»
const mainTitle = (t) => String(t || "").replace(/\s*\(.*?\)\s*/g, " ").split(/[:]/)[0].trim();
const isForeign = (t) => /[a-z]/i.test(t) && !/[а-яіїєґ]/i.test(t);

async function query(authors, fetchImpl) {
  const values = authors.map((a) => `${JSON.stringify(a)}@en`).join(" ");
  const sparql = `SELECT ?name ?en ?uk ?auk WHERE { VALUES ?name { ${values} } ?a rdfs:label ?name. ?w wdt:P50 ?a; rdfs:label ?uk. FILTER(lang(?uk) = "uk") ?w rdfs:label ?en. FILTER(lang(?en) = "en") OPTIONAL { ?a rdfs:label ?auk. FILTER(lang(?auk) = "uk") } }`;
  const r = await fetchImpl(ENDPOINT, { method: "POST", headers: { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ query: sparql, format: "json" }), signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()).results.bindings.map((b) => ({ name: b.name.value, en: b.en.value, uk: b.uk.value.replace(/\s*\((роман|книга|повість|збірка)[^)]*\)\s*$/i, ""), ukAuthor: b.auk?.value || "" }));
}

// books: [{ id, title, author }] -> { id: { uk, ukAuthor } }
async function ukTitles(books, { fetchImpl = fetch, log = () => {} } = {}) {
  const foreign = books.filter((b) => isForeign(b.title) && firstAuthor(b.author));
  const authors = [...new Set(foreign.map((b) => firstAuthor(b.author)))];
  const works = new Map(); // author|norm(en) -> { uk, ukAuthor }
  for (let i = 0; i < authors.length; i += 40) {
    try {
      for (const w of await query(authors.slice(i, i + 40), fetchImpl)) {
        const key = `${w.name}|${norm(w.en)}`;
        if (!works.has(key)) works.set(key, { uk: w.uk, ukAuthor: w.ukAuthor });
      }
    } catch (e) {
      log(`wikidata: ${e.cause?.code || e.message}`);
    }
  }
  const out = {};
  for (const b of foreign) {
    for (const t of [b.title, mainTitle(b.title)]) {
      const w = works.get(`${firstAuthor(b.author)}|${norm(t)}`);
      if (w) {
        out[b.id] = w;
        break;
      }
    }
  }
  log(`wikidata: ${Object.keys(out).length} Ukrainian titles for ${foreign.length} foreign books (${authors.length} authors)`);
  return out;
}

// The other way round, for a reader's book typed in Ukrainian («Інферно», Ден Браун): the original's
// English title and the author's English name, so enrich.js can ask Open Library for a cover (it knows
// next to no Ukrainian editions; Google Books refuses Fly). One query per 40 Ukrainian author names.
// books: [{ id, title, author }] -> { id: { en, enAuthor } }
const isCyrillic = (t) => /[а-яіїєґ]/i.test(t);
async function enQuery(authors, fetchImpl) {
  const values = authors.map((a) => `${JSON.stringify(a)}@uk`).join(" ");
  const sparql = `SELECT ?name ?en ?uk ?aen WHERE { VALUES ?name { ${values} } ?a rdfs:label ?name. ?w wdt:P50 ?a; rdfs:label ?uk. FILTER(lang(?uk) = "uk") ?w rdfs:label ?en. FILTER(lang(?en) = "en") OPTIONAL { ?a rdfs:label ?aen. FILTER(lang(?aen) = "en") } }`;
  const r = await fetchImpl(ENDPOINT, { method: "POST", headers: { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ query: sparql, format: "json" }), signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()).results.bindings.map((b) => ({ name: b.name.value, en: b.en.value, uk: b.uk.value.replace(/\s*\((роман|книга|повість|збірка)[^)]*\)\s*$/i, ""), enAuthor: b.aen?.value || "" }));
}
async function enTitles(books, { fetchImpl = fetch, log = () => {} } = {}) {
  const ours = books.filter((b) => isCyrillic(b.title) && isCyrillic(firstAuthor(b.author)));
  const authors = [...new Set(ours.map((b) => firstAuthor(b.author)))];
  const works = new Map(); // author|loose(uk) -> { en, enAuthor }
  const enAuthors = new Map(); // Ukrainian name -> English name
  const loose = (t) => norm(t).replace(/(^|\s)(та|і|й|and)(?=\s|$)/g, "$1i"); // «Янголи та демони» is «Янголи і демони» (\b is ASCII-only)
  for (let i = 0; i < authors.length; i += 40) {
    try {
      for (const w of await enQuery(authors.slice(i, i + 40), fetchImpl)) {
        const key = `${w.name}|${loose(w.uk)}`;
        if (!works.has(key) && w.enAuthor) works.set(key, { en: w.en, enAuthor: w.enAuthor });
        if (w.enAuthor) enAuthors.set(w.name, w.enAuthor);
      }
    } catch (e) {
      log(`wikidata: ${e.cause?.code || e.message}`);
    }
  }
  const out = {};
  for (const b of ours) {
    for (const t of [b.title, mainTitle(b.title), String(b.title).split(/[.]\s/)[0]]) {
      const w = works.get(`${firstAuthor(b.author)}|${loose(t)}`);
      if (w) {
        out[b.id] = w;
        break;
      }
    }
    // «Джерело (Origin)»: the original title is right there in the brackets.
    const inBrackets = /\(([A-Za-z][^()]{1,80})\)/.exec(b.title)?.[1];
    if (!out[b.id] && inBrackets && enAuthors.has(firstAuthor(b.author))) out[b.id] = { en: inBrackets.trim(), enAuthor: enAuthors.get(firstAuthor(b.author)) };
  }
  if (ours.length) log(`wikidata: ${Object.keys(out).length} originals for ${ours.length} Ukrainian-titled books (${authors.length} authors)`);
  return out;
}

// Look them up when the stored answer is older than a week; the store relinks translations after.
async function refreshUk(store, opts = {}) {
  const at = Number(store.db.get("wikidata:at") || 0);
  if (Date.now() - at < WEEK) return false;
  store.db.set("wikidata:at", String(Date.now())); // one attempt a week, even when it fails
  const books = [...store.seedBooks, ...Object.values(store.lib.books)];
  const found = await ukTitles(books, opts);
  store.db.set("wikidata:uk", JSON.stringify(found));
  store.linkTranslations();
  store.indexSearch();
  return true;
}

module.exports = { ukTitles, enTitles, refreshUk, firstAuthor, mainTitle };

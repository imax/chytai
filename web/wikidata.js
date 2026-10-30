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
  const ask = () => fetchImpl(ENDPOINT, { method: "POST", headers: { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ query: sparql, format: "json" }), signal: AbortSignal.timeout(60000) });
  let r = await ask();
  // Too many requests: wait and ask again, as authors.js does (the classics on «Класика» stayed bare, 2026-10-23).
  for (let i = 0; r.status === 429 && i < 3; i++) {
    await new Promise((ok) => setTimeout(ok, (Number(r.headers?.get?.("retry-after")) || 10 * (i + 1)) * 1000));
    r = await ask();
  }
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
  const ask = () => fetchImpl(ENDPOINT, { method: "POST", headers: { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ query: sparql, format: "json" }), signal: AbortSignal.timeout(60000) });
  let r = await ask();
  // Too many requests: wait and ask again, as authors.js does (the classics on «Класика» stayed bare, 2026-10-23).
  for (let i = 0; r.status === 429 && i < 3; i++) {
    await new Promise((ok) => setTimeout(ok, (Number(r.headers?.get?.("retry-after")) || 10 * (i + 1)) * 1000));
    r = await ask();
  }
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

// Series and the volume's number (Max, 2026-10-23: «ніхто не почне рандомно читати шосту книгу з 8»): the
// works of the readers' authors that are part of a series (P179) with an ordinal (P1545), in English or
// Ukrainian, so recommendations offer a series by its first book and a book page lists the volumes in order.
// An edition (Q3331189) is skipped: Czech printings of «Відьмак» sit in a publisher's «Fantasy» series.
// books: [{ id, title, author }] -> { books: { id: { qid, n } }, series: { qid: { name, uk, members: [{ n, en, uk }] } } }
async function seriesQuery(names, fetchImpl) {
  const values = names.map((a) => `${JSON.stringify(a)}@${isCyrillic(a) ? "uk" : "en"}`).join(" ");
  const sparql = `SELECT ?name ?w ?t ?s ?sl ?su ?n WHERE { VALUES ?name { ${values} } ?a rdfs:label ?name. ?w wdt:P50 ?a; p:P179 ?st. ?st ps:P179 ?s; pq:P1545 ?n. FILTER NOT EXISTS { ?w wdt:P31 wd:Q3331189 } ?w rdfs:label ?t. FILTER(lang(?t) = "en" || lang(?t) = "uk") OPTIONAL { ?s rdfs:label ?sl. FILTER(lang(?sl) = "en") } OPTIONAL { ?s rdfs:label ?su. FILTER(lang(?su) = "uk") } }`;
  const r = await fetchImpl(ENDPOINT, { method: "POST", headers: { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ query: sparql, format: "json" }), signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const qid = (u) => u.slice(u.lastIndexOf("/") + 1);
  return (await r.json()).results.bindings.map((b) => ({ name: b.name.value, w: qid(b.w.value), t: b.t.value, lang: b.t["xml:lang"], s: qid(b.s.value), sl: b.sl?.value || "", su: b.su?.value || "", n: Number(b.n.value) || 0 }));
}
// Not a reading order: an author's umbrella over standalone novels (Verne's «Voyages Extraordinaires», 54 of
// them, put a 55-book «Серія» block on «Діти капітана Гранта»; Max, 2026-10-30: «Нащо він тут потрібен?»),
// Scott's «Waverley Novels», or xkcd's thousands of strips. Anything over 20 volumes is taken as such.
const UMBRELLA = new Set(["Q3048935", "Q7975429", "Q13915"]);
const umbrella = (qid, size) => UMBRELLA.has(qid) || size > 20;
async function seriesOf(books, { fetchImpl = fetch, log = () => {} } = {}) {
  const named = books.filter((b) => b.title && firstAuthor(b.author));
  const authors = [...new Set(named.map((b) => firstAuthor(b.author)))];
  const works = new Map(); // wikidata work -> { en, uk, of: Map(series -> n) }
  const series = new Map(); // series -> { name, uk }
  const byTitle = new Map(); // author|norm(title) -> work
  let answered = 0;
  for (let i = 0; i < authors.length; i += 40) {
    try {
      for (const r of await seriesQuery(authors.slice(i, i + 40), fetchImpl)) {
        if (!r.n || (!r.sl && !r.su)) continue;
        const w = works.get(r.w) || works.set(r.w, { en: "", uk: "", of: new Map() }).get(r.w);
        if (r.lang === "uk") w.uk = r.t.replace(/\s*\((роман|книга|повість|збірка)[^)]*\)\s*$/i, "");
        else w.en = r.t;
        w.of.set(r.s, r.n);
        if (!series.has(r.s)) series.set(r.s, { name: r.sl || r.su, uk: r.su });
        byTitle.set(`${r.name}|${norm(r.t)}`, r.w);
      }
      answered++;
    } catch (e) {
      log(`wikidata series: ${e.cause?.code || e.message}`);
    }
  }
  if (authors.length && !answered) throw new Error("wikidata series: no answer"); // asked again on the next tick
  // A work in several numbered series (Mistborn and the Cosmere, the Witcher and its saga) counts in the
  // smallest one with two volumes or more: that is the reading order people mean.
  const size = new Map();
  for (const w of works.values()) for (const s of w.of.keys()) size.set(s, (size.get(s) || 0) + 1);
  const out = { books: {}, series: {} };
  const pick = (w) => [...w.of.keys()].filter((s) => size.get(s) >= 2 && !umbrella(s, size.get(s))).sort((a, b) => size.get(a) - size.get(b))[0];
  for (const b of named) {
    let wid = null;
    for (const t of [b.title, mainTitle(b.title)]) if ((wid = byTitle.get(`${firstAuthor(b.author)}|${norm(t)}`))) break;
    const s = wid && pick(works.get(wid));
    if (!s) continue;
    out.books[b.id] = { qid: s, n: works.get(wid).of.get(s) };
    if (!out.series[s]) {
      const members = [...works.values()].filter((w) => w.of.has(s)).map((w) => ({ n: w.of.get(s), en: w.en, uk: w.uk }));
      out.series[s] = { ...series.get(s), members: members.sort((a, b) => a.n - b.n) };
    }
  }
  log(`wikidata: ${Object.keys(out.books).length} books in ${Object.keys(out.series).length} series (${authors.length} authors)`);
  return out;
}

// Look them up when the stored answer is older than a week; the store relinks translations after.
async function refreshUk(store, opts = {}) {
  const at = Number(store.db.get("wikidata:at") || 0);
  if (Date.now() - at < WEEK) {
    if (store.db.get("wikidata:series")) return false;
    // The series came a few days after the titles (2026-10-23): asked once now, then with them weekly.
    store.db.set("wikidata:series", JSON.stringify(await seriesOf([...store.seedBooks, ...Object.values(store.lib.books)], opts)));
    store.linkTranslations();
    return true;
  }
  store.db.set("wikidata:at", String(Date.now())); // one attempt a week, even when it fails
  const books = [...store.seedBooks, ...Object.values(store.lib.books)];
  const found = await ukTitles(books, opts);
  store.db.set("wikidata:uk", JSON.stringify(found));
  store.db.set("wikidata:series", JSON.stringify(await seriesOf(books, opts)));
  store.linkTranslations();
  store.indexSearch();
  return true;
}

module.exports = { ukTitles, enTitles, seriesOf, umbrella, refreshUk, firstAuthor, mainTitle };

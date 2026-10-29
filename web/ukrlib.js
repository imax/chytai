// «Укрліб» (ukrlib.com.ua) in «Де взяти»: a link to read the text online, on the pages of Ukrainian classics
// whose authors died 70 full years ago (Max, 2026-10-27: «давай спробуємо», «Safe enough»). The site also
// keeps modern translations, audio and texts of living authors with no word on rights, so only its Ukrainian
// library (/books/) is read, and a link goes up only when Wikidata says the author's term is over. An author
// of the USSR who died in 1930–1953 (or was executed) may have been rehabilitated, and then the term runs from
// that: those get no link until someone checks by hand (as on /admin/free). Its own books are not added.
// Once (Max, 2026-10-27: «без перевірок раз на тиждень. що додали то і залишається»): the sitemap's author
// pages (windows-1251, «author.php?id=N[&page=N]»), one a second, saved as it goes so a restart picks up where
// it stopped (meta `ukrlib:index`). Daily the works are matched with ours by author and title, from that copy
// and with no visit to the site (`ukrlib:links`: book id -> text id); a link once made stays.
const { sparql, splitAuthors, allWorks } = require("./authors");
const { isRussian } = require("./store");
const { lastFree } = require("./freebooks");

const BASE = "https://www.ukrlib.com.ua";
const DAY = 86400000;
const UA = "Chytai/1.0 (https://chytai.org.ua; links to public-domain texts)";
const CYR = /[а-яіїєґ]/i;
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));

// «Кайдашева сім’я», «Кайдашева сiм'я» and «Кайдашева сімʼя» are one title; a Latin «i» in a Cyrillic word too.
const norm = (s) => String(s || "").toLowerCase().replace(/[’ʼ'`"«»…]/g, "").replace(/i/g, "і").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
// The title before its subtitle: «Захар Беркут. Образ із громадського життя» is «Захар Беркут».
const head = (s) => norm(String(s || "").split(/[.:;(/]/)[0]);
// A person as the set of their name's words, in any order («Франко Іван» on Укрліб is «Іван Франко» here).
const person = (s) => norm(s).split(" ").filter(Boolean).sort().join(" ");

// An author page: the name and the works ({ text id: title }), without the «most read» box (it repeats
// the list, and on a page of the list it is another page's works).
function parse(html) {
  const name = (/<h1[^>]*>([^<]+)<\/h1>/i.exec(html)?.[1] || "").replace(/\s+/g, " ").trim();
  const works = {};
  // Any spelling of the link (quotes or none, more attributes, tags inside): the first read on 2026-10-27
  // looked for one exact form, found the names and not a single work.
  const body = html.replace(/<ul[^>]*class=["']?popular\b[\s\S]*?<\/ul>/gi, "");
  for (const m of body.matchAll(/<a\s[^>]*?href=["']?(?:\.\/|(?:https?:\/\/[^/"' >]+)?\/books\/)?printit\.php\?tid=(\d+)[^>]*>([\s\S]*?)<\/a>/gi)) {
    const t = m[2].replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
    if (t && !/^Читати повністю/.test(t)) works[m[1]] = t;
  }
  return { name, works };
}

// People by a name in Ukrainian, both word orders: { name: qid }, the namesake with most sitelinks.
async function qidsByName(names, fetchImpl, log) {
  const out = {};
  for (let i = 0; i < names.length; i += 30) {
    const batch = names.slice(i, i + 30);
    const values = batch.flatMap((n) => { const w = n.split(" "); return w.length === 2 ? [n, `${w[1]} ${w[0]}`] : [n]; }).map((n) => `"${n.replace(/["\\]/g, "")}"@uk`).join(" ");
    try {
      const rows = await sparql(`SELECT ?name ?a ?sl WHERE { VALUES ?name { ${values} } { ?a rdfs:label ?name } UNION { ?a skos:altLabel ?name } ?a wdt:P31 wd:Q5; wikibase:sitelinks ?sl. }`, fetchImpl);
      const best = {};
      for (const r of rows) {
        const k = person(r.name.value);
        if (!best[k] || Number(r.sl.value) > best[k].sl) best[k] = { qid: r.a.value.split("/").pop(), sl: Number(r.sl.value) };
      }
      for (const n of batch) if (best[person(n)]) out[n] = best[person(n)].qid;
    } catch (e) {
      log(`names: ${e.cause?.code || e.message}`);
    }
  }
  return out;
}

class Ukrlib {
  constructor({ store, freeBooks, fetchImpl = fetch, log = () => {} }) {
    Object.assign(this, { store, freeBooks, fetchImpl, log, db: store.db });
    this.running = false;
    this.cache = null;
  }

  // The link for a book page, or null. The web process reads the map again every ten minutes.
  linkFor(book) {
    if (!book) return null;
    if (!this.cache || Date.now() - this.cache.at > 10 * 60 * 1000) this.cache = { at: Date.now(), links: JSON.parse(this.db.get("ukrlib:links") || "null")?.links || {} };
    const tid = this.cache.links[this.store.canonical(book.id)] || this.cache.links[book.id];
    return tid ? { label: "Укрліб, читати онлайн", url: `${BASE}/books/printit.php?tid=${tid}` } : null;
  }

  async get(url) {
    const r = await this.fetchImpl(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return new TextDecoder("windows-1251").decode(await r.arrayBuffer());
  }

  // The author pages, read once; false when they have been.
  async crawl() {
    let st = JSON.parse(this.db.get("ukrlib:index") || "null");
    if (st?.done && st.v === 2) return false;
    // v2: the first read kept no works (parse() above), so it is read once more.
    if (!st || st.v !== 2) st = { v: 2, at: Date.now(), authors: {}, pages: null, i: 0 };
    if (!st.pages) {
      const sm = await (await this.fetchImpl(`${BASE}/newsitemap.xml`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(60000) })).text();
      st.pages = [...new Set([...sm.matchAll(/\/books\/author\.php\?id=(\d+)(?:&amp;page=(\d+))?/g)].map((m) => `${m[1]}:${m[2] || 1}`))];
      if (!st.pages.length) throw new Error("no author pages in the sitemap");
    }
    let failed = 0;
    for (; st.i < st.pages.length; st.i++) {
      const [id, page] = st.pages[st.i].split(":");
      try {
        const html = await this.get(`${BASE}/books/author.php?id=${id}${page === "1" ? "" : `&page=${page}`}`);
        const { name, works } = parse(html);
        // A page's links as they came, to see what parse() met (the test copy of the database has it).
        if (st.i === 0 || (!Object.keys(works).length && !this.db.get("ukrlib:sample"))) this.db.set("ukrlib:sample", html.slice(Math.max(0, html.indexOf("printit") - 1500), html.indexOf("printit") + 1500));
        const a = st.authors[id] || (st.authors[id] = { name, works: {} });
        if (name && page === "1") a.name = name;
        Object.assign(a.works, works);
        failed = 0;
      } catch (e) {
        this.log(`ukrlib: ${st.pages[st.i]}: ${e.message}`);
        if (++failed >= 5) break; // the site is down or turned us away: the rest next time
      }
      if (st.i % 50 === 0) this.db.set("ukrlib:index", JSON.stringify(st));
      await wait(1000);
    }
    // Names and no works means parse() missed the links again: not done, so a fix reads it once more.
    const works = Object.values(st.authors).reduce((n, a) => n + Object.keys(a.works).length, 0);
    if (st.i >= st.pages.length && !works) this.log("ukrlib: read all pages and found no works, see ukrlib:sample");
    else if (st.i >= st.pages.length) Object.assign(st, { done: true, at: Date.now() });
    this.db.set("ukrlib:index", JSON.stringify(st));
    return st.done || false;
  }

  qidsByName(names) {
    return qidsByName(names, this.fetchImpl, (m) => this.log(`ukrlib: ${m}`));
  }

  // Our works by an Укрліб author with the same title, kept when the author's term is over.
  async match() {
    const st = JSON.parse(this.db.get("ukrlib:index") || "null");
    if (!st?.authors) return 0;
    const s = this.store;
    const byPerson = new Map(); // name words -> Укрліб author ids
    const byTitle = new Map(); // `${author id}|${title}` -> text id
    for (const [id, a] of Object.entries(st.authors)) {
      if (!a.name || a.name === "Невідомий Автор") continue;
      const k = person(a.name);
      (byPerson.get(k) || byPerson.set(k, []).get(k)).push(id);
      for (const [tid, t] of Object.entries(a.works)) for (const key of [norm(t), head(t)]) if (key && !byTitle.has(`${id}|${key}`)) byTitle.set(`${id}|${key}`, tid);
    }
    const found = [];
    for (const w of allWorks(s)) {
      const b = s.book(w.id);
      if (!b || !CYR.test(b.title) || isRussian(b)) continue;
      const names = splitAuthors(b.author);
      if (names.length !== 1) continue; // one author: an anthology of many is not one text there
      const ids = byPerson.get(person(names[0])) || [];
      for (const uid of ids) {
        const tid = byTitle.get(`${uid}|${norm(b.title)}`) || byTitle.get(`${uid}|${head(b.title)}`);
        if (tid) {
          found.push({ id: w.id, name: names[0], ukName: st.authors[uid].name, tid });
          break;
        }
      }
    }
    // Who the author is: our author index, else Wikidata by the Укрліб spelling.
    const known = {};
    for (const f of found) known[f.ukName] = known[f.ukName] || s.authors?.byName(f.name)?.qid || "";
    Object.assign(known, await this.qidsByName(Object.keys(known).filter((n) => !known[n])));
    const people = await this.freeBooks.people([...new Set(Object.values(known).filter(Boolean))]);
    const last = lastFree();
    const links = JSON.parse(this.db.get("ukrlib:links") || "null")?.links || {};
    let check = 0;
    // A translation is not linked, and one linked before this rule is taken off below (Max, 2026-10-29: the
    // translator's term is another matter, unlike the rest of «що додали то і залишається»).
    for (const f of found) {
      const p = people[known[f.ukName]];
      if (!p?.died || p.died > last) continue;
      if (this.freeBooks.translated(s.book(f.id), p)) {
        delete links[f.id];
        continue;
      }
      if (p.soviet && (p.executed || (p.died >= 1930 && p.died <= 1953))) {
        check++;
        continue;
      }
      links[f.id] = f.tid;
    }
    this.db.set("ukrlib:links", JSON.stringify({ at: Date.now(), links, matched: found.length, check, authors: Object.keys(st.authors).length }));
    this.cache = null;
    this.log(`ukrlib: ${Object.keys(links).length} links (${found.length} matched, ${check} to check by hand)`);
    return Object.keys(links).length;
  }

  async run() {
    if (this.running) return null;
    this.running = true;
    try {
      const fresh = await this.crawl();
      const st = JSON.parse(this.db.get("ukrlib:links") || "null");
      // Matched again after a new read, and daily anyway: new books come every day.
      return fresh || !st || Date.now() - st.at > DAY ? await this.match() : null;
    } finally {
      this.running = false;
    }
  }
}

module.exports = { Ukrlib, parse, norm, head, person, qidsByName };

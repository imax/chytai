// «Слухай» (sluhay.com.ua), a free library of Ukrainian audiobooks (Max, 2026-10-29: «А чи існують безкоштовні
// аудіокниги? Якщо є, давай їх теж додавати»). Made in 2018 by «Типовий Київ» with the Grinchenko University
// on Kyiv's citizens' budget, now kept up by donations: ~500 recordings of its own, mostly classics of the
// school programme, read by actors, hosts and volunteers, free to listen with no account. Like Укрліб
// (ukrlib.js) the site says nothing about rights, so a recording goes up in «Де взяти» only when the author's
// term is over (Wikidata, the rehabilitated waiting for a hand check). It is a line in the «Аудіо» row,
// «Слухай, читає …, безкоштовно»; its own books are not added. Only the page is linked, never the audio file.
// The sitemap lists the books («/<id>:<slug>»); each page is read once, one a second, and a week later the
// sitemap again for new ones (meta `sluhay:index`). Daily the books are matched with ours by author and title
// from that copy (`sluhay:links`: book id -> recording id); a link once made stays.
const { allWorks, splitAuthors } = require("./authors");
const { isRussian } = require("./store");
const { lastFree } = require("./freebooks");
const { norm, head, person, qidsByName } = require("./ukrlib");

const BASE = "https://sluhay.com.ua";
const DAY = 86400000;
const UA = "Chytai/1.0 (https://chytai.org.ua; links to free audiobooks)";
const CYR = /[а-яіїєґ]/i;
// Authors of the USSR who died in 1930–1953 and were never repressed, so never rehabilitated: free like any
// other (checked by hand, 2026-10-29). The repressed wait for 70 years from their rehabilitation (Підмогильний,
// Плужник, Хоткевич 2027; Косинка, Йогансен 2029).
const CHECKED = new Set(["Микола Хвильовий", "Ольга Кобилянська", "Юліан Опільський"].map(person));
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
const text = (s) => s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, "\n").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&quot;/g, '"').replace(/&apos;|&#0?39;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");

// A book page: the block after «Аудіокнига» reads «Автор - Назва», «Автор:», name, «Начитано:», reader,
// «Жанр:», genres between «•», «Час запису:», «04:12:24».
function parse(html) {
  const L = text(html).split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const i = L.indexOf("Аудіокнига");
  if (i < 0) return null;
  const blk = L.slice(i, i + 30);
  const after = (k) => (blk.includes(k) ? blk[blk.indexOf(k) + 1] : "");
  const author = after("Автор:");
  let title = blk[1] || "";
  if (author && title.startsWith(author)) title = title.slice(author.length).replace(/^\s*[-–—]\s*/, "");
  else title = title.split(/\s+[-–—]\s+/).slice(1).join(" - ") || title;
  const genres = [];
  if (blk.includes("Жанр:")) for (let j = blk.indexOf("Жанр:") + 1; j < blk.length && blk[j] !== "Час запису:"; j++) if (blk[j] !== "•") genres.push(blk[j]);
  const t = after("Час запису:").split(":").map(Number);
  const secs = t.length === 3 ? t[0] * 3600 + t[1] * 60 + t[2] : t.length === 2 ? t[0] * 3600 + t[1] * 60 : 0; // «00:40» is 40 minutes
  return { title: title.trim(), author, narrator: after("Начитано:"), genres, secs };
}

const duration = (s) => {
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return s ? [h ? `${h} год` : "", m ? `${m} хв` : ""].filter(Boolean).join(" ") : "";
};

class Sluhay {
  constructor({ store, freeBooks, fetchImpl = fetch, log = () => {} }) {
    Object.assign(this, { store, freeBooks, fetchImpl, log, db: store.db });
    this.running = false;
    this.cache = null;
  }

  // The «Аудіо» line for a book page, or null. The web process reads the map again every ten minutes.
  linkFor(book) {
    if (!book) return null;
    if (!this.cache || Date.now() - this.cache.at > 10 * 60 * 1000) {
      const st = JSON.parse(this.db.get("sluhay:index") || "null");
      this.cache = { at: Date.now(), links: JSON.parse(this.db.get("sluhay:links") || "null")?.links || {}, books: st?.books || {} };
    }
    const sid = this.cache.links[this.store.canonical(book.id)] || this.cache.links[book.id];
    const b = sid && this.cache.books[sid];
    return b ? { name: "Слухай", url: b.url, narrator: b.narrator || "", duration: duration(b.secs) } : null;
  }

  async get(url) {
    const r = await this.fetchImpl(encodeURI(url), { headers: { "User-Agent": UA, "Accept-Language": "uk" }, signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  }

  // The book pages not read yet; false when there was nothing new.
  async crawl() {
    let st = JSON.parse(this.db.get("sluhay:index") || "null");
    if (!st) st = { v: 1, books: {}, todo: null, seen: 0 };
    if (!st.todo || (!st.todo.length && Date.now() - st.seen > 7 * DAY)) {
      const sm = await this.get(`${BASE}/sitemap/0`);
      const urls = [...sm.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => text(m[1])).filter((u) => /^https?:\/\/[^/]+\/\d+:/.test(u));
      if (!urls.length) throw new Error("no books in the sitemap");
      st.todo = urls.filter((u) => !st.books[u.split("/").pop().split(":")[0]]);
      st.seen = Date.now();
    }
    if (!st.todo.length) return false;
    let failed = 0, n = 0;
    while (st.todo.length) {
      const url = st.todo[0];
      try {
        const b = parse(await this.get(url));
        if (b?.title) st.books[url.split("/").pop().split(":")[0]] = { url, ...b };
        st.todo.shift();
        failed = 0;
      } catch (e) {
        this.log(`sluhay: ${url}: ${e.message}`);
        if (++failed >= 5) break; // the site is down or turned us away: the rest next time
        st.todo.push(st.todo.shift());
      }
      if (++n % 50 === 0) this.db.set("sluhay:index", JSON.stringify(st));
      await wait(1000);
    }
    this.db.set("sluhay:index", JSON.stringify(st));
    return true;
  }

  // Our works by the recording's author with the same title, kept when the author's term is over.
  async match() {
    const st = JSON.parse(this.db.get("sluhay:index") || "null");
    if (!st?.books) return 0;
    const s = this.store;
    const byKey = new Map(); // `${person}|${title}` -> recording id; the longest recording of a title wins
    for (const [id, b] of Object.entries(st.books)) {
      if (!CYR.test(b.title) || !b.author || splitAuthors(b.author).length !== 1) continue;
      for (const t of [norm(b.title), head(b.title)]) {
        const k = `${person(b.author)}|${t}`;
        if (t && (!byKey.has(k) || st.books[byKey.get(k)].secs < b.secs)) byKey.set(k, id);
      }
    }
    const found = [];
    for (const w of allWorks(s)) {
      const b = s.book(w.id);
      if (!b || !CYR.test(b.title) || isRussian(b)) continue;
      const names = splitAuthors(b.author);
      if (names.length !== 1) continue;
      const sid = byKey.get(`${person(names[0])}|${norm(b.title)}`) || byKey.get(`${person(names[0])}|${head(b.title)}`);
      if (sid) found.push({ id: w.id, name: names[0], their: st.books[sid].author, sid });
    }
    const known = {};
    for (const f of found) known[f.their] = known[f.their] || s.authors?.byName(f.name)?.qid || "";
    Object.assign(known, await qidsByName(Object.keys(known).filter((n) => !known[n]), this.fetchImpl, (m) => this.log(`sluhay: ${m}`)));
    const people = await this.freeBooks.people([...new Set(Object.values(known).filter(Boolean))]);
    const last = lastFree();
    const links = JSON.parse(this.db.get("sluhay:links") || "null")?.links || {};
    const check = [];
    for (const f of found) {
      const p = people[known[f.their]];
      // An author who did not write in Ukrainian is read in a translation, and the translator's term is another matter.
      if (!p?.died || p.died > last || !p.uk || (p.soviet && (p.executed || (p.died >= 1930 && p.died <= 1953)) && !CHECKED.has(person(f.name)))) {
        check.push(f.id);
        continue;
      }
      links[f.id] = f.sid;
    }
    this.db.set("sluhay:links", JSON.stringify({ at: Date.now(), links, matched: found.length, check, books: Object.keys(st.books).length }));
    this.cache = null;
    this.log(`sluhay: ${Object.keys(links).length} links (${found.length} matched, ${check.length} not free or to check by hand)`);
    return Object.keys(links).length;
  }

  async run() {
    if (this.running) return null;
    this.running = true;
    try {
      const fresh = await this.crawl();
      const st = JSON.parse(this.db.get("sluhay:links") || "null");
      return fresh || !st || Date.now() - st.at > DAY ? await this.match() : null;
    } finally {
      this.running = false;
    }
  }
}

module.exports = { Sluhay, parse };

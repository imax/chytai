// «Вільні книжки з "Хочу прочитати"» (Max, 2026-10-24: «моніторити книжки, які люди додають на "хочу прочитати", і
// дивитись, що з них вже є out of copyright, щоб їх можна було додавати в читалку… список мій в моєму аккаунті»).
// Once a day: every work some reader wants, whose authors Wikidata says died 70 full years ago (Ukrainian law: free
// from 1 January of the 71st year, so in 2026 those who died before 1956). For a translation the original is free,
// the Ukrainian text only when its translator died that long ago too. An author of the USSR who died in 1930–1953
// may have been rehabilitated after death, and then the term runs from the rehabilitation: those are flagged to
// check by hand. For each free one: where a ready text is (uk.wikisource for Ukrainian, Project Gutenberg and
// Standard Ebooks for an original), and whether the reader already has it (seed/free.json).
// No AI: Wikidata and the three sites only. State in meta `free:state`; /admin/free shows it. When the owner
// switches it on, the free ones also go to a list of his («Вільні книжки, які хочуть прочитати»): new ones are
// added, nothing is taken out, and a book he removed is not added again.
const fs = require("fs");
const path = require("path");
const { sparql, splitAuthors } = require("./authors");
const { isRussian, norm, slugify } = require("./store");

const DAY = 86400000;
const UA = "Chytai/1.0 (https://chytai.org.ua; free books check)";
const CYR = /[а-яіїєґ]/i;
const USSR = "wd:Q15180, wd:Q133356"; // the Soviet Union, the Ukrainian SSR
const LIST_TITLE = "Вільні книжки, які хочуть прочитати";
const LIST_NOTE = "Книжки з «Хочу прочитати» читачів Chytai, автори яких померли понад 70 років тому: їхні тексти вже в суспільному надбанні. Список оновлюється сам.";

// The first year whose works are not free yet: died in `year - 71` or before is free on 1 January of `year`.
const lastFree = (now = new Date()) => now.getFullYear() - 71;
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));

function freeFiles() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "seed", "free.json"), "utf8"));
  } catch {
    return [];
  }
}

class FreeBooks {
  // `who(readerId)` is the public reader or null (a deleted account), `lists` the Lists of lists.js.
  constructor({ store, lists, who, ownerId, fetchImpl = fetch, log = () => {} }) {
    Object.assign(this, { store, lists, who, ownerId, fetchImpl, log, db: store.db });
    this.running = false;
  }

  state() {
    return JSON.parse(this.db.get("free:state") || "null");
  }
  listId() {
    return this.db.get("free:list") || "";
  }
  list() {
    return this.listId() ? this.lists.get(this.listId()) : null;
  }

  // Wanted works, a translation and its original as one (shown as the Ukrainian one, as on /popular):
  // [{ book, ids, readers }].
  wanted() {
    const s = this.store;
    const key = (id) => {
      const c = s.canonical(id);
      const tr = s.translations?.get(c);
      return tr?.size ? [c, ...tr].sort()[0] : c;
    };
    const works = new Map();
    for (const [rid, entries] of s.entries) {
      if (!this.who(rid)) continue;
      for (const [id, e] of Object.entries(entries)) {
        if (e.status !== "want") continue;
        const c = s.canonical(id);
        const k = key(c);
        const w = works.get(k) || works.set(k, { ids: new Set(), readers: new Set() }).get(k);
        w.ids.add(c);
        for (const t of s.translations?.get(c) || []) w.ids.add(t);
        w.readers.add(rid);
      }
    }
    const out = [];
    for (const w of works.values()) {
      const books = [...w.ids].map((id) => s.book(id)).filter(Boolean);
      const book = books.find((b) => CYR.test(b.title)) || books[0];
      if (!book || isRussian(book)) continue;
      out.push({ book, books, readers: w.readers.size });
    }
    return out;
  }

  // What we know of a work's original and Ukrainian text: the original's title (Latin, from a paired original,
  // the shop's «Оригінальна назва», altTitle or the originals pass) and the translators of its editions.
  facts(w) {
    const s = this.store;
    const latin = (t) => t && /[a-z]/i.test(t) && !CYR.test(t);
    const raw = [];
    for (const b of w.books) {
      const main = s.shelfItems?.get(b.id);
      if (main) raw.push(main.item);
      for (const e of s.editions?.get(b.id) || []) raw.push(e.item);
    }
    const orig = [...w.books.filter((b) => !CYR.test(b.title)).map((b) => b.title), ...w.books.map((b) => b.altTitle), ...raw.map((i) => i.originalTitle), ...raw.map((i) => i.altTitle), ...w.books.map((b) => s.aiOrigs?.().get(b.id)?.title)].find(latin) || "";
    const translators = [...new Set(raw.filter((i) => CYR.test(i.title || "")).flatMap((i) => splitAuthors(i.translator || "")))];
    const kind = w.books.map((b) => s.aiOrigs?.().get(b.id)?.kind).find(Boolean) || "";
    return { orig, translators, kind };
  }

  // People by Wikidata id: { died, born, soviet, executed, uk } (uk: wrote in Ukrainian), kept 30 days.
  async people(qids) {
    const cache = JSON.parse(this.db.get("free:people") || "{}");
    const stale = qids.filter((q) => !cache[q] || Date.now() - cache[q].at > 30 * DAY);
    for (let i = 0; i < stale.length; i += 50) {
      const batch = stale.slice(i, i + 50);
      try {
        const rows = await sparql(`SELECT ?a (MAX(YEAR(?d)) AS ?died) (MIN(YEAR(?b)) AS ?born) (SAMPLE(?sov_) AS ?sov) (SAMPLE(?ex_) AS ?ex) (SAMPLE(?uk_) AS ?uk) WHERE { VALUES ?a { ${batch.map((q) => `wd:${q}`).join(" ")} } OPTIONAL { ?a wdt:P570 ?d } OPTIONAL { ?a wdt:P569 ?b } OPTIONAL { ?a wdt:P27 ?sov_ FILTER(?sov_ IN (${USSR})) } OPTIONAL { ?a wdt:P1196 ?ex_ FILTER(?ex_ = wd:Q8454) } OPTIONAL { ?a wdt:P1412 ?uk_ FILTER(?uk_ = wd:Q8798) } } GROUP BY ?a`, this.fetchImpl);
        for (const q of batch) cache[q] = { at: Date.now(), died: 0, born: 0 };
        for (const r of rows) {
          const q = r.a.value.split("/").pop();
          cache[q] = { at: Date.now(), died: Number(r.died?.value) || 0, born: Number(r.born?.value) || 0, ...(r.sov ? { soviet: true } : {}), ...(r.ex ? { executed: true } : {}), ...(r.uk ? { uk: true } : {}) };
        }
      } catch (e) {
        this.log(`free: people: ${e.cause?.code || e.message}`);
      }
    }
    this.db.set("free:people", JSON.stringify(cache));
    return cache;
  }

  // Translators by name: { name: { qid, died } }, only when a single person of that name is a human on Wikidata.
  async translators(names) {
    const cache = JSON.parse(this.db.get("free:translators") || "{}");
    const stale = names.filter((n) => !cache[n] || Date.now() - cache[n].at > 30 * DAY);
    for (let i = 0; i < stale.length; i += 30) {
      const batch = stale.slice(i, i + 30);
      try {
        const values = batch.map((n) => `${JSON.stringify(n)}@uk`).join(" ");
        const rows = await sparql(`SELECT ?name ?a (MAX(YEAR(?d)) AS ?died) WHERE { VALUES ?name { ${values} } { ?a rdfs:label ?name } UNION { ?a skos:altLabel ?name } ?a wdt:P31 wd:Q5. OPTIONAL { ?a wdt:P570 ?d } } GROUP BY ?name ?a`, this.fetchImpl);
        for (const n of batch) {
          const people = rows.filter((r) => r.name.value === n);
          cache[n] = people.length === 1 ? { at: Date.now(), qid: people[0].a.value.split("/").pop(), died: Number(people[0].died?.value) || 0 } : { at: Date.now() };
        }
      } catch (e) {
        this.log(`free: translators: ${e.cause?.code || e.message}`);
      }
    }
    this.db.set("free:translators", JSON.stringify(cache));
    return cache;
  }

  async get(url, type = "text") {
    const r = await this.fetchImpl(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return type === "json" ? r.json() : r.text();
  }

  // Where a ready free text is: [{ site, title, url }], kept 30 days per work (a failed look, a day).
  async sources(id, { title, orig, author, surname, ukText }) {
    const key = `free:src:${id}`;
    const cached = JSON.parse(this.db.get(key) || "null");
    if (cached && Date.now() - cached.at < (cached.failed ? DAY : 30 * DAY)) return cached.found;
    const found = [];
    let failed = false;
    const same = (a, b) => {
      const x = norm(a);
      const y = norm(b);
      return x && y && (x === y || x.startsWith(`${y} `) || y.startsWith(`${x} `));
    };
    // uk.wikisource: a page of the work's Ukrainian title («Захар Беркут», «Захар Беркут (Франко)»).
    if (CYR.test(title)) {
      try {
        const j = await this.get(`https://uk.wikisource.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(`intitle:"${title}" ${surname}`)}&srnamespace=0&srlimit=8&format=json`, "json");
        const hit = (j.query?.search || []).find((p) => same(p.title.replace(/\s*\(.*\)\s*$/, ""), title));
        if (hit) found.push({ site: "Вікіджерела", title: hit.title, url: `https://uk.wikisource.org/wiki/${encodeURIComponent(hit.title.replace(/ /g, "_"))}` });
      } catch (e) {
        failed = true;
        this.log(`free: wikisource ${id}: ${e.message}`);
      }
      await wait(1000);
    }
    // The original on Standard Ebooks and Project Gutenberg, by its title and the author's surname.
    if (orig && !ukText) {
      try {
        const html = await this.get(`https://standardebooks.org/ebooks?query=${encodeURIComponent(`${orig} ${surname}`)}`);
        const want = slugify(orig.replace(/^(the|a|an)\s+/i, ""));
        for (const m of html.matchAll(/href="\/ebooks\/([a-z0-9-]+)\/([a-z0-9-]+)"/g)) {
          if (m[1].includes(slugify(surname)) && (m[2] === want || m[2] === slugify(orig))) {
            found.push({ site: "Standard Ebooks", title: orig, url: `https://standardebooks.org/ebooks/${m[1]}/${m[2]}` });
            break;
          }
        }
      } catch (e) {
        failed = true;
        this.log(`free: standard ebooks ${id}: ${e.message}`);
      }
      await wait(1000);
      try {
        const html = await this.get(`https://www.gutenberg.org/ebooks/search/?query=${encodeURIComponent(`${orig} ${surname}`)}`);
        for (const m of html.matchAll(/<li class="booklink">[\s\S]*?href="\/ebooks\/(\d+)"[\s\S]*?<span class="title">([^<]*)<\/span>(?:\s*<span class="subtitle">([^<]*)<\/span>)?/g)) {
          const t = m[2].replace(/&amp;/g, "&").replace(/&#39;|&#x27;/g, "'");
          if (same(t.split(/[:;]/)[0], orig) && norm(m[3] || "").includes(norm(surname))) {
            found.push({ site: "Gutenberg", title: t, url: `https://www.gutenberg.org/ebooks/${m[1]}` });
            break;
          }
        }
      } catch (e) {
        failed = true;
        this.log(`free: gutenberg ${id}: ${e.message}`);
      }
      await wait(1000);
    }
    this.db.set(key, JSON.stringify({ at: Date.now(), found, ...(failed ? { failed: true } : {}) }));
    return found;
  }

  async run() {
    if (this.running) return null;
    this.running = true;
    try {
      const s = this.store;
      const last = lastFree();
      const works = this.wanted();
      const authorsOf = (b) => splitAuthors(b.authorOrig || b.author).map((n) => ({ name: n, qid: s.authors?.byName(n)?.qid || "" }));
      const qids = [...new Set(works.flatMap((w) => authorsOf(w.book).map((a) => a.qid)).filter(Boolean))];
      const people = await this.people(qids);
      const inReader = new Map(freeFiles().map((f) => [norm(f.title), f.name]));
      const items = [];
      let unknown = 0;
      for (const w of works) {
        const as = authorsOf(w.book);
        if (!as.length || as.some((a) => !a.qid || !people[a.qid]?.died)) {
          if (!as.length || as.some((a) => !a.qid)) unknown++;
          continue; // an author we can't tell, or one alive (no death date): not free
        }
        const died = Math.max(...as.map((a) => people[a.qid].died));
        if (died > last + 2) continue;
        const f = this.facts(w);
        // The book is the author's own Ukrainian text when it says so, or when its author wrote in Ukrainian and
        // nobody calls it a translation.
        const ukText = CYR.test(w.book.title) && (f.kind === "ukrainian" || (f.kind !== "translation" && as.every((a) => people[a.qid].uk)));
        const check = as.some((a) => people[a.qid].soviet && (people[a.qid].executed || (people[a.qid].died >= 1930 && people[a.qid].died <= 1953)));
        items.push({ id: w.book.id, title: w.book.title, author: w.book.author, href: w.book.href, readers: w.readers, died, freeFrom: died + 71, born: Math.min(...as.map((a) => people[a.qid].born || 9999)), ukText, check, orig: ukText ? "" : f.orig, translators: ukText ? [] : f.translators, inReader: inReader.get(norm(w.book.title)) || (f.orig && inReader.get(norm(f.orig))) || "" });
      }
      // Translators of the free originals: is the Ukrainian text free too?
      const tr = await this.translators([...new Set(items.flatMap((x) => x.translators))]);
      for (const x of items) {
        x.translatorsDied = x.translators.map((n) => tr[n]?.died || 0);
        x.ukFree = x.ukText || (x.translators.length > 0 && x.translatorsDied.every((d) => d && d <= last));
      }
      for (const x of items.filter((x) => x.died <= last)) {
        const surname = (x.author.split(/[,;]/)[0].trim().split(" ").pop() || "").replace(/[^\p{L}-]/gu, "");
        const latinSurname = (s.book(x.id)?.authorOrig || s.authors?.byName(x.author.split(/[,;]/)[0].trim())?.other || "").split(/[,;]/)[0].trim().split(" ").pop() || surname;
        x.sources = await this.sources(x.id, { title: x.title, orig: x.orig, author: x.author, surname: x.ukText ? surname : latinSurname, ukText: x.ukText });
      }
      items.sort((a, b) => b.readers - a.readers || a.died - b.died);
      const st = { at: new Date().toISOString(), last, wanted: works.length, unknown, items };
      this.db.set("free:state", JSON.stringify(st));
      const added = this.syncList(st);
      this.log(`free: ${works.length} wanted, ${items.filter((x) => x.died <= last).length} free, ${unknown} with unknown authors${added ? `, ${added} added to the list` : ""}`);
      return st;
    } finally {
      this.running = false;
    }
  }

  // The line under a book in the owner's list.
  why(x) {
    const want = `хочуть прочитати: ${x.readers}`;
    if (x.ukText) return [`Автор помер ${x.died}`, x.sources?.some((s) => s.site === "Вікіджерела") ? "текст є на Вікіджерелах" : "", want].filter(Boolean).join(" · ");
    const sites = (x.sources || []).map((s) => s.site);
    return [`Оригінал вільний: автор помер ${x.died}`, sites.length ? `є на ${sites.join(" і ")}` : "", x.ukFree ? "український переклад теж вільний" : "український переклад, мабуть, ще захищений", want].filter(Boolean).join(" · ");
  }

  // New free books go to the end of the owner's list (when it is on); a book once added and then removed by
  // him stays out. Books to check by hand (a possible rehabilitation) wait for him on /admin/free.
  syncList(st = this.state()) {
    const l = this.list();
    if (!l || !st) return 0;
    const done = new Set(JSON.parse(this.db.get("free:listed") || "[]"));
    let n = 0;
    for (const x of st.items) {
      if (x.died > st.last || x.check || done.has(x.id)) continue;
      if (this.lists.add(l.id, x.id, this.why(x))) n++;
      done.add(x.id);
    }
    this.db.set("free:listed", JSON.stringify([...done]));
    return n;
  }

  // The owner's switch: on makes the list (once) and fills it, off only stops adding (the list stays his).
  setList(on) {
    if (!on) return this.db.set("free:list", "");
    let l = this.list() || this.lists.of(this.ownerId).find((x) => x.title === LIST_TITLE);
    if (!l) l = this.lists.create(this.ownerId, { title: LIST_TITLE, note: LIST_NOTE });
    this.db.set("free:list", l.id);
    this.syncList();
    return this.list();
  }

  // The state as plain text, for Claude (behind the owner's /claude/<key> link).
  text() {
    const st = this.state();
    if (!st) return this.running ? "Ще рахую…" : "Ще не перевіряли.";
    const line = (x) => `${x.title} — ${x.author} (${x.born < 9999 ? `${x.born}–` : "п. "}${x.died}) | хочуть ${x.readers}${x.ukText ? " | український текст" : ` | оригінал: ${x.orig || "?"} | перекладачі: ${x.translators.map((t, i) => `${t}${x.translatorsDied[i] ? ` п. ${x.translatorsDied[i]}` : ""}`).join(", ") || "?"}${x.ukFree ? " (вільний)" : ""}`}${x.check ? " | ПЕРЕВІРИТИ РЕАБІЛІТАЦІЮ" : ""}${x.inReader ? " | уже в Читалці" : ""}${(x.sources || []).map((s) => ` | ${s.site}: ${s.url}`).join("")}`;
    const free = st.items.filter((x) => x.died <= st.last);
    return [
      `${st.at}: книжок у «Хочу прочитати» ${st.wanted}, вільних ${free.length}, автора не знаємо у ${st.unknown}. Вільні: автор помер у ${st.last} або раніше.${this.list() ? ` Список: https://chytai.org.ua${this.list().href}` : " Список у акаунті вимкнено."}`,
      "",
      "## Вільні",
      ...free.map(line),
      "",
      "## Звільняться скоро",
      ...st.items.filter((x) => x.died > st.last).map((x) => `${line(x)} | з 1 січня ${x.freeFrom}`),
    ].join("\n");
  }
}

module.exports = { FreeBooks, lastFree, LIST_TITLE };

// Public libraries whose catalogs a program may read: where a book can be borrowed.
// Both run Koha, which answers a search as RSS (opac-search.pl?…&format=rss) and lists a record's
// copies, with the branch and whether each is on loan, through its public REST API
// (/api/v1/public/biblios/<id>/items). Neither has a robots.txt that forbids this.
// Survey of the others: /mnt/project-files/chytai-web/catalogs/libraries.md (most forbid robots).
// Kyiv: the union catalog of the Лесі Українки public library (ALEPH 500, base LUL01), with the books of
// all 90 public libraries for adults since 1992. Its robots.txt forbids robots, so it is draft (owner only)
// while Max talks to the library (they allowed links to it on 2026-10-20). Its X-Server answers a search
// as XML (/X?op=find, op=present) and lists a record's copies (op=item-data): a branch («Branch39»,
// collection 039) has no loans in the system, so only that it holds a copy is known; the central library
// («Loan Dep.», «Stock usage Dep.») shows whether a copy is out. Branch names come from the copies page.
// A book is looked up when its page asks (/api/libraries/:id), by ISBN, or by title and author when
// it has none, and the answer is kept for a day.

const LIBRARIES = [
  { id: "cherkasy", name: "Черкаські міські бібліотеки", city: "Черкаси", base: "https://opac.lib.cherkasy.ua" },
  { id: "uzhhorod", name: "Ужгородська публічна бібліотека", city: "Ужгород", base: "https://lib.itc.gov.ua" },
  { id: "kyiv", kind: "aleph", name: "Бібліотеки Києва", city: "Київ", base: "http://alpha.lukl.kyiv.ua", home: "http://alpha.lukl.kyiv.ua/F", draft: true },
];

const HEADERS = { "User-Agent": "Mozilla/5.0 (Chytai library lookup; chytai.org.ua)" };
const DAY = 86400000;

const ent = (s) => String(s || "").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(n)).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const tag = (xml, name) => ent(((xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)) || [])[1] || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).trim();
const norm = (s) => String(s || "").toLowerCase().replace(/[’'ʼ`]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
// «Бібліотека Лесі Українки абонемент (Хрещатик,200)» -> «Бібліотека Лесі Українки (Хрещатик,200)»:
// a branch's departments are one place for a reader.
const branchName = (s) => s.replace(/\s+(абонемент|читальний зал|інтернет-центр|комплектування|(сектор|відділ|методичний відділ)\b[^(]*?)\s*(?=\()/i, " ").replace(/\s+/g, " ").trim();

async function get(url, fetchImpl, as = "text") {
  const r = await fetchImpl(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return as === "json" ? r.json() : r.text();
}

// RSS search -> [{ biblio, title, desc }]
async function search(lib, params, fetchImpl) {
  const xml = await get(`${lib.base}/cgi-bin/koha/opac-search.pl?${new URLSearchParams({ ...params, format: "rss", count: "10" })}`, fetchImpl);
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => ({
    biblio: (tag(m[1], "link").match(/biblionumber=(\d+)/) || [])[1],
    title: tag(m[1], "title").replace(/\s*[/:]\s*$/, ""),
    desc: tag(m[1], "description").replace(/<[^>]+>/g, " ").replace(/\s+/g, " "),
  })).filter((x) => x.biblio);
}

const branches = new Map(); // library id -> { at, names: Map(branch id -> name) }
async function branchNames(lib, fetchImpl) {
  const c = branches.get(lib.id);
  if (c && Date.now() - c.at < 7 * DAY) return c.names;
  const list = await get(`${lib.base}/api/v1/public/libraries?_per_page=500`, fetchImpl, "json");
  const names = new Map(list.map((l) => [l.library_id, branchName(l.name)]));
  branches.set(lib.id, { at: Date.now(), names });
  return names;
}

const isbnsOf = (book) => [...new Set([book.isbn, ...(book.editions || []).map((e) => e.isbn)].map((s) => String(s || "").replace(/[^\dX]/gi, "")).filter((s) => s.length >= 10))].slice(0, 4);
const surnameOf = (book) => norm(String(book.author || "").split(/,|\sта\s|\sі\s/)[0]).split(" ").pop();

// One library's holdings of a book: the matching records, each with its copies by branch.
async function lookupOne(lib, book, fetchImpl) {
  if (lib.kind === "aleph") return lookupAleph(lib, book, fetchImpl);
  const isbns = isbnsOf(book);
  let found = [];
  for (const isbn of isbns) found.push(...(await search(lib, { idx: "nb", q: isbn }, fetchImpl)));
  if (!found.length && book.title) {
    // No ISBN (or none of them there): the same title, and the author's surname in the record.
    const titles = [book.title, book.altTitle].filter(Boolean).map(norm);
    const surname = surnameOf(book);
    const hits = await search(lib, { idx: "ti", q: book.title.replace(/[«»"]/g, "") }, fetchImpl);
    found = hits.filter((h) => titles.includes(norm(h.title)) && (!surname || norm(h.desc).includes(surname)));
  }
  const seen = new Set();
  found = found.filter((h) => !seen.has(h.biblio) && seen.add(h.biblio)).slice(0, 3);
  if (!found.length) return null;
  const names = await branchNames(lib, fetchImpl);
  const records = [];
  for (const h of found) {
    const items = await get(`${lib.base}/api/v1/public/biblios/${h.biblio}/items`, fetchImpl, "json");
    const by = new Map();
    for (const it of items) {
      if (it.withdrawn || it.lost_status) continue;
      const branch = names.get(it.holding_library_id || it.home_library_id) || it.home_library_id;
      const b = by.get(branch) || { branch, total: 0, onShelf: 0 };
      b.total++;
      if (!it.checked_out_date && !it.not_for_loan_status && !it.effective_not_for_loan_status) b.onShelf++;
      by.set(branch, b);
    }
    if (by.size) records.push({ title: h.title, url: `${lib.base}/cgi-bin/koha/opac-detail.pl?biblionumber=${h.biblio}`, branches: [...by.values()] });
  }
  return records.length ? { id: lib.id, name: lib.name, city: lib.city, records } : null;
}

// ---- ALEPH (Kyiv) ----

// The catalog types some Cyrillic letters as their Latin twins («Kaтepини Бiлokyp»).
const LATIN = { a: "а", c: "с", e: "е", i: "і", k: "к", o: "о", p: "р", x: "х", y: "у", A: "А", B: "В", C: "С", E: "Е", H: "Н", I: "І", K: "К", M: "М", O: "О", P: "Р", T: "Т", X: "Х" };
const cyr = (s) => s.replace(/[\p{L}.]+/gu, (w) => (/[а-яіїєґ]/i.test(w) || /^[aceikopxyABCEHIKMOPTX]\.?$/.test(w) ? w.replace(/[aceikopxyABCEHIKMOPTX]/g, (c) => LATIN[c]) : w));
// «ім. М.Бажана» -> «Бібліотека ім. М. Бажана», «№ 138» -> «Бібліотека № 138».
const alephBranch = (s) => {
  const n = cyr(ent(s)).replace(/\.(?=\S)/g, ". ").replace(/\s+/g, " ").trim();
  return /^(ім\.|№)/.test(n) ? `Бібліотека ${n}` : n;
};
const alephNames = new Map(); // collection code («039») -> branch name, gathered from the copies pages

async function alephFind(lib, request, fetchImpl) {
  const f = await get(`${lib.base}/X?op=find&base=LUL01&request=${encodeURIComponent(request)}`, fetchImpl);
  const set = (f.match(/<set_number>(\d+)/) || [])[1];
  const n = +((f.match(/<no_records>(\d+)/) || [])[1] || 0);
  if (!set || !n) return [];
  const p = await get(`${lib.base}/X?op=present&set_number=${set}&set_entry=1-${Math.min(n, 10)}`, fetchImpl);
  return [...p.matchAll(/<record>([\s\S]*?)<\/record>/g)]
    .map((m) => {
      const field = (id, label) => ent((m[1].match(new RegExp(`<varfield id="${id}"[^>]*>[\\s\\S]*?<subfield label="${label}">([^<]*)`)) || [])[1] || "").trim();
      return { doc: tag(m[1], "doc_number"), title: field("245", "a").replace(/\s*[/:;]\s*$/, ""), author: field("100", "a"), article: /varfield id="773"/.test(m[1]) };
    })
    .filter((r) => r.doc && !r.article);
}

async function lookupAleph(lib, book, fetchImpl) {
  let found = [];
  for (const isbn of isbnsOf(book)) found.push(...(await alephFind(lib, `020=${isbn}`, fetchImpl)));
  if (!found.length && book.title) {
    const titles = [book.title, book.altTitle].filter(Boolean).map(norm);
    const surname = surnameOf(book);
    const words = norm(book.title).split(" ").filter((w) => w.length > 1).slice(0, 6).join(" ");
    if (!words) return null;
    const hits = await alephFind(lib, `wti=(${words})${surname ? ` and wau=${surname}` : ""}`, fetchImpl);
    found = hits.filter((h) => titles.includes(norm(h.title)) && (!surname || norm(h.author).includes(surname)));
  }
  const seen = new Set();
  found = found.filter((h) => !seen.has(h.doc) && seen.add(h.doc)).slice(0, 3);
  const records = [];
  for (const h of found) {
    const xml = await get(`${lib.base}/X?op=item-data&base=LUL01&doc_number=${h.doc}`, fetchImpl);
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => ({ sub: tag(m[1], "sub-library"), code: tag(m[1], "collection"), due: tag(m[1], "loan-due-date") }));
    if (items.some((it) => it.code && !alephNames.has(it.code))) {
      const html = await get(`${lib.base}/F/?func=item-global&doc_library=LUL01&doc_number=${h.doc}`, fetchImpl);
      for (const m of html.matchAll(/<option value=(\d{3})>([^<]+)</g)) alephNames.set(m[1], alephBranch(m[2]));
    }
    const by = new Map();
    for (const it of items) {
      // The central library's lending desk and its stacks (a copy there is ordered to the desk).
      const central = it.sub === "Loan Dep." || it.sub === "Stock usage Dep.";
      const branch = central ? "Бібліотека ім. Лесі Українки" : alephNames.get(it.code) || it.sub;
      const b = by.get(branch) || { branch, total: 0, onShelf: 0, unknown: 0 };
      b.total++;
      if (!it.due) central ? b.onShelf++ : b.unknown++; // a branch's loans are not in the catalog
      by.set(branch, b);
    }
    if (by.size) records.push({ title: h.title, url: `${lib.home}/?func=direct&doc_number=${h.doc}&local_base=LUL01`, branches: [...by.values()] });
  }
  return records.length ? { id: lib.id, name: lib.name, city: lib.city, records } : null;
}

// Every library's holdings of a book, from the cache when it is less than a day old.
async function holdings(db, book, { fetchImpl = fetch, log = () => {}, includeDraft = false } = {}) {
  db.exec("CREATE TABLE IF NOT EXISTS library_cache (key TEXT PRIMARY KEY, data TEXT NOT NULL, at INTEGER NOT NULL)");
  const out = [];
  await Promise.all(
    LIBRARIES.filter((l) => includeDraft || !l.draft).map(async (lib) => {
      const key = `${lib.id}:${book.id}`;
      const row = db.prepare("SELECT data, at FROM library_cache WHERE key = ?").get(key);
      if (row && Date.now() - row.at < DAY) return void (row.data !== "null" && out.push(JSON.parse(row.data)));
      try {
        const r = await lookupOne(lib, book, fetchImpl);
        db.prepare("INSERT OR REPLACE INTO library_cache (key, data, at) VALUES (?, ?, ?)").run(key, JSON.stringify(r), Date.now());
        if (r) out.push(r);
      } catch (e) {
        log(`libraries: ${lib.id}: ${e.cause?.code || e.message}`);
        if (row && row.data !== "null") out.push(JSON.parse(row.data)); // a stale answer beats none
      }
    })
  );
  return out.sort((a, b) => LIBRARIES.findIndex((l) => l.id === a.id) - LIBRARIES.findIndex((l) => l.id === b.id));
}

module.exports = { LIBRARIES, holdings, branchName, alephBranch };

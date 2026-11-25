// Public libraries whose catalogs a program may read: where a book can be borrowed.
// Both run Koha, which answers a search as RSS (opac-search.pl?…&format=rss) and lists a record's
// copies, with the branch and whether each is on loan, through its public REST API
// (/api/v1/public/biblios/<id>/items). Neither has a robots.txt that forbids this.
// Survey of the others: /mnt/project-files/chytai-web/catalogs/libraries.md (most forbid robots).
// Kyiv: the union catalog of the Лесі Українки public library (ALEPH 500, base LUL01), with the books of
// all 90 public libraries for adults since 1992. Its robots.txt forbids robots; the library allowed
// Chytai to link to it on 2026-10-20 and to query it «в тестовому режимі», gently, on 2026-10-21. Its X-Server answers a search
// as XML (/X?op=find, op=present) and lists a record's copies (op=item-data): a branch («Branch39»,
// collection 039) has no loans in the system, so only that it holds a copy is known; the central library
// («Loan Dep.», «Stock usage Dep.») shows whether a copy is out. Branch names come from the copies page.
// A book is looked up when its page asks (/api/libraries/:id), by ISBN, or by title and author when
// it has none, and the answer is kept for a day.

const LIBRARIES = [
  { id: "cherkasy", name: "Черкаські міські бібліотеки", city: "Черкаси", base: "https://opac.lib.cherkasy.ua" },
  { id: "uzhhorod", name: "Ужгородська публічна бібліотека", city: "Ужгород", base: "https://lib.itc.gov.ua" },
  { id: "kyiv", kind: "aleph", name: "Бібліотека ім. Лесі Українки", city: "Київ", base: "http://alpha.lukl.kyiv.ua", home: "http://alpha.lukl.kyiv.ua/F", v: 3, ttl: 3 * 86400000, perHour: 120 },
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

// The catalog types some Cyrillic letters as their Latin twins («Kaтepини Бiлokyp», «Б-ka», «Слабошnuцького»):
// in a name that has Cyrillic, every Latin letter that has a twin becomes it.
const LATIN = { a: "а", c: "с", e: "е", i: "і", k: "к", n: "п", o: "о", p: "р", u: "и", x: "х", y: "у", A: "А", B: "В", C: "С", E: "Е", H: "Н", I: "І", K: "К", M: "М", O: "О", P: "Р", T: "Т", X: "Х" };
const cyr = (s) => (/[а-яіїєґ]/i.test(s) ? s.replace(/[acekinopuxyABCEHIKMOPTX]/g, (c) => LATIN[c]) : s);
// «ім. М.Бажана» -> «Бібліотека ім. М. Бажана», «Б-ка Всесвіт» -> «Бібліотека Всесвіт»; a name the catalog
// keeps only in English («Dostoyevsky Library») is not one a Kyiv reader would look for, so it is left out.
const alephBranch = (s) => {
  const n = cyr(ent(s)).replace(/\.(?=\S)/g, ". ").replace(/^Б-ка\s+/, "Бібліотека ").replace(/\s+/g, " ").trim();
  if (!/[а-яіїєґ]/i.test(n)) return null;
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
      for (const it of items) if (it.code && !alephNames.has(it.code)) alephNames.set(it.code, null); // not asked again
    }
    const by = new Map();
    for (const it of items) {
      // The central library's lending desk and its stacks (a copy there is ordered to the desk).
      const central = it.sub === "Loan Dep." || it.sub === "Stock usage Dep.";
      const branch = central ? "центральна (Кониського, 83/85)" : alephNames.get(it.code);
      if (!branch) continue; // «Moved collection» and the like
      const b = by.get(branch) || { branch, total: 0, onShelf: 0, unknown: 0 };
      b.total++;
      if (!it.due) central ? b.onShelf++ : b.unknown++; // a branch's loans are not in the catalog
      by.set(branch, b);
    }
    if (by.size) records.push({ title: h.title, url: `${lib.home}/?func=direct&doc_number=${h.doc}&local_base=LUL01`, branches: [...by.values()] });
  }
  return records.length ? { id: lib.id, name: lib.name, city: lib.city, records } : null;
}

// A library that asked us to go easy on its server (Kyiv, 2026-10-21: «сподіваємось, що кількість запитів
// не перенавантажить наш сервер») gets at most perHour lookups an hour, one at a time. The count is in the database,
// so the web process (book pages) and the background fill for «Хочу прочитати» in the reader share it; the fill takes
// only up to `cap` of it, so book pages keep the rest.
function allowed(db, lib, cap = lib.perHour) {
  if (!lib.perHour) return true;
  const hour = Math.floor(Date.now() / 3600000);
  db.prepare("INSERT OR IGNORE INTO library_budget (lib, hour, used) VALUES (?, ?, 0)").run(lib.id, hour);
  const r = db.prepare("UPDATE library_budget SET used = CASE WHEN hour = ? THEN used + 1 ELSE 1 END, hour = ? WHERE lib = ? AND (hour <> ? OR used < ?)").run(hour, hour, lib.id, hour, cap);
  return r.changes > 0;
}
const queues = new Map(); // library id -> the lookup running now
function gate(lib, fn) {
  if (!lib.perHour) return fn();
  const run = (queues.get(lib.id) || Promise.resolve()).then(fn, fn);
  queues.set(lib.id, run.catch(() => {}));
  return run;
}

function tables(db) {
  if (tables.done) return;
  db.exec("CREATE TABLE IF NOT EXISTS library_cache (key TEXT PRIMARY KEY, data TEXT NOT NULL, at INTEGER NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS library_budget (lib TEXT PRIMARY KEY, hour INTEGER NOT NULL, used INTEGER NOT NULL)");
  tables.done = true;
}
const keyOf = (lib, id) => `${lib.id}${lib.v ? `@${lib.v}` : ""}:${id}`; // v: bumped when a library's answers change shape
// Answers older than 60 days go (once a day): a book nobody opened since is asked again when someone does.
let swept = 0;
function sweep(db) {
  if (Date.now() - swept < DAY) return;
  swept = Date.now();
  db.prepare("DELETE FROM library_cache WHERE at < ?").run(Date.now() - 60 * DAY);
}

// One library's answer for a book: from the cache when fresh, else asked (within the budget), else a stale one.
async function one(db, lib, book, { fetchImpl = fetch, log = () => {}, cap, counted = false } = {}) {
  const key = keyOf(lib, book.id);
  const row = db.prepare("SELECT data, at FROM library_cache WHERE key = ?").get(key);
  const kept = row && row.data !== "null" ? JSON.parse(row.data) : null;
  if (row && Date.now() - row.at < (lib.ttl || DAY)) return kept;
  if (!counted && !allowed(db, lib, cap)) return kept; // over budget: a stale answer or none
  try {
    const r = await gate(lib, () => lookupOne(lib, book, fetchImpl));
    db.prepare("INSERT OR REPLACE INTO library_cache (key, data, at) VALUES (?, ?, ?)").run(key, JSON.stringify(r), Date.now());
    return r;
  } catch (e) {
    log(`libraries: ${lib.id}: ${e.cause?.code || e.message}`);
    return kept; // a stale answer beats none
  }
}

// Every library's holdings of a book, from the cache when it is less than a day old.
async function holdings(db, book, { fetchImpl = fetch, log = () => {}, includeDraft = false } = {}) {
  tables(db);
  sweep(db);
  const out = (await Promise.all(LIBRARIES.filter((l) => includeDraft || !l.draft).map((lib) => one(db, lib, book, { fetchImpl, log })))).filter(Boolean);
  return out.sort((a, b) => LIBRARIES.findIndex((l) => l.id === a.id) - LIBRARIES.findIndex((l) => l.id === b.id));
}

// ---- «Мої бібліотеки» in the reader's «Хочу прочитати» (Max 2026-11-25) ----

// A branch as a reader picks it: Черкаси's departments («Бібліотека №9 абонемент старшого шкільного віку 5-9 класи
// (Сумгаїтська,24/1)») are one place, «Бібліотека №9 (Сумгаїтська,24/1)»; the stored pick and the data both go through it.
const place = (s) =>
  String(s || "")
    .replace(/\s+(молодш\S*|старш\S*|абонемент|читальний зал|сектор|відділ)[^(]*?(?=\s*\()/i, "")
    .replace(/^центральна \(/, "Бібліотека ім. Лесі Українки (") // Kyiv's central library, as lookupAleph names it
    .replace(/\s+/g, " ")
    .trim();

// The branches readers can pick: every one that held a book someone asked about, with how many books (a day's copy).
let branchCache = null;
function branchList(db) {
  tables(db);
  if (branchCache && Date.now() - branchCache.at < 3600000) return branchCache.list;
  const list = LIBRARIES.filter((l) => !l.draft).map((lib) => {
    const n = new Map();
    const prefix = keyOf(lib, "");
    for (const r of db.prepare("SELECT data FROM library_cache WHERE key >= ? AND key < ? AND data != 'null'").iterate(prefix, `${prefix}\uffff`)) {
      const names = new Set();
      for (const rec of JSON.parse(r.data).records || []) for (const b of rec.branches || []) if (/[а-яіїєґ]/i.test(b.branch)) names.add(place(b.branch));
      for (const name of names) n.set(name, (n.get(name) || 0) + 1);
    }
    // A name seen once or twice is mostly a stray copy record («Moved collection», a typo).
    const branches = [...n].filter(([, c]) => c >= 3).map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name, "uk"));
    return { id: lib.id, city: lib.city, name: lib.name, branches };
  });
  branchCache = { at: Date.now(), list };
  return list;
}

// Which of the picked branches hold a book, from the cache only: [{ lib, city, branch, state, url }], state = "on"
// (on the shelf now), "held" (Kyiv's branches record no loans: a copy is there) or "out" (every copy lent).
function picked(db, book, picks) {
  tables(db);
  const out = [];
  for (const lib of LIBRARIES.filter((l) => picks.some((p) => p.lib === l.id))) {
    const row = db.prepare("SELECT data FROM library_cache WHERE key = ?").get(keyOf(lib, book.id));
    const data = row && row.data !== "null" ? JSON.parse(row.data) : null;
    for (const p of picks.filter((p) => p.lib === lib.id)) {
      let best = null;
      for (const rec of data?.records || []) for (const b of rec.branches || []) {
        if (place(b.branch) !== p.branch) continue;
        const state = b.onShelf ? "on" : b.unknown ? "held" : "out";
        const rank = { on: 0, held: 1, out: 2 }[state];
        if (!best || rank < best.rank) best = { rank, state, url: rec.url };
      }
      if (best) out.push({ lib: lib.id, city: lib.city, branch: p.branch, state: best.state, url: best.url });
    }
  }
  return out;
}
// How many of the books the cache has no answer for yet, for the picked libraries.
function unchecked(db, books, picks) {
  tables(db);
  const libs = LIBRARIES.filter((l) => picks.some((p) => p.lib === l.id));
  const q = db.prepare("SELECT 1 FROM library_cache WHERE key = ?");
  return books.filter((b) => libs.some((lib) => !q.get(keyOf(lib, b.id)))).length;
}

// Asks the picked libraries about the books whose answer is missing or old, one at a time in the background, the ones
// never asked first. At most half of a library's hourly budget (Kyiv: 60 of 120), the rest stays for book pages.
const filling = new Map(); // book id + library -> true while queued
let running = false;
const queue = [];
function fill(db, books, picks, { fetchImpl = fetch, log = () => {} } = {}) {
  tables(db);
  const libs = LIBRARIES.filter((l) => picks.some((p) => p.lib === l.id));
  const q = db.prepare("SELECT at FROM library_cache WHERE key = ?");
  const todo = [];
  for (const b of books) for (const lib of libs) {
    const k = keyOf(lib, b.id);
    if (filling.has(k)) continue;
    const row = q.get(k);
    if (row && Date.now() - row.at < (lib.ttl || DAY)) continue;
    todo.push({ b, lib, k, at: row?.at || 0 });
  }
  todo.sort((x, y) => x.at - y.at);
  for (const t of todo) filling.set(t.k, true), queue.push(t);
  if (running || !queue.length) return;
  running = true;
  (async () => {
    while (queue.length) {
      const t = queue.shift();
      const cap = t.lib.perHour ? Math.floor(t.lib.perHour / 2) : undefined;
      if (t.lib.perHour && !allowed(db, t.lib, cap)) {
        // Over this hour's share: the rest waits for the next time the page asks.
        for (const x of [t, ...queue]) filling.delete(x.k);
        queue.length = 0;
        break;
      }
      await one(db, t.lib, t.b, { fetchImpl, log, counted: true }).catch(() => {}); // allowed() above counted it
      filling.delete(t.k);
    }
    running = false;
  })();
}

module.exports = { LIBRARIES, holdings, branchName, alephBranch, branchList, picked, unchecked, fill, place };

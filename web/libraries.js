// Public libraries whose catalogs a program may read: where a book can be borrowed.
// Both run Koha, which answers a search as RSS (opac-search.pl?…&format=rss) and lists a record's
// copies, with the branch and whether each is on loan, through its public REST API
// (/api/v1/public/biblios/<id>/items). Neither has a robots.txt that forbids this.
// Survey of the others: /mnt/project-files/chytai-web/catalogs/libraries.md (most forbid robots).
// A book is looked up when its page asks (/api/libraries/:id), by ISBN, or by title and author when
// it has none, and the answer is kept for a day.

const LIBRARIES = [
  { id: "cherkasy", name: "Черкаські міські бібліотеки", city: "Черкаси", base: "https://opac.lib.cherkasy.ua", draft: true },
  { id: "uzhhorod", name: "Ужгородська публічна бібліотека", city: "Ужгород", base: "https://lib.itc.gov.ua", draft: true },
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

// One library's holdings of a book: the matching records, each with its copies by branch.
async function lookupOne(lib, book, fetchImpl) {
  const isbns = [...new Set([book.isbn, ...(book.editions || []).map((e) => e.isbn)].map((s) => String(s || "").replace(/[^\dX]/gi, "")).filter((s) => s.length >= 10))].slice(0, 4);
  let found = [];
  for (const isbn of isbns) found.push(...(await search(lib, { idx: "nb", q: isbn }, fetchImpl)));
  if (!found.length && book.title) {
    // No ISBN (or none of them there): the same title, and the author's surname in the record.
    const titles = [book.title, book.altTitle].filter(Boolean).map(norm);
    const surname = norm(String(book.author || "").split(/,|\sта\s|\sі\s/)[0]).split(" ").pop();
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

module.exports = { LIBRARIES, holdings, branchName };

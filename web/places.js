// «Мої книгарні й бібліотеки» (Max 2026-11-28, variant C of canvas UfKURsapQDWb2P1VA9XtD5): a reader's own shops (by
// the name a shop row carries, 5 at most) and library branches ({lib, branch}, 5 at most). One choice for the site and
// the reader: kept here, set on /settings/places or in the reader's «Хочу прочитати» (the newer one wins, `at`).
const libraries = require("./libraries");

const SHOPS_MAX = 5; // as the reader (bot №85)
const LIBS_MAX = 5;

function tables(db) {
  if (tables.done === db) return;
  db.exec("CREATE TABLE IF NOT EXISTS reader_places (reader TEXT PRIMARY KEY, shops TEXT NOT NULL, libs TEXT NOT NULL, at INTEGER NOT NULL)");
  tables.done = db;
}

// Names and branches as they come from a form or the reader: strings only, known libraries only, no repeats.
function clean({ shops = [], libs = [] } = {}) {
  const s = [...new Set((Array.isArray(shops) ? shops : []).filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim().slice(0, 80)))].slice(0, SHOPS_MAX);
  const seen = new Set();
  const l = (Array.isArray(libs) ? libs : [])
    .filter((p) => p && typeof p.lib === "string" && typeof p.branch === "string" && libraries.LIBRARIES.some((x) => x.id === p.lib && !x.draft))
    .map((p) => ({ lib: p.lib, branch: libraries.place(p.branch.slice(0, 200)) }))
    .filter((p) => p.branch && !seen.has(`${p.lib}|${p.branch}`) && seen.add(`${p.lib}|${p.branch}`))
    .slice(0, LIBS_MAX);
  return { shops: s, libs: l };
}

// { shops, libs, at } or null when the reader never chose.
function get(db, reader) {
  if (!reader) return null;
  tables(db);
  const r = db.prepare("SELECT shops, libs, at FROM reader_places WHERE reader = ?").get(String(reader));
  return r ? { shops: JSON.parse(r.shops), libs: JSON.parse(r.libs), at: r.at } : null;
}

function set(db, reader, v, at = Date.now()) {
  tables(db);
  const c = clean(v);
  db.prepare("INSERT INTO reader_places (reader, shops, libs, at) VALUES (?, ?, ?, ?) ON CONFLICT (reader) DO UPDATE SET shops = excluded.shops, libs = excluded.libs, at = excluded.at").run(String(reader), JSON.stringify(c.shops), JSON.stringify(c.libs), at);
  return { ...c, at };
}

function remove(db, reader) {
  tables(db);
  db.prepare("DELETE FROM reader_places WHERE reader = ?").run(String(reader));
}

// The reader's copy against ours (the reader's «Хочу прочитати» sends its own with the time it was changed there):
// the newer wins; a reader with picks in the reader and none here brings them over once.
function sync(db, reader, sent) {
  const have = get(db, reader);
  const c = clean(sent);
  const at = Number(sent?.at) || 0;
  if (!have) return c.shops.length || c.libs.length ? set(db, reader, c, at || Date.now()) : null;
  if (at > have.at) return set(db, reader, c, at);
  return have;
}

// The shops one can pick, an hour's copy: «Книгарні» (MEGOGO BOOKS, Сенс, the shop and audio shelves) and «Видавництва»
// (a publisher's own shop: pubshops.js, and a publisher shelf read from the publisher's own site, not from MEGOGO's).
let choiceCache = null;
function choices(store) {
  if (choiceCache && Date.now() - choiceCache.at < 3600000) return choiceCache;
  const shops = [{ name: require("./megogo").NAME, note: "" }, { name: require("./sens").NAME, note: "" }];
  const pubs = new Set(require("./pubshops").SHOPS.map((s) => s.name));
  for (const s of store.shelves || []) {
    const url = s.items?.[0]?.url || s.items?.[0]?.links?.[0]?.url || "";
    if (/mbooks\.com\.ua/.test(url) || !s.items?.length) continue;
    if (s.kind === "shop" || s.kind === "audio") {
      if (!shops.some((x) => x.name === s.name)) shops.push({ name: s.name, note: s.id === "bookua" ? "електронні" : s.kind === "audio" ? "аудіо" : ""});
    } else if (s.kind === "publisher") pubs.add(s.name);
  }
  choiceCache = { at: Date.now(), shops, publishers: [...pubs].sort((a, b) => a.localeCompare(b, "uk")) };
  return choiceCache;
}

module.exports = { SHOPS_MAX, LIBS_MAX, tables, clean, get, set, remove, sync, choices };

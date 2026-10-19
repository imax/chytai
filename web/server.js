// Chytai web: the platform part (library, Discovery, search), separate from the reader
// in server/index.js. Plain Express, server-rendered HTML, JSON on disk.
//
// Env: DATA_DIR (default ./data; the database is DATA_DIR/web/chytai.db, see db.js), PORT (default 8090),
// WEB_LOGIN_TOKEN (the magic link: opening /login/<token> once signs this browser in as the owner),
// WEB_OWNER (the public name of the one profile), WEB_OWNER_SLUG (its public shelf: /reader/<slug>), WEB_DOMAIN (the public host; www and *.fly.dev redirect to it).
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Store } = require("./store");
const pages = require("./pages");
const catalogs = require("./catalogs");
const libraries = require("./libraries");
const wikidata = require("./wikidata");

const ROOT = path.join(__dirname, "..");
loadDotEnv(path.join(ROOT, ".env"));

const PORT = Number(process.env.PORT) || 8090;
const DATA_DIR = path.join(process.env.DATA_DIR || path.join(ROOT, "data"), "web");
const TOKEN = process.env.WEB_LOGIN_TOKEN || "";
const OWNER = process.env.WEB_OWNER || "Макс І";
const READER = `/reader/${process.env.WEB_OWNER_SLUG || "max"}`; // the owner's public shelf: one reader among many
const DOMAIN = process.env.WEB_DOMAIN || ""; // e.g. chytai.org.ua; set once DNS points here
const COOKIE = "chytai_web";
const COOKIE_DAYS = 365;

if (!TOKEN) {
  console.error("WEB_LOGIN_TOKEN must be set: the magic link is /login/<token> (see .env.example)");
  process.exit(1);
}

function loadDotEnv(file) {
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  } catch {
    /* no .env */
  }
}

const store = new Store(DATA_DIR);

// ---- daily catalog refresh ----
// The machine sleeps between visits, so a timer alone would not fire: the first request of a day that
// finds the shelves older than a day starts a refresh in the background (the page itself is served from
// the current shelves), and the owner can force one with POST /api/refresh.
const REFRESH_MS = 24 * 3600 * 1000;
let lastRefresh = Date.parse(store.shelvesRefreshedAt) || 0;
let refreshing = null;
let lastResult = null; // { at, ok, errors, counts } of the last attempt, for /refresh-status
let currentLog = []; // the running refresh's log so far
function refreshShelves(force = false) {
  if (refreshing) return refreshing;
  if (!force && Date.now() - lastRefresh < REFRESH_MS) return null;
  lastRefresh = Date.now(); // even on failure: one attempt a day, not one per request
  const started = new Date().toISOString();
  const lines = (currentLog = []); // the refresh's own log, kept for /refresh-status
  const log = (m) => (console.log(m), lines.push(String(m).slice(0, 300)));
  refreshing = catalogs
    .refresh({ store, log })
    .catch((e) => (console.error("refresh failed:", e), { ok: false, errors: [e.message] }))
    .then((r) => (lastResult = { started, finished: new Date().toISOString(), ...r, log: lines.slice(-30) }))
    .finally(() => (refreshing = null));
  return refreshing;
}
// Ukrainian titles of foreign books (wikidata.js), weekly; the first time a minute after start.
const refreshUk = () => wikidata.refreshUk(store, { log: console.log }).catch((e) => console.error("wikidata failed:", e));
setTimeout(refreshUk, 60000).unref();
setInterval(refreshUk, 6 * 3600 * 1000).unref();

pages.setTitleLinks((md, id) => store.linkTitles(md, id));

const app = express();
app.set("trust proxy", true);
app.use(express.urlencoded({ extended: false, limit: "1mb" }));
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));
app.get("/icon.png", (req, res) => res.sendFile(path.join(ROOT, "build", "icon.png")));

// ---- auth: one owner, signed in by the magic link ----

const session = crypto.createHash("sha256").update(`chytai-web:${TOKEN}`).digest("hex");
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").map((c) => c.trim().split("=")).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join("="))]));
}
app.use((req, res, next) => {
  if (req.method === "GET") refreshShelves();
  // One public host: www and the Fly hostname go to the domain once it is live.
  const host = req.hostname || "";
  if (DOMAIN && host !== DOMAIN && (host === `www.${DOMAIN}` || host === `${process.env.FLY_APP_NAME}.fly.dev`)) return res.redirect(301, `https://${DOMAIN}${req.originalUrl}`);
  req.user = cookies(req)[COOKIE] === session ? OWNER : null;
  next();
});
const owner = (req, res, next) => (req.user ? next() : res.status(403).send("Спочатку відкрийте своє посилання для входу."));

// Public and harmless: when the shelves were last refreshed and whether the sources answered.
app.get("/refresh-status", (req, res) => {
  res.json({ running: !!refreshing, ...(refreshing && { log: currentLog.slice(-30) }), last: lastResult, shelvesFetched: store.shelvesFetched, refreshedAt: store.shelvesRefreshedAt, nextAfter: new Date(lastRefresh + REFRESH_MS).toISOString() });
});

app.get("/login/:token", (req, res) => {
  if (req.params.token !== TOKEN) return res.status(404).send(pages.messagePage({ title: "Посилання не підходить", text: "Перевірте посилання для входу." }));
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.setHeader("Set-Cookie", `${COOKIE}=${session}; Path=/; Max-Age=${COOKIE_DAYS * 86400}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`);
  res.redirect("/me");
});
app.get("/logout", (req, res) => {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; Max-Age=0`);
  res.redirect("/");
});

// ---- pages ----

// Library marks on cards («Хочу прочитати», «Прочитав») are the signed-in reader's own; guests see none.
const inLibraryMap = (req) => (req.user ? store.inLibrary() : new Map());
// Draft shelves (a new catalog Max has not looked at yet) are seen only by the signed-in owner.
const isDraft = (shelfId) => !!store.shelf(shelfId)?.draft;
const shelvesFor = (req) => (req.user ? store.shelves : store.shelves.filter((s) => !s.draft));
function bookFor(req, book, hasEntry) {
  if (req.user || !book) return book;
  const editions = book.editions && book.editions.filter((e) => !e.shelf.draft);
  const series = book.series && book.series.items.some((v) => v.shelf.draft) ? null : book.series;
  if (book.shelf && isDraft(book.shelf) && !editions?.length && !hasEntry) return null;
  return { ...book, editions, series };
}
const readersOf = (id) => {
  const e = store.sharedEntry(id);
  return e ? [{ name: OWNER, href: `${READER}#${e.via ? e.via.id : store.canonical(id)}`, entry: e }] : [];
};
const visible = (s) => store.visible(s);

app.get("/", (req, res) => {
  res.send(pages.discoveryPage({ shelves: shelvesFor(req), subscriptions: store.lib.subscriptions, user: req.user, owner: OWNER, readerHref: READER, libraryCount: store.library().length, inLibrary: inLibraryMap(req), visible, fetched: store.shelvesRefreshedAt ? new Date(store.shelvesRefreshedAt).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }) : store.shelvesFetched, ownerStrip: store.library().filter((r) => r.rating >= 5 && r.book.cover).slice(0, 5).map((r) => r.book), libraries: libraries.LIBRARIES.filter((l) => req.user || !l.draft) }));
});

function libraryRows() {
  const rows = store.library();
  let prev;
  for (const r of rows) {
    r._prevYear = prev;
    prev = r.year ?? null;
  }
  return rows;
}
// /me is your own library (guests have none: old links land on the owner's public shelf).
app.get("/me", (req, res) => {
  if (!req.user) return res.redirect(READER);
  res.send(pages.libraryPage({ rows: libraryRows(), user: req.user, owner: OWNER, own: true, readerHref: READER }));
});
app.get(READER, (req, res) => {
  res.send(pages.libraryPage({ rows: libraryRows(), user: req.user, owner: OWNER }));
});
app.get("/me/book/:id", owner, (req, res) => {
  const id = store.resolve(req.params.id);
  if (!id) return res.status(404).send(pages.messagePage({ title: "Немає такої книжки", text: "", user: req.user }));
  const book = store.book(id);
  res.send(pages.editPage({ book, entry: store.entry(book.id), user: req.user }));
});

app.get("/shelf/:id", (req, res) => {
  const shelf = store.shelf(req.params.id);
  if (!shelf || (shelf.draft && !req.user)) return res.status(404).send(pages.messagePage({ title: "Немає такої полиці", text: "", user: req.user }));
  res.send(pages.shelfPage({ shelf, subscribed: store.subscribed(shelf.id), user: req.user, inLibrary: inLibraryMap(req), visible }));
});

app.get("/search", (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 100);
  const hits = store.search(q).map((h) => ({ ...h, book: bookFor(req, h.book, !!h.entry) })).filter((h) => h.book);
  res.send(pages.searchPage({ q, hits, user: req.user, inLibrary: inLibraryMap(req), owner: OWNER, readerHref: READER }));
});

app.get("/book/:id", (req, res) => {
  const id = store.resolve(req.params.id);
  if (!id) return res.status(404).send(pages.messagePage({ title: "Немає такої книжки", text: "", user: req.user }));
  // One address per work: an id, an edition id or an old slug redirects to the canonical one.
  if (store.href(id) !== `/book/${encodeURIComponent(req.params.id)}`) return res.redirect(301, store.href(id));
  const book = bookFor(req, store.bookPage(id), !!store.entry(id));
  if (!book) return res.status(404).send(pages.messagePage({ title: "Немає такої книжки", text: "", user: req.user }));
  res.send(pages.bookPage({ book, entry: store.sharedEntry(book.id), user: req.user, shelf: book.shelf && (req.user || !isDraft(book.shelf)) ? store.shelf(book.shelf) : null, inLibrary: inLibraryMap(req), readers: readersOf(book.id) }));
});

// Where the book can be borrowed: libraries with open catalogs (libraries.js), asked when the page loads.
// A library marked draft in libraries.js is seen only by the signed-in owner.
app.get("/api/libraries/:id", async (req, res) => {
  const id = store.resolve(req.params.id);
  const book = id && bookFor(req, store.book(id), !!store.entry(id));
  if (!book) return res.status(404).json([]);
  res.json(await libraries.holdings(store.db, book, { includeDraft: !!req.user, log: console.log }));
});

// ---- writes (owner only) ----

const back = (req, res, fallback) => {
  const next = String(req.body.next || "");
  res.redirect(/^\/(?!\/)/.test(next) ? next : req.body.back ? req.get("referer") || fallback : fallback);
};

app.post("/api/entry/:id", owner, (req, res) => {
  const b = req.body;
  const patch = {};
  if ("status" in b) patch.status = ["read", "reading", "want"].includes(b.status) ? b.status : "";
  if ("rating" in b) patch.rating = b.rating === "none" || b.rating === "" ? null : Math.max(0, Math.min(5, Number(b.rating)));
  if ("year" in b) patch.year = b.year ? Number(b.year) : null;
  if ("copy" in b) patch.copy = ["paper", "ebook", "seeking"].includes(b.copy) ? b.copy : "";
  if ("note" in b) patch.note = String(b.note).trim();
  const e = store.setEntry(req.params.id, patch);
  if (!e) return res.status(404).send("Немає такої книжки");
  back(req, res, store.href(req.params.id));
});

app.post("/api/entry/:id/remove", owner, (req, res) => {
  store.removeEntry(req.params.id);
  res.redirect("/me");
});

app.post("/api/book", owner, (req, res) => {
  const { title, author, cover, status, copy } = req.body;
  if (!title || !title.trim()) return res.status(400).send("Потрібна назва");
  const b = store.addBook({ title, author, cover: /^https?:\/\//.test(cover || "") ? cover : "" });
  store.setEntry(b.id, { status: ["read", "reading", "want"].includes(status) ? status : "", copy: ["paper", "ebook", "seeking"].includes(copy) ? copy : "" });
  res.redirect(store.href(b.id));
});

app.post("/api/refresh", owner, async (req, res) => {
  const r = await refreshShelves(true);
  res.send(pages.messagePage({ title: r.ok ? "Каталоги оновлено" : "Не вдалося оновити", text: [...(r.counts || []).map(([id, n]) => `${id}: ${n}`), ...r.errors].join("; "), user: req.user }));
});

app.post("/api/subscribe/:id", owner, (req, res) => {
  if (store.toggleSubscription(req.params.id) === null) return res.status(404).send("Немає такої полиці");
  res.redirect(req.get("referer") || "/");
});

app.listen(PORT, () => console.log(`Chytai web on http://localhost:${PORT}  (library: ${store.file})`));

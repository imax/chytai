// Chytai web: the platform part (library, Discovery, search), separate from the reader
// in server/index.js. Plain Express, server-rendered HTML, JSON on disk.
//
// Env: DATA_DIR (default ./data; the database is DATA_DIR/web/chytai.db, see db.js), PORT (default 8090),
// WEB_DOMAIN (the public host; www and *.fly.dev redirect to it).
// Accounts (auth.js): readers sign up and in with a code mailed by Resend (RESEND_API_KEY, WEB_MAIL_FROM;
// without the key the code goes to the log). The owner (Max) is the reader "owner": WEB_OWNER is his name,
// WEB_OWNER_USERNAME his page (/@maxua), WEB_OWNER_SLUG the old /reader/<slug> address that redirects there,
// and WEB_LOGIN_TOKEN, if set, keeps the old magic link /login/<token> signing in as him.
const express = require("express");
const fs = require("fs");
const path = require("path");
const { Store, OWNER: OWNER_ID, slugify } = require("./store");
const { Auth } = require("./auth");
const pages = require("./pages");
const catalogs = require("./catalogs");
const libraries = require("./libraries");
const wikidata = require("./wikidata");
const authors = require("./authors");

const ROOT = path.join(__dirname, "..");
loadDotEnv(path.join(ROOT, ".env"));

const PORT = Number(process.env.PORT) || 8090;
const DATA_DIR = path.join(process.env.DATA_DIR || path.join(ROOT, "data"), "web");
const TOKEN = process.env.WEB_LOGIN_TOKEN || "";
const OWNER = process.env.WEB_OWNER || "Макс І";
const OWNER_USERNAME = process.env.WEB_OWNER_USERNAME || "maxua";
const OLD_READER = `/reader/${process.env.WEB_OWNER_SLUG || "max"}`; // the owner's page before usernames
const DOMAIN = process.env.WEB_DOMAIN || ""; // e.g. chytai.org.ua; set once DNS points here
const COOKIE = "chytai_web";

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
const auth = new Auth(store.db, { ownerToken: TOKEN, resendKey: process.env.RESEND_API_KEY || "", from: process.env.WEB_MAIL_FROM || `Chytai <code@${DOMAIN || "chytai.org.ua"}>` });
auth.ensureOwner({ id: OWNER_ID, name: OWNER, username: OWNER_USERNAME });
if (!process.env.RESEND_API_KEY) console.log("RESEND_API_KEY is not set: sign-in codes are printed here instead of mailed");

// ---- daily catalog refresh ----
// The machine sleeps between visits, so a timer alone would not fire: the first request that finds the
// shelves older than 20 hours starts a refresh in the background (the page itself is served from the
// current shelves), and the owner can force one with POST /api/refresh. A refresh takes a while and the
// machine stops when nobody asks it anything, so .github/workflows/catalogs.yml starts one every morning
// and keeps asking /refresh-status until it ends. 20 hours, not 24: the shelves are dated when a refresh
// ends, so a day after that would miss the next morning's run.
const REFRESH_MS = 20 * 3600 * 1000;
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
// Who is who among the authors (authors.js), weekly, after the Ukrainian titles.
const refreshAuthors = () => authors.refresh(store, { log: console.log }).catch((e) => console.error("authors failed:", e));
setTimeout(() => refreshUk().then(refreshAuthors), 60000).unref();
setInterval(() => refreshUk().then(refreshAuthors), 6 * 3600 * 1000).unref();

pages.setTitleLinks((md, id) => store.linkTitles(md, id));
pages.setAuthorLinks((name) => store.authors?.byName(name)?.href || null);

const app = express();
app.set("trust proxy", true);
app.use(express.urlencoded({ extended: false, limit: "1mb" }));
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));
app.get("/icon.png", (req, res) => res.sendFile(path.join(ROOT, "build", "icon.png")));

// ---- auth: readers signed in by a code sent to their e-mail (auth.js) ----

// A reader as the pages see them: name, username and the address of their page.
const pub = (r) => (r ? { id: r.id, name: r.name, username: r.username, href: `/@${r.username}`, owner: r.id === OWNER_ID, email: r.email } : null);
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").map((c) => c.trim().split("=")).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join("="))]));
}
app.use((req, res, next) => {
  if (req.method === "GET") refreshShelves();
  // One public host: www and the Fly hostname go to the domain once it is live.
  const host = req.hostname || "";
  if (DOMAIN && host !== DOMAIN && (host === `www.${DOMAIN}` || host === `${process.env.FLY_APP_NAME}.fly.dev`)) return res.redirect(301, `https://${DOMAIN}${req.originalUrl}`);
  req.token = cookies(req)[COOKIE] || "";
  req.user = pub(auth.readerOf(req.token, OWNER_ID));
  req.owner = !!req.user?.owner; // drafts, refresh: the owner's business
  res.locals.user = req.user;
  next();
});
const signed = (req, res, next) => (req.user ? next() : res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`));
const owner = (req, res, next) => (req.owner ? next() : res.status(403).send("Це може лише власник сайту."));
const secure = (req) => req.secure || req.headers["x-forwarded-proto"] === "https";
const safeNext = (v) => (/^\/(?!\/)/.test(String(v || "")) ? String(v) : "");

// Public and harmless: when the shelves were last refreshed and whether the sources answered.
app.get("/refresh-status", (req, res) => {
  res.json({ running: !!refreshing, ...(refreshing && { log: currentLog.slice(-30) }), last: lastResult, shelvesFetched: store.shelvesFetched, refreshedAt: store.shelvesRefreshedAt, authors: store.db.get("authors:log"), memoryMb: Object.fromEntries(Object.entries(process.memoryUsage()).map(([k, v]) => [k, Math.round(v / 1048576)])), nextAfter: new Date(lastRefresh + REFRESH_MS).toISOString() });
});

// Sign in or sign up, the same door: an e-mail, a code, and for a new address a name and a username.
app.get("/login", (req, res) => {
  if (req.user) return res.redirect(safeNext(req.query.next) || "/me");
  res.send(pages.loginPage({ next: safeNext(req.query.next) }));
});
app.post("/login", async (req, res) => {
  const next = safeNext(req.body.next);
  const { email, error } = auth.checkEmail(req.body.email);
  if (error) return res.status(400).send(pages.loginPage({ next, email: req.body.email, error }));
  const r = await auth.sendCode(email, req.ip);
  if (r.error) return res.status(429).send(pages.loginPage({ next, email, error: r.error }));
  res.send(pages.codePage({ next, email }));
});
app.post("/login/code", (req, res) => {
  const next = safeNext(req.body.next);
  const { email, error } = auth.checkEmail(req.body.email);
  if (error) return res.status(400).send(pages.loginPage({ next, error }));
  const r = auth.verify(email, req.body.code);
  if (r.error) return res.status(400).send(pages.codePage({ next, email, error: r.error }));
  if (r.reader) return signIn(req, res, r.reader, next);
  res.send(pages.signupPage({ next, ticket: r.ticket, email, name: "", username: "" }));
});
// The last step for a new reader: who they are on the site.
app.post("/login/signup", (req, res) => {
  const next = safeNext(req.body.next);
  const email = auth.ticketEmail(req.body.ticket);
  if (!email) return res.status(400).send(pages.loginPage({ next, error: "Час вийшов. Запросіть код ще раз." }));
  const name = auth.checkName(req.body.name);
  const username = auth.checkUsername(req.body.username || (name.name && auth.suggestUsername(name.name, slugify)));
  const error = name.error || username.error;
  if (error) return res.status(400).send(pages.signupPage({ next, ticket: req.body.ticket, email, name: req.body.name, username: req.body.username, error }));
  if (auth.byEmail(email)) return signIn(req, res, auth.byEmail(email), next);
  const reader = auth.createReader({ email, name: name.name, username: username.username });
  auth.useTicket(req.body.ticket);
  console.log(`new reader @${reader.username}`);
  signIn(req, res, reader, next);
});
function signIn(req, res, reader, next) {
  res.setHeader("Set-Cookie", auth.cookie(auth.signIn(reader.id), { secure: secure(req) }));
  res.redirect(next || "/me");
}
// The owner's magic link from before accounts still works, so Max is never locked out.
app.get("/login/:token", (req, res) => {
  if (!TOKEN || req.params.token !== TOKEN) return res.status(404).send(pages.messagePage({ title: "Посилання не підходить", text: "Перевірте посилання для входу.", user: req.user }));
  signIn(req, res, auth.reader(OWNER_ID), "/me");
});
app.get("/logout", (req, res) => {
  auth.signOut(req.token);
  res.setHeader("Set-Cookie", auth.cookie("", { clear: true, secure: secure(req) }));
  res.redirect("/");
});

app.get("/privacy", (req, res) => res.send(pages.privacyPage({ user: req.user })));

// ---- settings: name, username, e-mail, deleting the account ----

app.get("/settings", signed, (req, res) => {
  res.send(pages.settingsPage({ user: req.user, values: req.user, suggested: auth.suggestUsername(req.user.name, slugify), saved: !!req.query.saved }));
});
app.post("/settings", signed, (req, res) => {
  const name = auth.checkName(req.body.name);
  const username = auth.checkUsername(req.body.username, req.user.id);
  const email = req.body.email ? auth.checkEmail(req.body.email) : { email: req.user.email };
  const taken = email.email && auth.byEmail(email.email) && auth.byEmail(email.email).id !== req.user.id;
  const error = name.error || username.error || email.error || (taken ? "Ця пошта вже зайнята іншим читачем." : "");
  const values = { ...req.user, name: req.body.name, username: req.body.username, email: req.body.email };
  if (error) return res.status(400).send(pages.settingsPage({ user: req.user, values, error }));
  auth.updateReader(req.user.id, { name: name.name, username: username.username, email: email.email || null });
  res.redirect("/settings?saved=1");
});
app.post("/settings/delete", signed, (req, res) => {
  if (req.owner) return res.status(400).send(pages.messagePage({ title: "Власника не видаляємо", text: "Для цього є інший шлях.", user: req.user }));
  if (req.body.confirm !== req.user.username) return res.status(400).send(pages.settingsPage({ user: req.user, values: req.user, error: "Щоб видалити акаунт, впишіть своє ім'я для адреси." }));
  auth.deleteReader(req.user.id);
  store.forgetReader(req.user.id);
  res.setHeader("Set-Cookie", auth.cookie("", { clear: true, secure: secure(req) }));
  res.send(pages.messagePage({ title: "Акаунт видалено", text: "Книжки, оцінки й нотатки стерто. Дякуємо, що читали з нами." }));
});

// ---- pages ----

// Library marks on cards («Хочу прочитати», «Прочитав») are the signed-in reader's own; guests see none.
const inLibraryMap = (req) => store.inLibrary(req.user?.id);
// Draft shelves (a new catalog Max has not looked at yet) are seen only by the signed-in owner.
const isDraft = (shelfId) => !!store.shelf(shelfId)?.draft;
const shelvesFor = (req) => (req.owner ? store.shelves : store.shelves.filter((s) => !s.draft));
function bookFor(req, book, hasEntry) {
  if (req.owner || !book) return book;
  const editions = book.editions && book.editions.filter((e) => !e.shelf.draft);
  const series = book.series && book.series.items.some((v) => v.shelf.draft) ? null : book.series;
  if (book.shelf && isDraft(book.shelf) && !editions?.length && !hasEntry) return null;
  return { ...book, editions, series };
}
// The readers who have the book, for the book page and the cards: name, their page (at this book), entry.
const readersOf = (id) =>
  store
    .readersOf(id)
    .map(({ reader, entry }) => ({ reader: pub(auth.reader(reader)), entry }))
    .filter((r) => r.reader)
    .map(({ reader, entry }) => ({ name: reader.name, href: `${reader.href}#${entry.via ? entry.via.id : store.canonical(id)}`, entry }));
// Readers with public pages worth a card on the homepage: the fullest libraries first.
const readerCards = () =>
  auth
    .readers()
    .map((r) => ({ reader: pub(r), rows: store.library(r.id) }))
    .filter((c) => c.rows.length)
    .sort((a, b) => b.rows.length - a.rows.length)
    .slice(0, 8)
    .map((c) => ({ reader: c.reader, count: c.rows.length, strip: c.rows.filter((r) => r.rating >= 5 && r.book.cover).slice(0, 5).map((r) => r.book) }));
const visible = (s) => store.visible(s);
pages.setReaders(readersOf);

app.get("/", (req, res) => {
  res.send(pages.discoveryPage({ shelves: shelvesFor(req), subscriptions: store.subscriptions(req.user?.id), user: req.user, readers: readerCards(), inLibrary: inLibraryMap(req), visible, fetched: store.shelvesRefreshedAt ? new Date(store.shelvesRefreshedAt).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }) : store.shelvesFetched, libraries: libraries.LIBRARIES.filter((l) => req.owner || !l.draft) }));
});

function libraryRows(reader) {
  const rows = store.library(reader);
  let prev;
  for (const r of rows) {
    r._prevYear = prev;
    prev = r.year ?? null;
  }
  return rows;
}
// /me is your own library; a guest is sent to sign in. /@<username> is any reader's public page.
app.get("/me", signed, (req, res) => {
  res.send(pages.libraryPage({ rows: libraryRows(req.user.id), user: req.user, reader: req.user, own: true }));
});
app.get("/@:username", (req, res) => {
  const reader = pub(auth.byUsername(req.params.username));
  if (!reader) return res.status(404).send(pages.messagePage({ title: "Немає такого читача", text: "", user: req.user }));
  if (reader.username !== req.params.username) return res.redirect(301, reader.href);
  res.send(pages.libraryPage({ rows: libraryRows(reader.id), user: req.user, reader }));
});
// The owner's page before usernames (/reader/max) moved to /@maxua.
app.get(OLD_READER, (req, res) => res.redirect(301, pub(auth.reader(OWNER_ID)).href));
app.get("/me/book/:id", signed, (req, res) => {
  const id = store.resolve(req.params.id);
  if (!id) return res.status(404).send(pages.messagePage({ title: "Немає такої книжки", text: "", user: req.user }));
  const book = store.book(id);
  res.send(pages.editPage({ book, entry: store.entry(req.user.id, book.id), user: req.user }));
});

app.get("/shelf/:id", (req, res) => {
  const shelf = store.shelf(req.params.id);
  if (!shelf || (shelf.draft && !req.owner)) return res.status(404).send(pages.messagePage({ title: "Немає такої полиці", text: "", user: req.user }));
  res.send(pages.shelfPage({ shelf, subscribed: store.subscribed(req.user?.id, shelf.id), user: req.user, inLibrary: inLibraryMap(req), visible }));
});

const searchHits = (req, q) => store.search(q, { reader: req.user?.id }).map((h) => ({ ...h, book: bookFor(req, h.book, !!h.entry) })).filter((h) => h.book);
app.get("/search", (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 100);
  res.send(pages.searchPage({ q, hits: searchHits(req, q), user: req.user, inLibrary: inLibraryMap(req) }));
});
// The same results as an HTML fragment, for search as you type.
app.get("/api/search", (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 100);
  res.set("Cache-Control", "no-store").send(pages.searchResults({ q, hits: searchHits(req, q), user: req.user, inLibrary: inLibraryMap(req) }));
});

app.get("/book/:id", (req, res) => {
  const id = store.resolve(req.params.id);
  if (!id) return res.status(404).send(pages.messagePage({ title: "Немає такої книжки", text: "", user: req.user }));
  // One address per work: an id, an edition id or an old slug redirects to the canonical one.
  if (store.href(id) !== `/book/${encodeURIComponent(req.params.id)}`) return res.redirect(301, store.href(id));
  const book = bookFor(req, store.bookPage(id), !!store.entry(req.user?.id, id));
  if (!book) return res.status(404).send(pages.messagePage({ title: "Немає такої книжки", text: "", user: req.user }));
  res.send(pages.bookPage({ book, entry: store.sharedEntry(req.user?.id, book.id), user: req.user, shelf: book.shelf && (req.owner || !isDraft(book.shelf)) ? store.shelf(book.shelf) : null, inLibrary: inLibraryMap(req), readers: readersOf(book.id) }));
});

// An author: their works from Wikidata (linked to our books of them) and every book of theirs we have.
app.get("/author/:slug", async (req, res) => {
  const author = store.authors.bySlug.get(req.params.slug);
  if (!author) return res.status(404).send(pages.messagePage({ title: "Немає такого автора", text: "", user: req.user }));
  const works = author.qid ? authors.matchWorks(store, author, await authors.wikidataWorks(store, author.qid, { log: console.log })) : [];
  const shown = new Set(works.flatMap((w) => w.books.map((b) => b.id)));
  const hits = author.ids
    .map((id) => ({ book: bookFor(req, store.book(id), !!store.entry(req.user?.id, id)), entry: store.entry(req.user?.id, id) }))
    .filter((h) => h.book)
    .sort((a, b) => !!b.entry - !!a.entry || shown.has(a.book.id) - shown.has(b.book.id) || a.book.title.localeCompare(b.book.title, "uk"));
  res.send(pages.authorPage({ author, works, hits, user: req.user, inLibrary: inLibraryMap(req) }));
});

// Where the book can be borrowed: libraries with open catalogs (libraries.js), asked when the page loads.
// A library marked draft in libraries.js is seen only by the signed-in owner.
app.get("/api/libraries/:id", async (req, res) => {
  const id = store.resolve(req.params.id);
  const book = id && bookFor(req, store.book(id), !!store.entry(req.user?.id, id));
  if (!book) return res.status(404).json([]);
  res.json(await libraries.holdings(store.db, book, { includeDraft: req.owner, log: console.log }));
});

// ---- writes (signed-in readers; the catalog refresh is the owner's) ----

const back = (req, res, fallback) => {
  const next = String(req.body.next || "");
  res.redirect(/^\/(?!\/)/.test(next) ? next : req.body.back ? req.get("referer") || fallback : fallback);
};

app.post("/api/entry/:id", signed, (req, res) => {
  const b = req.body;
  const patch = {};
  if ("status" in b) patch.status = ["read", "reading", "want"].includes(b.status) ? b.status : "";
  if ("rating" in b) patch.rating = b.rating === "none" || b.rating === "" ? null : Math.max(0, Math.min(5, Number(b.rating)));
  if ("year" in b) patch.year = b.year ? Number(b.year) : null;
  if ("copy" in b) patch.copy = ["paper", "ebook", "seeking"].includes(b.copy) ? b.copy : "";
  if ("note" in b) patch.note = String(b.note).trim();
  const e = store.setEntry(req.user.id, req.params.id, patch);
  if (!e) return res.status(404).send("Немає такої книжки");
  back(req, res, store.href(req.params.id));
});

app.post("/api/entry/:id/remove", signed, (req, res) => {
  store.removeEntry(req.user.id, req.params.id);
  res.redirect("/me");
});

app.post("/api/book", signed, (req, res) => {
  const { title, author, cover, status, copy } = req.body;
  if (!title || !title.trim()) return res.status(400).send("Потрібна назва");
  const b = store.addBook({ title, author, cover: /^https?:\/\//.test(cover || "") ? cover : "" });
  store.setEntry(req.user.id, b.id, { status: ["read", "reading", "want"].includes(status) ? status : "", copy: ["paper", "ebook", "seeking"].includes(copy) ? copy : "" });
  res.redirect(store.href(b.id));
});

app.post("/api/refresh", owner, async (req, res) => {
  const r = await refreshShelves(true);
  res.send(pages.messagePage({ title: r.ok ? "Каталоги оновлено" : "Не вдалося оновити", text: [...(r.counts || []).map(([id, n]) => `${id}: ${n}`), ...r.errors].join("; "), user: req.user }));
});

app.post("/api/subscribe/:id", signed, (req, res) => {
  if (store.toggleSubscription(req.user.id, req.params.id) === null) return res.status(404).send("Немає такої полиці");
  res.redirect(req.get("referer") || "/");
});

app.listen(PORT, () => console.log(`Chytai web on http://localhost:${PORT}  (library: ${store.file})`));

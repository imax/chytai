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
const { Social } = require("./social");
const goodreads = require("./goodreads");
const { Digest } = require("./digest");
const applebooks = require("./applebooks");

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
function refreshShelves(force = false, only = "") {
  if (refreshing) return refreshing;
  if (!force && Date.now() - lastRefresh < REFRESH_MS) return null;
  if (!only) lastRefresh = Date.now(); // even on failure: one attempt a day, not one per request
  const started = new Date().toISOString();
  const lines = (currentLog = []); // the refresh's own log, kept for /refresh-status
  const log = (m) => (console.log(m), lines.push(String(m).slice(0, 300)));
  refreshing = catalogs
    .refresh({ store, log, only })
    .catch((e) => (console.error("refresh failed:", e), { ok: false, errors: [e.message] }))
    .then((r) => (lastResult = { started, finished: new Date().toISOString(), ...r, log: lines.slice(-30) }))
    .finally(() => (refreshing = null));
  return refreshing;
}
// A refresh that a restart (a deploy) cut short left its progress in partial:<id>: go on with that source.
for (const src of catalogs.SOURCES) if (JSON.parse(store.db.get(`partial:${src.id}`) || "[]").length) setTimeout(() => refreshShelves(true, src.id), 30000).unref();
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
  res.send(pages.settingsPage({ user: req.user, values: { ...req.user, digest: digest.enabled(req.user.id) }, suggested: auth.suggestUsername(req.user.name, slugify), saved: !!req.query.saved }));
});
app.post("/settings", signed, (req, res) => {
  const name = auth.checkName(req.body.name);
  const username = auth.checkUsername(req.body.username, req.user.id);
  const email = req.body.email ? auth.checkEmail(req.body.email) : { email: req.user.email };
  const taken = email.email && auth.byEmail(email.email) && auth.byEmail(email.email).id !== req.user.id;
  const error = name.error || username.error || email.error || (taken ? "Ця пошта вже зайнята іншим читачем." : "");
  const values = { ...req.user, name: req.body.name, username: req.body.username, email: req.body.email, digest: !!req.body.digest };
  if (error) return res.status(400).send(pages.settingsPage({ user: req.user, values, error }));
  auth.updateReader(req.user.id, { name: name.name, username: username.username, email: email.email || null });
  digest.setEnabled(req.user.id, !!req.body.digest);
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

// ---- import a library from elsewhere: Goodreads (goodreads.js) or Apple Books (applebooks.js) ----
// Upload, look at what each row becomes, confirm. A looked-at file waits in memory for half an hour under a
// token; nothing of it is written before the reader confirms.
const IMPORTS = {
  goodreads: { name: "Goodreads", parse: (files) => goodreads.parseExport(files[0].body.toString("utf8")) },
  "apple-books": { name: "Apple Books", parse: (files) => applebooks.parseLibrary(files) },
};
const pendingImports = new Map(); // token -> { reader, source, rows, filename, at }
const IMPORT_TTL = 30 * 60 * 1000;
const importSource = (req, res, next) => (IMPORTS[req.params.source] ? ((req.source = req.params.source), next()) : res.status(404).send(pages.messagePage({ title: "Немає такого імпорту", text: "", user: req.user })));
app.get("/import/:source", signed, importSource, (req, res) => res.send(pages.importPage({ user: req.user, source: req.source })));
app.post("/import/:source", signed, importSource, express.raw({ type: "multipart/form-data", limit: "60mb" }), (req, res) => {
  const fail = (error) => res.status(400).send(pages.importPage({ user: req.user, source: req.source, error }));
  const parts = Buffer.isBuffer(req.body) ? goodreads.parseMultipart(req.body, req.headers["content-type"]) : null;
  const files = [].concat(parts?.file || []).filter((f) => f && f.body?.length);
  if (!files.length) return fail(req.source === "goodreads" ? "Виберіть файл експорту Goodreads (.csv)." : "Виберіть файли з теки BKLibrary.");
  const { books, error, skipped = 0 } = IMPORTS[req.source].parse(files);
  if (error) return fail(error);
  const { rows, counts } = goodreads.plan(store, req.user.id, books);
  for (const [t, p] of pendingImports) if (Date.now() - p.at > IMPORT_TTL) pendingImports.delete(t);
  const token = require("crypto").randomBytes(12).toString("hex");
  const filename = files.length > 1 ? `${files.length} файли` : files[0].filename;
  pendingImports.set(token, { reader: req.user.id, source: req.source, rows, filename, at: Date.now() });
  res.send(pages.importPreviewPage({ user: req.user, source: req.source, token, rows, counts: { ...counts, skipped }, filename }));
});
app.post("/import/:source/apply", signed, importSource, (req, res) => {
  const p = pendingImports.get(String(req.body.token || ""));
  if (!p || p.reader !== req.user.id || p.source !== req.source || Date.now() - p.at > IMPORT_TTL) return res.status(400).send(pages.importPage({ user: req.user, source: req.source, error: "Час вийшов або файл уже імпортовано. Виберіть файл ще раз." }));
  pendingImports.delete(req.body.token);
  const keep = new Set([].concat(req.body.keep ?? []).map(Number));
  const chosen = p.rows.filter((r, i) => keep.has(i));
  // On the shelf they sit after what is already there: the read ones by date read, oldest first, then the rest by date added.
  const key = (r) => (r.read ? `0${r.read}` : `1${r.added || "9999"}`);
  chosen.sort((a, b) => key(a).localeCompare(key(b)));
  const result = store.importEntries(req.user.id, chosen.map((r) => ({ id: r.match?.id || null, title: r.title, author: r.author, isbns: r.isbns, goodreadsId: r.goodreadsId, appleId: r.appleId, status: r.status, rating: r.rating, year: r.year, note: r.note, copy: r.copy, added: r.added, read: r.read, touched: r.touched })), { source: req.source });
  const name = IMPORTS[req.source].name;
  console.log(`${name} import @${req.user.username}: ${result.added} added, ${result.updated} updated, ${result.created.length} new books`);
  // New books by hand are mailed to the owner one by one; an import sends one letter with the list.
  if (!req.owner && result.created.length) notifyOwner(`Імпорт з ${name}: ${result.created.length} нових книжок`, [`${req.user.name} (@${req.user.username}) імпортував(ла) полицю з ${name}: ${result.added} додано, ${result.updated} доповнено.`, `Нові книжки, яких немає в каталозі (${result.created.length}):`, "", ...result.created.slice(0, 100).map((b) => `• ${b.title}${b.author ? ` — ${b.author}` : ""}  ${site(req)}${store.href(b.id)}`), result.created.length > 100 ? `… і ще ${result.created.length - 100}` : "", "", `Полиця читача: ${site(req)}${req.user.href}`].join("\n"));
  res.send(pages.importDonePage({ user: req.user, source: req.source, result, skipped: p.rows.length - chosen.length }));
});

// ---- pages ----

// Library marks on cards («Хочу прочитати», «Прочитано») are the signed-in reader's own; guests see none.
const inLibraryMap = (req) => store.inLibrary(req.user?.id);
// Draft shelves (a new catalog Max has not looked at yet) are seen only by the signed-in owner.
const isDraft = (shelfId) => !!store.shelf(shelfId)?.draft;
const shelvesFor = (req) => (req.owner ? store.shelves : store.shelves.filter((s) => !s.draft));
function bookFor(req, book, hasEntry) {
  if (req.owner || !book) return book;
  const editions = book.editions && book.editions.filter((e) => !e.shelf.draft);
  const series = book.series?.items?.some((v) => v.shelf?.draft) ? null : book.series;
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
const visible = (s) => store.visible(s);
// Letters to the owner (WEB_NOTIFY_EMAIL, else the e-mail he signs in with), sent in the background.
const site = (req) => (DOMAIN ? `https://${DOMAIN}` : `${req.protocol}://${req.get("host")}`);
const SITE = DOMAIN ? `https://${DOMAIN}` : `http://localhost:${PORT}`;
function notifyOwner(subject, text) {
  const to = process.env.WEB_NOTIFY_EMAIL || auth.reader(OWNER_ID)?.email;
  if (!to) return console.log(`[notify] no owner e-mail: ${subject}`);
  auth.send(to, subject, text).catch((e) => console.error(`[notify] ${subject}: ${e.message}`));
}
const librariesFor = (req) => libraries.LIBRARIES.filter((l) => req.owner || !l.draft);
// What readers do with books (social.js): ratings, the feed, «книжка навмання», recommendations.
const social = new Social(store, (id) => pub(auth.reader(id)));
pages.setStats((id) => social.stats(id));
// The weekly letter (digest.js): Friday 9:00 Kyiv, to the owner alone until WEB_DIGEST_TO=all.
const digest = new Digest({ store, auth, social, libraries, site: SITE, ownerId: OWNER_ID, to: process.env.WEB_DIGEST_TO === "all" ? "all" : "owner" });
digest.schedule();
pages.setReadersWithNote((id) => readersOf(id).find((r) => r.entry.note) || null);
const day = (iso) => ((iso = iso || store.shelvesFetched) ? new Date(iso).toLocaleDateString("uk-UA", { timeZone: "Europe/Kyiv" }) : "");
// A publisher in the lists: its newest books (the ones marked new first), how many there are and are new.
function shelfSummary(req, shelf, n) {
  const items = visible(shelf);
  const fresh = items.filter((it) => it.isNew);
  return { shelf, items: [...fresh, ...items.filter((it) => !it.isNew && it.cover)].slice(0, n), total: items.length, fresh: fresh.length, subscribed: store.subscribed(req.user?.id, shelf.id) };
}
// Each reader with their shelf in numbers, fullest first.
function readerList() {
  const year = new Date().getFullYear();
  return auth
    .readers()
    .map((r) => ({ reader: pub(r), rows: store.library(r.id) }))
    .filter((c) => c.rows.length)
    .sort((a, b) => b.rows.length - a.rows.length)
    .map(({ reader, rows }) => {
      const last = social.feed({ limit: 1, notes: true, books: new Set(rows.map((r) => r.id)) }).find((x) => x.reader.id === reader.id);
      return { reader, count: rows.length, read: rows.filter((r) => r.status === "read").length, thisYear: rows.filter((r) => r.status === "read" && r.year === year).length, note: last ? pages.inline(last.entry.note) : "" };
    });
}

app.get("/", (req, res) => {
  // Search results lived at /?q= before they got their own address.
  if (req.query.q) return res.redirect(301, `/search?${new URLSearchParams({ q: String(req.query.q) })}`);
  const seeds = social.seeds(req.user?.id);
  const own = req.user ? new Set(Object.keys(store.entriesOf(req.user.id))) : new Set();
  const recs = seeds.map((seed) => ({ seed, own: own.has(seed.id), books: social.similar([seed.id], { limit: 6, skip: own }) })).filter((r) => r.books.length);
  // The two publishers with the most new books, subscriptions first.
  const showcase = shelvesFor(req)
    .map((s) => shelfSummary(req, s, 5))
    .filter((s) => s.items.length)
    .sort((a, b) => b.subscribed - a.subscribed || b.fresh - a.fresh)
    .slice(0, 2);
  res.send(pages.homePage({ user: req.user, picks: social.picks(), feed: feedFor(req, 6), recs, showcase, fetched: day(store.shelvesRefreshedAt), libraries: librariesFor(req) }));
});

// The feed as a signed-in reader sees it: what the readers they follow did comes first, then everyone else.
const followed = (req) => new Set(auth.following(req.user?.id));
function feedFor(req, limit) {
  const mine = followed(req);
  const first = mine.size ? social.feed({ limit, readers: mine }) : [];
  if (first.length >= limit) return first;
  const seen = new Set(first.map((x) => `${x.reader.id}:${x.id}`));
  return [...first, ...social.feed({ limit: limit + first.length }).filter((x) => !seen.has(`${x.reader.id}:${x.id}`))].slice(0, limit);
}

app.get("/readers", (req, res) => {
  const readers = readerList();
  const all = social.all();
  res.send(pages.readersPage({ user: req.user, feed: social.feed({ limit: 40 }), readers, followed: followed(req), totals: { readers: readers.length, books: readers.reduce((s, r) => s + r.count, 0), notes: all.filter((x) => x.entry.note).length } }));
});

// «Стежити» / «Стежу» on a reader's page: follow or unfollow them, then back to where it was pressed.
app.post("/api/follow/:username", signed, (req, res) => {
  const target = auth.byUsername(req.params.username);
  if (!target || auth.toggleFollow(req.user.id, target.id) === null) return res.status(404).send("Немає такого читача");
  res.redirect(req.get("referer") || `/@${target.username}`);
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
// /@<username> is a reader's shelf: their own (with «змінити», recommendations, «+ Додати книжку») when
// they open it, the public one for everyone else and with ?public. /me is a shortcut to your own
// (Max, 2026-10-20: one address for a shelf, so the one in the address bar can be shared).
app.get("/me", signed, (req, res) => res.redirect(req.user.href));
app.get("/@:username", (req, res) => {
  const reader = pub(auth.byUsername(req.params.username));
  if (!reader) return res.status(404).send(pages.messagePage({ title: "Немає такого читача", text: "", user: req.user }));
  if (reader.username !== req.params.username) return res.redirect(301, reader.href);
  const rows = libraryRows(reader.id);
  if (req.user?.id === reader.id && !("public" in req.query)) {
    const fives = rows.filter((r) => r.rating >= 5).slice(0, 5).map((r) => r.id);
    const recs = social.alsoLiked(fives, { limit: 4, skip: new Set(rows.map((r) => r.id)) });
    return res.send(pages.libraryPage({ rows, user: req.user, reader: req.user, own: true, recs }));
  }
  res.send(pages.libraryPage({ rows, user: req.user, reader, mineIds: req.user && req.user.id !== reader.id ? new Set(Object.keys(store.entriesOf(req.user.id))) : null, following: auth.follows(req.user?.id, reader.id) }));
});
// The owner's page before usernames (/reader/max) moved to /@maxua.
app.get(OLD_READER, (req, res) => res.redirect(301, pub(auth.reader(OWNER_ID)).href));
app.get("/me/book/:id", signed, (req, res) => {
  const id = store.resolve(req.params.id);
  if (!id) return res.status(404).send(pages.messagePage({ title: "Немає такої книжки", text: "", user: req.user }));
  const book = store.book(id);
  res.send(pages.editPage({ book, entry: store.entry(req.user.id, book.id), user: req.user }));
});

app.get("/publishers", (req, res) => {
  res.send(pages.publishersPage({ user: req.user, shelves: shelvesFor(req).map((s) => shelfSummary(req, s, 4)).sort((a, b) => b.fresh - a.fresh), libraries: librariesFor(req) }));
});
app.get("/publishers/:id", (req, res) => {
  const shelf = store.shelf(req.params.id);
  if (!shelf || (shelf.draft && !req.owner)) return res.status(404).send(pages.messagePage({ title: "Немає такого видавництва", text: "", user: req.user }));
  const items = visible(shelf);
  const fresh = items.filter((it) => it.isNew).slice(0, 6);
  const works = new Set(items.map((it) => store.canonical(it.id)));
  const others = shelvesFor(req).filter((s) => s.id !== shelf.id).map((s) => ({ shelf: s, total: visible(s).length }));
  res.send(pages.publisherPage({ shelf, subscribed: store.subscribed(req.user?.id, shelf.id), user: req.user, fresh, feed: social.feed({ limit: 6, books: works }), others, visible }));
});
// The shelves' address before the 2026-10-20 design.
app.get("/shelf/:id", (req, res) => res.redirect(301, `/publishers/${encodeURIComponent(req.params.id)}`));

const searchHits = (req, q) => store.search(q, { reader: req.user?.id }).map((h) => ({ ...h, book: bookFor(req, h.book, !!h.entry) })).filter((h) => h.book);
const normQ = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
// Everything /search shows: books (a genre's name lists that genre's books by rating), authors, readers,
// and books like the first hit on the side.
function searchAll(req, q) {
  if (!q) return {};
  const nq = normQ(q);
  const terms = nq.split(" ").filter(Boolean);
  const tag = [...new Set(store.library(OWNER_ID).flatMap((r) => r.book.tags || []))].find((t) => t === nq) || "";
  let hits = searchHits(req, q);
  if (tag) {
    const tagged = [...social.liked().values()].filter((x) => (x.book.tags || []).includes(tag)).sort((a, b) => b.avg - a.avg);
    const seen = new Set(hits.map((h) => h.book.id));
    hits = [...tagged.filter((x) => !seen.has(x.book.id)).map((x) => ({ book: x.book, entry: store.entry(req.user?.id, x.book.id) })), ...hits].slice(0, 40);
  }
  const has = (name) => terms.every((t) => normQ(name).split(" ").some((w) => w.startsWith(t)));
  const authorsFound = (store.authors?.list || [])
    .filter((a) => has(a.name) || (a.other && has(a.other)))
    .slice(0, 6)
    .map((a) => ({ ...a, books: a.ids.length, readers: new Set(a.ids.flatMap((id) => store.readersOf(id).map((r) => r.reader))).size }));
  const readersFound = auth
    .readers()
    .filter((r) => has(r.name) || r.username.startsWith(nq))
    .map((r) => ({ reader: pub(r), count: Object.keys(store.entriesOf(r.id)).length }))
    .filter((r) => r.count)
    .slice(0, 6);
  const similar = hits.length ? social.alsoLiked([hits[0].book.id], { limit: 4, skip: new Set(hits.map((h) => h.book.id)) }) : [];
  return { hits, authors: authorsFound, readers: readersFound, similar, tag };
}
app.get("/search", (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 100);
  res.send(pages.searchPage({ q, user: req.user, results: searchAll(req, q) }));
});
// The same results as an HTML fragment, for search as you type.
app.get("/api/search", (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 100);
  res.set("Cache-Control", "no-store").send(pages.searchResults({ q, user: req.user, ...searchAll(req, q) }));
});

app.get("/book/:id", (req, res) => {
  const id = store.resolve(req.params.id);
  if (!id) return res.status(404).send(pages.messagePage({ title: "Немає такої книжки", text: "", user: req.user }));
  // One address per work: an id, an edition id or an old slug redirects to the canonical one.
  if (store.href(id) !== `/book/${encodeURIComponent(req.params.id)}`) return res.redirect(301, store.href(id));
  const book = bookFor(req, store.bookPage(id), !!store.entry(req.user?.id, id));
  if (!book) return res.status(404).send(pages.messagePage({ title: "Немає такої книжки", text: "", user: req.user }));
  res.send(pages.bookPage({ book, entry: store.sharedEntry(req.user?.id, book.id), user: req.user, shelf: book.shelf && (req.owner || !isDraft(book.shelf)) ? store.shelf(book.shelf) : null, inLibrary: inLibraryMap(req), readers: readersOf(book.id), also: social.alsoLiked([book.id], { limit: 4 }) }));
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
    .map((h) => ({ ...h, avg: social.stats(h.book.id).avg }))
    .sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1) || !!b.entry - !!a.entry || shown.has(a.book.id) - shown.has(b.book.id) || a.book.title.localeCompare(b.book.title, "uk"));
  // Who reads this author, and what else those readers rated highest.
  const ids = new Set(hits.map((h) => h.book.id));
  const who = [...new Set(hits.flatMap((h) => store.readersOf(h.book.id).map((r) => r.reader)))]
    .map((id) => ({ reader: pub(auth.reader(id)), rows: store.library(id) }))
    .filter((r) => r.reader)
    .map(({ reader, rows }) => ({ reader, count: rows.length, read: rows.filter((r) => r.status === "read").length }));
  const also = social.alsoLiked([...ids], { limit: 4, skip: ids }).filter((b) => !author.ids.includes(b.id));
  res.send(pages.authorPage({ author, works, hits, user: req.user, readers: who, also }));
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
  // A book typed in by hand may duplicate a catalog's or be junk: the owner gets a letter and sorts it out
  // (Max, 2026-10-20: «треба … сповіщення мені на імейл. будемо поки вручну розбирати»).
  if (!req.owner) notifyOwner(`Нова книжка: ${b.title}`, [`${req.user.name} (@${req.user.username}) додав(ла) книжку вручну.`, "", `Назва: ${b.title}`, `Автор: ${b.author || "не вказано"}`, b.cover ? `Обкладинка: ${b.cover}` : "", "", `Книжка: ${site(req)}${store.href(b.id)}`, `Полиця читача: ${site(req)}${req.user.href}`].filter((l, i, a) => l || a[i - 1]).join("\n"));
  res.redirect(store.href(b.id));
});

app.post("/api/refresh", owner, async (req, res) => {
  const r = await refreshShelves(true, String(req.query.only || ""));
  res.send(pages.messagePage({ title: r.ok ? "Каталоги оновлено" : "Не вдалося оновити", text: [...(r.counts || []).map(([id, n]) => `${id}: ${n}`), ...r.errors].join("; "), user: req.user }));
});

// ---- the weekly letter (digest.js) ----

// «Відписатися» in the letter: one click, no sign-in, a signed link per reader; the page offers to turn it
// back on. The POST form of the same address is the mail client's own unsubscribe button (List-Unsubscribe).
const unsubscribe = (req, res, on) => {
  const reader = auth.reader(req.params.id);
  if (!reader || !digest.check(reader.id, req.params.token)) return res.status(404).send(pages.messagePage({ title: "Посилання не підходить", text: "Вимкнути листи можна в налаштуваннях.", user: req.user }));
  digest.setEnabled(reader.id, on);
  if (req.method === "POST" && !req.body.page) return res.type("text").send("OK");
  res.send(pages.digestPage({ on, action: `/digest/${on ? "unsubscribe" : "resubscribe"}/${encodeURIComponent(reader.id)}/${req.params.token}`, user: req.user }));
};
app.get("/digest/unsubscribe/:id/:token", (req, res) => unsubscribe(req, res, false));
app.post("/digest/unsubscribe/:id/:token", (req, res) => unsubscribe(req, res, false));
app.post("/digest/resubscribe/:id/:token", (req, res) => unsubscribe(req, res, true));
// The owner looks at a letter as it would go out (their own, or ?reader=<username>'s), and sends the run.
app.get("/digest/preview", owner, async (req, res) => {
  const reader = req.query.reader ? auth.byUsername(req.query.reader) : auth.reader(req.user.id);
  if (!reader) return res.status(404).send("Немає такого читача");
  const d = await digest.build(reader.id);
  if (d.empty) return res.type("text").send(`@${reader.username}: за цей період нічого нового, лист не пішов би.\n\n${JSON.stringify(d.state, null, 2)}`);
  const letter = digest.render({ ...reader }, d);
  if (req.query.text) return res.type("text").send(`Тема: ${letter.subject}\n\n${letter.text}`);
  // On top of the letter, for the owner: the subject and a button that mails it to them.
  const bar = `<div style="background:#1b1a17;color:#ece8df;font:14px -apple-system,sans-serif;padding:10px 20px;display:flex;gap:16px;align-items:center;flex-wrap:wrap"><span>Тема: <b>${pages.esc(letter.subject)}</b></span><span style="flex:1"></span><a href="?text=1" style="color:#a29d92">текстова версія</a>${reader.id === req.user.id ? `<form method="post" action="/api/digest?test=1" style="margin:0"><button style="border:1px solid #ece8df;background:none;color:#ece8df;border-radius:999px;padding:6px 14px;cursor:pointer">Надіслати собі</button></form>` : ""}</div>`;
  res.send(letter.html.replace("<body", `${bar}<body`));
});
// POST /api/digest?test=1 mails the owner their own letter without recording it; without `test` it is the
// weekly run itself (every recipient, recorded), for when the Friday timer has to be redone by hand.
app.post("/api/digest", owner, async (req, res) => {
  if (req.query.test) {
    const r = await digest.sendTo(auth.reader(req.user.id), { dry: true, force: true });
    return res.send(pages.messagePage({ title: r.sent ? "Лист надіслано" : "Листа не було б", text: r.sent ? `Тема: ${r.subject}` : r.reason, user: req.user }));
  }
  const r = await digest.run();
  res.send(pages.messagePage({ title: "Розсилку виконано", text: `надіслано ${r.sent}, пропущено ${r.skipped}${r.errors.length ? `; помилки: ${r.errors.join("; ")}` : ""}`, user: req.user }));
});
app.get("/digest/status", owner, (req, res) => res.json({ to: digest.to, recipients: digest.recipients().map((r) => `@${r.username}`), lastRun: store.db.get("digest:lastRun"), last: JSON.parse(store.db.get("digest:last") || "null") }));

app.post("/api/subscribe/:id", signed, (req, res) => {
  if (store.toggleSubscription(req.user.id, req.params.id) === null) return res.status(404).send("Немає такої полиці");
  res.redirect(req.get("referer") || "/");
});

app.listen(PORT, () => console.log(`Chytai web on http://localhost:${PORT}  (library: ${store.file})`));

// Chytai web: the platform part (library, Discovery, search), separate from the reader
// in server/index.js. Plain Express, server-rendered HTML, JSON on disk.
//
// Env: DATA_DIR (default ./data; the database is DATA_DIR/web/chytai.db, see db.js), PORT (default 8090), GOOGLE_BOOKS_KEY (book details, enrich.js),
// WEB_DOMAIN (the public host; www and *.fly.dev redirect to it).
// Accounts (auth.js): readers sign up and in with a code mailed by Resend (RESEND_API_KEY, WEB_MAIL_FROM;
// without the key the code goes to the log). The owner (Max) is the reader "owner": WEB_OWNER is his name,
// WEB_OWNER_USERNAME his page (/@maxua), WEB_OWNER_SLUG the old /reader/<slug> address that redirects there,
// and WEB_LOGIN_TOKEN, if set, keeps the old magic link /login/<token> signing in as him.
const express = require("express");
const fs = require("fs");
const path = require("path");
const { Store, OWNER: OWNER_ID, slugify, isRussian, norm, workName, mainGenres } = require("./store");
const { Auth } = require("./auth");
const pages = require("./pages");
const catalogs = require("./catalogs");
const libraries = require("./libraries");
const wikidata = require("./wikidata");
const authors = require("./authors");
const { Social } = require("./social");
const goodreads = require("./goodreads");
const { Digest, AUDIENCES } = require("./digest");
const { WelcomeMail } = require("./welcome-mail");
const listimport = require("./listimport");
const applebooks = require("./applebooks");
const enrich = require("./enrich");
const readeat = require("./readeat");
const { BookPage, isUrl } = require("./bookpage");
const { UkFinder } = require("./ukfind");
const { Admin, adminPage, shelvesPage, readersPage, overviewsPage, speedPage, jobsPage, BOT } = require("./admin");
const { Mcp } = require("./mcp");
const { Reviews } = require("./reviews");
const { Advice } = require("./advice");
const { Lists } = require("./lists");
const bg = require("./jobs"); // background jobs in their own process (main.js, jobs.js)

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
const admin = new Admin(store.db, { ownerId: OWNER_ID }); // the owner's statistics (/admin): visits and page views
const speed = new (require("./speed").Speed)({ db: store.db, today: () => require("./admin").dayOf(new Date()) }); // /admin/speed
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
function refreshCatalogs(force = false, only = "") {
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
const refreshShelves = bg.fn("refresh", refreshCatalogs, true, () => ({ refreshRunning: !!refreshing, log: currentLog.slice(-30), last: lastResult, lastRefresh }));
// The daily refresh starts by itself once the shelves are older than REFRESH_MS (refreshCatalogs checks).
bg.every("refresh-check", 10 * 60 * 1000, () => refreshShelves(), { db: store.db, first: 2 * 60 * 1000 });
// After a start, go on with a source a restart (a deploy) cut short (its progress is in partial:<id>), and
// read a source added since the last refresh (no shelf yet) instead of leaving it for the next morning;
// one source at a time.
const pendingSources = catalogs.SOURCES.filter((s) => !store.shelf(s.id) || JSON.parse(store.db.get(`partial:${s.id}`) || "[]").length).map((s) => s.id);
if (pendingSources.length && bg.background)
  setTimeout(async () => {
    for (const id of pendingSources) {
      while (refreshing) await refreshing;
      await refreshShelves(true, id);
    }
  }, 30000).unref();
// Ukrainian titles of foreign books (wikidata.js), weekly; the first time a minute after start.
const refreshUk = () => wikidata.refreshUk(store, { log: console.log }).catch((e) => console.error("wikidata failed:", e));
// Who is who among the authors (authors.js), weekly, after the Ukrainian titles.
const refreshAuthors = () => authors.refresh(store, { log: console.log }).catch((e) => console.error("authors failed:", e));
// Details of the readers' own books from Open Library (enrich.js), weekly, after those.
// Readeat (readeat.js) goes first for books typed in Ukrainian: the Ukrainian edition's cover, not the original's.
const readeatPass = (ids) => readeat.enrich(store, { ids, log: console.log }).catch((e) => console.error("readeat failed:", e));
const details = (opts) => readeatPass(opts.ids).then(() => enrich.enrich(store, { log: console.log, googleKey: process.env.GOOGLE_BOOKS_KEY || "", ...opts })).catch((e) => console.error("enrich failed:", e));
const refreshDetails = () => readeatPass().then(() => enrich.refresh(store, { log: console.log, googleKey: process.env.GOOGLE_BOOKS_KEY || "" })).catch((e) => console.error("enrich failed:", e));
const refreshWikidata = bg.fn("wikidata", () => refreshUk().then(refreshAuthors).then(refreshDetails).then(() => true), true);
bg.every("wikidata", 6 * 3600 * 1000, () => refreshWikidata(), { db: store.db });
// Bulk passes the owner starts (/admin/readeat, /admin/enrich) go to the jobs process too; a reader's own
// new book (details above) is looked up right here, so its cover shows at once.
const readeatAll = bg.fn("readeat", () => readeatPass().then(() => true), true);
const enrichMany = bg.fn("enrich", (opts) => enrich.enrich(store, { ...opts, log: console.log, googleKey: process.env.GOOGLE_BOOKS_KEY || "" }).then(() => true), true);

// «Огляди» on book pages (reviews.js): links the owner adds on /admin/reviews.
const reviews = new Reviews(store, { log: console.log });

pages.setTitleLinks((md, id) => store.linkTitles(md, id));
pages.setAuthorLinks((name) => store.authors?.byName(name)?.href || null);

const app = express();
app.set("trust proxy", true);
app.use(express.urlencoded({ extended: false, limit: "1mb" }));
app.use(express.json({ limit: "1mb" }));
app.use(require("compression")()); // pages are 50–150 KB of HTML; gzip cuts that about five times
// A page that took over two seconds, and a main loop that stood still for over one, go to the log (a new reader
// waited ~30 s for search and their shelf on 2026-10-24, and nothing told us where): `fly logs | grep slow`.
// The server's own time goes out as `Server-Timing: app;dur=…` (the browser's network tab shows it, and
// scripts/perf-check.sh holds every deploy to it, network aside).
app.use((req, res, next) => {
  const t0 = Date.now();
  const head = res.writeHead;
  res.writeHead = function (...args) {
    if (!res.headersSent) res.setHeader("Server-Timing", `app;dur=${Date.now() - t0}`);
    return head.apply(this, args);
  };
  res.on("finish", () => {
    const ms = Date.now() - t0;
    if (ms > 2000) console.log(`slow: ${req.method} ${req.originalUrl.slice(0, 120)} ${ms} ms ${res.statusCode}${req.user ? ` @${req.user.username}` : ""}`);
    // A page (HTML, not a picture, a call or /admin) for /admin/speed: people and robots apart.
    if (req.method === "GET" && res.statusCode === 200 && /text\/html/.test(res.getHeader("Content-Type") || "") && !/^\/(api|admin|t)\//.test(req.path) && !("rest" in req.query))
      speed.add(BOT.test(req.headers["user-agent"] || "") ? "bot" : "page", ms);
  });
  next();
});
// How long the main loop stood still in the last 30 seconds (the stall watch below fills it).
let stillRecently = () => 0;
{
  // In the jobs process a stall keeps no reader waiting: it is only logged («jobs slow:»), for the profile.
  const who = bg.ROLE === "jobs" ? "jobs " : "";
  let tick = Date.now();
  setInterval(() => {
    const late = Date.now() - tick - 1000;
    if (late > 1000) console.log(`${who}slow: the main loop stood still for ${late} ms`), stalls++, who || speed.add("stall", late);
    else stalls = 0;
    // Stood still over half of the last five minutes: the site is as good as down (2026-10-24: an hour of it,
    // and we learned from a reader). The owner gets a letter, and the process exits so Fly starts it afresh.
    const t = Date.now();
    recent.push([t, Math.max(0, late)]);
    while (recent[0][0] < t - 5 * 60 * 1000) recent.shift();
    const still = recent.reduce((n, [, ms]) => n + ms, 0);
    if (still > 150 * 1000 && !exiting && bg.serving) {
      exiting = true;
      const msg = `За останні 5 хвилин сервер стояв ${Math.round(still / 1000)} с: сайт майже не відповідав. Перезапускаю процес. Що їло процесор, дивись у fly logs: grep "slow: cpu".`;
      console.log(`${who}slow: ${msg}`);
      notifyOwner("Chytai: сайт гальмував, перезапуск", msg);
      setTimeout(() => process.exit(1), 5000);
    }
    if (stalls >= 3 && Date.now() - profiled > 10 * 60 * 1000) (profiled = Date.now()), profile();
    tick = Date.now();
  }, 1000).unref();
  // Three stalls in a row (2026-10-24: 2–4 s every 3 s for an hour, and the log said nothing of whose):
  // a 15-second CPU profile, its top functions by own time to the log as `slow: cpu …`, once in ten minutes.
  let stalls = 0;
  let profiled = 0;
  const recent = []; // [time, ms the loop was late] for the last five minutes
  stillRecently = () => recent.reduce((n, [t, ms]) => n + (t > Date.now() - 30 * 1000 ? ms : 0), 0);
  let exiting = false;
  function profile() {
    const s = new (require("inspector").Session)();
    s.connect();
    s.post("Profiler.enable", () =>
      s.post("Profiler.start", () =>
        setTimeout(() =>
          s.post("Profiler.stop", (err, { profile } = {}) => {
            s.disconnect();
            if (err || !profile) return console.log(`${who}slow: cpu profile failed: ${err?.message}`);
            const dt = new Map(); // node id -> ms of own time
            for (let i = 0; i < profile.samples.length; i++) dt.set(profile.samples[i], (dt.get(profile.samples[i]) || 0) + (profile.timeDeltas[i] || 0) / 1000);
            const self = new Map();
            for (const n of profile.nodes) {
              const f = n.callFrame;
              const k = `${f.functionName || "(anon)"} ${f.url.replace(/^.*\/(web|node_modules)\//, "$1/")}:${f.lineNumber + 1}`;
              self.set(k, (self.get(k) || 0) + (dt.get(n.id) || 0));
            }
            const top = [...self].sort((a, b) => b[1] - a[1]).slice(0, 12);
            console.log(`${who}slow: cpu 15 s, own time: ${top.map(([k, ms]) => `${Math.round(ms)} ms ${k}`).join(" | ")}`);
            // And our own functions with what they called: whose work it was.
            const parent = new Map();
            for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n);
            const byId = new Map(profile.nodes.map((n) => [n.id, n]));
            const total = new Map();
            for (const [id, ms] of dt) {
              const seen = new Set();
              for (let n = byId.get(id); n; n = parent.get(n.id)) {
                const f = n.callFrame;
                if (!/\/web\/[^/]+\.js$/.test(f.url)) continue;
                const k = `${f.functionName || "(anon)"} ${f.url.replace(/^.*\//, "")}:${f.lineNumber + 1}`;
                if (!seen.has(k)) seen.add(k), total.set(k, (total.get(k) || 0) + ms);
              }
            }
            console.log(`${who}slow: cpu 15 s, ours with callees: ${[...total].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, ms]) => `${Math.round(ms)} ms ${k}`).join(" | ")}`);
          }),
        15000).unref()
      )
    );
  }
}
// Robots wait while the site is struggling (2026-10-25: Google's crawler, let in by the new sitemap, stood the
// site still for readers): when the main loop stood still over 3 s of the last 30, a robot gets 503 and «come
// back in five minutes», which Google and Bing take as a sign to crawl slower; people are served as always.
let turnedAway = 0;
app.use((req, res, next) => {
  if (stillRecently() < 3000 || !["GET", "HEAD"].includes(req.method) || /^\/(mcp|oauth|\.well-known)/.test(req.path) || !BOT.test(req.headers["user-agent"] || "")) return next();
  if (!turnedAway++) setTimeout(() => (console.log(`slow: ${turnedAway} robot requests turned away (503) while the site was busy`), (turnedAway = 0)), 60 * 1000).unref();
  res.set("Retry-After", "300").status(503).type("text").send("Busy, please come back later.");
});
// Style and script addresses carry a content hash (pages.js asset()), so they can live in caches for a year.
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1y", immutable: true }));
// Covers the owner sets by hand live here, not on a shop's site (Max, 2026-10-23: «я думав ми обкладинки самі
// хостимо»). The file name is a hash of the picture, so it never changes and can be cached for good.
const COVERS = path.join(DATA_DIR, "covers");
fs.mkdirSync(COVERS, { recursive: true });
app.use("/covers", express.static(COVERS, { maxAge: "1y", immutable: true }));
// Small copies of the covers on shelves and lists (thumbs.js).
const thumbs = new (require("./thumbs").Thumbs)({ db: store.db, dir: COVERS, log: console.log, isBot: (req) => BOT.test(req.headers["user-agent"] || "") });
pages.setThumbs((src, shown) => thumbs.url(src, shown));
app.get("/t/:w/:sig/:src", (req, res) => thumbs.serve(req, res).catch(() => res.status(500).end()));
bg.every("thumbs-prune", 24 * 3600 * 1000, () => thumbs.prune(), { db: store.db, first: 30 * 60 * 1000 });
bg.every("thumbs-warm", 6 * 3600 * 1000, () => thumbs.warm([...store.entries.values()].flatMap((es) => Object.keys(es)).map((id) => store.book(id)?.cover)), { db: store.db, first: 20 * 60 * 1000 });
const COVER_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif" };
// A picture's address -> { url: our own /covers/<hash>.<ext> } or, when it can't be fetched, { url: the
// address itself, error }.
// A GET over IPv6 with a body as bytes, shaped like fetch's answer for keepCover.
function getV6(url, headers) {
  const u = new URL(url);
  const lib = u.protocol === "http:" ? require("http") : require("https");
  return new Promise((resolve, reject) => {
    const rq = lib.request({ host: u.hostname, family: 6, path: u.pathname + u.search, headers, timeout: 15000 }, (r) => {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => resolve({ ok: r.statusCode >= 200 && r.statusCode < 300, status: r.statusCode, headers: { get: (k) => r.headers[k.toLowerCase()] }, arrayBuffer: async () => Buffer.concat(chunks) }));
    });
    rq.on("timeout", () => rq.destroy(new Error("timeout")));
    rq.on("error", reject);
    rq.end();
  });
}
async function keepCover(url) {
  if (!/^https?:\/\//i.test(url || "")) return { url };
  try {
    const headers = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36", Accept: "image/avif,image/webp,image/*,*/*;q=0.8", Referer: new URL(url).origin + "/" };
    let r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    // Some shops turn Fly's shared IPv4 away (Наш Формат: 403); over IPv6 they may not.
    if (!r.ok) r = (await getV6(url, headers).catch(() => null)) || r;
    const type = String(r.headers.get("content-type") || "").split(";")[0].trim();
    const buf = Buffer.from(await r.arrayBuffer());
    // Some shops say octet-stream: the first bytes tell a picture anyway.
    const sniff = buf[0] === 0xff && buf[1] === 0xd8 ? "jpg" : buf.slice(1, 4).toString() === "PNG" ? "png" : buf.slice(8, 12).toString() === "WEBP" ? "webp" : buf.slice(0, 3).toString() === "GIF" ? "gif" : "";
    const ext = COVER_TYPES[type] || sniff;
    if (!r.ok) return { url, error: `HTTP ${r.status}` };
    if (!ext) return { url, error: `не картинка (${type || "без типу"})` };
    if (buf.length < 500 || buf.length > 8e6) return { url, error: `розмір ${buf.length} байт` };
    const name = `${require("crypto").createHash("sha1").update(buf).digest("hex").slice(0, 20)}.${ext}`;
    fs.writeFileSync(path.join(COVERS, name), buf);
    return { url: `/covers/${name}` };
  } catch (e) {
    console.error("cover not kept:", url, e.message, e.cause?.code || "");
    return { url, error: [e.message, e.cause?.code].filter(Boolean).join(", ") };
  }
}
// Open Library's covers take 2–9 s each (2026-10-25: the slowest thing on readers' shelves), so the books'
// covers from there are kept here too, a few hundred a run, and new ones each run after. The old address
// stays in `coverFrom` (store.js fromOpenLibrary).
const OL_COVER = /^https?:\/\/covers\.openlibrary\.org\//;
const keepOpenLibraryCovers = bg.fn("ol-covers", async () => {
  const ids = Object.values(store.lib.books).filter((b) => OL_COVER.test(b.cover || "")).map((b) => b.id);
  let kept = 0;
  for (const id of ids.slice(0, 300)) {
    const b = store.lib.books[id];
    if (!b || !OL_COVER.test(b.cover || "")) continue;
    const r = await keepCover(b.cover);
    if (!r.error) store.updateBook(id, { cover: r.url, coverFrom: b.cover, coverKept: r.url }), kept++;
    await new Promise((ok) => setTimeout(ok, 1000));
  }
  if (ids.length) console.log(`covers: kept ${kept} of ${Math.min(ids.length, 300)} Open Library covers here, ${ids.length - kept} left`);
  return kept > 0;
}, true);
bg.every("ol-covers", 3 * 3600 * 1000, () => keepOpenLibraryCovers(), { db: store.db, first: 15 * 60 * 1000 });
// Covers set by hand before we kept them: fetched once after a start, in the background.
setTimeout(async () => {
  for (const [id, fix] of Object.entries(store.edits())) {
    if (!/^https?:/i.test(fix.cover || "")) continue;
    const { url } = await keepCover(fix.cover);
    if (url !== fix.cover) store.editBook(id, { ...store.edits()[id], cover: url });
  }
}, 30000);
app.get("/icon.png", (req, res) => res.sendFile(path.join(ROOT, "build", "icon.png")));

// ---- auth: readers signed in by a code sent to their e-mail (auth.js) ----

// A reader as the pages see them: name, username and the address of their page.
const pub = (r) => (r ? { id: r.id, name: r.name, username: r.username, href: `/@${r.username}`, owner: r.id === OWNER_ID, email: r.email, noindex: !!r.noindex, created: r.created || "" } : null);
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").map((c) => c.trim().split("=")).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join("="))]));
}
app.use((req, res, next) => {
  // One public host: www and the Fly hostname go to the domain once it is live.
  const host = req.hostname || "";
  if (DOMAIN && host !== DOMAIN && (host === `www.${DOMAIN}` || host === `${process.env.FLY_APP_NAME}.fly.dev`)) return res.redirect(301, `https://${DOMAIN}${req.originalUrl}`);
  req.token = cookies(req)[COOKIE] || "";
  req.user = pub(auth.readerOf(req.token, OWNER_ID));
  req.owner = !!req.user?.owner; // drafts, refresh: the owner's business
  res.locals.user = req.user;
  admin.touch(req, req.user?.id);
  admin.arrive(req, res, req.user?.id, { cookies: cookies(req), ownHosts: new Set([host, DOMAIN, `www.${DOMAIN}`, `${process.env.FLY_APP_NAME}.fly.dev`, "localhost"].filter(Boolean)), secure: secure(req) });
  next();
});
const signed = (req, res, next) => (req.user ? next() : res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`));
const owner = (req, res, next) => (req.owner ? next() : res.status(403).send("Це може лише власник сайту."));
const secure = (req) => req.secure || req.headers["x-forwarded-proto"] === "https";
const safeNext = (v) => (/^\/(?!\/)/.test(String(v || "")) ? String(v) : "");

// Public and harmless: when the shelves were last refreshed and whether the sources answered.
app.get("/refresh-status", (req, res) => {
  const r = bg.ROLE === "web" ? bg.status("refresh") : { refreshRunning: !!refreshing, log: currentLog.slice(-30), last: lastResult, lastRefresh };
  res.json({ running: !!r.refreshRunning, ...(r.refreshRunning && { log: r.log }), last: r.last, shelvesFetched: store.shelvesFetched, refreshedAt: store.shelvesRefreshedAt, authors: store.db.get("authors:log"), enrich: store.db.get("enrich:log"), memoryMb: Object.fromEntries(Object.entries(process.memoryUsage()).map(([k, v]) => [k, Math.round(v / 1048576)])), nextAfter: new Date((r.lastRefresh || 0) + REFRESH_MS).toISOString(), jobs: bg.ROLE });
});

// Sign in or sign up, the same door: an e-mail, a code, and for a new address a name and a username.
app.get("/login", (req, res) => {
  if (req.user) return res.redirect(safeNext(req.query.next) || "/me");
  const next = safeNext(req.query.next);
  // A guest's «Хочу прочитати» (or another /do/ step): the page says which book it is for.
  const m = /^\/do\/(want|read|now|kids)\/([^/?#]+)$/.exec(next);
  const id = m && store.canonical(store.resolve(decodeURIComponent(m[2])) || "");
  const book = id ? store.bookPage(id) : null;
  if (book) admin.guestTap(req, null, m[1] === "want" ? "want" : "mark", cookies(req));
  res.send(pages.loginPage({ next, book, what: m?.[1], free: !!freeFileFor(book) }));
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
  admin.came(reader.id, cookies(req).chytai_came);
  res.append("Set-Cookie", `chytai_came=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
  console.log(`new reader @${reader.username}`);
  welcomeMail.newReader(reader);
  // Someone who came from the reader goes straight back to it; the welcome page is about the site.
  // So does one who signed up to save a book (/do/…): the book is saved and they are back on its page.
  signIn(req, res, reader, next.startsWith("/reader-login") || next.startsWith("/oauth/authorize") || next.startsWith("/do/") ? next : `/welcome${next ? `?next=${encodeURIComponent(next)}` : ""}`);
});
app.get("/welcome", signed, (req, res) => (admin.step(req.user.id, "welcome"), res.send(pages.welcomePage({ user: req.user, next: safeNext(req.query.next) }))));
function signIn(req, res, reader, next) {
  res.append("Set-Cookie", auth.cookie(auth.signIn(reader.id), { secure: secure(req) }));
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

// The reader (app.chytai.org.ua; chytai.fly.dev in the iPhone app) signs in with the site's account (Max, 2026-10-22):
// its login page sends the reader here, the site makes a one-time ticket for whoever is signed in and
// sends them back with it, and the reader's server trades the ticket for who it is (POST below).
// The reader keeps its own cookie after that; a ticket lasts two minutes and works once.
const READER_ORIGINS = (process.env.READER_ORIGINS || "https://app.chytai.org.ua,https://read.chytai.org.ua,https://chytai.fly.dev").split(",").map((o) => o.trim()).filter(Boolean);
const readerTickets = new Map(); // ticket -> { id, expires }
const READER_URL = (process.env.READER_URL || READER_ORIGINS[0]).replace(/\/$/, "");
// With the account the reader also gets a key for that account alone, to tell the site which books it
// has (POST /api/reader-library). The key is an HMAC with the site's own secret, kept in the database.
const readerSecret = () => store.db.get("reader:secret") || (store.db.set("reader:secret", require("crypto").randomBytes(32).toString("hex")), store.db.get("reader:secret"));
const readerKey = (id) => require("crypto").createHmac("sha256", readerSecret()).update(`reader:${id}`).digest("hex");
app.get("/reader-login", signed, (req, res) => {
  let origin = "";
  try {
    origin = new URL(String(req.query.back || "")).origin;
  } catch {}
  if (!READER_ORIGINS.includes(origin)) return res.status(400).send(pages.messagePage({ title: "Невідома адреса читалки", text: "Відкрийте читалку ще раз і натисніть «Увійти».", user: req.user }));
  for (const [t, v] of readerTickets) if (v.expires < Date.now()) readerTickets.delete(t);
  const ticket = require("crypto").randomBytes(16).toString("hex");
  readerTickets.set(ticket, { id: req.user.id, expires: Date.now() + 120000 });
  res.redirect(`${origin}/auth?ticket=${ticket}`);
});
app.post("/api/reader-ticket", (req, res) => {
  const t = readerTickets.get(String(req.body?.ticket || ""));
  readerTickets.delete(String(req.body?.ticket || ""));
  const r = t && t.expires > Date.now() ? auth.reader(t.id) : null;
  if (!r) return res.status(404).json({ error: "ticket" });
  res.json({ id: r.id, name: r.name, username: r.username, key: readerKey(r.id) });
});
// The reader's list of books for one account: titles and authors only, never the files. Replaces the old list.
app.post("/api/reader-library", (req, res) => {
  const id = String(req.body?.id || "");
  const key = String(req.body?.key || "");
  const want = auth.reader(id) && readerKey(id);
  if (!want || key.length !== want.length || !require("crypto").timingSafeEqual(Buffer.from(key), Buffer.from(want))) return res.status(403).json({ error: "key" });
  const books = (Array.isArray(req.body?.books) ? req.body.books : []).slice(0, 5000);
  store.db.tx(() => {
    store.db.prepare("DELETE FROM reader_files WHERE reader = ?").run(id);
    const add = store.db.prepare("INSERT OR IGNORE INTO reader_files (reader, name, title, authors) VALUES (?, ?, ?, ?)");
    for (const b of books) if (b?.name && b?.title) add.run(id, String(b.name).slice(0, 300), String(b.title).slice(0, 300), (Array.isArray(b.authors) ? b.authors : []).map(String).join("; ").slice(0, 300));
  });
  res.json({ ok: true, books: books.length });
});
// The reader's file of this book, if the signed-in reader has one: same title (or the original's, or
// another edition's) and, when both name an author in the same alphabet, a shared surname.
function readerFileFor(readerId, book) {
  if (!readerId || !book) return null;
  return fileFor(store.db.prepare("SELECT name, title, authors FROM reader_files WHERE reader = ?").all(readerId), book);
}
// Free books in the reader (public domain, its free/ folder), listed in seed/free.json as { name, title, authors }.
// readerOnly: given «з дозволу автора» to read in the reader, never as a file (Max, 2026-10-26: Sivers).
const FREE = JSON.parse(fs.readFileSync(path.join(__dirname, "seed", "free.json"), "utf8"));
const freeFileFor = (book) => (book ? fileFor(FREE, book) : null);
function fileFor(files, book) {
  if (!files.length) return null;
  const key = (t) => norm(workName(t));
  const titles = new Set([book.title, book.altTitle, ...(book.editions || []).map((e) => e.title), ...(book.translations || []).map((t) => t.title)].filter(Boolean).map(key).filter((t) => t.length > 1));
  const surnames = (a) => new Set(norm(a).split(" ").filter((w) => w.length > 2));
  const bookAuthors = surnames([book.author, ...(book.translations || []).map((t) => t.author)].join(" "));
  const cyr = (set) => [...set].some((w) => /[а-яіїєґ]/.test(w));
  const sameAuthor = (f) => {
    const mine = surnames(f.authors);
    if (!mine.size || !bookAuthors.size || cyr(mine) !== cyr(bookAuthors)) return true; // «Орвелл» and «Orwell» can't be compared
    return [...mine].some((w) => bookAuthors.has(w));
  };
  return files.find((f) => titles.has(key(f.title)) && sameAuthor(f)) || null;
}

// A free book's page here by its file name in the reader: the QR on the last page the reader prints
// (Max, 2026-10-26: «qr код має вести на сайт каталога»). Not found: a search for its title.
app.get("/free-book/:name", (req, res) => {
  const f = FREE.find((x) => x.name === req.params.name);
  if (!f) return res.redirect("/");
  // The file's title can be longer than the catalog's («Лис Микита. Коли ще звірі говорили»): try its first part too.
  const queries = [...new Set([f.title, f.title.split(/[.:(]/)[0].trim()])].filter((q) => q.length > 1);
  const hit = queries
    .flatMap((q) => store.search(q, { limit: 10, alias: false }))
    .find((h) => freeFileFor(store.bookPage(h.book.id))?.name === f.name);
  res.redirect(hit ? store.href(hit.book.id) : `/search?q=${encodeURIComponent(f.title)}`);
});

// The reader asks once a day which of its accounts are gone (deleted here), to delete their books too.
app.post("/api/readers-gone", (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(String).slice(0, 10000);
  res.json({ gone: ids.filter((id) => !auth.reader(id)) });
});

app.get("/privacy", (req, res) => res.send(pages.privacyPage({ user: req.user })));
app.get("/updates", (req, res) => res.send(pages.updatesPage({ user: req.user })));
app.get("/reader", (_req, res) => res.redirect(302, `${READER_URL}/`)); // shortcut to the reader (Max 2026-10-22)

// ---- settings: name, username, e-mail, deleting the account ----

app.get("/settings", signed, (req, res) => {
  res.send(pages.settingsPage({ user: req.user, values: { ...req.user }, suggested: auth.suggestUsername(req.user.name, slugify), saved: !!req.query.saved }));
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
// The letters' tab: the weekly letter and the «стежить за вами» letter, each on or off.
app.get("/settings/mail", signed, (req, res) => {
  res.send(pages.mailSettingsPage({ user: req.user, values: { digest: digest.enabled(req.user.id), follow_mail: auth.followMailEnabled(req.user.id), want_mail: wantMail.enabled(req.user.id) }, saved: !!req.query.saved }));
});
app.post("/settings/mail", signed, (req, res) => {
  digest.setEnabled(req.user.id, !!req.body.digest);
  auth.setFollowMail(req.user.id, !!req.body.follow_mail);
  wantMail.setEnabled(req.user.id, !!req.body.want_mail);
  res.redirect("/settings/mail?saved=1");
});
app.post("/settings/delete", signed, (req, res) => {
  if (req.owner) return res.status(400).send(pages.messagePage({ title: "Власника не видаляємо", text: "Для цього є інший шлях.", user: req.user }));
  if (req.body.confirm !== req.user.username) return res.status(400).send(pages.settingsPage({ user: req.user, values: req.user, error: "Щоб видалити акаунт, впишіть своє ім'я для адреси." }));
  lists.forgetReader(req.user.id);
  mcp.forgetReader(req.user.id);
  auth.deleteReader(req.user.id);
  store.forgetReader(req.user.id);
  res.setHeader("Set-Cookie", auth.cookie("", { clear: true, secure: secure(req) }));
  res.send(pages.messagePage({ title: "Акаунт видалено", text: "Книжки, оцінки й нотатки стерто. Дякуємо, що читали з нами." }));
});

// ---- Chytai in a chat: the MCP server at /mcp and its OAuth (mcp.js) ----
const mcp = new Mcp({ store, auth, pages, site: (req) => site(req), notifyOwner, details, dropNow: (reader, id) => dropNow(reader, id) });
mcp.routes(app, { signed });

// ---- adding books: /add (one page with every way in), and imports from elsewhere ----
// A pasted list (listimport.js), Goodreads (goodreads.js) or Apple Books (applebooks.js): the reader looks at
// what each row becomes, unticks what should not go, confirms. A looked-at list waits in memory for half an
// hour under a token; nothing of it is written before the reader confirms.
// ?text= fills the list: «Додати книжку, якої ще немає» from a search that found nothing (the old one-book form is gone).
app.get("/add", signed, (req, res) => (admin.step(req.user.id, "add"), res.send(pages.addPage({ user: req.user, text: String(req.query.text || "").slice(0, 2000) }))));
// «Шукати» / «Інша книжка» on /add: our catalog first, then Open Library, so a book nobody here has yet can
// come in with its cover and ISBNs (Max, 2026-10-22: «напів-мануальне наповнення бази»).
app.get("/api/add/find", signed, async (req, res) => {
  // An address instead of words: the book from its page on a store's or a publisher's site (bookpage.js).
  if (isUrl(req.query.q)) {
    const b = await bookpage.fromUrl(String(req.query.q).trim().slice(0, 500), req.user.id, { debug: req.owner && req.query.debug === "1" });
    if (b.debug) return res.json(b.debug); // the owner's look at what the server saw on the page
    const id = !b.error && store.findWork(b);
    return res.set("Cache-Control", "no-store").send(pages.addPageResult(b, id ? store.book(id) : null));
  }
  const q = String(req.query.q || "").slice(0, 100);
  const hits = store.search(q, { limit: 6 });
  const known = new Set(hits.map((h) => h.book.id));
  const outside = (await enrich.searchOpenLibrary(q)).filter((b) => !known.has(store.findWork(b)));
  res.set("Cache-Control", "no-store").send(pages.addFindResults(hits, outside));
});
const IMPORTS = {
  list: { name: "списку", parse: null },
  goodreads: { name: "Goodreads", parse: (files) => goodreads.parseExport(files[0].body.toString("utf8")) },
  "apple-books": { name: "Apple Books", parse: (files) => applebooks.parseLibrary(files) },
};
const pendingImports = new Map(); // token -> { reader, source, rows, filename, at }
const IMPORT_TTL = 30 * 60 * 1000;
const importSource = (req, res, next) => (IMPORTS[req.params.source] ? ((req.source = req.params.source), next()) : res.status(404).send(pages.messagePage({ title: "Немає такого імпорту", text: "", user: req.user })));
const importPreview = (req, res, books, { filename = "", skipped = 0, text = "" } = {}) => {
  const { rows, counts } = goodreads.plan(store, req.user.id, books);
  for (const [t, p] of pendingImports) if (Date.now() - p.at > IMPORT_TTL) pendingImports.delete(t);
  const token = require("crypto").randomBytes(12).toString("hex");
  pendingImports.set(token, { reader: req.user.id, source: req.source, rows, filename, at: Date.now() });
  admin.step(req.user.id, "review");
  if (req.source === "list") return res.send(pages.addReviewPage({ user: req.user, token, rows, text }));
  res.send(pages.importPreviewPage({ user: req.user, source: req.source, token, rows, counts: { ...counts, skipped }, filename }));
};
app.get("/import/list", (req, res) => res.redirect("/add"));
app.post("/import/list", signed, async (req, res) => {
  req.source = "list";
  const text = String(req.body.text || "");
  const { books, error } = listimport.parseList(text, { status: "read" });
  if (error) return res.status(400).send(pages.addPage({ user: req.user, text, error }));
  // Lines that are addresses of books' pages: read at once, ten at most (the rest can go one by one via «Шукати»).
  const rows = listimport.resolve(store, books);
  await Promise.all(rows.filter((r) => r.url).map(async (r, k) => {
    const b = k < 10 ? await bookpage.fromUrl(r.url, req.user.id) : { error: "Забагато посилань за раз: до десяти." };
    if (b.error) Object.assign(r, { title: r.url, pageError: b.error });
    else Object.assign(r, fromPage(b));
  }));
  importPreview(req, res, rows, { text });
});
app.get("/import/:source", signed, importSource, (req, res) => res.send(pages.importPage({ user: req.user, source: req.source })));
app.post("/import/:source", signed, importSource, express.raw({ type: "multipart/form-data", limit: "60mb" }), (req, res) => {
  const fail = (error) => res.status(400).send(pages.importPage({ user: req.user, source: req.source, error }));
  const parts = Buffer.isBuffer(req.body) ? goodreads.parseMultipart(req.body, req.headers["content-type"]) : null;
  const files = [].concat(parts?.file || []).filter((f) => f && f.body?.length);
  if (!files.length) return fail(req.source === "goodreads" ? "Виберіть файл експорту Goodreads (.csv)." : "Виберіть файли з теки BKLibrary.");
  const { books, error, skipped = 0 } = IMPORTS[req.source].parse(files);
  if (error) return fail(error);
  importPreview(req, res, books, { filename: files.length > 1 ? `${files.length} файли` : files[0].filename, skipped });
});
// A book read from a page, as an import row: the store's link on the book page, the annotation as its blurb.
// Readeat links are fine on the site again (Max, 2026-10-23: «думаю і на сайті можемо лінки додавати насправді»).
const fromPage = (b) => ({ title: b.title, author: b.author, isbns: b.isbns || [], cover: b.cover || "", blurb: b.blurb || "", blurbSource: b.site || "", pages: b.pages || null, published: b.published || null, link: b.url ? { label: b.site || new URL(b.url).hostname, url: b.url } : null });
app.post("/import/:source/apply", signed, importSource, async (req, res) => {
  const p = pendingImports.get(String(req.body.token || ""));
  if (!p || p.reader !== req.user.id || p.source !== req.source || Date.now() - p.at > IMPORT_TTL) return res.status(400).send(req.source === "list" ? pages.addPage({ user: req.user, text: "", error: "Час вийшов або список уже імпортовано. Вставте його ще раз." }) : pages.importPage({ user: req.user, source: req.source, error: "Час вийшов або файл уже імпортовано. Виберіть файл ще раз." }));
  pendingImports.delete(req.body.token);
  admin.step(req.user.id, "saved");
  const keep = new Set([].concat(req.body.keep ?? []).map(Number));
  // «Інша книжка» on /add: the reader picked the right book for a line.
  const swapped = async (r, i) => {
    const to = String(req.body[`swap_${i}`] || "");
    const b = to && store.book(to);
    if (b) return { ...r, match: { id: b.id, title: b.title, author: b.author, href: b.href } };
    // A book from a pasted page address: read again from the cache (the browser sends only the address).
    const page = String(req.body[`page_${i}`] || "");
    if (isUrl(page)) {
      const p = await bookpage.fromUrl(page.slice(0, 500), req.user.id);
      if (!p.error) {
        const id = store.findWork(p);
        const m = id && store.book(id);
        return m ? { ...r, match: { id: m.id, title: m.title, author: m.author, href: m.href } } : { ...r, ...fromPage(p), match: null };
      }
    }
    // Filled in by hand: a title (and an author) the reader typed for a line we could not find.
    const title = String(req.body[`title_${i}`] || "").trim().slice(0, 200);
    if (!r.match && title) return { ...r, title, author: String(req.body[`author_${i}`] || "").trim().slice(0, 200), url: null, pageError: null };
    // A book picked from Open Library: the catalog's own copy if we have one after all, else a new book with its cover.
    let ol = null;
    try {
      ol = req.body[`ol_${i}`] ? JSON.parse(req.body[`ol_${i}`]) : null;
    } catch {}
    if (!ol?.title) return r;
    const book = { title: String(ol.title).slice(0, 200), author: String(ol.author || "").slice(0, 200), isbns: [].concat(ol.isbns || []).map(String).filter((x) => /^[\dX]{10,13}$/.test(x)).slice(0, 20) };
    const id = store.findWork(book);
    const m = id && store.book(id);
    if (m) return { ...r, match: { id: m.id, title: m.title, author: m.author, href: m.href } };
    return { ...r, ...book, match: null, cover: /^https:\/\/covers\.openlibrary\.org\//.test(ol.cover || "") ? ol.cover : "", ol: /^\/works\/OL\w+$/.test(ol.ol || "") ? ol.ol : "", published: Number(ol.published) || null };
  };
  // The status picked on /add for the whole list; «На папері» is no status but where the copy is.
  const as = p.source === "list" ? String(req.body.status || "read") : null;
  const kids = as === "kids";
  const batch = (r) => (kids ? { ...r, status: "", kids: true } : batchStatus(r));
  const batchStatus = (r) => (as === "paper" ? { ...r, status: "", year: null, copy: "paper" } : as && ["read", "reading", "want", "abandoned"].includes(as) ? { ...r, status: as, year: as === "read" ? r.year : null, rating: ["want", "reading"].includes(as) ? null : r.rating } : r);
  const chosen = (await Promise.all(p.rows.map(swapped))).map(batch).filter((r, i) => keep.has(i) && !r.pageError && !(p.source === "list" && r.match && store.entry(req.user.id, r.match.id)));
  // One new book once, however many lines brought it (a pasted link and «Шукати» on another line for the same book).
  const fresh = new Set();
  const unique = chosen.filter((r) => {
    const key = !r.match && `${r.title}|${r.author}`.toLowerCase();
    return !key || (!fresh.has(key) && fresh.add(key));
  });
  chosen.splice(0, chosen.length, ...unique);
  // On the shelf they sit after what is already there: the read ones by date read, oldest first, then the rest by date added.
  const key = (r) => (r.read ? `0${r.read}` : `1${r.added || "9999"}`);
  chosen.sort((a, b) => key(a).localeCompare(key(b)));
  const result = store.importEntries(req.user.id, chosen.map((r) => ({ id: r.match?.id || null, title: r.title, author: r.author, isbns: r.isbns, goodreadsId: r.goodreadsId, cycle: r.cycle, appleId: r.appleId, status: r.status, rating: r.rating, year: r.year, note: r.note, copy: r.copy, kids: r.kids, added: r.added, read: r.read, touched: r.touched, cover: r.cover, ol: r.ol, published: r.published, blurb: r.blurb, blurbSource: r.blurbSource, pages: r.pages, links: r.link ? [r.link] : [] })), { source: req.source });
  const name = IMPORTS[req.source].name;
  console.log(`${name} import @${req.user.username}: ${result.added} added, ${result.updated} updated, ${result.created.length} new books`);
  // New books by hand are mailed to the owner one by one; an import sends one letter with the list.
  if (!req.owner && result.created.length) notifyOwner(`Імпорт з ${name}: ${result.created.length} нових книжок`, [`${req.user.name} (@${req.user.username}) імпортував(ла) полицю з ${name}: ${result.added} додано, ${result.updated} доповнено.`, `Нові книжки, яких немає в каталозі (${result.created.length}):`, "", ...result.created.slice(0, 100).map((b) => `• ${b.title}${b.author ? ` — ${b.author}` : ""}  ${site(req)}${store.href(b.id)}`), result.created.length > 100 ? `… і ще ${result.created.length - 100}` : "", "", `Полиця читача: ${site(req)}${req.user.href}`].join("\n"));
  // The new books go to Readeat and Open Library for covers and details in the background, while the reader looks at the shelf.
  if (result.created.length) details({ ids: result.created.map((b) => b.id) });
  if (req.source === "list") return res.redirect(req.user.href);
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
    .map(({ reader, entry }) => ({ name: reader.name, href: reader.href, entry, now: nowIds(reader.id).has(entry.via ? store.canonical(entry.via.id) : store.canonical(id)) }));
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
// «Списки» (lists.js): readers' own public lists of books.
const lists = new Lists(store, (id) => pub(auth.reader(id)));
const withCovers = (l) => ({ ...l, covers: lists.covers(l.id) });
// Wanted books already out of copyright (freebooks.js): once a day, /admin/free, and the owner's list when he has it on.
const freeBooks = new (require("./freebooks").FreeBooks)({ store, lists, who: (id) => pub(auth.reader(id)), ownerId: OWNER_ID, log: console.log });
bg.register("freeBooks", freeBooks, { run: true });
bg.every("free", 24 * 3600 * 1000, () => freeBooks.run(), { db: store.db, first: 10 * 60 * 1000 });
// «Чи варто читати?» on book pages (advice.js): Claude, by the reader's own shelf, on a click.
const bookpage = new BookPage({ apiKey: process.env.ANTHROPIC_API_KEY || "", log: console.log });
const advice = new Advice({ store, social, db: store.db, apiKey: process.env.ANTHROPIC_API_KEY || "", log: console.log });
const genreTrial = new (require("./genretrial").GenreTrial)({ store, social, db: store.db, apiKey: process.env.ANTHROPIC_API_KEY || "", genres: pages.GENRES, log: console.log });
const origTrial = new (require("./origtrial").OrigTrial)({ store, social, db: store.db, apiKey: process.env.ANTHROPIC_API_KEY || "", log: console.log });
const ukTrial = new (require("./uktrial").UkTrial)({ store, social, db: store.db, apiKey: process.env.ANTHROPIC_API_KEY || "", log: console.log });
const aiPasses = new Map(require("./catalogpasses").passes({ store, social, db: store.db, apiKey: process.env.ANTHROPIC_API_KEY || "", log: console.log }).map((p) => [p.key, p]));
const langTrial = new (require("./langtrial").LangTrial)({ store, db: store.db, apiKey: process.env.ANTHROPIC_API_KEY || "", log: console.log });
// A trial (run) changes nothing on the site; a whole-catalog run (runAll) does.
for (const [name, t] of Object.entries({ genreTrial, origTrial, langTrial })) bg.register(name, t, { run: false, runAll: true });
bg.register("ukTrial", ukTrial, { run: false });
for (const p of aiPasses.values()) bg.register(`pass:${p.key}`, p, { run: false, runAll: true });
// Automatic overviews (advice.want/sweep/redo and their queue) are made in the jobs process; a reader's own
// «Чи варто читати?» is answered here.
bg.register("advice", advice, { want: false, sweep: false, redo: false }, ["queued", "capped"], { mirror: false, quiet: ["want"] });
// A whole-catalog run cut by a deploy goes on a minute after the start; once it has finished, books added
// since are asked about every six hours.
if (bg.background) setTimeout(() => {
  const fixed = store.dropPublishedYears();
  if (fixed) console.log(`read years that were publication years: ${fixed.length} dropped`);
  const st = genreTrial.allState();
  if (st && !st.stopped) genreTrial.runAll().catch((e) => console.log(`genreall: ${e.message}`));
  // Originals and languages (Max 2026-10-23 «включаємо і те і те»): the first run starts by itself, a cut one goes on.
  for (const t of [origTrial, langTrial]) if (!t.allState()?.finished) t.runAll().catch((e) => console.log(`${t.constructor.name}: ${e.message}`));
  for (const p of aiPasses.values()) if (p.apply && p.allState() && !p.allState().finished) p.runAll().catch((e) => console.log(`aipass ${p.key} all: ${e.message}`));
}, 60 * 1000).unref();
bg.every("aipasses", 6 * 3600 * 1000, () => {
  const st = genreTrial.allState();
  if (st?.finished) genreTrial.runAll().catch((e) => console.log(`genreall: ${e.message}`));
  for (const t of [origTrial, langTrial]) if (t.allState()?.finished) t.runAll().catch((e) => console.log(`${t.constructor.name}: ${e.message}`));
  for (const p of aiPasses.values()) if (p.apply && p.live()) p.runAll().catch((e) => console.log(`aipass ${p.key} all: ${e.message}`));
}, { db: store.db, first: 5 * 60 * 1000 });
if (!advice.enabled) console.log("ANTHROPIC_API_KEY is not set: «Чи варто читати?» is off");
// «Відгуки в інтернеті» by itself: a minute after start, overviews made with an older prompt are redone,
// and (while advice.js BACKFILL is on) every rated book without one gets queued, again once a day; a
// rating or a note queues its own book (advice.want). Imports wait for the backfill.
if (bg.background) setTimeout(async () => console.log(`overview: ${await advice.redo()} to redo, ${await advice.sweep()} books queued`), 60 * 1000).unref();
// Google Search Console numbers for /admin/traffic, once a day (gsc.js).
const gsc = bg.register("gsc", require("./gsc").create(store.db), { run: false });
bg.every("gsc", 24 * 3600 * 1000, () => gsc.run(), { db: store.db, first: 5 * 60 * 1000 });
bg.every("overviews", 24 * 3600 * 1000, () => advice.sweep(), { db: store.db });
pages.setStats((id) => social.stats(id));
// The weekly letter (digest.js): Friday 9:00 Kyiv, to every reader who has not switched it off (Max,
// 2026-10-20: «Включаємо на всіх»); WEB_DIGEST_TO=owner limits it to the owner again.
const digest = new Digest({ store, auth, social, lists, libraries, site: SITE, ownerId: OWNER_ID, to: process.env.WEB_DIGEST_TO === "owner" ? "owner" : "all" });
if (bg.background) digest.schedule();
// «Книжка з вашого «Хочу прочитати» тепер є» (wantmail.js): once a day, a letter of its own (Max, 2026-10-25).
const wantMail = new (require("./wantmail").WantMail)({ store, auth, digest, site: SITE, ownerId: OWNER_ID, to: process.env.WEB_WANTMAIL_TO === "owner" ? "owner" : "all" });
if (bg.background) wantMail.schedule();
// The welcome letter right after sign-up (welcome-mail.js), while the owner has it switched on.
const welcomeMail = new WelcomeMail({ store, auth, site: SITE, ownerId: OWNER_ID });
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
    .map((r) => ({ reader: pub(r), rows: store.library(r.id).filter((x) => !x.kids) }))
    .filter((c) => c.rows.some((r) => r.rating != null)) // no ratings yet: not listed (Max 2026-10-26)
    .sort((a, b) => b.rows.length - a.rows.length)
    .map(({ reader, rows }) => {
      const last = social.feed({ limit: 1, notes: true, books: new Set(rows.map((r) => r.id)) }).find((x) => x.reader.id === reader.id);
      return { reader, now: nowFor(reader.id), count: rows.length, read: rows.filter((r) => r.status === "read").length, thisYear: rows.filter((r) => r.status === "read" && r.year === year).length, note: last ? pages.inline(last.entry.note) : "", noteBook: last ? { id: store.canonical(last.id), title: last.book.title } : null };
    });
}

app.get("/", (req, res) => {
  // Search results lived at /?q= before they got their own address.
  if (req.query.q) return res.redirect(301, `/search?${new URLSearchParams({ q: String(req.query.q) })}`);
  const seeds = social.seeds(req.user?.id);
  const own = req.user ? new Map(Object.entries(store.entriesOf(req.user.id))) : new Set();
  const recs = seeds.map((seed) => ({ seed, name: store.seriesOf(seed.id)?.name || seed.title, own: own.has(seed.id), books: social.similar([seed.id], { limit: 6, skip: own, own }) })).filter((r) => r.books.length);
  // The two publishers with the most new books, subscriptions first.
  const showcase = shelvesFor(req)
    .map((s) => shelfSummary(req, s, 5))
    .filter((s) => s.items.length)
    .sort((a, b) => b.subscribed - a.subscribed || b.fresh - a.fresh)
    .slice(0, 2);
  res.send(pages.homePage({ user: req.user, starts: social.starts(), picks: social.picks(), feed: feedFor(req, 6), recs, showcase, fetched: day(store.shelvesRefreshedAt), libraries: librariesFor(req) }));
});

// «Зараз читають» on the homepage: the readers one follows first, then everyone else, at most two rows
// a reader, so one person adding a dozen books doesn't fill it and the newest of others still shows
// (Max, 2026-10-20: the homepage showed a run of one reader while the feed had someone newer). Those
// followed take at most half of it.
const followed = (req) => new Set(auth.following(req.user?.id));
function feedFor(req, limit) {
  const mine = followed(req);
  const first = mine.size ? social.feed({ limit: Math.ceil(limit / 2), readers: mine, perReader: 2 }) : [];
  const per = new Map();
  for (const x of first) per.set(x.reader.id, (per.get(x.reader.id) || 0) + 1);
  const seen = new Set(first.map((x) => `${x.reader.id}:${x.id}`));
  const out = [...first];
  for (const x of social.feed({ limit: limit * 4, perReader: 2 })) {
    if (out.length >= limit) break;
    if (seen.has(`${x.reader.id}:${x.id}`) || (per.get(x.reader.id) || 0) >= 2) continue;
    out.push(x);
    per.set(x.reader.id, (per.get(x.reader.id) || 0) + 1);
  }
  return out;
}

app.get("/readers", (req, res) => res.redirect(301, "/community"));
app.get("/community", (req, res) => {
  const readers = readerList();
  const all = social.all();
  res.send(pages.readersPage({ user: req.user, feed: social.feed({ limit: 40 }), readers, followed: followed(req), totals: { readers: readers.length, books: readers.reduce((s, r) => s + r.count, 0), notes: all.filter((x) => x.entry.note).length } }));
});

// «Стежити» / «Стежу» on a reader's page: follow or unfollow them, then back to where it was pressed.
app.post("/api/follow/:username", signed, (req, res) => {
  const target = auth.byUsername(req.params.username);
  const on = target && auth.toggleFollow(req.user.id, target.id);
  if (on === null || !target) return res.status(404).send("Немає такого читача");
  if (on && auth.followMailDue(req.user.id, target.id)) followMail(req.user, target).catch((e) => console.log(`follow mail to @${target.username} failed: ${e.message}`));
  res.redirect(req.get("referer") || `/@${target.username}`);
});

// «X тепер стежить за вашою полицею» (Max, 2026-10-20): a short plain letter the first time someone
// follows a reader, with the follower's page and one click to stop such letters (the digest's signed link).
async function followMail(follower, target) {
  const off = `${SITE}/follow-mail/unsubscribe/${encodeURIComponent(target.id)}/${digest.token(target.id)}`;
  const subject = `${follower.name} тепер стежить за вашою полицею`;
  const text = [
    `${follower.name} (chytai.org.ua/@${follower.username}) тепер стежить за вашою полицею на Chytai: ваші оцінки й нотатки будуть у них першими в стрічці.`,
    ``,
    `Подивитись, що читає ${follower.name}: ${SITE}${follower.href}`,
    ``,
    `Це єдиний лист про цього читача. Не хочете таких листів: ${off}`,
    `Інші налаштування: ${SITE}/settings`,
  ].join("\n");
  await auth.send(target.email, subject, text, { headers: { "List-Unsubscribe": `<${off}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } });
  console.log(`follow mail: @${follower.username} → @${target.username}`);
}
const followMailSwitch = (req, res, on) => {
  const reader = auth.reader(req.params.id);
  if (!reader || !digest.check(reader.id, req.params.token)) return res.status(404).send(pages.messagePage({ title: "Посилання не підходить", text: "Вимкнути листи можна в налаштуваннях.", user: req.user }));
  auth.setFollowMail(reader.id, on);
  if (req.method === "POST" && !req.body.page) return res.type("text").send("OK");
  res.send(pages.followMailPage({ on, action: `/follow-mail/${on ? "unsubscribe" : "resubscribe"}/${encodeURIComponent(reader.id)}/${req.params.token}`, user: req.user }));
};
app.get("/follow-mail/unsubscribe/:id/:token", (req, res) => followMailSwitch(req, res, false));
app.post("/follow-mail/unsubscribe/:id/:token", (req, res) => followMailSwitch(req, res, false));
app.post("/follow-mail/resubscribe/:id/:token", (req, res) => followMailSwitch(req, res, true));
const wantMailSwitch = (req, res, on) => {
  const reader = auth.reader(req.params.id);
  if (!reader || !digest.check(reader.id, req.params.token)) return res.status(404).send(pages.messagePage({ title: "Посилання не підходить", text: "Вимкнути листи можна в налаштуваннях.", user: req.user }));
  wantMail.setEnabled(reader.id, on);
  if (req.method === "POST" && !req.body.page) return res.type("text").send("OK");
  res.send(pages.wantMailPage({ on, action: `/want-mail/${on ? "unsubscribe" : "resubscribe"}/${encodeURIComponent(reader.id)}/${req.params.token}`, user: req.user }));
};
app.get("/want-mail/unsubscribe/:id/:token", (req, res) => wantMailSwitch(req, res, false));
app.post("/want-mail/unsubscribe/:id/:token", (req, res) => wantMailSwitch(req, res, false));
app.post("/want-mail/resubscribe/:id/:token", (req, res) => wantMailSwitch(req, res, true));
// The owner's look at it: what a reader would get now (?reader=<username>), and the last run.
app.get("/want-mail/preview", owner, (req, res) => {
  const reader = req.query.reader ? auth.byUsername(req.query.reader) : auth.reader(req.user.id);
  if (!reader) return res.status(404).type("text").send("Немає такого читача");
  const l = wantMail.preview(reader);
  res.type("text").send(l ? `Тема: ${l.subject}\n\n${l.text}` : `Для @${reader.username} зараз нічого нового (або ще не було першої перевірки).\nОстанній запуск: ${store.db.get("wantmail:last") || "ще не було"}`);
});

function libraryRows(reader) {
  const rows = store.library(reader);
  let prev;
  for (const r of rows) {
    r._prevYear = prev;
    prev = r.year ?? null;
    r.series = store.seriesOf(r.id); // pages.foldSeries folds a series' volumes into one row
  }
  return rows;
}
// /@<username> is a reader's shelf: their own (with «змінити», recommendations, «+ Додати книжку») when
// they open it, the public one for everyone else and with ?public. /me is a shortcut to your own
// (Max, 2026-10-20: one address for a shelf, so the one in the address bar can be shared).
// ?rest: the rest of a long list, which app.js fetches after the page opens (pages.twoParts); not a page for search.
const restPart = (req, res) => ("rest" in req.query ? (res.set("X-Robots-Tag", "noindex"), "rest") : "");
app.get("/me", signed, (req, res) => res.redirect(req.user.href));
app.get("/@:username", (req, res) => {
  const reader = pub(auth.byUsername(req.params.username));
  if (!reader) return res.status(404).send(pages.messagePage({ title: "Немає такого читача", text: "", user: req.user }));
  if (reader.username !== req.params.username) return res.redirect(301, reader.href);
  const own = req.user?.id === reader.id && !("public" in req.query);
  const rows = libraryRows(reader.id);
  const follows = { followers: auth.followers(reader.id).map((id) => pub(auth.reader(id))).filter(Boolean), following: auth.following(reader.id).map((id) => pub(auth.reader(id))).filter(Boolean) };
  // The profile is the reader's own stats and books; recommendations live on other pages (Max, 2026-10-23).
  const theirLists = lists.of(reader.id).filter((l) => own || l.count);
  const part = restPart(req, res);
  if (own) return res.send(pages.libraryPage({ part, lists: theirLists, savedLists: lists.savedBy(reader.id), rows, user: req.user, reader: req.user, own: true, follows, now: nowFor(reader.id, { own: true }) }));
  res.send(pages.libraryPage({ part, lists: theirLists, rows, user: req.user, reader, now: nowFor(reader.id), mineIds: req.user && req.user.id !== reader.id ? store.inLibrary(req.user.id) : null, mineDirect: req.user ? new Set(Object.keys(store.entriesOf(req.user.id))) : null, following: auth.follows(req.user?.id, reader.id), follows }));
});
// ---- «Списки» (lists.js): /@<username>/list/<slug>, /lists, and what the author does with a list ----
app.get("/@:username/list/:slug", (req, res) => {
  const reader = pub(auth.byUsername(req.params.username));
  const list = reader && lists.bySlug(reader.id, req.params.slug);
  if (!list) return res.status(404).send(pages.messagePage({ title: "Немає такого списку", text: "", user: req.user }));
  if (reader.username !== req.params.username) return res.redirect(301, list.href);
  const own = req.user?.id === reader.id;
  const items = lists.items(list.id, { own });
  const q = own ? String(req.query.add || "").trim().slice(0, 100) : "";
  const inList = own && q ? lists.ids(list.id) : null;
  const find = q ? { q, hits: searchHits(req, q).slice(0, 8).map((h) => ({ book: h.book, in: inList.has(store.canonical(h.book.id)) })) } : null;
  const more = lists.of(reader.id).filter((l) => l.id !== list.id && (own || l.count)).slice(0, 5);
  res.send(pages.listPage({ list: { ...list, count: items.length }, items, user: req.user, own, saved: lists.saved(req.user?.id, list.id), more, similar: lists.similar(list), find }));
});
app.get("/lists", (req, res) => {
  const tab = ["new", "saved", "mine"].includes(req.query.tab) && (req.user || req.query.tab === "new") ? req.query.tab : "popular";
  const shown = tab === "saved" ? lists.savedBy(req.user.id) : tab === "mine" ? lists.of(req.user.id) : lists.all({ sort: tab });
  res.send(pages.listsPage({ user: req.user, tab, lists: shown.map(withCovers), savedCount: req.user ? lists.savedBy(req.user.id).length : 0 }));
});
// The author's own list, or 404 for anyone else.
const myList = (req, res, next) => {
  const l = lists.get(req.params.id);
  if (!l || l.reader.id !== req.user.id) return res.status(404).send(pages.messagePage({ title: "Немає такого списку", text: "", user: req.user }));
  req.list = l;
  next();
};
const bookParam = (req) => store.canonical(store.resolve(String(req.body.book || "")) || "");
// A new list; from a book's «Додати до списку…» it starts with that book and the page stays where it was.
app.post("/api/lists", signed, (req, res) => {
  if (auth.tooMany(`lists:${req.user.id}`, 30)) return res.status(429).send(pages.messagePage({ title: "Забагато нових списків за годину", text: "Спробуйте трохи згодом.", user: req.user }));
  const l = lists.create(req.user.id, { title: req.body.title, note: req.body.note });
  if (!l) return res.redirect(req.get("referer") || "/lists");
  const id = bookParam(req);
  if (id && store.book(id)) {
    lists.add(l.id, id);
    return res.redirect(303, store.href(id));
  }
  res.redirect(303, l.href);
});
app.post("/api/lists/:id", signed, myList, (req, res) => res.redirect(303, lists.edit(req.list.id, { title: req.body.title, note: req.body.note }).href));
app.post("/api/lists/:id/delete", signed, myList, (req, res) => (lists.remove(req.list.id), res.redirect(303, req.user.href)));
app.post("/api/lists/:id/add", signed, myList, (req, res) => {
  const id = bookParam(req);
  if (id) lists.add(req.list.id, id);
  res.redirect(303, `${req.list.href}#${encodeURIComponent(id)}`);
});
app.post("/api/lists/:id/remove", signed, myList, (req, res) => (lists.drop(req.list.id, bookParam(req)), res.redirect(303, req.list.href)));
app.post("/api/lists/:id/why", signed, myList, (req, res) => {
  const id = bookParam(req);
  lists.setWhy(req.list.id, id, req.body.why);
  res.redirect(303, `${req.list.href}#${encodeURIComponent(id)}`);
});
app.post("/api/lists/:id/move", signed, myList, (req, res) => {
  const id = bookParam(req);
  lists.move(req.list.id, id, Number(req.body.dir));
  res.redirect(303, `${req.list.href}#${encodeURIComponent(id)}`);
});
app.post("/api/lists/:id/save", signed, (req, res) => {
  const l = lists.get(req.params.id);
  if (!l) return res.status(404).send(pages.messagePage({ title: "Немає такого списку", text: "", user: req.user }));
  lists.toggleSave(req.user.id, l.id);
  res.redirect(303, l.href);
});
// «Додати до списку…» on a book's page: the ticks of the reader's lists shown there (`shown`), as they are now.
app.post("/api/book/:id/lists", signed, (req, res) => {
  const id = store.canonical(store.resolve(req.params.id) || "");
  if (!id || !store.book(id)) return res.status(404).send("Немає такої книжки");
  const on = new Set([].concat(req.body.list || []).map(String));
  for (const lid of new Set([].concat(req.body.shown || []).map(String))) {
    const l = lists.get(lid);
    if (!l || l.reader.id !== req.user.id) continue;
    const has = lists.has(l.id, id);
    if (on.has(l.id) && !has) lists.add(l.id, id);
    if (!on.has(l.id) && has) lists.drop(l.id, id);
  }
  res.redirect(303, store.href(id));
});

// The owner's page before usernames (/reader/max) moved to /@maxua.
app.get(OLD_READER, (req, res) => res.redirect(301, pub(auth.reader(OWNER_ID)).href));
app.get("/me/book/:id", signed, (req, res) => {
  const id = store.resolve(req.params.id);
  if (!id) return res.status(404).send(pages.messagePage({ title: "Немає такої книжки", text: "", user: req.user }));
  const book = store.book(id);
  const entry = store.entry(req.user.id, book.id);
  // «Уся серія» (Max, 2026-10-23): offered on every volume of a series; ticked when they came by «Прочитано ·
  // всю серію» (?series) or their shelf already shows the series as one row (another volume with the same
  // status and year).
  const c = store.cycleOf(book.id);
  const series = c && c.items.length > 1 ? { name: c.name, total: c.items.length, checked: "series" in req.query || (!!entry && c.items.some((v) => v.id && v.id !== book.id && ((e) => e && e.status === entry.status && (e.year ?? null) === (entry.year ?? null))(store.entry(req.user.id, v.id)))) } : null;
  res.send(pages.editPage({ book, entry, user: req.user, series }));
});

// A volume in a book page's series list that no catalog has: a click makes its page (a book of the reader's
// kind, in the series at its place) and opens it, so it is marked like any other book.
app.post("/api/series-volume/:id", signed, (req, res) => {
  const c = store.cycleOf(req.params.id);
  const v = c?.items.find((x) => x.n === Number(req.body.n));
  if (!v) return res.status(404).send("Немає такої книжки");
  let id = v.id;
  if (!id) {
    id = store.addBook({ title: v.title, author: store.book(req.params.id)?.author || "", cover: "", links: [], cycle: { name: c.name, n: v.n } }).id;
    store.linkCycles();
    details({ ids: [id] });
  }
  res.redirect(store.href(id));
});

app.get("/popular", (req, res) => res.send(pages.popularPage({ user: req.user, pop: social.popular() })));
// A genre's books (/genre/biohrafii, the label on a book page): what readers have and rate first, then the
// rest with Ukrainian titles and covers ahead. Kept ten minutes per genre: it looks at every book of it.
const genreCache = new Map();
function genreList(g) {
  const hit = genreCache.get(g);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.out;
  const by = new Map(); // work -> { readers, sum, rated }
  for (const { reader, id, entry: e } of social.all()) {
    const k = store.canonical(id);
    const x = by.get(k) || by.set(k, { readers: new Set(), sum: 0, rated: 0 }).get(k);
    x.readers.add(reader.id);
    if (e.rating != null) (x.sum += e.rating), x.rated++;
  }
  const rows = [];
  for (const id of store.genreBooks(g)) {
    const book = store.book(id);
    if (!book) continue;
    const x = by.get(id);
    rows.push({ book, readers: x?.readers.size || 0, rated: x?.rated || 0, avg: x?.rated ? Math.round((x.sum / x.rated) * 10) / 10 : null, uk: /[а-яіїєґ]/i.test(book.title) });
  }
  rows.sort((a, b) => b.readers - a.readers || (b.avg ?? 0) - (a.avg ?? 0) || b.uk - a.uk || !!b.book.cover - !!a.book.cover || a.book.title.localeCompare(b.book.title, "uk"));
  const top = rows.filter((r) => r.avg >= 4).sort((a, b) => b.avg - a.avg || b.rated - a.rated).slice(0, 6);
  const out = { rows, top, works: new Set(rows.filter((r) => r.readers).map((r) => r.book.id)) };
  genreCache.set(g, { at: Date.now(), out });
  return out;
}
app.get("/genre/:slug", (req, res) => {
  const slug = req.params.slug;
  const g = store.genreBySlug(slug) || store.genreBySlug(slugify(slug));
  if (!g) return res.status(404).send(pages.messagePage({ title: "Немає такого жанру", text: "", user: req.user }));
  if (slugify(g) !== slug) return res.redirect(301, `/genre/${slugify(g)}`);
  const { rows, top, works } = genreList(g);
  const shown = rows.map((r) => ({ ...r, book: bookFor(req, r.book, false) })).filter((r) => r.book);
  const others = pages.GENRES.filter((x) => x !== g).map((x) => [x, store.genreBooks(x).length]).filter(([, n]) => n);
  res.send(pages.genrePage({ part: restPart(req, res), genre: g, rows: shown, top, feed: social.feed({ limit: 6, books: works, notes: true }), others, user: req.user }));
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
  res.send(pages.publisherPage({ part: restPart(req, res), shelf, subscribed: store.subscribed(req.user?.id, shelf.id), user: req.user, fresh, feed: social.feed({ limit: 6, books: works }), others, visible }));
});
// The shelves' address before the 2026-10-20 design.
app.get("/shelf/:id", (req, res) => res.redirect(301, `/publishers/${encodeURIComponent(req.params.id)}`));

const searchHits = (req, q) => store.search(q, { reader: req.user?.id }).map((h) => ({ ...h, book: bookFor(req, h.book, !!h.entry) })).filter((h) => h.book);
const normQ = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
// Everything /search shows: books (a genre's name lists that genre's books by rating), authors, readers,
// and books like the first hit on the side.
// Every word typed starts a word of the name, or sounds like one of its Latin words («міллер», Madeline Miller).
function nameHas(name, nq) {
  const words = normQ(name).normalize("NFKD").replace(/\p{M}/gu, "").split(" ");
  return nq.split(" ").filter(Boolean).every((t) => {
    const alts = store.latinAlts(t);
    return words.some((w) => w.startsWith(t) || alts.includes(w));
  });
}
function searchAll(req, q) {
  if (!q) return {};
  const nq = normQ(q);
  const tag = [...new Set(store.library(OWNER_ID).flatMap((r) => r.book.tags || []))].find((t) => t === nq) || "";
  let hits = searchHits(req, q);
  if (tag) {
    const tagged = [...social.liked().values()].filter((x) => (x.book.tags || []).includes(tag)).sort((a, b) => b.avg - a.avg);
    const seen = new Set(hits.map((h) => h.book.id));
    hits = [...tagged.filter((x) => !seen.has(x.book.id)).map((x) => ({ book: x.book, entry: store.sharedEntry(req.user?.id, x.book.id) })), ...hits].slice(0, 40);
  }
  // A short name («grrm», «гп») finds the authors of what it stands for too.
  const nqs = [nq, normQ(store.aliasQuery(q))].filter(Boolean);
  const has = (name) => nqs.some((n) => nameHas(name, n));
  const authorsFound = (store.authors?.list || [])
    .filter((a) => has(a.name) || (a.other && has(a.other)))
    .slice(0, 6)
    .map((a) => ({ ...a, books: a.ids.length, readers: new Set(a.ids.flatMap((id) => store.readersOf(id).filter((r) => r.entry.status !== "abandoned").map((r) => r.reader))).size }));
  const readersFound = auth
    .readers()
    .filter((r) => has(r.name) || r.username.startsWith(nq))
    .map((r) => ({ reader: pub(r), count: Object.keys(store.entriesOf(r.id)).length }))
    .filter((r) => r.count)
    .slice(0, 6);
  // Publishers (and the other shelves) by name; the one named exactly («Readberry») lists its books first.
  const flat = (s) => normQ(s).replace(/ /g, "");
  const shelvesFound = shelvesFor(req)
    .filter((s) => has(s.name) || flat(s.name) === flat(q))
    .slice(0, 6)
    .map((s) => ({ shelf: s, total: visible(s).length }));
  const named = shelvesFound.find((s) => flat(s.shelf.name) === flat(q));
  if (named) {
    const seen = new Set(hits.map((h) => h.book.id));
    const own = [...new Set(visible(named.shelf).map((it) => store.canonical(it.id)))]
      .filter((id) => !seen.has(id))
      .map((id) => ({ book: bookFor(req, store.book(id), !!store.entry(req.user?.id, id)), entry: store.sharedEntry(req.user?.id, id) }))
      .filter((h) => h.book);
    hits = [...own, ...hits].slice(0, 40);
  }
  foldTwins(hits);
  const similar = hits.length ? social.alsoLiked([hits[0].book.id], { limit: 4, skip: new Set(hits.map((h) => h.book.id)) }) : [];
  return { hits, authors: authorsFound, readers: readersFound, shelves: shelvesFound, similar, tag };
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

// The sitemap: every public page, so search engines need not discover 16 thousand books by links.
// Built at most once an hour and kept in memory (walking the catalog takes a moment; crawlers ask often).
// Left out: books in Russian, draft sources, readers' pages.
let sitemap = { at: 0, xml: "" };
app.get("/sitemap.xml", (req, res) => {
  if (Date.now() - sitemap.at > 3600 * 1000) {
    const t0 = Date.now();
    const origin = `https://${DOMAIN || req.get("host")}`;
    const urls = ["/", "/community", "/popular", "/publishers", "/updates", "/privacy"];
    for (const shelf of store.shelves) if (!shelf.draft) urls.push(`/publishers/${encodeURIComponent(shelf.id)}`);
    const ru = new Set();
    for (const w of authors.allWorks(store)) {
      const b = store.book(w.id);
      if (b && !isRussian(b)) urls.push(b.href);
      else if (b) ru.add(w.id);
    }
    // An author with fewer than two non-Russian books is left out: one book's author page mostly repeats the
    // book page (Max 2026-10-26), and none goes to Russian editions (Max 2026-10-25). The second book adds them.
    for (const a of store.authors?.list || []) if (new Set((a.ids || []).map((id) => store.canonical(id)).filter((id) => !ru.has(id))).size >= 2) urls.push(a.href);
    // Readers' pages are not listed: noindex (Max, 2026-10-21), their notes live on the book pages.
    sitemap = { at: Date.now(), xml: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `<url><loc>${pages.esc(origin + u)}</loc></url>`).join("\n")}\n</urlset>\n` };
    console.log(`sitemap: ${urls.length} addresses in ${Date.now() - t0} ms`);
  }
  res.type("application/xml").set("Cache-Control", "public, max-age=3600").send(sitemap.xml);
});

// The book's overview with the titles it names linked to their pages (advice.linkTitles).
const linkedOverview = (book) => {
  const o = advice.overviewOf(book.id);
  return o && { ...o, text: advice.linkTitles(o.text, book, `${o.book}|${o.created}|${store.canonical(book.id)}`) };
};
// «Читали це, сподобалось і це»; when nothing is like this book yet, four of the publishers' new books instead,
// not tied to it (Max, 2026-10-23: «дефолтний сайдбар для таких книжок», «Новинки видавництв»).
function alsoFor(req, id) {
  const also = social.alsoForBook(id, { limit: 4 });
  if (also.length) return { also };
  const seen = new Set([store.canonical(id)]);
  const fresh = shelvesFor(req).flatMap((sh) => visible(sh).filter((it) => it.isNew && it.cover));
  const out = [];
  for (const it of fresh.sort(() => Math.random() - 0.5)) {
    const b = store.book(it.id);
    if (!b || seen.has(b.id) || isRussian(b)) continue;
    seen.add(b.id);
    out.push(b);
    if (out.length >= 4) break;
  }
  return { also: out, alsoTitle: "Новинки видавництв" };
}
// Discovery blocks under «Читали це, сподобалось і це» (Max, 2026-10-23): the best rated books of the
// book's genre, the new books of its publisher, and one random book a reader rated 4,5+ and wrote about.
function discovery(req, book, also = []) {
  const skip = new Set([book.id, ...store.translationsOf(book.id).map((t) => t.id), ...also.map((b) => b.id)]);
  // By the main genre only, on both sides: «Соляріс» has «психологія» somewhere in its tags too (Max 2026-10-23).
  const genre = mainGenres(book.tags)[0];
  const inGenre = genre
    ? [...social.liked().values()]
        .filter((x) => !skip.has(x.book.id) && mainGenres(x.book.tags)[0] === genre)
        // Four of the well rated ones, different every time (Max 2026-10-23: «ті самі книжки» on every page).
        .map((x) => ({ x, r: Math.random() + (x.book.cover ? 0.5 : 0) }))
        .sort((a, b) => b.r - a.r)
        .map(({ x }) => x)
        .slice(0, 4)
        .map((x) => x.book)
    : [];
  // The publisher: the book's own shelf or an edition's, the first with new books.
  // A shop reselling another publisher's book («Старий Лев» selling Meridian Czernowitz's «Бурчак», its
  // edition names that publisher) is not the book's publisher (Max, 2026-10-25).
  const own = new Set([book.shelf, ...(book.editions || []).filter((e) => !e.edition).map((e) => e.shelf?.id || e.shelf)].filter(Boolean));
  let fresh = null;
  for (const sh of shelvesFor(req).filter((sh) => own.has(sh.id) && sh.kind !== "free")) {
    const items = [];
    for (const it of visible(sh).filter((it) => it.isNew && it.cover)) {
      const b = store.book(it.id);
      if (!b || skip.has(b.id) || isRussian(b) || items.some((x) => x.id === b.id)) continue;
      items.push(b);
      if (items.length >= 4) break;
    }
    if (items.length >= 2) {
      fresh = { shelf: sh, books: items };
      break;
    }
  }
  const pick = social.picks(3).find((p) => !skip.has(p.book.id) && !inGenre.some((b) => b.id === p.book.id)) || null;
  return { inGenre: genre && inGenre.length >= 2 ? { genre, books: inGenre } : null, fresh, pick };
}
// Off for now (Max, 2026-10-23: «Решту поки ні»): authorAbout() asks Wikidata, so it is not even called.
const SHOW_AUTHOR_ABOUT = false;
// «Про автора» and the book's awards (Max, 2026-10-23), from Wikidata through authors.aboutNow(): the
// first of the book's authors Wikidata knows. Nothing yet on the first view of an author's book.
function authorAbout(book) {
  const a = [book.author, book.authorOrig].flatMap((x) => authors.splitAuthors(x)).map((n) => store.authors?.byName(n)).find((x) => x?.qid);
  if (!a) return {};
  const info = authors.aboutNow(store, a.qid, { log: console.log });
  if (!info) return {};
  const ids = new Set([book.id, ...store.translationsOf(book.id).map((t) => t.id)]);
  const awards = authors
    .matchWorks(store, a, info.works || [])
    .filter((w) => w.books.some((b) => ids.has(b.id)))
    .flatMap((w) => w.awards)
    .filter((x, i, all) => all.findIndex((y) => y.name === x.name) === i)
    .sort((x, y) => (x.year || 9999) - (y.year || 9999));
  return { awards, authorInfo: info.person && { ...info.person, name: a.name, href: a.href, books: a.ids.length } };
}
// «Читати безкоштовно» and «Завантажити EPUB» on a free book's page go through here, so /admin/traffic can count
// the guests who used them; then on to the reader, which opens the book without an account.
for (const what of ["read", "epub"]) {
  app.get(`/go/${what}/:id`, (req, res) => {
    const id = store.resolve(req.params.id);
    const free = id && freeFileFor(store.bookPage(id));
    if (!free || (what === "epub" && free.readerOnly)) return res.redirect(id ? store.href(id) : "/");
    admin.guestTap(req, req.user?.id, what, cookies(req));
    res.redirect(`${READER_URL}/${what === "epub" ? "free-file" : "free"}/${encodeURIComponent(free.name)}`);
  });
}
app.get("/book/:id", (req, res) => {
  const id = store.resolve(req.params.id);
  if (!id) return res.status(404).send(pages.messagePage({ title: "Немає такої книжки", text: "", user: req.user }));
  // One address per work: an id, an edition id or an old slug redirects to the canonical one.
  if (store.href(id) !== `/book/${encodeURIComponent(req.params.id)}`) return res.redirect(301, store.href(id));
  const book = bookFor(req, store.bookPage(id), !!store.entry(req.user?.id, id));
  if (!book) return res.status(404).send(pages.messagePage({ title: "Немає такої книжки", text: "", user: req.user }));
  const file = readerFileFor(req.user?.id, book);
  const free = !file && freeFileFor(book);
  const alsoBooks = alsoFor(req, book.id);
  const myLists = req.user ? lists.of(req.user.id).map((l) => ({ id: l.id, title: l.title, count: l.count, has: lists.has(l.id, book.id) })) : null;
  res.send(pages.bookPage({ ...(SHOW_AUTHOR_ABOUT ? authorAbout(book) : {}), ...discovery(req, book, alsoBooks.also), lists: lists.withBook(book.id).map(withCovers), myLists, freeRead: !!free, freeFile: !!free && !free.readerOnly, book, entry: store.sharedEntry(req.user?.id, book.id), now: !!req.user && nowIds(req.user.id).has(store.canonical(book.id)), user: req.user, readUrl: file ? `${READER_URL}/?open=${encodeURIComponent(file.name)}` : free ? `${READER_URL}/free/${encodeURIComponent(free.name)}` : "", shelf: book.shelf && (req.owner || !isDraft(book.shelf)) ? store.shelf(book.shelf) : null, inLibrary: inLibraryMap(req), readers: readersOf(book.id), ...alsoBooks, writings: reviews.of(book.id), reviewError: String(req.query.review_error || "").slice(0, 300), editionError: String(req.query.edition_error || "").slice(0, 300), ukAsk: ukAskFor(req, book) || (req.user && req.query.edition_error ? "ask" : null), advice: advice.state(req.user, book.id), overview: linkedOverview(book), overviewVote: advice.voteOf(book.id, req.user?.id) }));
});

// A translation and its original in one list are one card (Max, 2026-10-25: two rows «трохи плутає»; 2026-10-26: the same
// in search): the Ukrainian edition leads, the other pages are a line under its title. Readers and ratings are shared anyway.
function foldTwins(hits) {
  const seen = new Set();
  for (let i = 0; i < hits.length; i++) {
    if (seen.has(hits[i].book.id)) {
      hits.splice(i--, 1);
      continue;
    }
    const twins = hits[i].twins || store.translationsOf(hits[i].book.id);
    const group = [hits[i], ...twins.map((t) => hits.find((h) => h.book.id === t.id)).filter(Boolean)];
    for (const h of group) seen.add(h.book.id);
    const lead = group.find((h) => CYR_RE.test(h.book.title)) || group[0];
    hits[i] = { ...lead, entry: lead.entry || group.find((h) => h.entry)?.entry, others: group.filter((h) => h !== lead).map((h) => h.book) };
  }
  return hits;
}

// An author: their works from Wikidata (linked to our books of them) and every book of theirs we have.
app.get("/author/:slug", async (req, res) => {
  const author = store.authors.bySlug.get(req.params.slug);
  if (!author) return res.status(404).send(pages.messagePage({ title: "Немає такого автора", text: "", user: req.user }));
  const works = author.qid ? authors.matchWorks(store, author, await authors.wikidataWorks(store, author.qid, { log: console.log })) : [];
  const shown = new Set(works.flatMap((w) => w.books.map((b) => b.id)));
  const hits = author.ids
    .map((id) => ({ book: bookFor(req, store.book(id), !!store.entry(req.user?.id, id)), entry: store.sharedEntry(req.user?.id, id) }))
    // Box sets and workbooks are noise on an author's page (Max 2026-10-25, James Clear: «Комплект»,
    // «Посібник для змін» next to «Атомні звички»); their own pages stay. A reader's own copy still shows.
    .filter((h) => h.book && (h.entry || !(h.book.bundle || /комплект|workbook|робочий зошит/i.test(`${h.book.title} ${h.book.altTitle || ""} ${h.book.origTitle || ""}`))))
    .map((h) => ({ ...h, avg: social.stats(h.book.id).avg }))
    .sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1) || !!b.entry - !!a.entry || shown.has(a.book.id) - shown.has(b.book.id) || a.book.title.localeCompare(b.book.title, "uk"))
    .map((h) => ({ ...h, twins: store.translationsOf(h.book.id) }));
  foldTwins(hits);
  // Who reads this author, and what else those readers rated highest.
  const ids = new Set(hits.map((h) => h.book.id));
  const who = [...new Set(hits.flatMap((h) => store.readersOf(h.book.id).filter((r) => r.entry.status !== "abandoned").map((r) => r.reader)))]
    .map((id) => ({ reader: pub(auth.reader(id)), rows: store.library(id) }))
    .filter((r) => r.reader)
    .map(({ reader, rows }) => ({ reader, count: rows.length, read: rows.filter((r) => r.status === "read").length }));
  const also = social.alsoLiked([...ids], { limit: 4, skip: ids }).filter((b) => !author.ids.includes(b.id));
  const pairing = req.user?.owner ? store.translationPairing(author) : null;
  const joins = req.user?.owner ? authors.ownerJoins(store).map((p, index) => ({ p, index })).filter(({ p }) => p.some((n) => author.names?.includes(n))).map(({ p, index }) => ({ names: p, index })) : null;
  res.send(pages.authorPage({ author, works, hits, user: req.user, readers: who, also, pairing, joins }));
});

// The owner joins two spellings of one person (Max, 2026-10-23: «як нам зєднувати авторів?»): on an author
// page, another author's address or name. Kept in meta `authors:join` as [name, name]; undone by index.
app.post("/admin/authors/join", owner, (req, res) => {
  const a = store.authors.bySlug.get(String(req.body.author || ""));
  const q = String(req.body.other || "").trim();
  const slug = (q.match(/\/author\/([^/?#\s]+)/) || [])[1];
  const b = slug ? store.authors.bySlug.get(decodeURIComponent(slug)) : store.authors.byName(q) || store.authors.bySlug.get(slugify(q));
  if (!a || !b) return res.status(404).send(pages.messagePage({ title: "Немає такого автора", text: q, user: req.user }));
  if (a.key !== b.key) {
    const j = authors.ownerJoins(store);
    j.push([a.names[0], b.names[0]]);
    store.db.set("authors:join", JSON.stringify(j));
    store.linkTranslations(); // rebuilds the author index
  }
  res.redirect(303, store.authors.byName(a.names[0])?.href || "/");
});
app.post("/admin/authors/unjoin", owner, (req, res) => {
  const j = authors.ownerJoins(store);
  const [pair] = j.splice(Number(req.body.index), 1);
  store.db.set("authors:join", JSON.stringify(j));
  store.linkTranslations();
  res.redirect(303, (pair && store.authors.byName(pair[0])?.href) || "/");
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

// ---- «Читаю зараз» (Max, 2026-10-22: a reader's status) ----
// The book the reader has in hand right now (one: Max, 2026-10-22); set by hand only. A book
// leaves it when it is marked read, abandoned or wanted, or taken off the shelf.
function nowFor(readerId, { own = false } = {}) {
  const v = auth.nowOf(readerId);
  const books = v.books
    .map((n) => ({ id: store.canonical(n.id), since: n.since }))
    .map((n) => ({ ...n, book: store.book(n.id), entry: store.entry(readerId, n.id) }))
    .filter((n) => n.book && n.entry && (own || (n.entry.status !== "abandoned" && !isRussian(n.book))));
  return { books };
}
const nowIds = (readerId) => new Set(auth.nowOf(readerId).books.map((n) => store.canonical(n.id)));
function dropNow(readerId, id) {
  const v = auth.nowOf(readerId);
  const c = store.canonical(id);
  if (v.books.some((n) => store.canonical(n.id) === c)) auth.setNow(readerId, { books: v.books.filter((n) => store.canonical(n.id) !== c) });
}
// From a book page: put it first (a book that wasn't «Читаю» becomes it; a read one stays read, it's a
// re-read) or take it off. It takes the place of the book that was there.
app.post("/api/now/:id", signed, (req, res) => {
  const id = store.canonical(store.resolve(req.params.id) || "");
  if (!id || !store.book(id)) return res.status(404).send("Немає такої книжки");
  const v = auth.nowOf(req.user.id);
  if (v.books.some((n) => store.canonical(n.id) === id)) dropNow(req.user.id, id);
  else {
    const e = store.entry(req.user.id, id);
    if (!e || !["reading", "read"].includes(e.status)) store.setEntry(req.user.id, id, { status: "reading" });
    auth.setNow(req.user.id, { books: [{ id, since: new Date().toISOString().slice(0, 10) }, ...v.books] });
  }
  req.body ||= {};
  back(req, res, store.href(id));
});
app.get("/me/now", signed, (req, res) => {
  const now = nowFor(req.user.id, { own: true });
  const ids = new Set(now.books.map((n) => n.id));
  const candidates = store.library(req.user.id).filter((r) => r.status === "reading" && !ids.has(r.id));
  res.send(pages.nowPage({ user: req.user, now, candidates }));
});
app.post("/me/now", signed, (req, res) => {
  const v = auth.nowOf(req.user.id);
  const since = new Map(v.books.map((n) => [store.canonical(n.id), n.since]));
  const today = new Date().toISOString().slice(0, 10);
  req.body ||= {};
  const picked = [...new Set([].concat(req.body.book || []).map((id) => store.canonical(store.resolve(String(id)) || "")))].filter((id) => store.entry(req.user.id, id));
  auth.setNow(req.user.id, { books: picked.map((id) => ({ id, since: since.get(id) || today })) });
  res.redirect(req.user.href);
});

const STATUSES = ["read", "reading", "want", "abandoned"];
app.post("/api/entry/:id", signed, (req, res) => {
  const b = req.body;
  const patch = {};
  if ("status" in b) patch.status = STATUSES.includes(b.status) ? b.status : "";
  // «Дитяча полиця» is one of the statuses in the edit form (Max, 2026-10-23: «в Статус»): any other one takes the book back.
  if ("status" in b) patch.kids = b.status === "kids";
  if ("rating" in b) patch.rating = b.rating === "none" || b.rating === "" ? null : Math.max(0, Math.min(5, Number(b.rating)));
  if ("year" in b) patch.year = b.year ? Number(b.year) : null;
  if ("copy" in b) patch.copy = ["paper", "ebook", "seeking"].includes(b.copy) ? b.copy : "";
  if ("note" in b) patch.note = String(b.note).trim();
  // The «⋯» menu: kids=1 puts the book on «Дитяча полиця» (no other status), kids=0 takes it back.
  if ("kids" in b) {
    patch.kids = b.kids === "1";
    if (patch.kids) patch.status = "";
  }
  const e = store.setEntry(req.user.id, req.params.id, patch);
  if (!e) return res.status(404).send("Немає такої книжки");
  // «Уся серія»: the same on every volume (the note stays here); volumes we only knew of get a book and
  // their details. No overview for each of them: one book's worth of AI, not eight.
  if (b.series === "1") {
    const added = store.markSeries(req.user.id, req.params.id, patch);
    if (added.length) details({ ids: added });
    if (["read", "want", "abandoned"].includes(patch.status)) for (const v of store.cycleOf(req.params.id)?.items || []) if (v.id) dropNow(req.user.id, v.id);
  }
  if (["read", "want", "abandoned"].includes(patch.status)) dropNow(req.user.id, req.params.id);
  // A rating, a note, or «Хочу прочитати» (Max, 2026-10-23) gets the book its overview.
  if (e.status === "want" || (e.status !== "abandoned" && (e.rating != null || e.note))) advice.want(req.params.id);
  back(req, res, store.href(req.params.id));
});

// What a guest tapped before signing in (pages.guestDo): done once they are in, then back to the book. Only a
// book not on the shelf yet is touched, so a link followed by someone else's hand changes nothing they have.
app.get("/do/:what/:id", signed, (req, res) => {
  const id = store.canonical(store.resolve(req.params.id) || "");
  if (!id || !store.book(id)) return res.redirect("/me");
  const what = req.params.what;
  if (!store.entry(req.user.id, id)) {
    if (["want", "read"].includes(what)) store.setEntry(req.user.id, id, { status: what });
    else if (what === "kids") store.setEntry(req.user.id, id, { kids: true, status: "" });
    else if (what === "now") {
      store.setEntry(req.user.id, id, { status: "reading" });
      auth.setNow(req.user.id, { books: [{ id, since: new Date().toISOString().slice(0, 10) }, ...auth.nowOf(req.user.id).books] });
    }
    if (what === "want") advice.want(id);
  }
  res.redirect(store.href(id));
});

app.post("/api/entry/:id/remove", signed, (req, res) => {
  dropNow(req.user.id, req.params.id);
  if (req.body.series === "1") store.removeSeries(req.user.id, req.params.id);
  store.removeEntry(req.user.id, req.params.id);
  res.redirect(303, req.body.back ? req.get("referer") || "/me" : "/me");
});

app.post("/api/book", signed, (req, res) => {
  const { title, author, cover, status, copy } = req.body;
  if (!title || !title.trim()) return res.status(400).send("Потрібна назва");
  const b = store.addBook({ title, author, cover: /^https?:\/\//.test(cover || "") ? cover : "" });
  store.setEntry(req.user.id, b.id, { status: STATUSES.includes(status) ? status : "", copy: ["paper", "ebook", "seeking"].includes(copy) ? copy : "" });
  if (status === "want") advice.want(b.id);
  details({ ids: [b.id] });
  // A book typed in by hand may duplicate a catalog's or be junk: the owner gets a letter and sorts it out
  // (Max, 2026-10-20: «треба … сповіщення мені на імейл. будемо поки вручну розбирати»).
  if (!req.owner) notifyOwner(`Нова книжка: ${b.title}`, [`${req.user.name} (@${req.user.username}) додав(ла) книжку вручну.`, "", `Назва: ${b.title}`, `Автор: ${b.author || "не вказано"}`, b.cover ? `Обкладинка: ${b.cover}` : "", "", `Книжка: ${site(req)}${store.href(b.id)}`, `Полиця читача: ${site(req)}${req.user.href}`].filter((l, i, a) => l || a[i - 1]).join("\n"));
  res.redirect(store.href(b.id));
});

// The same as a link for the owner (Max, 2026-10-24, after the console quest for КСД): starts the refresh,
// or one source with ?only=<id>, and shows its progress instead of waiting for the end.
app.get("/admin/refresh", owner, (req, res) => {
  refreshShelves(true, String(req.query.only || ""));
  res.redirect("/refresh-status");
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
  const ed = digest.editorial();
  const editorial = ed && digest.audience(ed.audience).has(reader.id) ? ed : null;
  if (d.empty && !editorial) return res.type("text").send(`@${reader.username}: за цей період нічого нового, лист не пішов би.\n\n${JSON.stringify(d.state, null, 2)}`);
  const letter = digest.render({ ...reader }, d, editorial);
  if (req.query.text) return res.type("text").send(`Тема: ${letter.subject}\n\n${letter.text}`);
  // On top of the letter, for the owner: the subject and a button that mails it to them.
  const bar = `<div style="background:#1b1a17;color:#ece8df;font:14px -apple-system,sans-serif;padding:10px 20px;display:flex;gap:16px;align-items:center;flex-wrap:wrap"><span>Тема: <b>${pages.esc(letter.subject)}</b></span><span style="flex:1"></span><a href="/admin/digest" style="color:#a29d92">твій текст</a><a href="?text=1${req.query.reader ? `&reader=${encodeURIComponent(req.query.reader)}` : ""}" style="color:#a29d92">текстова версія</a>${reader.id === req.user.id ? `<form method="post" action="/api/digest?test=1" style="margin:0"><button style="border:1px solid #ece8df;background:none;color:#ece8df;border-radius:999px;padding:6px 14px;cursor:pointer">Надіслати собі</button></form>` : ""}</div>`;
  res.send(letter.html.replace("<body", `${bar}<body`));
});
// POST /api/digest?test=1 mails the owner their own letter without recording it; without `test` it is the
// weekly run itself (every recipient, recorded), for when the Friday timer has to be redone by hand.
app.post("/api/digest", owner, async (req, res) => {
  if (req.query.test) {
    const r = await digest.sendTo(auth.reader(req.user.id), { dry: true, force: true, editorial: digest.editorial() });
    return res.send(pages.messagePage({ title: r.sent ? "Лист надіслано" : "Листа не було б", text: r.sent ? `Тема: ${r.subject}` : r.reason, user: req.user }));
  }
  // ?skip=a@x,b@y: the same day once more, to everyone but these addresses.
  const skip = req.query.skip ? new Set(String(req.query.skip).split(",").map((e) => auth.byEmail(e.trim())?.id).filter(Boolean)) : null;
  const r = await digest.run({ skip });
  res.send(pages.messagePage({ title: "Розсилку виконано", text: `надіслано ${r.sent}, пропущено ${r.skipped}${r.errors.length ? `; помилки: ${r.errors.join("; ")}` : ""}`, user: req.user }));
});
// Max's own text on top of the next Friday letter (digest.js): a form, who gets it, what went out before.
// (Max, 2026-10-23: «урл поміняємо на admin/digest»; the old address redirects.) Also the weekend book, one for everyone.
const letterPage = (req, res, error = "", values = null) => {
  const w = digest.weekend();
  const weekend = values || (w ? { id: w.book, book: `${SITE}${store.href(w.book)}`, note: w.note, title: store.book(w.book)?.title } : { book: "", note: "" });
  res.status(error ? 400 : 200).send(pages.letterEditorPage({ user: req.user, editorial: digest.editorial(), weekend, weekends: digest.sentWeekends(), error, sent: digest.sentEditorials(), audiences: AUDIENCES, counts: digest.audienceCounts(), next: nextFriday(), saved: !!req.query.saved }));
};
app.get("/admin/digest", owner, (req, res) => letterPage(req, res));
app.get("/admin/letter", owner, (req, res) => res.redirect(301, "/admin/digest"));
app.post("/admin/digest", owner, (req, res) => {
  digest.setEditorial({ subject: String(req.body.subject || ""), text: String(req.body.text || ""), audience: String(req.body.audience || "all") });
  const error = digest.setWeekend({ book: String(req.body.book || ""), note: String(req.body.book_note || "") });
  if (error) return letterPage(req, res, error, { book: req.body.book, note: req.body.book_note });
  res.redirect(303, req.body.preview ? "/digest/preview" : "/admin/digest?saved=1");
});
// The next Friday 9:00 Kyiv the letter goes out, for the form's «піде …» line (today, until the run has been).
function nextFriday() {
  const t = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
  const today = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  let add = (5 - t.getDay() + 7) % 7;
  if (add === 0 && store.db.get("digest:lastRun") === today) add = 7;
  t.setDate(t.getDate() + add);
  return t;
}
// The owner looks at the welcome letter (as their own, or ?reader=<username>'s), mails it to themselves and
// switches it on or off for new readers.
app.get("/welcome-mail/preview", owner, (req, res) => {
  const reader = req.query.reader ? auth.byUsername(req.query.reader) : auth.reader(req.user.id);
  if (!reader) return res.status(404).send("Немає такого читача");
  const letter = welcomeMail.render(reader);
  if (req.query.text) return res.type("text").send(`Тема: ${letter.subject}\n\n${letter.text}`);
  const btn = (action, label) => `<form method="post" action="${action}" style="margin:0"><button style="border:1px solid #ece8df;background:none;color:#ece8df;border-radius:999px;padding:6px 14px;cursor:pointer">${label}</button></form>`;
  const on = welcomeMail.on;
  const missed = welcomeMail.missed(WEEK);
  const bar = `<div style="background:#1b1a17;color:#ece8df;font:14px -apple-system,sans-serif;padding:10px 20px;display:flex;gap:16px;align-items:center;flex-wrap:wrap"><span>Тема: <b>${pages.esc(letter.subject)}</b></span><span style="flex:1"></span><span style="color:${on ? "#8fd1a6" : "#e0a58f"}">${on ? "Надсилається новим читачам" : "Вимкнено"}</span><a href="?text=1" style="color:#a29d92">текстова версія</a>${btn("/api/welcome-mail?test=1", "Надіслати собі")}${btn(`/api/welcome-mail?on=${on ? 0 : 1}`, on ? "Вимкнути" : "Увімкнути")}${missed.length ? btn(`/api/welcome-mail/catch-up?since=${WEEK}`, `Надіслати ${missed.length} з цього тижня`) : ""}</div>`;
  res.send(letter.html.replace("<body", `${bar}<body`));
});
// Monday 19.10, 00:00 Kyiv: the week Max asked the catch-up for (2026-10-21).
const WEEK = "2026-10-18T21:00:00Z";
// A one-off catch-up for readers who signed up before it was on: GET lists them, POST sends.
app.get("/welcome-mail/catch-up", owner, (req, res) => {
  const since = String(req.query.since || "");
  res.type("text").send(welcomeMail.missed(since).map((r) => `@${r.username}\t${r.created}`).join("\n") || "нікого");
});
app.post("/api/welcome-mail/catch-up", owner, async (req, res) => {
  const r = await welcomeMail.catchUp(String(req.query.since || "9999"));
  if (req.query.json) return res.json(r);
  res.send(pages.messagePage({ title: `Надіслано: ${r.done.length}`, text: [r.done.map((u) => `@${u}`).join(", "), r.errors.join("; ")].filter(Boolean).join(". Помилки: ") || "Нікому не треба було.", user: req.user }));
});
app.post("/api/welcome-mail", owner, async (req, res) => {
  if (req.query.test) {
    const me = auth.reader(req.user.id);
    try {
      const letter = await welcomeMail.sendTo(me);
      return res.send(pages.messagePage({ title: "Лист надіслано", text: `На ${me.email}. Тема: ${letter.subject}`, user: req.user }));
    } catch (e) {
      return res.status(500).send(pages.messagePage({ title: "Не вдалося надіслати", text: e.message, user: req.user }));
    }
  }
  if (req.query.on !== undefined) welcomeMail.setOn(req.query.on === "1");
  res.redirect("/welcome-mail/preview");
});
// The owner's statistics page: readers, retention by sign-up week, what people do on the site (admin.js).
// The genres trial (genretrial.js): Haiku's genres for 200 books on readers' shelves next to ours.
app.get("/admin/genres-trial", owner, (req, res) => res.send(pages.genreTrialPage({ user: req.user, st: genreTrial.state(), running: genreTrial.running, all: { ...genreTrial.allState(), running: genreTrial.allRunning, have: store.aiGenres().size }, href: (id) => store.href(id) })));
// The results as plain text behind an unguessable link the owner can hand to Claude, who reads the site as a
// guest (Max 2026-10-23: «що треба щоб побачив?»). Only titles and genres; the link changes with every run.
app.get("/genres-trial/:key", (req, res) => {
  const st = genreTrial.state();
  if (!st?.key || req.params.key !== st.key) return res.status(404).send("Немає");
  const line = (x) => `${x.after[0] !== x.before[0] ? "*" : " "} ${x.title} — ${x.author} | було: ${x.before.join(", ") || "—"} | стало: ${x.error ? `помилка ${x.error}` : x.after.join(", ") || "—"}`;
  res.type("text/plain").send([`промпт v${st.prompt || 1}, ${st.model || ""}, ${st.at || ""}: ${st.done} з ${st.total}, $${(st.cost || 0).toFixed(3)}${st.finished ? "" : ", ще йде"}`, "* = змінився основний жанр", "", ...st.items.map(line)].join("\n"));
});
// The language trial (langtrial.js): Haiku's language for 200 doubtful Cyrillic editions next to isRussian().
app.get("/admin/lang-trial", owner, (req, res) => res.send(pages.langTrialPage({ user: req.user, st: langTrial.state(), running: langTrial.running, all: { ...langTrial.allState(), running: langTrial.allRunning, have: store.aiLangs().size }, differs: require("./langtrial").differs, href: (id) => store.href(id) })));
app.get("/lang-trial/:key", (req, res) => {
  const st = langTrial.state();
  if (!st?.key || req.params.key !== st.key) return res.status(404).send("Немає");
  const { differs } = require("./langtrial");
  const line = (x) => `${differs(x) ? "*" : " "} ${x.title} — ${x.author} | зараз: ${x.before} | Haiku: ${x.error ? `помилка ${x.error}` : x.after}`;
  res.type("text/plain").send([`промпт v${st.prompt}, ${st.model}, ${st.at}: ${st.done} з ${st.total} (сумнівних у каталозі ${st.pool}), $${(st.cost || 0).toFixed(3)}${st.finished ? "" : ", ще йде"}`, "* = Haiku не згоден з сайтом (рос чи ні)", "", ...st.items.map(line)].join("\n"));
});
app.post("/admin/lang-trial", owner, (req, res) => {
  langTrial.run().catch((e) => console.log(`langtrial: ${e.message}`));
  res.redirect(303, "/admin/lang-trial");
});
// «Якість каталогу» (Max 2026-10-24: «нормальну адмінку для всього цього, а не пачку окремих сторінок»): every
// Claude pass over the catalog on one page, with what it has done and a link to its own page and trial.
app.get("/admin/catalog", owner, (req, res) => {
  const all = (t, have) => ({ ...t.allState(), running: t.allRunning, have });
  const trial = (t) => { const st = t.state(); return st && { done: st.done, total: st.total, cost: st.cost, at: st.at, running: t.running, prompt: st.prompt }; };
  res.send(pages.catalogAdminPage({
    user: req.user,
    claude: `/claude/${claudeKey()}`,
    passes: [
      { key: "genres", name: "Жанри", what: "Один-два жанри для кожної книжки замість жанрів з полиць магазинів. Твій «Основний жанр» важливіший.", href: "/admin/genres-trial", all: all(genreTrial, store.aiGenres().size), trial: trial(genreTrial) },
      { key: "lang", name: "Мова", what: "Мова видань з кириличною назвою, з якої не видно мови. «Рос» ховає книжку, «укр» нічого не змінює.", href: "/admin/lang-trial", all: all(langTrial, store.aiLangs().size), trial: trial(langTrial) },
      { key: "orig", name: "Оригінали", what: "З чого перекладена українська книжка: пара з оригіналом у каталозі або рядок «Оригінал: …».", href: "/admin/orig-trial", all: all(origTrial, store.aiOrigs().size), trial: trial(origTrial) },
      { key: "uk", name: "Переклади", what: "Українське видання іноземної книжки, яке Haiku знає і яке є в каталозі. Поки тільки проба.", href: "/admin/uk-trial", all: null, trial: trial(ukTrial) },
      ...[...aiPasses.values()].map((p) => ({ key: p.key, name: p.name, what: p.apply && p.live() ? p.what : `${p.what} Поки тільки проба.`, href: `/admin/ai/${p.key}`, all: p.apply && p.allState() ? all(p, p.answered().size) : null, trial: trial(p) })),
    ],
  }));
});
app.get("/admin/free", owner, (req, res) => res.send(pages.freeBooksPage({ user: req.user, st: freeBooks.state(), running: freeBooks.running, list: freeBooks.list(), claude: `/claude/${claudeKey()}/free` })));
app.post("/admin/free", owner, (req, res) => {
  if (req.body?.list !== undefined) freeBooks.setList(req.body.list === "1");
  if (req.body?.run) freeBooks.run().catch((e) => console.log(`free: ${e.message}`));
  res.redirect(303, "/admin/free");
});
app.get("/claude/:key/free", (req, res) => {
  if (req.params.key !== store.db.get("claude:key")) return res.status(404).send("Немає");
  res.type("text/plain").send(freeBooks.text());
});
// Claude's own handle on the catalog passes (Max 2026-10-24: «зберігай output десь в базі, щоб ти сам міг
// читати і керувати»): plain text behind one unguessable link shown on /admin/catalog. It reads every pass's
// state and starts a trial or a whole-catalog run; GET only, since that is what Claude can send. At most 30
// starts a day, each a few cents at most.
const claudeKey = () => {
  let k = store.db.get("claude:key");
  if (!k) store.db.set("claude:key", (k = require("crypto").randomBytes(16).toString("hex")));
  return k;
};
const applies = (k, p) => (["genres", "lang", "orig"].includes(k) ? true : !!p.apply);
const passByKey = () => ({ genres: genreTrial, lang: langTrial, orig: origTrial, uk: ukTrial, ...Object.fromEntries(aiPasses) });
app.get(["/claude/:key", "/claude/:key/:action/:pass"], (req, res) => {
  if (req.params.key !== store.db.get("claude:key")) return res.status(404).send("Немає");
  res.type("text/plain");
  const all = passByKey();
  const { action, pass } = req.params;
  if (action) {
    const p = all[pass];
    if (!p) return res.status(404).send(`Немає перевірки ${pass}`);
    const day = new Date().toISOString().slice(0, 10);
    const used = JSON.parse(store.db.get("claude:starts") || "{}");
    if ((used[day] || 0) >= 30) return res.send("На сьогодні вже 30 запусків, більше не можна.");
    const run = action === "run" ? p.run : action === "apply" && applies(pass, p) ? p.runAll : null;
    if (!run) return res.status(404).send("Дії: run (проба), apply (весь каталог і на сайт, де вміє)");
    if (p.running || p.allRunning) return res.send(`${pass}: уже йде`);
    store.db.set("claude:starts", JSON.stringify({ [day]: (used[day] || 0) + 1 }));
    run.call(p).catch((e) => console.log(`claude ${action} ${pass}: ${e.message}`));
    return res.send(`${pass}: ${action === "run" ? "проба" : "прогін по каталогу"} запущено`);
  }
  const fmt = (o) => (o ? Object.entries(o).filter(([k]) => !["items", "key"].includes(k)).map(([k, v]) => `${k}=${typeof v === "number" ? Math.round(v * 1000) / 1000 : v}`).join(" ") : "—");
  const share = { genres: "genres-trial", lang: "lang-trial", orig: "orig-trial", uk: "uk-trial" };
  const lines = [];
  for (const [k, p] of Object.entries(all)) {
    const st = p.state();
    const link = st?.key ? (share[k] ? `/${share[k]}/${st.key}` : `/ai-trial/${k}/${st.key}`) : "";
    lines.push(`## ${k}${p.name ? ` (${p.name})` : ""}${p.running ? " · проба йде" : ""}${p.allRunning ? " · прогін йде" : ""}`, `проба: ${fmt(st)}${link ? `\nрезультати: https://chytai.org.ua${link}` : ""}`, applies(k, p) ? `весь каталог: ${fmt(p.allState())}` : "весь каталог: ще не вміє застосовувати, тільки проба", "");
  }
  lines.push("Вільні книжки з «Хочу прочитати»: https://chytai.org.ua/claude/<ключ>/free", "");
  const ry = JSON.parse(store.db.get("fix:readyear") || "null");
  if (ry) lines.push(`## Роки прочитання = роки видання (прибрано ${ry.at}): ${ry.fixed.length} записів у ${ry.readers} читачів`, ...ry.fixed.map((f) => `${f.reader} ${f.id} ${f.year}`), "");
  lines.push(`Дії: https://chytai.org.ua/claude/<ключ>/run/<перевірка> — проба; /apply/<перевірка> — весь каталог і на сайт. Запусків сьогодні: ${JSON.parse(store.db.get("claude:starts") || "{}")[new Date().toISOString().slice(0, 10)] || 0} з 30.`);
  res.send(lines.join("\n"));
});

// The other catalog passes (catalogpasses.js on aipass.js): a trial page each, a plain-text link for Claude.
app.get("/admin/ai/:key", owner, (req, res) => {
  const p = aiPasses.get(req.params.key);
  if (!p) return res.status(404).send(pages.messagePage({ title: "Немає такої перевірки", text: req.params.key, user: req.user }));
  res.send(pages.aiPassPage({ user: req.user, pass: p, st: p.state(), running: p.running, href: (id) => store.href(id) }));
});
app.post("/admin/ai/:key", owner, (req, res) => {
  const p = aiPasses.get(req.params.key);
  // «На весь каталог» (Max 2026-10-25, «Описи»): the owner starts the whole-catalog run himself after a trial.
  if (p && req.body?.all && p.apply) p.runAll().catch((e) => console.log(`aipass ${p.key} all: ${e.message}`));
  else if (p) p.run().catch((e) => console.log(`aipass ${p.key}: ${e.message}`));
  res.redirect(303, `/admin/ai/${encodeURIComponent(req.params.key)}`);
});
app.get("/ai-trial/:key/:token", (req, res) => {
  const p = aiPasses.get(req.params.key);
  const st = p?.state();
  if (!st?.key || req.params.token !== st.key) return res.status(404).send("Немає");
  res.type("text/plain").send(p.text());
});
// The translations trial (uktrial.js): the Ukrainian edition Haiku names for a foreign book, checked against the catalogs.
app.get("/admin/uk-trial", owner, (req, res) => res.send(pages.ukTrialPage({ user: req.user, st: ukTrial.state(), running: ukTrial.running, href: (id) => store.href(id), title: (id) => store.book(id)?.title || id })));
app.get("/uk-trial/:key", (req, res) => {
  const st = ukTrial.state();
  if (!st?.key || req.params.key !== st.key) return res.status(404).send("Немає");
  const line = (x) => `${x.found ? "*" : " "} ${x.title} — ${x.author} | ${x.error ? `помилка ${x.error}` : x.answer === "yes" ? `українською: ${x.uk} — ${x.ukAuthor} (${x.publisher})${x.found ? ` [у каталозі: ${store.book(x.found)?.title || x.found}]` : ""}` : x.answer === "no" ? "перекладу немає" : "не знає"}`;
  res.type("text/plain").send([`промпт v${st.prompt}, ${st.model}, ${st.at}: ${st.done} з ${st.total} (без перекладу на полицях ${st.pool}), $${(st.cost || 0).toFixed(3)}${st.finished ? "" : ", ще йде"}`, "* = знайшли це видання в каталозі", "", ...st.items.map(line)].join("\n"));
});
app.post("/admin/uk-trial", owner, (req, res) => {
  ukTrial.run().catch((e) => console.log(`uktrial: ${e.message}`));
  res.redirect(303, "/admin/uk-trial");
});
// The originals trial (origtrial.js): what Haiku says a reader's Ukrainian book was translated from.
app.get("/admin/orig-trial", owner, (req, res) => res.send(pages.origTrialPage({ user: req.user, st: origTrial.state(), running: origTrial.running, all: { ...origTrial.allState(), running: origTrial.allRunning, have: store.aiOrigs().size }, href: (id) => store.href(id) })));
app.get("/orig-trial/:key", (req, res) => {
  const st = origTrial.state();
  if (!st?.key || req.params.key !== st.key) return res.status(404).send("Немає");
  const line = (x) => `${x.title} — ${x.author} | ${x.error ? `помилка ${x.error}` : x.kind === "translation" ? `оригінал: ${x.orig} — ${x.origAuthor} (${x.lang})${x.inCatalog ? " [є в каталозі]" : ""}` : x.kind === "ukrainian" ? "українська книжка" : "не знає"}`;
  res.type("text/plain").send([`промпт v${st.prompt}, ${st.model}, ${st.at}: ${st.done} з ${st.total} (без оригіналу на полицях ${st.pool}), $${(st.cost || 0).toFixed(3)}${st.finished ? "" : ", ще йде"}`, "", ...st.items.map(line)].join("\n"));
});
app.post("/admin/orig-trial", owner, (req, res) => {
  if (req.body?.all) origTrial.runAll().catch((e) => console.log(`origall: ${e.message}`));
  else origTrial.run().catch((e) => console.log(`origtrial: ${e.message}`));
  res.redirect(303, "/admin/orig-trial");
});
// The whole catalog: start, or stop (the books asked so far keep their genres).
app.post("/admin/genres-all", owner, (req, res) => {
  if (req.body?.stop) genreTrial.stopAll = true;
  else genreTrial.runAll().catch((e) => console.log(`genreall: ${e.message}`));
  res.redirect(303, "/admin/genres-trial");
});
app.post("/admin/genres-trial", owner, (req, res) => {
  genreTrial.run().catch((e) => console.log(`genretrial: ${e.message}`));
  res.redirect(303, "/admin/genres-trial");
});
app.get("/admin", owner, (req, res) => res.send(adminPage({ user: req.user, stats: admin.stats(), overviews: advice.overviewStats(), catalog: store.catalogStats(), layout: pages.layout })));
app.get("/admin/shelves", owner, (req, res) => res.send(shelvesPage({ user: req.user, catalog: store.catalogStats(), layout: pages.layout })));
// How long pages take (speed.js): the server's time for every page, and the reader's browser's own, which app.js
// sends once a page has loaded (two numbers and whether it is a phone).
app.post("/api/speed", (req, res) => {
  const { load, first, phone } = req.body || {};
  if (!BOT.test(req.headers["user-agent"] || "")) {
    const kind = phone ? "phone" : "computer";
    if (Number.isFinite(load) && load > 0 && load < 120000) speed.add(kind, Math.round(load));
    if (Number.isFinite(first) && first > 0 && first < 120000) speed.add(`${kind}-first`, Math.round(first));
  }
  res.status(204).end();
});
app.get("/admin/jobs", owner, (req, res) => res.send(jobsPage({ user: req.user, layout: pages.layout, o: bg.overview(store.db), digest: JSON.parse(store.db.get("digest:last") || "null"), wantMail: JSON.parse(store.db.get("wantmail:last") || "null") })));
app.get("/admin/speed", owner, (req, res) => res.send(speedPage({ user: req.user, days: speed.days(), layout: pages.layout })));
app.get("/admin/traffic", owner, (req, res) => res.send(adminPage({ user: req.user, stats: admin.stats(), gsc: gsc.data(), gscOn: gsc.configured(), layout: pages.layout, page: "traffic" })));
app.get("/admin/stats", owner, (req, res) => res.redirect(301, "/admin/traffic"));
app.get("/admin/overviews", owner, (req, res) => res.send(overviewsPage({ user: req.user, list: advice.overviewList().map((r) => ({ ...r, complaints: r.down ? advice.complaintsOf(r.book.id) : [] })), stats: advice.overviewStats(), who: (id) => (id && id !== "auto" ? pub(auth.reader(id)) : null), layout: pages.layout })));
app.get("/admin/readers", owner, (req, res) => res.send(readersPage({ user: req.user, stats: admin.stats(), layout: pages.layout, q: req.query.q, min: Number(req.query.books) || 0, sort: String(req.query.sort || "created"), page: req.query.page })));
app.get("/admin.json", owner, (req, res) => res.json(admin.stats()));
// One Google Books request with the server's key, for the owner to see what Google answers from here.
app.get("/admin/google", owner, async (req, res) => {
  const params = new URLSearchParams({ q: String(req.query.q || "Солярис Лем"), maxResults: "3", printType: "books", key: process.env.GOOGLE_BOOKS_KEY || "" });
  for (const [k, v] of Object.entries(req.query)) if (!["q", "key", "nokey", "ua", "host", "ref"].includes(k)) params.set(k, String(v));
  if (req.query.nokey) params.delete("key"); // does Google answer this server at all, key aside?
  const headers = { "User-Agent": req.query.ua === "browser" ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36" : req.query.ua === "none" ? "" : "Chytai/1.0 (https://chytai.org.ua)", Accept: "application/json" };
  if (req.query.ref) headers.Referer = "https://chytai.org.ua/";
  const host = req.query.host === "books" ? "books.googleapis.com" : "www.googleapis.com";
  try {
    if (req.query.v6) {
      // Over IPv6 (Fly machines have their own), in case Google refuses only Fly's shared IPv4 addresses.
      const https = require("https");
      const out = await new Promise((resolve, reject) => {
        const rq = https.request({ host, family: 6, path: `/books/v1/volumes?${params}`, headers, timeout: 15000 }, (r) => {
          let body = "";
          r.on("data", (c) => (body += c));
          r.on("end", () => resolve(`${r.statusCode} via ${rq.socket?.remoteAddress}\n${body.slice(0, 1500)}`));
        });
        rq.on("error", reject);
        rq.end();
      });
      return res.type("text").send(out);
    }
    const r = await fetch(`https://${host}/books/v1/volumes?${params}`, { headers, signal: AbortSignal.timeout(15000) });
    res.type("text").send(`${r.status}\n${(await r.text()).slice(0, 1500)}`);
  } catch (e) {
    res.type("text").send(`error ${e.message}`);
  }
});
// The address Google and others see this server from (Fly's shared egress), for the owner.
app.get("/admin/ip", owner, async (req, res) => {
  try {
    const r = await fetch("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(10000) });
    res.type("text").send(`ipv4 ${(await r.json()).ip}\n`);
  } catch (e) {
    res.type("text").send(`error ${e.message}`);
  }
});
app.get("/admin/reviews", owner, (req, res) => {
  const done = req.query.added ? store.book(store.resolve(String(req.query.added))) : null;
  const list = reviews.all().map((w) => ({ ...w, adder: w.by ? pub(auth.reader(w.by)) : null }));
  res.send(pages.reviewsAdminPage({ user: req.user, list, error: String(req.query.error || ""), done: done && { title: done.title, href: store.href(done.id) } }));
});
// A link added by hand: any reader from a book's page (book=<id>, back=book), the owner also on
// /admin/reviews, where the book is a link to its page, an address or a title (the first search hit).
// «Чи варто мені читати?»: JSON with the answer as HTML; `fresh` asks Claude again instead of the kept one.
app.post("/api/advice/:id", signed, async (req, res) => {
  const book = bookFor(req, store.bookPage(store.resolve(req.params.id)), !!store.entry(req.user.id, req.params.id));
  if (!book) return res.status(404).json({ error: "Книжку не знайдено." });
  try {
    const a = await advice.ask(req.user.id, book, { fresh: req.body?.fresh === "1" });
    res.json({ html: pages.adviceHtml(a), cached: a.cached });
  } catch (e) {
    console.error("advice failed:", e);
    res.status(e.status >= 400 && e.status < 600 ? 502 : 400).json({ error: e.status ? "Claude зараз не відповідає, спробуйте трохи згодом." : e.message });
  }
});
// «Що кажуть про книжку»: one overview per book from the web; any signed-in reader makes it, only the owner redoes one.
app.post("/api/overview/:id", signed, async (req, res) => {
  const book = bookFor(req, store.bookPage(store.resolve(req.params.id)), !!store.entry(req.user.id, req.params.id));
  if (!book) return res.status(404).json({ error: "Книжку не знайдено." });
  // No overview for a book in Russian (Max 2026-10-23): its page has no «Про книжку» at all.
  if (isRussian(book)) return res.status(404).json({ error: "Книжку не знайдено." });
  try {
    const o = await advice.overview(book, { fresh: req.body?.fresh === "1" && req.owner, by: req.user.id });
    res.json({ html: pages.overviewHtml({ ...o, text: advice.linkTitles(o.text, book) }, req.user), cached: o.cached });
  } catch (e) {
    console.error("overview failed:", e);
    res.status(e.status >= 400 && e.status < 600 ? 502 : 400).json({ error: e.status ? "Claude зараз не відповідає, спробуйте трохи згодом." : e.message });
  }
});
// 🤩 / 🙂 / 🙁 under an overview: vote=1, 2, -1, or 0 to take it back.
app.post("/api/overview/:id/vote", signed, (req, res) => {
  const book = store.book(store.resolve(req.params.id));
  if (!book) return res.status(404).json({ error: "Немає такої книжки" });
  const v = Number(req.body?.vote);
  if (![1, 2, -1, 0].includes(v)) return res.status(400).json({ error: "Не той голос" });
  const note = String(req.body?.note || "").trim().slice(0, 1000);
  try {
    const r = advice.vote(book.id, req.user.id, v, note);
    // A complaint goes to the owner at once, like a new review.
    if (v === -1 && note && !req.owner) notifyOwner(`Скарга на огляд: ${book.title}`, [`${req.user.name} (@${req.user.username}) про «Що пишуть в інтернеті»:`, "", note || "(без слів)", "", `Книжка: ${site(req)}${store.href(book.id)}#reviews`, `Усі огляди: ${site(req)}/admin/overviews`].join("\n"));
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
// The Ukrainian edition of `orig` from its page (bookpage.js): the catalog's book when it has one, else a new
// book with the store as «Де взяти»; paired with the original as its translation. Null if it is the original.
function addEdition(orig, p, by) {
  const row = fromPage(p);
  // The catalog knows the Ukrainian title as the original's other name (store.workIndex): that is no edition yet.
  const found = store.findWork(p);
  const known = found && store.canonical(found) !== store.canonical(orig.id) ? found : null;
  let book = known && store.book(known);
  if (!book) book = store.addBook({ title: row.title, author: row.author, cover: row.cover, links: row.link ? [row.link] : [], source: "tip", ...(by ? { by } : {}), ...(row.isbns.length ? { isbns: row.isbns } : {}), ...(row.blurb ? { blurb: row.blurb, blurbSource: row.blurbSource } : {}), ...(row.pages ? { pages: row.pages } : {}), ...(row.published ? { published: row.published } : {}) });
  if (store.canonical(book.id) === store.canonical(orig.id)) return null;
  store.decideTranslation(orig.id, book.id);
  return book;
}
// Our own search for those editions (ukfind.js); the owner runs it on /admin/ukfind for now.
// A reader's hint that found the edition is news for the owner, to check the pair.
// Who asked (Max, 2026-10-24: «додай в цей імейл хто»): the readers who pressed «Є український переклад».
const hintedBy = (id) => store.db.prepare("SELECT DISTINCT reader FROM uk_hint WHERE book = ? ORDER BY created").all(id).map((h) => pub(auth.reader(h.reader))).filter(Boolean).map((u) => `${u.name} (${SITE}${u.href})`).join(", ");
const onUkHint = (b, r) => r.status === "found" && r.edition && notifyOwner(`Знайшли українське видання: ${r.edition.title}`, [`${hintedBy(b.id) || "Читач"} підказав(ла), що є переклад «${b.title}», і пошук знайшов:`, "", `Переклад: ${r.edition.title}${r.edition.author ? ` — ${r.edition.author}` : ""}  ${SITE}${store.href(r.edition.id)}`, `Сторінка: ${r.url}`, "", `Прибрати пару: ${SITE}/admin/dupes#decided`, `Усі пошуки: ${SITE}/admin/ukfind`].join("\n"));
const ukfind = new UkFinder({ store, db: store.db, apiKey: process.env.ANTHROPIC_API_KEY || "", bookpage, addEdition, onHint: onUkHint, log: console.log });
// «Додати» after «Українською: …, у каталогах поки немає» for a signed-in reader (pages.ukLine).
// Also a foreign book Wikidata knows no translation of (Max, 2026-10-23: «тут немає перекладу але він є», Feynman):
// a Latin title, no Ukrainian edition or translation linked.
const CYR_RE = /[а-яіїєґ]/i;
function ukAskFor(req, book) {
  if (!req.user) return null;
  if (!book.ukTitle && (!/[a-z]/i.test(book.title) || CYR_RE.test(book.title) || (book.translations || []).some((t) => CYR_RE.test(t.title)) || (book.editions || []).some((e) => CYR_RE.test(e.title)))) return null;
  const st = ukfind.state(book.id);
  return st === "found" ? null : !ukfind.client && st !== "none" ? "ask" : st;
}
// /admin/readeat: what Readeat would fill for the readers' own books (a trial writes nothing), and the switch.
let readeatTrial = null;
app.get("/admin/readeat", owner, (req, res) => res.send(pages.readeatPage({ user: req.user, on: readeat.on(store), waiting: readeat.wanting(store).length, trial: readeatTrial, log: store.db.get("readeat:log") || "" })));
app.post("/admin/readeat", owner, (req, res) => {
  if (req.body.on != null) store.db.set("readeat:on", req.body.on === "1" ? "1" : "0");
  else if (!readeatTrial?.running) {
    const ids = String(req.body.ids || "").split(/[\s,]+/).map((x) => store.resolve(x.replace(/^.*\/book\//, "")) || "").filter(Boolean);
    readeatTrial = { running: true, at: new Date().toISOString() };
    readeat.enrich(store, { dry: true, ids: ids.length ? ids : undefined, max: Math.min(Number(req.body.n) || 10, 30), log: console.log })
      .then((r) => (readeatTrial = { ...r, at: readeatTrial.at }))
      .catch((e) => (readeatTrial = { error: e.message, at: readeatTrial.at, rows: [] }));
  }
  if (req.body.on === "1") readeatAll();
  res.redirect(303, "/admin/readeat");
});
app.get("/admin/ukfind", owner, (req, res) => res.send(pages.ukFindPage({ user: req.user, candidates: ukfind.candidates().length, list: ukfind.list(), running: ukfind.running, enabled: !!ukfind.client })));
app.post("/admin/ukfind", owner, async (req, res) => {
  const ids = String(req.body.ids || "").split(/[\s,]+/).map((x) => store.resolve(x.replace(/^.*\/book\//, "")) || "").filter(Boolean);
  ukfind.run(Math.min(Number(req.body.n) || 5, 20), ids.length ? { ids } : {}).catch((e) => console.error("ukfind failed:", e)); // a few minutes; the page shows it running
  res.redirect(303, "/admin/ukfind");
});

// «Знаєте, де знайти?» on a foreign book whose Ukrainian translation Wikidata knows and no catalog has
// (Max, 2026-10-23: «вона насправді є, це у нас в базі її немає … щоб читачі могли нам підказати де її
// знайти»): a reader pastes the address of the Ukrainian edition's page; it is read like a link on /add
// (bookpage.js), becomes a book of its own with that store as «Де взяти», paired with the original as its
// translation. Published at once, like «Огляди»; Max gets a letter and can undo the pair on /admin/dupes.
// «Є український переклад» on a foreign book's page: with an address, that page is the edition (below);
// without one, we look for it ourselves (ukfind.js) and the page says so meanwhile.
// The field takes «Назва або посилання» (Max, 2026-10-23): an address is read as the edition's page; a
// title is looked for in our catalogs first, then searched for under that title; empty, under Wikidata's.
app.post("/api/book/:id/uk-hint", signed, async (req, res, next) => {
  const q = String(req.body.q ?? req.body.url ?? "").trim().slice(0, 500);
  if (isUrl(q)) return (req.body.url = q), next();
  const orig = store.book(store.resolve(req.params.id) || req.params.id);
  if (!orig) return res.status(404).send(pages.messagePage({ title: "Немає такої книжки", text: "", user: req.user }));
  const title = q.slice(0, 200);
  if (title && /[а-яіїєґ]/i.test(title)) {
    const id = store.findWork({ title, author: orig.author }) || store.findWork({ title, author: store.ukTitles?.[orig.id]?.ukAuthor || "" });
    if (id && store.canonical(id) !== store.canonical(orig.id) && /[а-яіїєґ]/i.test(store.book(id)?.title || "")) {
      store.decideTranslation(orig.id, id);
      console.log(`uk hint @${req.user.username}: ${orig.id} -> ${id} (catalog, «${title}»)`);
      if (!req.owner) notifyOwner(`Українське видання: ${store.book(id).title}`, [`${req.user.name} (@${req.user.username}) підказав(ла) українську назву «${title}», і вона знайшлася в каталозі.`, "", `Оригінал: ${orig.title}  ${site(req)}${store.href(orig.id)}`, `Переклад: ${store.book(id).title}  ${site(req)}${store.href(id)}`, "", `Прибрати пару: ${site(req)}/admin/dupes#decided`].join("\n"));
      return res.redirect(303, store.href(id));
    }
  }
  const ok = ukfind.hint(orig, req.user.id, title);
  console.log(`uk hint @${req.user.username}: ${orig.id}${title ? ` «${title}»` : ""}${ok ? "" : " (not queued)"}`);
  res.redirect(303, `${store.href(orig.id)}#about`);
});
app.post(["/api/book/:id/edition", "/api/book/:id/uk-hint"], signed, async (req, res) => {
  const orig = store.book(store.resolve(req.params.id) || req.params.id);
  if (!orig) return res.status(404).send(pages.messagePage({ title: "Немає такої книжки", text: "", user: req.user }));
  const back = (error) => res.redirect(303, `${store.href(orig.id)}${error ? `?edition_error=${encodeURIComponent(error)}` : ""}#about`);
  const url = String(req.body.url || "").trim().slice(0, 500);
  if (!isUrl(url)) return back("Вставте посилання на сторінку книжки в магазині чи у видавництва.");
  // A link to one of our own books (Max, 2026-10-23: «що буде якщо вказати урл з Chytai?»): no page to
  // read, the two works are paired as original and translation.
  const own = url.match(/^https?:\/\/(?:www\.)?(?:chytai\.org\.ua|chytai-web\.fly\.dev|localhost(?::\d+)?)\/book\/([^/?#\s]+)/i);
  if (own) {
    const id = store.resolve(decodeURIComponent(own[1]));
    if (!id) return back("Такої книжки в нас немає.");
    if (store.canonical(id) === store.canonical(orig.id)) return back("Це та сама книжка, а не її український переклад.");
    const uk = store.book(id);
    if (!/[а-яіїєґ]/i.test(uk.title)) return back(`На сторінці книжка «${uk.title}», а не українське видання.`);
    store.decideTranslation(orig.id, id);
    console.log(`edition tip @${req.user.username}: ${orig.id} -> ${id} (our page)`);
    if (!req.owner) notifyOwner(`Українське видання: ${uk.title}`, [`${req.user.name} (@${req.user.username}) з’єднав(ла) переклад із оригіналом.`, "", `Оригінал: ${orig.title}  ${site(req)}${store.href(orig.id)}`, `Переклад: ${uk.title}  ${site(req)}${store.href(id)}`, "", `Прибрати пару: ${site(req)}/admin/dupes#decided`].join("\n"));
    return res.redirect(303, store.href(id));
  }
  if (!req.owner && auth.tooMany(`edition:${req.user.id}`, 20)) return back("Забагато посилань за годину. Спробуйте трохи згодом.");
  const p = await bookpage.fromUrl(url, req.user.id);
  if (p.error) return back(p.error);
  if (!/[а-яіїєґ]/i.test(p.title)) return back(`На сторінці книжка «${p.title}», а не українське видання.`);
  const known = store.findWork(p) && store.canonical(store.findWork(p)) !== store.canonical(orig.id);
  const book = addEdition(orig, p, req.user.id);
  if (!book) return back("Це та сама книжка, а не її український переклад.");
  console.log(`edition tip @${req.user.username}: ${orig.id} -> ${book.id}${known ? " (known)" : ""} ${url}`);
  if (!req.owner) notifyOwner(`Українське видання: ${book.title}`, [`${req.user.name} (@${req.user.username}) підказав(ла), де знайти українське видання.`, "", `Оригінал: ${orig.title}${orig.author ? ` — ${orig.author}` : ""}  ${site(req)}${store.href(orig.id)}`, `Переклад: ${book.title}${book.author ? ` — ${book.author}` : ""}  ${site(req)}${store.href(book.id)}${known ? " (вже була в каталозі)" : ""}`, `Посилання: ${url}`, "", `Прибрати пару: ${site(req)}/admin/dupes#decided`, `Полиця читача: ${site(req)}${req.user.href}`].join("\n"));
  res.redirect(303, store.href(book.id));
});
app.post("/api/reviews/add", signed, async (req, res) => {
  const q = String(req.body.book || "").trim();
  const slug = (q.match(/\/book\/([^/?#\s]+)/) || [])[1];
  const id = (slug && store.resolve(decodeURIComponent(slug))) || store.resolve(q) || (req.owner ? store.search(q, { limit: 1 })[0]?.book.id : null);
  const fromBook = req.body.back === "book" || !req.owner;
  const back = (error) => res.redirect(303, fromBook && id ? `${store.href(id)}?review_error=${encodeURIComponent(error)}#writings` : `/admin/reviews?error=${encodeURIComponent(error)}`);
  if (!id) return back(`Не знайшов книжку «${q}». Встав посилання на її сторінку.`);
  if (!req.owner && auth.tooMany(`review:${req.user.id}`, 20)) return back("Забагато оглядів за годину. Спробуйте трохи згодом.");
  try {
    await reviews.add(String(req.body.url || ""), id, { date: String(req.body.date || ""), by: req.user.id, owner: req.owner });
  } catch (e) {
    return back(e.message);
  }
  // Max, 2026-10-22: a letter to him for every review a reader adds, to check it.
  const r = !req.owner && reviews.row(String(req.body.url || "").trim());
  if (r) notifyOwner(`Новий огляд: ${store.book(id)?.title || id}`, [`${req.user.name} (@${req.user.username}) додав(ла) огляд до книжки.`, "", `Огляд: ${r.title}`, `Де: ${r.name}${r.date ? `, ${r.date}` : ""}`, `Посилання: ${r.url}`, "", `Книжка: ${site(req)}${store.href(id)}#writings`, `Усі огляди і «Прибрати»: ${site(req)}/admin/reviews`, `Полиця читача: ${site(req)}${req.user.href}`].join("\n"));
  res.redirect(303, fromBook ? `${store.href(id)}#writings` : `/admin/reviews?added=${encodeURIComponent(id)}`);
});
app.post("/api/reviews/date", owner, (req, res) => {
  reviews.setDate(String(req.body.url || ""), String(req.body.date || ""));
  res.redirect(303, "/admin/reviews");
});
// The owner takes any link off; a reader, the ones they added.
app.post("/api/reviews/remove", signed, (req, res) => {
  const id = store.resolve(String(req.body.work || ""));
  if (!id || !req.body.url) return res.status(400).send("Немає такої книжки чи посилання.");
  if (!req.owner && reviews.row(String(req.body.url))?.by !== req.user.id) return res.status(403).send("Прибрати можна лише свій огляд.");
  reviews.remove(id, String(req.body.url));
  res.redirect(303, req.body.back === "admin" ? "/admin/reviews" : `${store.href(id)}#writings`);
});

// The owner fixes a book's title, author, description or cover by hand (Max, 2026-10-23: «як тут дефіс в
// тайтл поправити?»); the fix outlives catalog refreshes (store.editBook, meta `edits`).
app.get("/admin/book/:id", owner, (req, res) => {
  const id = store.resolve(req.params.id);
  if (!id) return res.status(404).send(pages.messagePage({ title: "Немає такої книжки", text: "", user: req.user }));
  res.send(pages.bookEditPage({ book: store.book(id), raw: store.book(id, { edited: false }), user: req.user, coverError: String(req.query.cover_error || "").slice(0, 200) }));
});
// Suspected Russian books on readers' shelves, each marked by hand (Max, 2026-10-23: «Жук в муравейнике»).
app.get("/admin/russian", owner, (req, res) => res.send(pages.russianPage({ user: req.user, books: store.russianSuspects() })));
app.post("/admin/russian", owner, (req, res) => {
  const id = store.resolve(String(req.body.id || ""));
  if (id) store.editField(id, "language", req.body.ru === "1" ? "російська" : "українська");
  if (req.get("accept")?.includes("json")) return res.json({ ok: !!id });
  res.redirect(303, "/admin/russian");
});
// A cover file from the owner's computer, for shops that won't give the picture to our server.
app.post("/admin/book/:id/cover", owner, express.raw({ type: "image/*", limit: "8mb" }), (req, res) => {
  const id = store.resolve(req.params.id);
  const ext = COVER_TYPES[String(req.get("content-type") || "").split(";")[0].trim()];
  if (!id || !ext || !Buffer.isBuffer(req.body) || req.body.length < 500) return res.status(400).json({ error: "Потрібна картинка: jpg, png або webp." });
  const name = `${require("crypto").createHash("sha1").update(req.body).digest("hex").slice(0, 20)}.${ext}`;
  fs.writeFileSync(path.join(COVERS, name), req.body);
  res.json({ url: `/covers/${name}` });
});
// Pictures to pick a cover from: other editions in our catalogs first, then Open Library and Google Books.
app.get("/admin/book/:id/covers", owner, async (req, res) => {
  const id = store.resolve(req.params.id);
  if (!id) return res.status(404).json({ covers: [] });
  const book = store.book(id, { edited: false });
  const ours = (store.editions.get(id) || []).filter(({ item }) => item.cover).map(({ shelf, item }) => ({ src: item.cover, title: item.title, author: item.author || "", from: shelf.name }));
  const outside = await enrich.searchCovers(book, { googleKey: process.env.GOOGLE_BOOKS_KEY || "" });
  const all = [...ours, ...outside];
  res.json({ covers: all.filter((c, i) => all.findIndex((x) => x.src === c.src) === i).slice(0, 24) });
});
app.post("/admin/book/:id", owner, async (req, res) => {
  const id = store.resolve(req.params.id);
  if (!id) return res.status(404).send("Немає такої книжки");
  const body = req.body.reset ? {} : { ...req.body };
  // A cover still on someone else's site (just pasted, or one that failed before) is fetched again.
  let error = "";
  if (/^https?:/i.test(body.cover || "")) ({ url: body.cover, error = "" } = await keepCover(String(body.cover).trim()));
  const b = store.editBook(id, body);
  res.redirect(303, error ? `/admin/book/${encodeURIComponent(store.href(id).split("/").pop())}?cover_error=${encodeURIComponent(error.slice(0, 200))}` : b.href);
});
app.get("/admin/dupes", owner, (req, res) => res.send(pages.dupesPage({ user: req.user, groups: store.dupes(), decisions: store.decisions(), book: (id) => store.book(id), all: req.query.all === "1" })));
app.get("/admin/volumes", owner, (req, res) => res.send(pages.volumesPage({ user: req.user, groups: (store.volumeGroups || []).map((g) => ({ ...g, items: g.items.map((si) => ({ ...si, item: { ...si.item, href: si.item.href || store.href(si.item.id) } })) })), on: store.db.get("volumes:on") === "1" })));
app.post("/admin/volumes", owner, (req, res) => {
  store.setVolumesOn(req.body.on === "1");
  res.redirect(303, "/admin/volumes");
});
app.post("/admin/volumes/apart", owner, (req, res) => {
  store.keepApart(String(req.body.ids || "").split(",").filter(Boolean));
  decidedJson(req, res, "/admin/volumes#top");
});
app.get("/admin/translations", owner, (req, res) => res.send(pages.translationsPage({ user: req.user, translations: store.translationCandidates(), decisions: store.decisions(), book: (id) => store.book(id) })));
// Every Ukrainian–foreign pair with how it was made (tier 5 owner … 1 main-title guess), and the ones the
// one-pair rule dropped, with the pair that took their place.
app.get("/admin/translations/check", owner, (req, res) => {
  const t = (id) => store.book(id)?.title || id;
  const cyr = (id) => /[а-яіїєґ]/i.test(t(id));
  const row = ([a, b, tier]) => ({ uk: t(cyr(a) ? a : b), orig: t(cyr(a) ? b : a), tier, ids: [a, b] });
  const kept = store.pairLog.kept.filter(([a, b]) => cyr(a) !== cyr(b)).map(row);
  const dropped = store.pairLog.dropped.map((p) => ({ ...row(p), instead: [...(store.translations.get(p[0]) || []), ...(store.translations.get(p[1]) || [])].map(t) }));
  // Originals with more than one Ukrainian page: the same edition twice is a dupe to merge on /admin/dupes.
  const many = new Map();
  for (const k of kept) {
    const o = cyr(k.ids[0]) ? k.ids[1] : k.ids[0];
    (many.get(o) || many.set(o, []).get(o)).push(cyr(k.ids[0]) ? k.ids[0] : k.ids[1]);
  }
  const groups = [...many].filter(([, uk]) => uk.length > 1).map(([o, uk]) => ({ orig: t(o), href: store.href(o), uk: uk.map((id) => ({ title: t(id), href: store.href(id) })) }));
  res.json({ groups, kept: kept.length, byTier: kept.reduce((m, k) => ({ ...m, [k.tier]: (m[k.tier] || 0) + 1 }), {}), dropped, weak: kept.filter((k) => k.tier <= 2), owner: kept.filter((k) => k.tier === 5) });
});
// The owner's verdict on a group of look-alikes: keep=<id> folds the rest into it, verdict=different keeps them apart.
const decidedJson = (req, res, back) => (req.get("X-Requested-With") === "fetch" ? res.json({ ok: true, decided: pages.decidedList(store.decisions(), (id) => store.book(id)) }) : res.redirect(back));
app.post("/admin/dupes/decide", owner, (req, res) => {
  const ids = String(req.body.ids || "").split(",").filter(Boolean);
  if (ids.length >= 2) store.decide(ids, req.body.verdict === "different" ? null : String(req.body.keep || ""));
  decidedJson(req, res, `/admin/dupes${req.body.all === "1" ? "?all=1" : ""}#top`);
});
app.post("/admin/dupes/translation", owner, (req, res) => {
  store.decideTranslation(String(req.body.uk || ""), String(req.body.orig || ""));
  decidedJson(req, res, "/admin/translations#top");
});
// Move readers' entries from one work to another after a wrong merge was split: from, to (ids or
// slugs), readers (usernames, comma-separated; empty moves everyone's).
app.post("/admin/entries/move", owner, (req, res) => {
  const readers = String(req.body.readers || "").split(",").map((u) => auth.byUsername(u.trim().replace(/^@/, ""))?.id).filter(Boolean);
  const moved = store.moveEntries(store.workId(String(req.body.from || "")), store.workId(String(req.body.to || "")), readers);
  res.json({ ok: true, moved });
});
// Ask Open Library (and Wikidata for Ukrainian titles) again, now: ids (ids or slugs, comma-separated)
// or, with none, every own book still wanting something, up to max (300).
app.post("/admin/enrich", owner, (req, res) => {
  const ids = String(req.body.ids || "").split(",").map((x) => store.workId(x.trim())).filter(Boolean);
  // Runs in the background (a pass of 300 books takes five minutes); /refresh-status shows the result.
  enrichMany({ ids: ids.length ? ids : undefined, force: true, max: Math.min(Number(req.body.max) || 300, 1000) }).catch((e) => console.error("enrich failed:", e));
  res.json({ started: true, ids: ids.length });
});
app.post("/admin/dupes/undo", owner, (req, res) => {
  store.undecide(["different", "translations"].includes(req.body.kind) ? req.body.kind : "same", Number(req.body.index));
  decidedJson(req, res, "/admin/dupes#decided");
});
app.get("/digest/status", owner, (req, res) => res.json({ to: digest.to, recipients: digest.recipients().map((r) => `@${r.username}`), lastRun: store.db.get("digest:lastRun"), last: JSON.parse(store.db.get("digest:last") || "null") }));

app.post("/api/subscribe/:id", signed, (req, res) => {
  if (store.toggleSubscription(req.user.id, req.params.id) === null) return res.status(404).send("Немає такої полиці");
  res.redirect(req.get("referer") || "/");
});

if (bg.serving) {
  const server = app.listen(PORT, () => {
    console.log(`Chytai web on http://localhost:${PORT}  (library: ${store.file})${bg.ROLE === "web" ? ", the jobs in their own process" : ""}`);
    watchdog();
  });
  // main.js has a fresh web process answering: finish what is in flight and go.
  process.on("message", (m) => m?.type === "shutdown" && server.close(() => process.exit(0)));
}
// The jobs process ends itself to read fresh data only when the overview queue is empty too (or capped for today).
bg.startJobs({ idle: () => !advice.queue.size || advice.capped, db: store.db });
if (bg.ROLE === "jobs") console.log(`Chytai jobs ready (library: ${store.file})`);

// A process stuck in a CPU loop answers nothing but stays up (2026-10-21: an hour down). A thread beside it
// watches a heartbeat the main loop writes every 5 s and kills the process after 60 s of silence, so Fly
// starts it again.
function watchdog() {
  const { Worker } = require("worker_threads");
  const beat = new Int32Array(new SharedArrayBuffer(4));
  const now = () => Math.floor(Date.now() / 1000);
  Atomics.store(beat, 0, now());
  setInterval(() => Atomics.store(beat, 0, now()), 5000).unref();
  const code = `const { workerData: beat } = require("worker_threads");
setInterval(() => {
  const silent = Math.floor(Date.now() / 1000) - Atomics.load(beat, 0);
  if (silent > 60) { require("fs").writeSync(2, "watchdog: the server has not answered for " + silent + " s, restarting\\n"); process.kill(process.pid, "SIGKILL"); }
}, 10000);`;
  new Worker(code, { eval: true, workerData: beat }).unref();
}

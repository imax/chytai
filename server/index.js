// Web version of Chytai (AI Reader): the same renderer served to phones, with a small API that keeps the
// Claude key, the shared library and everyone's reading positions on the server.
//
// Env: ANTHROPIC_API_KEY, READER_PASSWORD (one family password), READER_SECRET (signs the login
// cookie), DATA_DIR (default ./data; /data on Fly), PORT (default 8080).
// Guest (demo) mode: GUEST_MODE=off disables /demo; GUEST_EXPLAIN_LIMIT (per guest per day, default 15)
// and GUEST_EXPLAIN_TOTAL (all guests per day, default 300) cap what the demo can spend on Claude.
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { explain } = require("../src/ai");
const JSZip = require("jszip");
const library = require("../src/library");
const { isRussian } = require("./language");
const { adminPage, cost } = require("./admin");

const ROOT = path.join(__dirname, "..");
loadDotEnv(path.join(ROOT, ".env"));

const PORT = Number(process.env.PORT) || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const BOOKS_DIR = path.join(DATA_DIR, "books");
const REFLOW_DIR = path.join(DATA_DIR, "reflow");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const PASSWORD = process.env.READER_PASSWORD || "";
const SECRET = process.env.READER_SECRET || "";
const COOKIE = "reader";
const COOKIE_DAYS = 365;
// Guests get their own cookie, so the family cookie format (and everyone's login) stays as it is.
const GUEST_COOKIE = "reader_guest";
const GUEST_ENABLED = process.env.GUEST_MODE !== "off";
const GUEST_LIMIT = Number(process.env.GUEST_EXPLAIN_LIMIT) || 15;
const GUEST_TOTAL_LIMIT = Number(process.env.GUEST_EXPLAIN_TOTAL) || 300;
const GUEST_MAX_CHARS = 1500; // selection and each side of context, so one demo request stays small
const GUEST_MAX_TURNS = 8;
// The demo book: a library book chosen in settings (state.shared.demoBook), else the first EPUB/PDF in
// DATA_DIR/demo (on the Fly volume), else the one shipped in the repo under demo/.
const DEMO_DIRS = [path.join(DATA_DIR, "demo"), path.join(ROOT, "demo")];
const BOOK_EXT = /\.(epub|pdf)$/i;
const MAX_UPLOAD = "300mb";
// Days in the usage stats (/admin) are counted in this time zone, and kept for this long.
const STATS_TZ = process.env.STATS_TZ || "Europe/Kyiv";
const STATS_KEEP_DAYS = 400;

if (!PASSWORD || !SECRET) {
  console.error("READER_PASSWORD and READER_SECRET must be set (see .env.example)");
  process.exit(1);
}
for (const dir of [BOOKS_DIR, REFLOW_DIR]) fs.mkdirSync(dir, { recursive: true });

function loadDotEnv(file) {
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  } catch {
    /* no .env, that's fine */
  }
}

// ---------- State: shared model settings, per-person look and positions ----------

// Translation runs on a cheaper model than explanations (Max, 2026-10-15).
const SHARED_DEFAULTS = { model: "claude-opus-5-5", deepModel: "claude-fable-5-1", translateModel: "claude-sonnet-5-5", language: "українська" };
const USER_DEFAULTS = { autoExplain: true, pageTaps: false, font: "literata", margins: "normal", pdfMode: "reflow", fontSizes: {}, theme: "light", explainStyle: "default", customStyle: "", lastBook: null, positions: {} };
const SHARED_KEYS = new Set(Object.keys(SHARED_DEFAULTS));
const USER_KEYS = new Set(Object.keys(USER_DEFAULTS));

let state = { shared: {}, users: {}, guestUsage: {} };
try {
  state = { shared: {}, users: {}, guestUsage: {}, ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) };
} catch {
  /* first start */
}

let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  }, 200);
}

function userState(name) {
  state.users[name] ??= {};
  return state.users[name];
}

function settingsFor(req) {
  const { notes, ...u } = req.guest ? guestState(req.guest) : userState(req.user);
  const demo = req.guest ? demoBooks() : null;
  return {
    ...SHARED_DEFAULTS,
    ...state.shared,
    ...USER_DEFAULTS,
    ...u,
    positions: u.positions || {},
    user: req.user,
    hasApiKey: !!process.env.ANTHROPIC_API_KEY,
    apiKeyFromEnv: true,
    web: true,
    guest: !!req.guest,
    demoBook: state.shared.demoBook || "",
    demoDefault: demoBooks(true)[0]?.name || "",
    ...(req.guest
      ? { lastBook: u.lastBook || demo[0]?.name || null, guestLimit: { used: guestUsage().guests[req.guest] || 0, limit: GUEST_LIMIT } }
      : {}),
  };
}

// ---------- Guests: a demo session that lives in memory and sees only the demo book ----------

const guests = new Map(); // guest id -> { positions, lastBook, ...settings }
const GUEST_MAX = 5000;

function guestState(id) {
  let g = guests.get(id);
  if (!g) {
    if (guests.size >= GUEST_MAX) guests.delete(guests.keys().next().value); // oldest first
    g = { positions: {} };
    guests.set(id, g);
  } else {
    guests.delete(id); // re-insert so the map stays ordered by last use
    guests.set(id, g);
  }
  return g;
}

// Daily counters survive restarts (state.json) so a redeploy doesn't reset the demo budget.
function guestUsage() {
  const day = new Date().toISOString().slice(0, 10);
  if (state.guestUsage?.day !== day) state.guestUsage = { day, total: 0, guests: {}, ips: {} };
  return state.guestUsage;
}

function guestExplainAllowed(req) {
  const usage = guestUsage();
  const ip = req.ip || "";
  if (usage.total >= GUEST_TOTAL_LIMIT) return "Демо на сьогодні вичерпало свій ліміт пояснень. Спробуйте завтра або увійдіть зі своїм паролем.";
  if ((usage.guests[req.guest] || 0) >= GUEST_LIMIT || (usage.ips[ip] || 0) >= GUEST_LIMIT * 3) {
    return `У демо-режимі доступно до ${GUEST_LIMIT} пояснень на день, і вони вже використані. Увійдіть, щоб читати без обмежень.`;
  }
  usage.total++;
  usage.guests[req.guest] = (usage.guests[req.guest] || 0) + 1;
  usage.ips[ip] = (usage.ips[ip] || 0) + 1;
  saveState();
  return null;
}

// Keeps a guest request small: trimmed context and a bounded conversation.
function trimGuestRequest(request) {
  const cut = (t, fromEnd) => {
    const str = String(t || "");
    if (str.length <= GUEST_MAX_CHARS) return str;
    return fromEnd ? str.slice(-GUEST_MAX_CHARS) : str.slice(0, GUEST_MAX_CHARS);
  };
  if (request.context) {
    const c = request.context;
    request.context = { ...c, before: cut(c.before, true), selection: cut(c.selection), after: cut(c.after), question: c.question && cut(c.question) };
  }
  if (Array.isArray(request.messages) && request.messages.length > GUEST_MAX_TURNS) {
    request.messages = [request.messages[0], ...request.messages.slice(-(GUEST_MAX_TURNS - 1))];
  }
  return request;
}

// ---------- Usage stats: explanations per day, per reader and per model, for /admin ----------

const statsDay = (ts = Date.now()) => new Date(ts).toLocaleDateString("sv-SE", { timeZone: STATS_TZ }); // YYYY-MM-DD

function recordExplain(req, { model, usage }) {
  const day = statsDay();
  const stats = (state.stats ??= { since: day, days: {} });
  const d = (stats.days[day] ??= { explains: 0, users: {}, guests: 0, models: {} });
  d.explains++;
  if (req.guest) d.guests++;
  else d.users[req.user] = (d.users[req.user] || 0) + 1;
  const m = (d.models[model || "?"] ??= { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  m.requests++;
  m.input += usage?.input_tokens || 0;
  m.output += usage?.output_tokens || 0;
  m.cacheRead += usage?.cache_read_input_tokens || 0;
  m.cacheWrite += usage?.cache_creation_input_tokens || 0;
  const cutoff = statsDay(Date.now() - STATS_KEEP_DAYS * 86400000);
  for (const old of Object.keys(stats.days)) if (old < cutoff) delete stats.days[old];
  saveState();
}

async function collectStats() {
  const stats = state.stats || { since: null, days: {} };
  const today = statsDay();
  const weekAgo = statsDay(Date.now() - 7 * 86400000);
  const dayKeys = Object.keys(stats.days).sort().reverse();
  const sumUser = (name, from) => dayKeys.filter((k) => !from || k >= from).reduce((a, k) => a + (stats.days[k].users[name] || 0), 0);
  const sumAll = (from) => dayKeys.filter((k) => !from || k >= from).reduce((a, k) => a + stats.days[k].explains, 0);

  const users = Object.entries(state.users)
    .map(([name, u]) => {
      const lastSeen = Math.max(0, ...Object.values(u.opened || {}));
      const started = new Set(Object.keys(u.positions || {}).map((p) => p.replace(/#reflow$/, ""))).size;
      return { name, today: sumUser(name, today), week: sumUser(name, weekAgo), total: sumUser(name), started, lastSeen, lastBook: u.lastBook, activeWeek: lastSeen > Date.now() - 7 * 86400000 };
    })
    .sort((a, b) => b.lastSeen - a.lastSeen);

  const library = await scanLibrary();
  const books = library
    .map((b) => {
      const name = path.relative(BOOKS_DIR, b.path);
      const readers = Object.values(state.users).filter((u) => u.positions?.[name] || u.positions?.[`${name}#reflow`]).length;
      return { name, title: b.title || name, authors: (b.authors || []).join(", "), size: b.size, readers };
    })
    .sort((a, b) => b.readers - a.readers || a.title.localeCompare(b.title, "uk"));

  const modelTotals = {};
  const days = dayKeys.map((day) => {
    const d = stats.days[day];
    const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let dayCost = 0;
    for (const [model, m] of Object.entries(d.models)) {
      for (const k of Object.keys(t)) t[k] += m[k] || 0;
      const c = cost(model, m);
      dayCost = dayCost == null || c == null ? null : dayCost + c;
      const mt = (modelTotals[model] ??= { model, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      mt.requests += m.requests;
      for (const k of Object.keys(t)) mt[k] += m[k] || 0;
    }
    return { day, explains: d.explains, family: d.explains - d.guests, guests: d.guests, ...t, cost: dayCost };
  });
  const models = Object.values(modelTotals)
    .map((m) => ({ ...m, cost: cost(m.model, m) }))
    .sort((a, b) => b.requests - a.requests);

  const gu = guestUsage();
  return {
    timeZone: STATS_TZ,
    since: stats.since,
    totals: { today: sumAll(today), week: sumAll(weekAgo), all: sumAll() },
    users,
    books,
    days,
    models,
    guestsToday: Object.keys(gu.guests).length,
    guestExplainsToday: gu.total,
    guestTotalLimit: GUEST_TOTAL_LIMIT,
    wishes: wishStats(library),
  };
}

// «Хочу прочитати» across the family: one row per wanted title, who wants it and whether it is in the library yet.
// Titles match loosely, the same way the home screen decides «Уже є» (home.js).
const normTitle = (s) => String(s || "").toLowerCase().replace(/[«»"'’ʼ.,:;!?()—–-]/g, " ").replace(/\s+/g, " ").trim();
const sameTitle = (a, b) => {
  const x = normTitle(a);
  const y = normTitle(b);
  return x.length > 2 && y.length > 2 && (x === y || x.includes(y) || y.includes(x));
};

function wishStats(library) {
  const rows = [];
  for (const [name, u] of Object.entries(state.users)) {
    for (const w of u.wish || []) {
      let row = rows.find((r) => sameTitle(r.title, w.title));
      if (!row) {
        const book = library.find((b) => sameTitle(b.title, w.title));
        rows.push((row = { title: w.title, author: w.author, who: [], addedAt: 0, inLibrary: !!book }));
      }
      if (!row.author && w.author) row.author = w.author;
      if (!row.who.includes(name)) row.who.push(name);
      row.addedAt = Math.max(row.addedAt, w.addedAt || 0);
    }
  }
  rows.sort((a, b) => b.who.length - a.who.length || a.inLibrary - b.inLibrary || b.addedAt - a.addedAt);
  const lists = Object.values(state.users).filter((u) => u.wish?.length).length;
  return { rows, total: Object.values(state.users).reduce((n, u) => n + (u.wish?.length || 0), 0), lists };
}

// [{ dir, name }] of the books a guest may open. builtInOnly skips the library choice.
function demoBooks(builtInOnly) {
  const chosen = state.shared.demoBook;
  if (!builtInOnly && chosen && fs.existsSync(bookFile(chosen))) return [{ dir: BOOKS_DIR, name: chosen }];
  for (const dir of DEMO_DIRS) {
    try {
      const names = fs.readdirSync(dir).filter((n) => !n.startsWith(".") && BOOK_EXT.test(n)).sort();
      if (names.length) return names.map((name) => ({ dir, name }));
    } catch {
      /* no such folder */
    }
  }
  return [];
}

// ---------- Auth: one family password, the name goes into a signed cookie ----------

const sign = (value) => crypto.createHmac("sha256", SECRET).update(value).digest("base64url");

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function currentUser(req) {
  const raw = parseCookies(req)[COOKIE];
  if (!raw) return null;
  const i = raw.lastIndexOf(".");
  if (i < 0) return null;
  const name = raw.slice(0, i);
  const sig = raw.slice(i + 1);
  const expected = sign(name);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return name;
}

function cookieHeader(req, cookie, value, days) {
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  return `${cookie}=${encodeURIComponent(value)}; Path=/; Max-Age=${days * 86400}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

function setLoginCookie(req, res, name) {
  // Logging in as family ends any guest session on this device.
  res.setHeader("Set-Cookie", [cookieHeader(req, COOKIE, `${name}.${sign(name)}`, COOKIE_DAYS), cookieHeader(req, GUEST_COOKIE, "", 0)]);
}

function currentGuest(req) {
  if (!GUEST_ENABLED) return null;
  const raw = parseCookies(req)[GUEST_COOKIE];
  const i = raw ? raw.lastIndexOf(".") : -1;
  if (i < 0) return null;
  const id = raw.slice(0, i);
  const sig = raw.slice(i + 1);
  const expected = sign(`guest:${id}`);
  if (!/^[a-f0-9]{24}$/.test(id) || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return id;
}

function startGuest(req, res) {
  const id = crypto.randomBytes(12).toString("hex");
  res.setHeader("Set-Cookie", cookieHeader(req, GUEST_COOKIE, `${id}.${sign(`guest:${id}`)}`, 30));
}

function passwordOk(given) {
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function loginPage(error) {
  return `<!doctype html>
<html lang="uk"><head><meta charset="utf-8"><title>Chytai</title>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<link rel="icon" href="/icon.png"><link rel="apple-touch-icon" href="/icon.png">
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; background: #f6efe0; color: #3b2f1e; }
  @media (prefers-color-scheme: dark) { body { background: #1e1e20; color: #e6e6e6; } input { background: #2a2a2d; color: inherit; } }
  form { width: min(360px, 90vw); padding: 28px 24px; border-radius: 16px; background: rgba(255,255,255,0.5); box-shadow: 0 8px 30px rgba(0,0,0,0.12); }
  @media (prefers-color-scheme: dark) { form { background: #2a2a2d; } }
  h1 { margin: 0 0 4px; font-size: 22px; } p { margin: 0 0 18px; opacity: 0.7; }
  label { display: block; margin-bottom: 14px; font-weight: 500; }
  input { display: block; width: 100%; box-sizing: border-box; margin-top: 5px; padding: 10px 12px; font: inherit; border: 1px solid rgba(0,0,0,0.2); border-radius: 8px; }
  button { width: 100%; padding: 11px; font: inherit; font-weight: 600; color: #fff; background: #b7791f; border: none; border-radius: 8px; }
  .err { color: #c0392b; margin-bottom: 12px; }
  .demo { margin: 18px 0 0; text-align: center; font-size: 14px; }
  .demo a { color: #b7791f; font-weight: 600; }
</style></head>
<body><form method="post" action="/login">
  <h1>Chytai</h1><p>Читалка з поясненнями від Claude</p>
  ${error ? `<div class="err">${esc(error)}</div>` : ""}
  <label>Ім'я <input name="name" required autocomplete="username" autocapitalize="words" placeholder="Макс"></label>
  <label>Пароль <input name="password" type="password" required autocomplete="current-password"></label>
  <button>Увійти</button>
  ${GUEST_ENABLED && demoBooks().length ? `<p class="demo">Немає пароля? <a href="/demo">Подивитися демо</a> з однією книжкою.</p>` : ""}
</form></body></html>`;
}

// ---------- App ----------

const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");

// Public: icon and manifest, so the phone can show them before login.
app.get("/icon.png", (_req, res) => res.sendFile(path.join(ROOT, "build", "icon.png")));
app.get("/manifest.webmanifest", (_req, res) => {
  res.type("application/manifest+json").json({
    name: "Chytai",
    short_name: "Chytai",
    start_url: "/",
    display: "standalone",
    background_color: "#f6efe0",
    theme_color: "#f5f5f7",
    icons: [{ src: "/icon.png", sizes: "1024x1024", type: "image/png" }],
  });
});

// The service worker keeps the reader on the device (src/renderer/sw.js). Its version is a hash of the
// reader's files and package-lock, so a deploy that changes any of them installs a fresh copy; the list
// of files to keep is everything in src/renderer plus the libraries the page loads from node_modules.
const serviceWorker = (() => {
  const rendererDir = path.join(ROOT, "src", "renderer");
  const rendererFiles = fs.readdirSync(rendererDir).filter((f) => /\.(js|css|html)$/.test(f));
  const hash = crypto.createHash("sha1");
  for (const f of [...rendererFiles.map((f) => path.join(rendererDir, f)), path.join(ROOT, "package-lock.json")]) hash.update(fs.readFileSync(f));
  const fontDir = "@fontsource-variable/literata";
  const fontCss = ["wght.css", "wght-italic.css"];
  const fontFiles = fontCss.flatMap((f) =>
    [...fs.readFileSync(path.join(ROOT, "node_modules", fontDir, f), "utf8").matchAll(/url\(\.\/([^)]+)\)/g)].map((m) => `${fontDir}/${m[1]}`),
  );
  const libs = [
    "jszip/dist/jszip.min.js",
    "epubjs/dist/epub.min.js",
    "marked/lib/marked.umd.js",
    "dompurify/dist/purify.min.js",
    "pdfjs-dist/build/pdf.mjs",
    "pdfjs-dist/build/pdf.worker.mjs",
    "pdfjs-dist/web/pdf_viewer.mjs",
    "pdfjs-dist/web/pdf_viewer.css",
    ...fontCss.map((f) => `${fontDir}/${f}`),
    ...fontFiles,
  ];
  const assets = [
    "/",
    "/icon.png",
    "/manifest.webmanifest",
    ...rendererFiles.filter((f) => f !== "index.html" && f !== "sw.js").map((f) => `/${f}`),
    ...libs.map((l) => `/node_modules/${l}`),
  ];
  const source = fs
    .readFileSync(path.join(rendererDir, "sw.js"), "utf8")
    .replace("__VERSION__", hash.digest("hex").slice(0, 12))
    .replace("__ASSETS__", JSON.stringify(assets));
  return source;
})();
app.get("/sw.js", (_req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.type("application/javascript").send(serviceWorker);
});

app.get("/login", (req, res) => (currentUser(req) ? res.redirect("/") : res.type("html").send(loginPage())));
app.post("/login", express.urlencoded({ extended: false }), (req, res) => {
  const name = String(req.body.name || "").trim().slice(0, 40);
  if (!name || !passwordOk(req.body.password)) {
    return res.status(401).type("html").send(loginPage("Неправильне ім'я або пароль."));
  }
  setLoginCookie(req, res, name);
  res.redirect("/");
});
app.post("/logout", (_req, res) => {
  res.setHeader("Set-Cookie", [`${COOKIE}=; Path=/; Max-Age=0`, `${GUEST_COOKIE}=; Path=/; Max-Age=0`]);
  res.redirect("/login");
});

// /demo opens the reader as a guest: one demo book, no uploads, a daily cap on explanations.
app.get("/demo", (req, res) => {
  if (currentUser(req)) return res.redirect("/");
  if (!GUEST_ENABLED || !demoBooks().length) return res.redirect("/login");
  if (!currentGuest(req)) startGuest(req, res);
  res.redirect("/");
});

app.use((req, res, next) => {
  const user = currentUser(req);
  const guest = user ? null : currentGuest(req);
  if (!user && !guest) {
    if (req.path.startsWith("/api/")) return res.status(401).json({ error: "login" });
    return res.redirect("/login");
  }
  req.user = user || "Гість";
  req.guest = guest;
  next();
});

const guestsCannot = (message) => (req, res, next) => (req.guest ? res.status(403).json({ error: message }) : next());

// The dashboard is for the family: a guest who finds the link is sent to the login page.
app.get("/admin", async (req, res, next) => {
  if (req.guest) return res.redirect("/login");
  try {
    res.type("html").send(adminPage(await collectStats()));
  } catch (err) {
    next(err);
  }
});

// Static renderer: index.html at /, its scripts next to it, node_modules at /node_modules
// (so the renderer's ../../node_modules/… paths resolve, as they do under file:// in Electron).
app.get("/", (_req, res) => res.sendFile(path.join(ROOT, "src", "renderer", "index.html")));
app.use("/node_modules", express.static(path.join(ROOT, "node_modules"), { index: false, maxAge: "7d" }));
app.use(express.static(path.join(ROOT, "src", "renderer"), { index: false }));

// ---------- API ----------

const api = express.Router();
api.use(express.json({ limit: "20mb" }));

api.get("/settings", (req, res) => res.json(settingsFor(req)));

api.get("/admin", guestsCannot("Статистика доступна лише родині."), async (req, res, next) => {
  try {
    res.json(await collectStats());
  } catch (err) {
    next(err);
  }
});

api.patch("/settings", (req, res) => {
  const u = req.guest ? guestState(req.guest) : userState(req.user);
  for (const [k, v] of Object.entries(req.body || {})) {
    if (k === "demoBook") {
      // Family members pick which library book the demo shows; "" goes back to the built-in one.
      if (!req.guest) state.shared.demoBook = safeBookName(v) || "";
    } else if (SHARED_KEYS.has(k)) {
      if (!req.guest) state.shared[k] = v;
    } else if (k === "customStyle") u[k] = String(v ?? "").slice(0, 1500);
    else if (USER_KEYS.has(k) && k !== "positions") u[k] = v;
  }
  if (!req.guest) saveState();
  res.json(settingsFor(req));
});

api.put("/position", (req, res) => {
  const { path: bookPath, cfi, pct, chapter } = req.body || {};
  if (typeof bookPath !== "string" || typeof cfi !== "string") return res.status(400).json({ error: "bad request" });
  const u = req.guest ? guestState(req.guest) : userState(req.user);
  const name = bookPath.replace(/#reflow$/, "");
  u.positions ??= {};
  u.positions[bookPath] = cfi;
  (u.opened ??= {})[name] = Date.now();
  // How far in and which chapter, for the home screen: the position itself is a CFI it cannot read.
  if (Number.isFinite(pct)) {
    (u.progress ??= {})[name] = { pct: Math.max(0, Math.min(100, Math.round(pct))), chapter: typeof chapter === "string" ? chapter.slice(0, 200) : "" };
  }
  if (!req.guest) saveState();
  res.json({ ok: true });
});

// ---------- Notes: passages a reader saved with "В нотатки", per person and per book ----------

const NOTE_TEXT_MAX = 4000;

function notesOf(req, bookPath) {
  const u = req.guest ? guestState(req.guest) : userState(req.user);
  u.notes ??= {};
  return { u, list: (u.notes[bookPath] ??= []) };
}

api.get("/notes", (req, res) => {
  const bookPath = String(req.query.path || "");
  const u = req.guest ? guestState(req.guest) : userState(req.user);
  res.json({ notes: u.notes?.[bookPath] || [] });
});

// Every note of this reader, for the home screen's Нотатки: { "<book>": [note, …] }.
api.get("/notes/all", (req, res) => {
  const u = req.guest ? guestState(req.guest) : userState(req.user);
  res.json({ books: u.notes || {} });
});

api.post("/notes", (req, res) => {
  const { path: bookPath, cfi, posKey, text, chapter } = req.body || {};
  if (typeof bookPath !== "string" || typeof cfi !== "string" || typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "bad request" });
  }
  const { list } = notesOf(req, bookPath);
  const existing = list.find((n) => n.cfi === cfi);
  if (existing) return res.json({ note: existing });
  const note = {
    id: crypto.randomBytes(6).toString("hex"),
    cfi,
    posKey: typeof posKey === "string" ? posKey : bookPath,
    text: text.trim().slice(0, NOTE_TEXT_MAX),
    chapter: typeof chapter === "string" ? chapter.slice(0, 200) : "",
    comment: "",
    createdAt: Date.now(),
  };
  list.push(note);
  if (!req.guest) saveState();
  res.json({ note });
});

api.patch("/notes/:id", (req, res) => {
  const { list } = notesOf(req, String(req.query.path || ""));
  const note = list.find((n) => n.id === req.params.id);
  if (!note) return res.status(404).json({ error: "Нотатки немає." });
  if (typeof req.body?.comment === "string") note.comment = req.body.comment.slice(0, NOTE_TEXT_MAX);
  if (!req.guest) saveState();
  res.json({ note });
});

api.delete("/notes/:id", (req, res) => {
  const bookPath = String(req.query.path || "");
  const { u, list } = notesOf(req, bookPath);
  u.notes[bookPath] = list.filter((n) => n.id !== req.params.id);
  if (!u.notes[bookPath].length) delete u.notes[bookPath];
  if (!req.guest) saveState();
  res.json({ ok: true });
});

// Book names are the file names inside BOOKS_DIR; a name is never allowed to escape it.
function safeBookName(name) {
  const base = path.basename(String(name || "")).normalize("NFC");
  if (!base || base.startsWith(".") || !BOOK_EXT.test(base)) return null;
  return base;
}
const bookFile = (name) => path.join(BOOKS_DIR, name);

// The family can correct a book's title and author in the library; the file and its metadata stay as
// they are, the correction lives in state.shared.bookMeta[name] = { title, authors }.
async function scanLibrary() {
  const books = await library.scan([BOOKS_DIR], path.join(DATA_DIR, "library-cache.json"));
  const meta = state.shared.bookMeta || {};
  return books.map((b) => {
    const m = meta[path.relative(BOOKS_DIR, b.path)];
    return m ? { ...b, title: m.title || b.title, authors: m.authors?.length ? m.authors : b.authors, edited: true } : b;
  });
}

// Forgets everything that pointed at a deleted book: positions, "last book", the demo choice, corrections.
function forgetBook(name) {
  for (const u of Object.values(state.users)) {
    if (u.lastBook === name) u.lastBook = null;
    delete u.positions?.[name];
    delete u.positions?.[`${name}#reflow`];
    delete u.opened?.[name];
    delete u.notes?.[name];
    delete u.progress?.[name];
    delete u.seen?.[name];
  }
  delete state.shared.added?.[name];
  if (state.shared.demoBook === name) state.shared.demoBook = "";
  delete state.shared.bookMeta?.[name];
  saveState();
}

api.get("/library", async (req, res) => {
  const u = req.guest ? guestState(req.guest) : userState(req.user);
  let books;
  if (req.guest) {
    const demo = demoBooks();
    const allowed = new Set(demo.map((d) => path.join(d.dir, d.name)));
    const scanned = await library.scan([...new Set(demo.map((d) => d.dir))], path.join(DATA_DIR, "demo-cache.json"));
    books = scanned.filter((b) => allowed.has(b.path)).map((b) => ({ ...b, dir: path.dirname(b.path) }));
  } else {
    books = (await scanLibrary()).map((b) => ({ ...b, dir: BOOKS_DIR }));
  }
  const positions = u.positions || {};
  const added = state.shared.added || {};
  const list = books.map((b) => {
    const name = path.relative(b.dir, b.path);
    const openedAt = u.opened?.[name] || 0;
    const progress = u.progress?.[name];
    return {
      ...b, dir: undefined, path: name, cloud: false, openedAt,
      started: !!(positions[name] || positions[`${name}#reflow`]),
      pct: progress ? progress.pct : null,
      chapter: progress?.chapter || "",
      // Who put the book in the library and when; books from before this was recorded have only the file's date.
      addedAt: added[name]?.at || b.mtime || 0,
      addedBy: added[name]?.by || "",
      seen: !!(openedAt || u.seen?.[name]) || (!!req.user && added[name]?.by === req.user),
    };
  });
  res.json({ folders: [], books: list, lastBook: u.lastBook || (req.guest ? demoBooks()[0]?.name : null) || null });
});

api.get("/book", (req, res) => {
  const name = safeBookName(req.query.path);
  const demo = req.guest ? demoBooks().find((d) => d.name === name) : null;
  const file = req.guest ? demo && path.join(demo.dir, demo.name) : name && bookFile(name);
  if (!file || !fs.existsSync(file)) return res.status(404).json({ error: "Книжки немає на сервері." });
  const u = req.guest ? guestState(req.guest) : userState(req.user);
  u.lastBook = name;
  (u.opened ??= {})[name] = Date.now();
  if (!req.guest) saveState();
  res.setHeader("X-Book-Position", encodeURIComponent(u.positions?.[name] || ""));
  res.setHeader("X-Book-Reflow-Position", encodeURIComponent(u.positions?.[`${name}#reflow`] || ""));
  res.sendFile(file);
});

// ---------- Home screen: covers, "new arrivals" seen, the wish list ----------

// The cover image inside an EPUB, cached on the volume by file name, size and date; PDFs have none.
const COVER_DIR = path.join(DATA_DIR, "covers");
const COVER_TYPES = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };

async function epubCover(file) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const container = await zip.file("META-INF/container.xml")?.async("string");
  const opfPath = container?.match(/full-path="([^"]+)"/)?.[1];
  const opf = opfPath && (await zip.file(opfPath)?.async("string"));
  if (!opf) return null;
  const items = [...opf.matchAll(/<(?:opf:)?item\b[^>]*>/g)].map((m) => {
    const attr = (name) => m[0].match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] || "";
    return { id: attr("id"), href: attr("href"), type: attr("media-type"), props: attr("properties") };
  });
  const coverId = opf.match(/<meta\b[^>]*name="cover"[^>]*content="([^"]+)"/)?.[1] || opf.match(/<meta\b[^>]*content="([^"]+)"[^>]*name="cover"/)?.[1];
  const item =
    items.find((i) => i.props.split(/\s+/).includes("cover-image")) ||
    items.find((i) => i.id === coverId && i.type.startsWith("image/")) ||
    items.find((i) => /cover/i.test(i.id + i.href) && i.type.startsWith("image/"));
  if (!item) return null;
  const href = decodeURIComponent(path.posix.join(path.posix.dirname(opfPath), item.href));
  const data = await zip.file(href)?.async("nodebuffer");
  const ext = path.extname(href).slice(1).toLowerCase();
  return data && COVER_TYPES[ext] ? { data, ext } : null;
}

api.get("/cover", async (req, res) => {
  const name = safeBookName(req.query.path);
  const demo = req.guest ? demoBooks().find((d) => d.name === name) : null;
  const file = req.guest ? demo && path.join(demo.dir, demo.name) : name && bookFile(name);
  if (!file || !/\.epub$/i.test(file) || !fs.existsSync(file)) return res.status(404).end();
  try {
    const st = fs.statSync(file);
    const key = crypto.createHash("sha1").update(`${file}:${st.size}:${st.mtimeMs}`).digest("hex").slice(0, 16);
    fs.mkdirSync(COVER_DIR, { recursive: true });
    let cached = fs.readdirSync(COVER_DIR).find((f) => f.startsWith(`${key}.`));
    if (!cached) {
      const cover = await epubCover(file);
      cached = `${key}.${cover ? cover.ext : "none"}`;
      fs.writeFileSync(path.join(COVER_DIR, cached), cover ? cover.data : "");
    }
    const ext = path.extname(cached).slice(1);
    if (ext === "none") return res.status(404).end();
    // The URL carries the file's date, so a replaced book gets a new address.
    res.setHeader("Cache-Control", "private, max-age=2592000, immutable");
    res.type(COVER_TYPES[ext]).sendFile(path.join(COVER_DIR, cached));
  } catch {
    res.status(404).end();
  }
});

// "Позначити переглянутими" on the new arrivals.
api.post("/library/seen", (req, res) => {
  const u = req.guest ? guestState(req.guest) : userState(req.user);
  for (const p of Array.isArray(req.body?.paths) ? req.body.paths : []) {
    const name = safeBookName(p);
    if (name) (u.seen ??= {})[name] = Date.now();
  }
  if (!req.guest) saveState();
  res.json({ ok: true });
});

// "Хочу прочитати": each reader's own list of books to get; the home screen shows when one arrives.
const clean = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
api.get("/wish", (req, res) => res.json({ wish: req.guest ? [] : userState(req.user).wish || [] }));
api.post("/wish", guestsCannot("У демо-режимі список бажаного недоступний."), (req, res) => {
  const title = clean(req.body?.title, 300);
  if (!title) return res.status(400).json({ error: "Вкажіть назву." });
  const u = userState(req.user);
  const item = { id: crypto.randomBytes(6).toString("hex"), title, author: clean(req.body?.author, 300), addedAt: Date.now() };
  u.wish = [item, ...(u.wish || [])].slice(0, 500);
  saveState();
  res.json({ item, wish: u.wish });
});
api.delete("/wish/:id", guestsCannot("У демо-режимі список бажаного недоступний."), (req, res) => {
  const u = userState(req.user);
  u.wish = (u.wish || []).filter((w) => w.id !== req.params.id);
  saveState();
  res.json({ wish: u.wish });
});

// Guests read the demo book and nothing else: no uploads, no deletions, no shared caches.
api.put("/books/:name", guestsCannot("У демо-режимі не можна додавати книжки. Увійдіть, щоб завантажити свою."));
api.delete("/books/:name", guestsCannot("У демо-режимі не можна видаляти книжки."));
api.patch("/books/:name", guestsCannot("У демо-режимі не можна редагувати книжки."));
api.put("/reflow", guestsCannot("У демо-режимі конвертація PDF не зберігається."));
api.get("/reflow", (req, res, next) => (req.guest ? res.status(204).end() : next()));

// Upload: PUT /api/books/<file name> with the raw file as the body.
api.put("/books/:name", express.raw({ type: () => true, limit: MAX_UPLOAD }), async (req, res) => {
  const name = safeBookName(req.params.name);
  if (!name) return res.status(400).json({ error: "Підтримуються лише EPUB і PDF." });
  if (!req.body?.length) return res.status(400).json({ error: "Порожній файл." });
  // Chytai does not take books in Russian: the file is refused, not kept.
  if (await isRussian(name, req.body)) return res.status(400).json({ error: "Книжки російською мовою в Chytai не завантажуються." });
  fs.writeFileSync(bookFile(name), req.body);
  (state.shared.added ??= {})[name] = { by: req.user, at: Date.now() };
  saveState();
  res.json({ path: name });
});

api.delete("/books/:name", (req, res) => {
  const name = safeBookName(req.params.name);
  if (!name) return res.status(400).json({ error: "Немає такої книжки." });
  fs.rmSync(bookFile(name), { force: true });
  forgetBook(name);
  res.json({ ok: true });
});

// Title and author as the library should show them: PATCH /api/books/<name> { title, authors }.
// Empty values go back to what the file itself says.
api.patch("/books/:name", (req, res) => {
  const name = safeBookName(req.params.name);
  if (!name || !fs.existsSync(bookFile(name))) return res.status(404).json({ error: "Книжки немає на сервері." });
  const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  const title = clean(req.body?.title);
  const raw = req.body?.authors;
  const authors = (Array.isArray(raw) ? raw : String(raw ?? "").split(/[,;]/)).map(clean).filter(Boolean).slice(0, 10);
  const meta = (state.shared.bookMeta ??= {});
  if (title || authors.length) meta[name] = { title, authors };
  else delete meta[name];
  saveState();
  res.json({ path: name, title, authors, edited: !!meta[name] });
});

// Cache for PDFs converted to EPUB in the browser ("як книжка" mode), shared by everyone.
function reflowFile(name, version) {
  const st = fs.statSync(bookFile(name));
  const key = crypto.createHash("sha1").update(`${name}:${st.size}:${st.mtimeMs}:v${version}`).digest("hex").slice(0, 16);
  return path.join(REFLOW_DIR, `${key}-reflow.epub`);
}

api.get("/reflow", (req, res) => {
  const name = safeBookName(req.query.path);
  try {
    const file = reflowFile(name, String(req.query.version || ""));
    if (!fs.existsSync(file)) return res.status(204).end();
    res.type("application/epub+zip").sendFile(file);
  } catch {
    res.status(404).end();
  }
});

api.put("/reflow", express.raw({ type: () => true, limit: MAX_UPLOAD }), (req, res) => {
  const name = safeBookName(req.query.path);
  try {
    fs.writeFileSync(reflowFile(name, String(req.query.version || "")), req.body);
    res.json({ ok: true });
  } catch {
    res.status(404).end();
  }
});

// Streams an explanation as newline-delimited JSON events, the same events the Electron renderer gets.
api.post("/explain", async (req, res) => {
  const request = req.body?.request;
  if (!request || typeof request !== "object") return res.status(400).json({ error: "bad request" });
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  const send = (payload) => !res.writableEnded && res.write(JSON.stringify(payload) + "\n");

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    send({ type: "error", message: "На сервері не налаштовано ключ Claude API." });
    return res.end();
  }
  if (req.guest) {
    const denied = guestExplainAllowed(req);
    if (denied) {
      send({ type: "error", message: denied });
      return res.end();
    }
    trimGuestRequest(request);
  }
  const controller = new AbortController();
  // The request's own "close" fires once its body is read; the response closes when the phone goes away.
  res.on("close", () => !res.writableEnded && controller.abort());
  const shared = { ...SHARED_DEFAULTS, ...state.shared };
  const me = { ...USER_DEFAULTS, ...(req.guest ? guestState(req.guest) : userState(req.user)) };
  try {
    const result = await explain({
      apiKey,
      model: request.mode === "translate" ? shared.translateModel : request.deep ? shared.deepModel : shared.model,
      language: shared.language,
      style: me.explainStyle,
      customStyle: me.customStyle,
      request,
      signal: controller.signal,
      onText: (text) => send({ type: "text", text }),
    });
    const { usage, ...done } = result;
    recordExplain(req, { model: done.model, usage });
    send({ type: "done", ...done });
  } catch (err) {
    if (controller.signal.aborted) send({ type: "aborted" });
    else send({ type: "error", message: describeError(err) });
  }
  res.end();
});

function describeError(err) {
  const status = err?.status;
  if (status === 401) return "Ключ API на сервері недійсний.";
  if (status === 429) return "Перевищено ліміт запитів. Спробуйте трохи згодом.";
  if (status === 529 || status >= 500) return "Сервіс Claude тимчасово перевантажений. Спробуйте ще раз.";
  if (err?.name === "APIConnectionError") return "Немає з'єднання з Claude API.";
  return err?.message || String(err);
}

app.use("/api", api);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || "server error" });
});

app.listen(PORT, "0.0.0.0", () => console.log(`Chytai web on http://0.0.0.0:${PORT}, books in ${BOOKS_DIR}`));

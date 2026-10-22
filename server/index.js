// Web version of Chytai (AI Reader): the same renderer served to phones, with a small API that keeps the
// Claude key, each account's library and reading positions on the server.
//
// Accounts (Max, 2026-10-22): the reader signs in with the account of the web site (chytai.org.ua), one
// person per account, each with a private library nobody else sees. The login page sends the reader to
// WEB_URL/reader-login, which comes back to /auth with a one-time ticket that this server trades for the
// account (web/server.js). The site's owner (account "owner", Max) keeps the library that was here before
// accounts: DATA_DIR/books and the old state; everyone else gets DATA_DIR/accounts/<id>/.
//
// Env: ANTHROPIC_API_KEY, READER_SECRET (signs the login cookie), WEB_URL (default https://chytai.org.ua),
// DATA_DIR (default ./data; /data on Fly), PORT (default 8080).
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
const { checkUpload } = require("./content");
const { adminPage, cost } = require("./admin");

const ROOT = path.join(__dirname, "..");
loadDotEnv(path.join(ROOT, ".env"));

const PORT = Number(process.env.PORT) || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const BOOKS_DIR = path.join(DATA_DIR, "books");
const REFLOW_DIR = path.join(DATA_DIR, "reflow");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const SECRET = process.env.READER_SECRET || "";
const WEB_URL = (process.env.WEB_URL || "https://chytai.org.ua").replace(/\/$/, "");
const COOKIE = "reader_acct";
const OLD_COOKIE = "reader"; // the family password's cookie, cleared on the way
const COOKIE_DAYS = 365;
const OWNER_ID = "owner"; // web/store.js OWNER
const OWNER_LEGACY_NAME = process.env.READER_OWNER_NAME || "Макс"; // Max's name under the family password
const ACCOUNT_ID = /^(?:owner|[a-f0-9]{16})$/;
const ACCOUNTS_DIR = path.join(DATA_DIR, "accounts");
// A link to one book for one person (Max, 2026-10-22): it opens without an account, on the first device
// that opens it and no other, for SHARE_DAYS, until its owner switches it off; read only, a few
// explanations a day. A reader has at most SHARE_MAX links at a time.
const SHARE_COOKIE = "reader_share";
const DEVICE_COOKIE = "reader_device";
const SHARE_DAYS = 30;
const SHARE_MAX = 5;
const SHARE_EXPLAIN_LIMIT = 20;
// Guests (the /demo) get their own cookie.
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
// No limits for signed-in readers (Max, 2026-10-22: «якщо будуть аб'юзери, ну тоді виключу»), only a
// fuse a person reading never reaches, against a script; the owner has none.
const ACCOUNT_DAILY_CAP = Number(process.env.ACCOUNT_EXPLAIN_CAP) || 300;

if (!SECRET) {
  console.error("READER_SECRET must be set (see .env.example)");
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
const USER_DEFAULTS = { autoExplain: true, pageTaps: false, deskScroll: false, font: "literata", margins: "normal", pdfMode: "reflow", fontSizes: {}, theme: "auto", explainStyle: "default", customStyle: "", lastBook: null, positions: {} };
const SHARED_KEYS = new Set(Object.keys(SHARED_DEFAULTS));
const USER_KEYS = new Set(Object.keys(USER_DEFAULTS));

// state.users and state.libs are keyed by account id; state.accounts[id] = { name, username, since, seen, off }.
// state.shared holds the model settings and, being the owner's from before accounts, his library's
// bookMeta and added; other libraries keep theirs in state.libs[id].
let state = { shared: {}, users: {}, guestUsage: {} };
try {
  state = { shared: {}, users: {}, guestUsage: {}, ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) };
} catch {
  /* first start */
}
state.accounts ??= {};
state.libs ??= {};
state.shares ??= {}; // token -> { acct, book, for, created, expires, device, off, opened, usage: { day, n }, reader: { positions, … } }

// 2026-10-22: from names under one family password to accounts. The names were tests (Max), except his
// own, which becomes the owner's account; the rest stay in state.legacyUsers, unused.
if (!state.accountsSince) {
  const legacy = state.users || {};
  state.legacyUsers = legacy;
  state.users = legacy[OWNER_LEGACY_NAME] ? { [OWNER_ID]: legacy[OWNER_LEGACY_NAME] } : {};
  for (const a of Object.values(state.shared.added || {})) if (a.by === OWNER_LEGACY_NAME) a.by = OWNER_ID;
  for (const d of Object.values(state.stats?.days || {})) {
    if (d.users?.[OWNER_LEGACY_NAME]) (d.users[OWNER_ID] = (d.users[OWNER_ID] || 0) + d.users[OWNER_LEGACY_NAME]), delete d.users[OWNER_LEGACY_NAME];
  }
  state.accountsSince = new Date().toISOString();
}

// 2026-10-16: the theme now follows the phone's light/dark setting by default. Everyone who had
// picked light or dark (the only ways to get dark before) moves to it once; sepia stays.
if (!state.themeAuto) {
  for (const u of Object.values(state.users)) if (u.theme === "light" || u.theme === "dark") u.theme = "auto";
  state.themeAuto = true;
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
  const { notes, ...u } = req.guest ? guestState(req.guest) : userState(req.acct);
  const demo = req.guest ? guestBooks(req) : null;
  return {
    ...SHARED_DEFAULTS,
    ...state.shared,
    ...USER_DEFAULTS,
    ...u,
    positions: u.positions || {},
    user: req.user,
    owner: !!req.owner,
    hasApiKey: !!process.env.ANTHROPIC_API_KEY,
    apiKeyFromEnv: true,
    web: true,
    guest: !!req.guest,
    demoBook: state.shared.demoBook || "",
    demoDefault: demoBooks(true)[0]?.name || "",
    ...(req.guest
      ? { lastBook: u.lastBook || demo[0]?.name || null, guestLimit: req.share ? { used: shareUsage(req.share).n, limit: SHARE_EXPLAIN_LIMIT } : { used: guestUsage().guests[req.guest] || 0, limit: GUEST_LIMIT } }
      : {}),
    ...(req.share ? { share: { from: accountName(req.share.acct), until: req.share.expires } } : {}),
  };
}

// ---------- Guests: a demo session that lives in memory and sees only the demo book ----------

const guests = new Map(); // guest id -> { positions, lastBook, ...settings }
const GUEST_MAX = 5000;

function guestState(id) {
  // Someone reading by a link keeps their place on the server, with the link.
  if (id.startsWith("share:")) return (state.shares[id.slice(6)].reader ??= { positions: {} });
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
  else d.users[req.acct] = (d.users[req.acct] || 0) + 1;
  // What each account costs, for /admin: dollars at list prices, as the day's model rows count them.
  if (!req.guest) {
    const c = cost(model || "?", { input: usage?.input_tokens || 0, output: usage?.output_tokens || 0, cacheRead: usage?.cache_read_input_tokens || 0, cacheWrite: usage?.cache_creation_input_tokens || 0 });
    if (c != null) (d.userCost ??= {})[req.acct] = (d.userCost[req.acct] || 0) + c;
  }
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
  const sumUser = (id, from) => dayKeys.filter((k) => !from || k >= from).reduce((a, k) => a + (stats.days[k].users[id] || 0), 0);
  const sumAll = (from) => dayKeys.filter((k) => !from || k >= from).reduce((a, k) => a + stats.days[k].explains, 0);

  const monthAgo = statsDay(Date.now() - 30 * 86400000);
  const costOf = (id) => dayKeys.filter((k) => k >= monthAgo).reduce((a, k) => a + (stats.days[k].userCost?.[id] || 0), 0);
  const ids = [...new Set([...Object.keys(state.users), ...Object.keys(state.accounts)])].filter((id) => ACCOUNT_ID.test(id));
  const users = ids
    .map((id) => [id, state.users[id] || {}])
    .map(([id, u]) => {
      const lastSeen = Math.max(0, state.accounts[id]?.seen || 0, ...Object.values(u.opened || {}));
      const started = new Set(Object.keys(u.positions || {}).map((p) => p.replace(/#reflow$/, ""))).size;
      return { id, name: accountName(id), username: state.accounts[id]?.username || "", off: !!state.accounts[id]?.off, owner: id === OWNER_ID, cost30: costOf(id), books: countBooks(id), today: sumUser(id, today), week: sumUser(id, weekAgo), total: sumUser(id), started, lastSeen, lastBook: u.lastBook, activeWeek: lastSeen > Date.now() - 7 * 86400000 };
    })
    .sort((a, b) => b.lastSeen - a.lastSeen);

  const library = await scanLibrary(OWNER_LIB);
  const books = library
    .map((b) => {
      const name = path.relative(BOOKS_DIR, b.path);
      const u = state.users[OWNER_ID] || {};
      const readers = u.positions?.[name] || u.positions?.[`${name}#reflow`] ? 1 : 0;
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
    accountCap: ACCOUNT_DAILY_CAP,
    wishes: wishStats(library),
  };
}

// How many books an account has, without reading them (the admin page lists every account).
function countBooks(id) {
  try {
    return fs.readdirSync(id === OWNER_ID ? BOOKS_DIR : path.join(ACCOUNTS_DIR, id, "books")).filter((n) => BOOK_EXT.test(n)).length;
  } catch {
    return 0;
  }
}

// «Хочу прочитати» across the readers: one row per wanted title, who wants it and whether it is in the library yet.
// Titles match loosely, the same way the home screen decides «Уже є» (home.js).
const normTitle = (s) => String(s || "").toLowerCase().replace(/[«»"'’ʼ.,:;!?()—–-]/g, " ").replace(/\s+/g, " ").trim();
const sameTitle = (a, b) => {
  const x = normTitle(a);
  const y = normTitle(b);
  return x.length > 2 && y.length > 2 && (x === y || x.includes(y) || y.includes(x));
};

function wishStats(library) {
  const rows = [];
  for (const [id, u] of Object.entries(state.users)) {
    const name = accountName(id);
    for (const w of u.wish || []) {
      let row = rows.find((r) => sameTitle(r.title, w.title));
      if (!row) {
        const book = id === OWNER_ID && library.find((b) => sameTitle(b.title, w.title));
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

// What a guest may open: the book of their link, or the demo.
function guestBooks(req) {
  if (req.share) return [{ dir: libOf(req.share.acct).dir, name: req.share.book }];
  return demoBooks();
}

// [{ dir, name }] of the books a guest may open. builtInOnly skips the library choice.
function demoBooks(builtInOnly) {
  const chosen = state.shared.demoBook;
  if (!builtInOnly && chosen && fs.existsSync(path.join(BOOKS_DIR, chosen))) return [{ dir: BOOKS_DIR, name: chosen }];
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

// ---------- Auth: the web site's account, its id in a signed cookie ----------

const sign = (value) => crypto.createHmac("sha256", SECRET).update(value).digest("base64url");

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// The signed-in account's id, or null. Max's cookie from the family password still counts as his account,
// so his phone and the app stay signed in through the change.
function currentAccount(req) {
  const cookies = parseCookies(req);
  const raw = cookies[COOKIE];
  const i = raw ? raw.lastIndexOf(".") : -1;
  if (i < 0) return cookies[OLD_COOKIE] && cookies[OLD_COOKIE] === `${OWNER_LEGACY_NAME}.${sign(OWNER_LEGACY_NAME)}` ? OWNER_ID : null;
  const id = raw.slice(0, i);
  const sig = raw.slice(i + 1);
  const expected = sign(`acct:${id}`);
  if (!ACCOUNT_ID.test(id) || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return id;
}

const accountName = (id) => state.accounts[id]?.name || (id === OWNER_ID ? OWNER_LEGACY_NAME : "Читач");

function cookieHeader(req, cookie, value, days) {
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  return `${cookie}=${encodeURIComponent(value)}; Path=/; Max-Age=${days * 86400}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

function setLoginCookie(req, res, id) {
  // Signing in ends any guest session on this device, and the family password's old cookie.
  res.setHeader("Set-Cookie", [cookieHeader(req, COOKIE, `${id}.${sign(`acct:${id}`)}`, COOKIE_DAYS), cookieHeader(req, GUEST_COOKIE, "", 0), cookieHeader(req, OLD_COOKIE, "", 0)]);
}

// Trades the site's one-time ticket for the account: { id, name, username }.
async function redeemTicket(ticket) {
  const res = await fetch(`${WEB_URL}/api/reader-ticket`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticket }), signal: AbortSignal.timeout(10000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`reader-ticket ${res.status}`);
  const who = await res.json();
  return ACCOUNT_ID.test(String(who?.id)) ? who : null;
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

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function loginPage(req, error) {
  const signIn = `${WEB_URL}/reader-login?back=${encodeURIComponent(`${req.protocol}://${req.get("host")}`)}`;
  return `<!doctype html>
<html lang="uk"><head><meta charset="utf-8"><title>Chytai</title>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<link rel="icon" href="/icon.png"><link rel="apple-touch-icon" href="/icon.png">
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; background: #f6efe0; color: #3b2f1e; }
  @media (prefers-color-scheme: dark) { body { background: #1e1e20; color: #e6e6e6; } input { background: #2a2a2d; color: inherit; } }
  form { box-sizing: border-box; width: min(360px, 90vw); padding: 28px 24px; border-radius: 16px; background: rgba(255,255,255,0.5); box-shadow: 0 8px 30px rgba(0,0,0,0.12); }
  @media (prefers-color-scheme: dark) { form { background: #2a2a2d; } }
  h1 { margin: 0 0 4px; font-size: 22px; } p { margin: 0 0 18px; opacity: 0.7; }
  label { display: block; margin-bottom: 14px; font-weight: 500; }
  .btn { display: block; box-sizing: border-box; width: 100%; padding: 11px; font: inherit; font-weight: 600; text-align: center; text-decoration: none; color: #fff; background: #b7791f; border: none; border-radius: 8px; }
  .err { color: #c0392b; margin-bottom: 12px; }
  .demo { margin: 18px 0 0; text-align: center; font-size: 14px; }
  .demo a { color: #b7791f; font-weight: 600; }
</style></head>
<body><form onsubmit="return false">
  <h1>Chytai</h1><p>Читалка з поясненнями від Claude</p>
  ${error ? `<div class="err">${esc(error)}</div>` : ""}
  <a class="btn" href="${esc(signIn)}">Увійти</a>
  ${GUEST_ENABLED && demoBooks().length ? `<p class="demo">Або <a href="/demo">подивитися демо</a> з однією книжкою.</p>` : ""}
</form></body></html>`;
}

// The first thing someone not signed in sees (Max, 2026-10-22): what the reader is, then «Увійти».
// The words are Max's; he writes the copy himself.
function landingPage(req) {
  const signIn = `${WEB_URL}/reader-login?back=${encodeURIComponent(`${req.protocol}://${req.get("host")}`)}`;
  const demo = GUEST_ENABLED && demoBooks().length;
  return `<!doctype html>
<html lang="uk"><head><meta charset="utf-8"><title>Chytai · читалка</title>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="Читалка з AI-explainer. Спроба пере-придумати зручний інтерфейс для читання онлайн.">
<link rel="icon" href="/icon.png"><link rel="apple-touch-icon" href="/icon.png">
<style>
  :root { color-scheme: light dark; --bg: #f6efe0; --fg: #3b2f1e; --muted: rgba(59,47,30,0.65); --accent: #b7791f; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1e1e20; --fg: #e6e6e6; --muted: rgba(230,230,230,0.65); } }
  * { box-sizing: border-box; }
  body { margin: 0; font: 17px/1.55 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; background: var(--bg); color: var(--fg); }
  .wrap { max-width: 980px; margin: 0 auto; padding: 0 20px; }
  header { display: flex; align-items: center; gap: 10px; padding: 18px 0; }
  header img { width: 34px; height: 34px; border-radius: 8px; }
  header b { font-size: 20px; } header a.in { margin-left: auto; color: var(--accent); font-weight: 600; text-decoration: none; }
  .hero { padding: 30px 0 8px; max-width: 640px; }
  .wip { display: inline-block; margin: 0 0 14px; padding: 3px 10px; border: 1px solid var(--accent); border-radius: 999px; color: var(--accent); font-size: 13px; font-weight: 600; }
  h1 { font-size: 40px; line-height: 1.15; margin: 0 0 14px; letter-spacing: -0.01em; }
  .lead { font-size: 19px; color: var(--muted); margin: 0 0 26px; }
  .acts { padding: 0 0 30px; display: flex; flex-wrap: wrap; gap: 12px 18px; align-items: center; }
  .btn { display: inline-block; padding: 13px 28px; font-weight: 600; text-decoration: none; color: #fff; background: var(--accent); border-radius: 10px; }
  .acts a.demo { color: var(--accent); font-weight: 600; }
  .shots { position: relative; padding: 0 0 30px; }
  .desk { margin-right: 120px; border-radius: 10px; overflow: hidden; box-shadow: 0 20px 50px rgba(0,0,0,0.18); border: 1px solid rgba(0,0,0,0.12); background: #fff; }
  .desk i { display: block; height: 26px; background: #e9e6df; border-bottom: 1px solid rgba(0,0,0,0.08); }
  .phone { position: absolute; right: 0; bottom: 20px; width: 230px; border-radius: 30px; overflow: hidden; box-shadow: 0 20px 50px rgba(0,0,0,0.25); border: 8px solid #1d1d1f; }
  .shots img { display: block; width: 100%; }
  footer { padding: 24px 0 40px; color: var(--muted); font-size: 14px; } footer a { color: inherit; }
  @media (max-width: 760px) {
    .hero { padding-top: 10px; }
    .desk { display: none; }
    .phone { position: static; margin: 0 auto; width: min(300px, 100%); }
    h1 { font-size: 30px; }
  }
</style></head>
<body><div class="wrap">
  <header><img src="/icon.png" alt=""><b>Chytai</b><a class="in" href="${esc(signIn)}">Увійти</a></header>
  <section class="hero">
    <div>
      <span class="wip">Work-in-progress</span>
      <h1>Читалка з AI-explainer</h1>
      <p class="lead">Спроба пере-придумати зручний інтерфейс для читання онлайн.</p>
    </div>
  </section>
  <section class="shots">
    <div class="desk"><i></i><img src="/landing-desk.jpg" alt="Читалка Chytai на комп'ютері: пояснення виділеного речення"></div>
    <div class="phone"><img src="/landing-phone.jpg" alt="Читалка Chytai на телефоні: пояснення виділеного рядка"></div>
  </section>
  <div class="acts"><a class="btn" href="${esc(signIn)}">Увійти</a>${demo ? `<a class="demo" href="/demo">Подивитися демо</a>` : ""}</div>
  <footer>Частина <a href="https://chytai.org.ua">chytai.org.ua</a></footer>
</div></body></html>`;
}

// ---------- App ----------

const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");

// The reader's address is app.chytai.org.ua (2026-10-22; read.chytai.org.ua for its first hour). Browsers
// on chytai.fly.dev and read. go there; the iPhone app (ChytaiApp in its user agent) stays on
// chytai.fly.dev until it is rebuilt, as does /sw.js, so a service worker installed there can still update itself.
const READER_DOMAIN = process.env.READER_DOMAIN ?? "app.chytai.org.ua";
app.use((req, res, next) => {
  const old = req.hostname === "read.chytai.org.ua" || (req.hostname.endsWith(".fly.dev") && !/ChytaiApp/.test(req.get("user-agent") || ""));
  if (READER_DOMAIN && req.method === "GET" && old && !req.path.startsWith("/api/") && req.path !== "/sw.js") {
    return res.redirect(302, `https://${READER_DOMAIN}${req.originalUrl}`);
  }
  next();
});

// Public: icon and manifest, so the phone can show them before login.
app.get("/icon.png", (_req, res) => res.sendFile(path.join(ROOT, "build", "icon.png")));
for (const f of ["landing-desk.jpg", "landing-phone.jpg"]) app.get(`/${f}`, (_req, res) => res.sendFile(path.join(ROOT, "build", f), { maxAge: "7d" }));
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

// Where to go after signing in (a book from «Читати» on the site), kept in a cookie for the round trip.
const NEXT_COOKIE = "reader_next";
const safeNext = (v) => (/^\/(?!\/)/.test(String(v || "")) ? String(v).slice(0, 500) : "");
app.get("/login", (req, res) => {
  if (currentAccount(req)) return res.redirect(safeNext(req.query.next) || "/");
  if (safeNext(req.query.next)) res.setHeader("Set-Cookie", cookieHeader(req, NEXT_COOKIE, safeNext(req.query.next), 1 / 96));
  res.type("html").send(landingPage(req));
});
// Back from the site with a ticket (web/server.js /reader-login).
app.get("/auth", async (req, res) => {
  const ticket = String(req.query.ticket || "");
  if (!/^[a-f0-9]{32}$/.test(ticket)) return res.redirect("/login");
  let who;
  try {
    who = await redeemTicket(ticket);
  } catch (err) {
    console.error("sign-in:", err.message);
    return res.status(502).type("html").send(loginPage(req, "Сайт chytai.org.ua зараз не відповідає. Спробуйте ще раз за хвилину."));
  }
  if (!who) return res.status(401).type("html").send(loginPage(req, "Посилання для входу застаріло. Натисніть «Увійти» ще раз."));
  const a = (state.accounts[who.id] ??= { since: Date.now() });
  Object.assign(a, { name: String(who.name || "").slice(0, 60), username: String(who.username || "").slice(0, 30), seen: Date.now() });
  if (/^[a-f0-9]{64}$/.test(String(who.key || ""))) a.key = who.key;
  saveState();
  tellSite(who.id);
  console.log(`reader sign-in @${a.username}`);
  setLoginCookie(req, res, who.id);
  const next = safeNext(parseCookies(req)[NEXT_COOKIE]);
  if (next) res.append("Set-Cookie", cookieHeader(req, NEXT_COOKIE, "", 0));
  res.redirect(next || "/");
});
app.post("/logout", (req, res) => {
  res.setHeader("Set-Cookie", [cookieHeader(req, COOKIE, "", 0), cookieHeader(req, GUEST_COOKIE, "", 0), cookieHeader(req, OLD_COOKIE, "", 0), cookieHeader(req, SHARE_COOKIE, "", 0)]);
  res.redirect("/login");
});

// /demo opens the reader as a guest: one demo book, no uploads, a daily cap on explanations.
app.get("/demo", (req, res) => {
  if (currentAccount(req)) return res.redirect("/");
  if (!GUEST_ENABLED || !demoBooks().length) return res.redirect("/login");
  if (!currentGuest(req)) startGuest(req, res);
  res.redirect("/");
});

// ---------- Links to one book ----------

const shareActive = (sh) => !!sh && !sh.off && sh.expires > Date.now() && fs.existsSync(path.join(libOf(sh.acct).dir, sh.book)) && !state.accounts[sh.acct]?.off;
function shareUsage(sh) {
  const day = statsDay();
  if (sh.usage?.day !== day) sh.usage = { day, n: 0 };
  return sh.usage;
}
function signedCookie(req, name, kind) {
  const raw = parseCookies(req)[name];
  const i = raw ? raw.lastIndexOf(".") : -1;
  if (i < 0) return null;
  const v = raw.slice(0, i);
  const sig = raw.slice(i + 1);
  const expected = sign(`${kind}:${v}`);
  return /^[\w-]{16,32}$/.test(v) && sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) ? v : null;
}
// The link this device reads by, while it still works here.
function currentShare(req) {
  const token = signedCookie(req, SHARE_COOKIE, "share");
  const sh = token && state.shares[token];
  if (!shareActive(sh) || sh.device !== signedCookie(req, DEVICE_COOKIE, "device")) return null;
  return Object.assign(sh, { token });
}
const sharePage = (req, title, text) => loginPage(req, `${title} ${text}`);

app.get("/s/:token", (req, res) => {
  const token = String(req.params.token);
  const sh = state.shares[token];
  if (!shareActive(sh)) return res.status(404).type("html").send(sharePage(req, "Посилання вже не діє.", "Попросіть того, хто його надіслав, зробити нове."));
  const acct = currentAccount(req);
  if (acct === sh.acct) return res.redirect(`/?open=${encodeURIComponent(sh.book)}`); // the owner trying their own link
  if (acct) return res.type("html").send(sharePage(req, "Ви вже в читалці під своїм акаунтом.", "Це посилання для когось без акаунта: відкрийте його на іншому пристрої або вийдіть."));
  let device = signedCookie(req, DEVICE_COOKIE, "device");
  if (sh.device && sh.device !== device) return res.status(403).type("html").send(sharePage(req, "Це посилання вже відкрили на іншому пристрої.", "Попросіть нове посилання для цього пристрою."));
  const cookies = [];
  if (!device) {
    device = crypto.randomBytes(12).toString("base64url");
    cookies.push(cookieHeader(req, DEVICE_COOKIE, `${device}.${sign(`device:${device}`)}`, 400));
  }
  if (!sh.device) Object.assign(sh, { device, opened: Date.now() }), saveState();
  cookies.push(cookieHeader(req, SHARE_COOKIE, `${token}.${sign(`share:${token}`)}`, SHARE_DAYS), cookieHeader(req, GUEST_COOKIE, "", 0));
  res.setHeader("Set-Cookie", cookies);
  res.redirect("/");
});

app.use((req, res, next) => {
  const acct = currentAccount(req);
  const share = acct ? null : currentShare(req);
  const guest = acct ? null : share ? `share:${share.token}` : currentGuest(req);
  if (!acct && !guest) {
    if (req.path.startsWith("/api/")) return res.status(401).json({ error: "login" });
    return res.redirect(req.originalUrl === "/" ? "/login" : `/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
  // Max can switch the reader off for one account (/admin); the site stays theirs.
  if (acct && state.accounts[acct]?.off) {
    if (req.path.startsWith("/api/")) return res.status(403).json({ error: "Читалку для цього акаунта вимкнено." });
    return res.status(403).type("html").send(loginPage(req, "Читалку для цього акаунта вимкнено. Якщо це помилка, напишіть Максові."));
  }
  req.acct = acct || null;
  req.owner = acct === OWNER_ID;
  req.user = acct ? accountName(acct) : "Гість";
  req.guest = guest;
  req.share = share;
  req.lib = acct ? libOf(acct) : null;
  next();
});

const guestsCannot = (message) => (req, res, next) => (req.guest ? res.status(403).json({ error: message }) : next());
const ownerOnly = (req, res, next) => (req.owner ? next() : res.status(403).json({ error: "Це може лише Макс." }));

// The dashboard is the owner's.
app.get("/admin", async (req, res, next) => {
  if (!req.owner) return res.redirect("/");
  try {
    res.type("html").send(adminPage(await collectStats()));
  } catch (err) {
    next(err);
  }
});

// Switch the reader off (or on again) for one account: POST /admin/off { id, off: "1" | "" }.
app.post("/admin/off", express.urlencoded({ extended: false }), (req, res) => {
  if (!req.owner) return res.redirect("/");
  const id = String(req.body.id || "");
  if (ACCOUNT_ID.test(id) && id !== OWNER_ID) {
    const a = (state.accounts[id] ??= {});
    if (req.body.off) a.off = Date.now();
    else delete a.off;
    saveState();
  }
  res.redirect("/admin#readers");
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

api.get("/admin", ownerOnly, async (req, res, next) => {
  try {
    res.json(await collectStats());
  } catch (err) {
    next(err);
  }
});

api.patch("/settings", (req, res) => {
  const u = req.guest ? guestState(req.guest) : userState(req.acct);
  for (const [k, v] of Object.entries(req.body || {})) {
    if (k === "demoBook") {
      // The owner picks which of his books the demo shows; "" goes back to the built-in one.
      if (req.owner) state.shared.demoBook = safeBookName(v) || "";
    } else if (SHARED_KEYS.has(k)) {
      if (req.owner) state.shared[k] = v;
    } else if (k === "customStyle") u[k] = String(v ?? "").slice(0, 1500);
    else if (USER_KEYS.has(k) && k !== "positions") u[k] = v;
  }
  if (!req.guest || req.share) saveState();
  res.json(settingsFor(req));
});

api.put("/position", (req, res) => {
  const { path: bookPath, cfi, pct, chapter } = req.body || {};
  if (typeof bookPath !== "string" || typeof cfi !== "string") return res.status(400).json({ error: "bad request" });
  const u = req.guest ? guestState(req.guest) : userState(req.acct);
  const name = bookPath.replace(/#reflow$/, "");
  u.positions ??= {};
  u.positions[bookPath] = cfi;
  (u.opened ??= {})[name] = Date.now();
  if (u.setAside) delete u.setAside[name];
  // How far in and which chapter, for the home screen: the position itself is a CFI it cannot read.
  if (Number.isFinite(pct)) {
    (u.progress ??= {})[name] = { pct: Math.max(0, Math.min(100, Math.round(pct))), chapter: typeof chapter === "string" ? chapter.slice(0, 200) : "" };
  }
  if (!req.guest || req.share) saveState();
  res.json({ ok: true });
});

// ---------- Notes: passages a reader saved with "В нотатки", per person and per book ----------

const NOTE_TEXT_MAX = 4000;

function notesOf(req, bookPath) {
  const u = req.guest ? guestState(req.guest) : userState(req.acct);
  u.notes ??= {};
  return { u, list: (u.notes[bookPath] ??= []) };
}

api.get("/notes", (req, res) => {
  const bookPath = String(req.query.path || "");
  const u = req.guest ? guestState(req.guest) : userState(req.acct);
  res.json({ notes: u.notes?.[bookPath] || [] });
});

// Every note of this reader, for the home screen's Нотатки: { "<book>": [note, …] }.
api.get("/notes/all", (req, res) => {
  const u = req.guest ? guestState(req.guest) : userState(req.acct);
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
  if (!req.guest || req.share) saveState();
  res.json({ note });
});

api.patch("/notes/:id", (req, res) => {
  const { list } = notesOf(req, String(req.query.path || ""));
  const note = list.find((n) => n.id === req.params.id);
  if (!note) return res.status(404).json({ error: "Нотатки немає." });
  if (typeof req.body?.comment === "string") note.comment = req.body.comment.slice(0, NOTE_TEXT_MAX);
  if (!req.guest || req.share) saveState();
  res.json({ note });
});

api.delete("/notes/:id", (req, res) => {
  const bookPath = String(req.query.path || "");
  const { u, list } = notesOf(req, bookPath);
  u.notes[bookPath] = list.filter((n) => n.id !== req.params.id);
  if (!u.notes[bookPath].length) delete u.notes[bookPath];
  if (!req.guest || req.share) saveState();
  res.json({ ok: true });
});

// An account deleted on the site takes its books, notes and positions with it (the site's privacy page
// promises that). Once a day the reader asks the site which of its accounts are gone. If the site says
// most of them are, something is wrong there, and nothing is deleted.
async function dropDeletedAccounts() {
  const ids = Object.keys(state.accounts).filter((id) => id !== OWNER_ID && ACCOUNT_ID.test(id));
  if (!ids.length) return;
  try {
    const res = await fetch(`${WEB_URL}/api/readers-gone`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }), signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`readers-gone ${res.status}`);
    const gone = ((await res.json()).gone || []).filter((id) => ids.includes(id));
    if (gone.length > 2 && gone.length > ids.length / 2) return console.error(`readers-gone: ${gone.length} of ${ids.length} accounts gone, not deleting`);
    for (const id of gone) {
      fs.rmSync(path.join(ACCOUNTS_DIR, id), { recursive: true, force: true });
      delete state.accounts[id];
      delete state.users[id];
      delete state.libs[id];
      for (const [t, sh] of Object.entries(state.shares)) if (sh.acct === id) delete state.shares[t];
      libs.delete(id);
      console.log(`account ${id} deleted on the site: its reader data is gone too`);
    }
    if (gone.length) saveState();
  } catch (err) {
    console.error("readers-gone:", err.message);
  }
}
setTimeout(dropDeletedAccounts, 60 * 1000).unref();
setInterval(dropDeletedAccounts, 24 * 3600 * 1000).unref();

// The site shows «Читати» on a book's page when the reader has its file here, so it gets each library's
// titles and authors (never the files) after every change, with the account's key from signing in.
const tellTimers = new Map();
function tellSite(id) {
  if (!state.accounts[id]?.key) return;
  clearTimeout(tellTimers.get(id));
  tellTimers.set(id, setTimeout(async () => {
    tellTimers.delete(id);
    try {
      const books = (await scanLibrary(libOf(id))).map((b) => ({ name: path.basename(b.path), title: b.title || "", authors: b.authors || [] }));
      const res = await fetch(`${WEB_URL}/api/reader-library`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, key: state.accounts[id].key, books }), signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`reader-library ${res.status}`);
    } catch (err) {
      console.error(`reader-library ${id}:`, err.message);
    }
  }, 2000));
}

// ---------- Libraries: one per account, private to it ----------

// Where an account's books, PDF conversions and hand-set covers live, and its library's state
// (bookMeta: corrected titles, added: when each book came). The owner's is the one from before accounts.
const libs = new Map();
function libOf(id) {
  let lib = libs.get(id);
  if (lib) return lib;
  if (id === OWNER_ID) {
    lib = { id, dir: BOOKS_DIR, reflow: REFLOW_DIR, covers: path.join(DATA_DIR, "covers", "custom"), cache: path.join(DATA_DIR, "library-cache.json"), meta: state.shared };
  } else {
    const root = path.join(ACCOUNTS_DIR, id);
    lib = { id, dir: path.join(root, "books"), reflow: path.join(root, "reflow"), covers: path.join(root, "covers"), cache: path.join(root, "library-cache.json"), meta: (state.libs[id] ??= {}) };
  }
  for (const dir of [lib.dir, lib.reflow]) fs.mkdirSync(dir, { recursive: true });
  libs.set(id, lib);
  return lib;
}
const OWNER_LIB = libOf(OWNER_ID);

// Book names are the file names inside a library's folder; a name is never allowed to escape it.
function safeBookName(name) {
  const base = path.basename(String(name || "")).normalize("NFC");
  if (!base || base.startsWith(".") || !BOOK_EXT.test(base)) return null;
  return base;
}
const bookFile = (lib, name) => path.join(lib.dir, name);

// A reader can correct a book's title and author in the library; the file and its metadata stay as
// they are, the correction lives in the library's bookMeta[name] = { title, authors }.
async function scanLibrary(lib) {
  const books = await library.scan([lib.dir], lib.cache);
  const meta = lib.meta.bookMeta || {};
  return books.map((b) => {
    const m = meta[path.relative(lib.dir, b.path)];
    return m ? { ...b, title: m.title || b.title, authors: m.authors?.length ? m.authors : b.authors, edited: true } : b;
  });
}

api.get("/library", async (req, res) => {
  const u = req.guest ? guestState(req.guest) : userState(req.acct);
  let books;
  if (req.guest) {
    const demo = guestBooks(req);
    const allowed = new Set(demo.map((d) => path.join(d.dir, d.name)));
    const scanned = await library.scan([...new Set(demo.map((d) => d.dir))], req.share ? libOf(req.share.acct).cache : path.join(DATA_DIR, "demo-cache.json"));
    books = scanned.filter((b) => allowed.has(b.path)).map((b) => ({ ...b, dir: path.dirname(b.path) }));
  } else {
    books = (await scanLibrary(req.lib)).map((b) => ({ ...b, dir: req.lib.dir }));
  }
  const positions = u.positions || {};
  const added = req.guest ? {} : req.lib.meta.added || {};
  const coverDir = req.guest ? null : req.lib.covers;
  const customs = new Map(coverDir && fs.existsSync(coverDir) ? fs.readdirSync(coverDir).map((f) => [f.split(".")[0], f]) : []);
  // Who added a book, as the library shows it: an account id since accounts, a name before.
  const who = (by) => (!by ? "" : by === req.acct ? req.user : state.accounts[by]?.name || (ACCOUNT_ID.test(by) ? accountName(by) : by));
  const list = books.map((b) => {
    const name = path.relative(b.dir, b.path);
    // «Прибрати з читання» hides the book from what you are reading until you open it again; the place is kept.
    const aside = !!u.setAside?.[name];
    const openedAt = aside ? 0 : u.opened?.[name] || 0;
    const progress = aside ? null : u.progress?.[name];
    const custom = customs.get(customCoverKey(name));
    return {
      ...b, dir: undefined, path: name, cloud: false, openedAt, aside,
      started: !aside && !!(positions[name] || positions[`${name}#reflow`]),
      pct: progress ? progress.pct : null,
      chapter: progress?.chapter || "",
      // Who put the book in the library and when; books from before this was recorded have only the file's date.
      addedAt: added[name]?.at || b.mtime || 0,
      addedBy: who(added[name]?.by),
      // When a cover was set by hand, so the cover's address changes with it.
      coverAt: custom ? Math.round(fs.statSync(path.join(coverDir, custom)).mtimeMs) : 0,
      seen: !!(openedAt || aside || u.seen?.[name]) || (!!req.acct && added[name]?.by === req.acct),
    };
  });
  res.json({ folders: [], books: list, lastBook: u.lastBook || (req.guest ? guestBooks(req)[0]?.name : null) || null });
});

api.get("/book", (req, res) => {
  const name = safeBookName(req.query.path);
  const demo = req.guest ? guestBooks(req).find((d) => d.name === name) : null;
  const file = req.guest ? demo && path.join(demo.dir, demo.name) : name && bookFile(req.lib, name);
  if (!file || !fs.existsSync(file)) return res.status(404).json({ error: "Книжки немає на сервері." });
  const u = req.guest ? guestState(req.guest) : userState(req.acct);
  u.lastBook = name;
  (u.opened ??= {})[name] = Date.now();
  if (u.setAside) delete u.setAside[name];
  if (!req.guest || req.share) saveState();
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

// The cached cover's file name in COVER_DIR ("<key>.none" when the book has no cover), extracting it once.
async function coverFile(file) {
  const st = fs.statSync(file);
  const key = crypto.createHash("sha1").update(`${file}:${st.size}:${st.mtimeMs}`).digest("hex").slice(0, 16);
  fs.mkdirSync(COVER_DIR, { recursive: true });
  let cached = fs.readdirSync(COVER_DIR).find((f) => f.startsWith(`${key}.`));
  if (!cached) {
    const cover = await epubCover(file);
    cached = `${key}.${cover ? cover.ext : "none"}`;
    fs.writeFileSync(path.join(COVER_DIR, cached), cover ? cover.data : "");
  }
  return cached;
}

// Covers are taken out of the books ahead of time (at start and on upload), so nobody waits for the first one.
async function warmCovers(lib, names) {
  for (const name of names) {
    try {
      if (/\.epub$/i.test(name)) await coverFile(bookFile(lib, name));
    } catch (err) {
      console.warn("cover", name, err.message);
    }
  }
}

// A cover set by hand for a book in a library (PDFs have none of their own), kept by the book's name.
const customCoverKey = (name) => crypto.createHash("sha1").update(name).digest("hex").slice(0, 16);
function customCover(lib, name) {
  if (!name || !fs.existsSync(lib.covers)) return null;
  const key = customCoverKey(name);
  const file = fs.readdirSync(lib.covers).find((f) => f.startsWith(`${key}.`));
  return file ? path.join(lib.covers, file) : null;
}

api.get("/cover", async (req, res) => {
  const name = safeBookName(req.query.path);
  const demo = req.guest ? guestBooks(req).find((d) => d.name === name) : null;
  const file = req.guest ? demo && path.join(demo.dir, demo.name) : name && bookFile(req.lib, name);
  if (!file || !fs.existsSync(file)) return res.status(404).end();
  const custom = !req.guest && customCover(req.lib, name);
  if (custom) {
    res.setHeader("Cache-Control", "private, max-age=2592000, immutable");
    return res.type(COVER_TYPES[path.extname(custom).slice(1)]).sendFile(custom);
  }
  if (!/\.epub$/i.test(file)) return res.status(404).end();
  try {
    const cached = await coverFile(file);
    const ext = path.extname(cached).slice(1);
    if (ext === "none") return res.status(404).end();
    // The URL carries the file's date, so a replaced book gets a new address.
    res.setHeader("Cache-Control", "private, max-age=2592000, immutable");
    res.type(COVER_TYPES[ext]).sendFile(path.join(COVER_DIR, cached));
  } catch {
    res.status(404).end();
  }
});

// Set a book's cover by hand: PUT /api/cover?path=<book> with a JPEG, PNG or WebP image as the body.
api.put("/cover", guestsCannot("У демо-режимі не можна змінювати обкладинки."), express.raw({ type: () => true, limit: "5mb" }), (req, res) => {
  const name = safeBookName(req.query.path);
  if (!name || !fs.existsSync(bookFile(req.lib, name))) return res.status(404).json({ error: "Книжки немає на сервері." });
  const b = req.body;
  const ext = b?.length > 3 && b[0] === 0xff && b[1] === 0xd8 ? "jpg"
    : b?.length > 8 && b.subarray(1, 4).toString() === "PNG" ? "png"
    : b?.length > 12 && b.subarray(8, 12).toString() === "WEBP" ? "webp" : null;
  if (!ext) return res.status(400).json({ error: "Обкладинка має бути JPEG, PNG або WebP." });
  const key = customCoverKey(name);
  const dir = req.lib.covers;
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (f.startsWith(`${key}.`)) fs.unlinkSync(path.join(dir, f));
  fs.writeFileSync(path.join(dir, `${key}.${ext}`), b);
  res.json({ path: name, coverAt: Date.now() });
});

// Links to one book: GET /api/shares?path=<book>, POST /api/shares { path, for }, DELETE /api/shares/<token>.
const shareView = (req, token, sh) => ({ token, url: `${req.protocol}://${req.get("host")}/s/${token}`, for: sh.for, created: sh.created, expires: sh.expires, opened: sh.opened || 0, active: shareActive(sh) });
const mySharesOf = (req) => Object.entries(state.shares).filter(([, sh]) => sh.acct === req.acct);
api.get("/shares", guestsCannot("Гість не може ділитися книжками."), (req, res) => {
  const name = safeBookName(req.query.path);
  res.json({ shares: mySharesOf(req).filter(([, sh]) => sh.book === name && !sh.off && sh.expires > Date.now()).map(([t, sh]) => shareView(req, t, sh)), max: SHARE_MAX });
});
api.post("/shares", guestsCannot("Гість не може ділитися книжками."), (req, res) => {
  const name = safeBookName(req.body?.path);
  const who = clean(req.body?.for, 60);
  if (!name || !fs.existsSync(bookFile(req.lib, name))) return res.status(404).json({ error: "Книжки немає на сервері." });
  if (!who) return res.status(400).json({ error: "Напишіть, для кого посилання." });
  if (mySharesOf(req).filter(([, sh]) => shareActive(sh)).length >= SHARE_MAX) return res.status(400).json({ error: `Діючих посилань може бути до ${SHARE_MAX}. Вимкніть якесь старе.` });
  const token = crypto.randomBytes(12).toString("base64url");
  const sh = (state.shares[token] = { acct: req.acct, book: name, for: who, created: Date.now(), expires: Date.now() + SHARE_DAYS * 86400000, device: null });
  saveState();
  res.json({ share: shareView(req, token, sh) });
});
api.delete("/shares/:token", guestsCannot("Гість не може ділитися книжками."), (req, res) => {
  const sh = state.shares[req.params.token];
  if (!sh || sh.acct !== req.acct) return res.status(404).json({ error: "Немає такого посилання." });
  sh.off = Date.now();
  saveState();
  res.json({ ok: true });
});

// "Позначити переглянутими" on the new arrivals.
api.post("/library/seen", (req, res) => {
  const u = req.guest ? guestState(req.guest) : userState(req.acct);
  for (const p of Array.isArray(req.body?.paths) ? req.body.paths : []) {
    const name = safeBookName(p);
    if (name) (u.seen ??= {})[name] = Date.now();
  }
  if (!req.guest || req.share) saveState();
  res.json({ ok: true });
});

// «Прибрати з читання»: a book opened only to try it stops counting as one you read, for you alone.
api.post("/library/aside", (req, res) => {
  const u = req.guest ? guestState(req.guest) : userState(req.acct);
  const name = safeBookName(req.body?.path);
  if (!name) return res.status(400).json({ error: "bad request" });
  (u.setAside ??= {})[name] = Date.now();
  if (u.lastBook === name) u.lastBook = null;
  if (!req.guest || req.share) saveState();
  res.json({ ok: true });
});

// "Хочу прочитати": each reader's own list of books to get; the home screen shows when one arrives.
const clean = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
api.get("/wish", (req, res) => res.json({ wish: req.guest ? [] : userState(req.acct).wish || [] }));
api.post("/wish", guestsCannot("У демо-режимі список бажаного недоступний."), (req, res) => {
  const title = clean(req.body?.title, 300);
  if (!title) return res.status(400).json({ error: "Вкажіть назву." });
  const u = userState(req.acct);
  const item = { id: crypto.randomBytes(6).toString("hex"), title, author: clean(req.body?.author, 300), addedAt: Date.now() };
  u.wish = [item, ...(u.wish || [])].slice(0, 500);
  saveState();
  res.json({ item, wish: u.wish });
});
api.delete("/wish/:id", guestsCannot("У демо-режимі список бажаного недоступний."), (req, res) => {
  const u = userState(req.acct);
  u.wish = (u.wish || []).filter((w) => w.id !== req.params.id);
  saveState();
  res.json({ wish: u.wish });
});

// Guests read the demo book and nothing else: no uploads, no edits, no shared caches.
api.put("/books/:name", guestsCannot("У демо-режимі не можна додавати книжки. Увійдіть, щоб завантажити свою."));
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
  // Nor pornography (the family library was shared with a child; the rule stays for everyone).
  const check = await checkUpload(name, req.body);
  if (check.blocked) {
    console.log("upload refused", name, req.user, check.reason);
    return res.status(400).json({ error: "Схоже, це порнографія чи еротика, тому Chytai не додав книжку до бібліотеки. Якщо це помилка, напишіть Максові." });
  }
  fs.writeFileSync(bookFile(req.lib, name), req.body);
  (req.lib.meta.added ??= {})[name] = { by: req.acct, at: Date.now() };
  saveState();
  warmCovers(req.lib, [name]);
  tellSite(req.acct);
  res.json({ path: name });
});

// Title and author as the library should show them: PATCH /api/books/<name> { title, authors }.
// Empty values go back to what the file itself says.
api.patch("/books/:name", (req, res) => {
  const name = safeBookName(req.params.name);
  if (!name || !fs.existsSync(bookFile(req.lib, name))) return res.status(404).json({ error: "Книжки немає на сервері." });
  const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  const title = clean(req.body?.title);
  const raw = req.body?.authors;
  const authors = (Array.isArray(raw) ? raw : String(raw ?? "").split(/[,;]/)).map(clean).filter(Boolean).slice(0, 10);
  const meta = (req.lib.meta.bookMeta ??= {});
  if (title || authors.length) meta[name] = { title, authors };
  else delete meta[name];
  saveState();
  tellSite(req.acct);
  res.json({ path: name, title, authors, edited: !!meta[name] });
});

// Cache for PDFs converted to EPUB in the browser ("як книжка" mode), one per library.
function reflowFile(lib, name, version) {
  const st = fs.statSync(bookFile(lib, name));
  const key = crypto.createHash("sha1").update(`${name}:${st.size}:${st.mtimeMs}:v${version}`).digest("hex").slice(0, 16);
  return path.join(lib.reflow, `${key}-reflow.epub`);
}

api.get("/reflow", (req, res) => {
  const name = safeBookName(req.query.path);
  try {
    const file = reflowFile(req.lib, name, String(req.query.version || ""));
    if (!fs.existsSync(file)) return res.status(204).end();
    res.type("application/epub+zip").sendFile(file);
  } catch {
    res.status(404).end();
  }
});

api.put("/reflow", express.raw({ type: () => true, limit: MAX_UPLOAD }), (req, res) => {
  const name = safeBookName(req.query.path);
  try {
    fs.writeFileSync(reflowFile(req.lib, name, String(req.query.version || "")), req.body);
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
  if (!req.guest && !req.owner && (state.stats?.days?.[statsDay()]?.users?.[req.acct] || 0) >= ACCOUNT_DAILY_CAP) {
    send({ type: "error", message: "На сьогодні пояснень забагато, це схоже на автоматичні запити. Завтра все запрацює знову; якщо це помилка, напишіть Максові." });
    return res.end();
  }
  if (req.share) {
    const usage = shareUsage(req.share);
    if (usage.n >= SHARE_EXPLAIN_LIMIT) {
      send({ type: "error", message: `За цим посиланням можна ${SHARE_EXPLAIN_LIMIT} пояснень на день, на сьогодні вони закінчились. Книжку можна читати далі.` });
      return res.end();
    }
    usage.n++;
    saveState();
    trimGuestRequest(request);
  } else if (req.guest) {
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
  const me = { ...USER_DEFAULTS, ...(req.guest ? guestState(req.guest) : userState(req.acct)) };
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Chytai web on http://0.0.0.0:${PORT}, books in ${BOOKS_DIR}`);
  warmCovers(OWNER_LIB, fs.readdirSync(BOOKS_DIR));
});

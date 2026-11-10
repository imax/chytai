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
const { bookLanguage } = require("./language");
const { checkUpload } = require("./content");
const { cost } = require("./admin");
const { createProtected } = require("./protected");
const paper = require("./paper");
const storage = require("./storage");
const { searchReader } = require("./search");
const { landingPage: renderLanding } = require("./landing");

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
const FREE_COOKIE = "reader_free"; // the free-shelf book a guest reads without an account
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
// Free books (public domain, 2026-10-22), shipped in the repo under free/. Since 2026-10-24 they are
// «Вільна полиця», one copy every account sees (Max: «полиця яка видна в усіх акаунтах»); free/shelf.json
// gives each its title, authors and group. A book taken from the shelf (opened) shows with the reader's own
// books too. Reading needs an account (Max: «акаунт потрібен щоб читати»).
const FREE_DIR = path.join(ROOT, "free");
// Shelf books kept off the public repo, on the volume (DATA_DIR/free/<name>.epub); free/shelf.json still lists them.
// For books free here but still protected in the US, where GitHub is (Orwell, Max 2026-10-30).
const FREE_VOLUME_DIR = path.join(DATA_DIR, "free");
const FREE_CACHE = path.join(DATA_DIR, "free-cache.json");
const MAX_UPLOAD = "300mb"; // the owner's limit; readers have UPLOAD_MAX below
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

// Explanations on Opus, «Переклад» (translation only) on the cheaper model (Max, 2026-10-26).
const SHARED_DEFAULTS = { model: "claude-opus-5-5", translateModel: "claude-sonnet-5-5", language: "українська" };
const USER_DEFAULTS = { pageTaps: false, deskScroll: false, font: "literata", margins: "normal", spacing: "normal", column: "normal", pdfMode: "reflow", fontSizes: {}, theme: "auto", explainStyle: "default", customStyle: "", lastBook: null, positions: {} };
const SHARED_KEYS = new Set(Object.keys(SHARED_DEFAULTS));
const USER_KEYS = new Set(Object.keys(USER_DEFAULTS));

// state.users and state.libs are keyed by account id; state.accounts[id] = { name, username, since, seen, off }.
// state.shared holds the model settings and, being the owner's from before accounts, his library's
// bookMeta and added; other libraries keep theirs in state.libs[id].
// Since 2026-11-05 all of it lives in DATA_DIR/reader.db (server/db.js): the small part in memory, written row by
// row when it changes; notes, kept explanations and paper-book questions only in the database. The first start
// with it reads state.json once and moves everything over (at the end of this file, before listen).
const store = require("./db").open(DATA_DIR);
let state = { shared: {}, users: {}, guestUsage: {} };
if (store.migrated()) {
  state = { shared: {}, users: {}, guestUsage: {}, ...store.loadState() };
} else {
  try {
    state = { shared: {}, users: {}, guestUsage: {}, ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) };
  } catch {
    /* first start */
  }
}
state.accounts ??= {};
state.libs ??= {};
state.opds ??= {}; // token -> { acct, created, used, downloads }: the address of an account's OPDS catalog (server/opds.js)
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

// Writes what changed since the last save (server/db.js persist), a moment after the last change.
let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushState, 200);
}
function flushState() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!store.migrated()) return; // before the move from state.json nothing is written (migrateState writes it all)
  store.persist(state);
}
// A deploy stops the machine: what changed in the last moment is written first.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    try {
      flushState();
    } catch (err) {
      console.error("save on exit:", err.message);
    }
    process.exit(0);
  });
}

// Notes, kept explanations and paper-book questions (kind "notes" | "chats" | "paperChats") of whoever asks, per
// book: an account's in the database, a guest's (and a shared link's) in memory with the guest, as before.
function bookItems(req, kind, book) {
  if (req.guest) return guestState(req.guest)[kind]?.[book] || [];
  return store.items.list(req.acct, kind, book);
}
function saveBookItems(req, kind, book, list) {
  if (req.guest) {
    const u = guestState(req.guest);
    u[kind] ??= {};
    if (list.length) u[kind][book] = list;
    else delete u[kind][book];
    if (req.share) saveState();
    return;
  }
  store.items.save(req.acct, kind, book, list);
}
// One note or talk added or replaced by its id; at most `max` in the book, the oldest go.
function putBookItem(req, kind, book, item, max = 0) {
  if (!req.guest) return store.items.put(req.acct, kind, book, item, max);
  const list = [...bookItems(req, kind, book)];
  const i = list.findIndex((x) => x.id === item.id);
  if (i >= 0) list[i] = item;
  else list.push(item);
  if (max && list.length > max) list.splice(0, list.length - max);
  saveBookItems(req, kind, book, list);
}
function allBookItems(req, kind) {
  if (req.guest) return guestState(req.guest)[kind] || {};
  return store.items.books(req.acct, kind);
}

function userState(name) {
  state.users[name] ??= {};
  return state.users[name];
}

function settingsFor(req) {
  // Notes and kept explanations come by their own calls; they would make every settings answer heavy.
  const { notes, chats, paperChats, ...u } = req.guest ? guestState(req.guest) : userState(req.acct);
  const demo = req.guest ? guestBooks(req) : null;
  return {
    ...SHARED_DEFAULTS,
    ...state.shared,
    ...USER_DEFAULTS,
    ...u,
    positions: u.positions || {},
    user: req.user,
    username: (!req.guest && state.accounts[req.acct]?.username) || "",
    owner: !!req.owner,
    hasApiKey: !!process.env.ANTHROPIC_API_KEY,
    apiKeyFromEnv: true,
    web: true,
    guest: !!req.guest,
    demoBook: state.shared.demoBook || "",
    demoDefault: demoBooks(true)[0]?.name || "",
    ...(req.guest
      ? { lastBook: (demo.some((d) => d.name === u.lastBook) ? u.lastBook : demo[0]?.name) || null, guestLimit: req.share ? { used: shareUsage(req.share).n, limit: SHARE_EXPLAIN_LIMIT } : { used: guestUsage().guests[req.guest] || 0, limit: GUEST_LIMIT } }
      : {}),
    ...(req.share ? { share: { from: accountName(req.share.acct), until: req.share.expires } } : {}),
    // Printing those gives the current chapter, not the whole book (renderer.js, «Print»).
    freeBooks: freeShelf.map((f) => f.name),
    noFileBooks: freeShelf.filter((f) => !fileAllowed(f.name)).map((f) => f.name),
    // Publishers' books: no print, no copy beyond a quote (server/protected.js).
    protectedBooks: protectedNames(),
    ...(req.free ? { free: { signIn: `/login?go=1&next=${encodeURIComponent(`/free/${encodeURIComponent(req.free)}`)}`, download: fileAllowed(req.free) ? `/free-file/${encodeURIComponent(req.free)}` : "" } } : {}),
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
    return `Без входу доступно до ${GUEST_LIMIT} пояснень на день, і вони вже використані. Увійдіть, щоб читати без обмежень.`;
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
    request.context = { ...c, before: cut(c.before, true), selection: cut(c.selection), after: cut(c.after), page: c.page && cut(c.page), question: c.question && cut(c.question) };
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
  // And the whole day's, guests included, for the daily budget below.
  const c = cost(model || "?", { input: usage?.input_tokens || 0, output: usage?.output_tokens || 0, cacheRead: usage?.cache_read_input_tokens || 0, cacheWrite: usage?.cache_creation_input_tokens || 0 });
  if (c != null) {
    d.cost = (d.cost || 0) + c;
    if (!req.guest) (d.userCost ??= {})[req.acct] = (d.userCost[req.acct] || 0) + c;
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

// Daily budget for Claude (security review 2026-11-04, Max OK): sign-up is open, so a script with a few
// mailboxes could run explanations all night. Each account gets ACCOUNT_COST_CAP dollars a day (list prices),
// everyone together DAILY_COST_CAP; the owner is never stopped. When the whole day's budget runs out the owner
// gets one letter (through the site, signed with his reader key).
const DAILY_COST_CAP = Number(process.env.DAILY_COST_CAP) || 40;
const ACCOUNT_COST_CAP = Number(process.env.ACCOUNT_COST_CAP) || 5;
function aiBudgetDenied(req) {
  if (req.owner) return null;
  const day = statsDay();
  const d = state.stats?.days?.[day];
  if (!d) return null;
  if ((d.cost || 0) >= DAILY_COST_CAP) {
    if (d.capMailed !== day) {
      d.capMailed = day;
      saveState();
      alertOwner("Chytai: денний бюджет на Claude вичерпано", `За ${day} пояснення в Читалці коштували $${(d.cost || 0).toFixed(2)} (стеля $${DAILY_COST_CAP}). До кінця дня читачі пояснень не отримують, ти отримуєш. Хто скільки витратив: ${WEB_URL}/admin/reader. Стелю міняє DAILY_COST_CAP у секретах Fly (app chytai).`);
    }
    return "Пояснення на сьогодні тимчасово недоступні. Завтра все запрацює знову.";
  }
  if (!req.guest && (d.userCost?.[req.acct] || 0) >= ACCOUNT_COST_CAP) return "На сьогодні запитів забагато. Завтра все запрацює знову; якщо це помилка, напишіть Максові.";
  return null;
}
// An error a reader ran into goes to the site, which keeps it for /admin and tells the owner in Telegram (web/errors.js,
// risk review 2026-11-05). The same message at most once in 10 minutes from here; a crash waits for it to leave.
const errorSent = new Map();
function reportError(err, url = "") {
  const key = state.accounts?.[OWNER_ID]?.key;
  const msg = String(err?.message || err || "без опису").slice(0, 500);
  const sig = msg.replace(/\d+/g, "N").slice(0, 120);
  if (!key || Date.now() - (errorSent.get(sig) || 0) < 10 * 60000) return Promise.resolve();
  errorSent.set(sig, Date.now());
  const stack = String(err?.stack || "").split("\n").slice(1, 6).map((l) => l.trim()).join("\n");
  return fetch(`${WEB_URL}/api/reader-alert`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: OWNER_ID, key, error: msg, stack, url }), signal: AbortSignal.timeout(5000) }).catch((e) => console.error(`error report: ${e.message}`));
}
{
  let dying = false;
  const die = (err) => {
    console.error(err);
    if (dying) process.exit(1);
    dying = true;
    Promise.race([reportError(err instanceof Error ? err : new Error(String(err)), "процес упав"), new Promise((r) => setTimeout(r, 3000))]).finally(() => process.exit(1));
  };
  process.on("uncaughtException", die);
  process.on("unhandledRejection", die);
}
// Script errors from readers' browsers (web-bridge.js; Max, 2026-11-09). Extension noise and the network's own
// failures are dropped; the rest goes the way of server errors (reportError: the site's list, Telegram once an hour),
// marked «[браузер]». At most 20 from one address and 200 in all an hour, so a broken page can't flood anything.
const CLIENT_NOISE = /^Script error\.?|chrome-extension:|moz-extension:|safari-(web-)?extension:|chrome\.storage|__gCrWeb|webkit\.messageHandlers|ResizeObserver loop|AbortError|The operation was aborted|Failed to fetch|Load failed|NetworkError|network error|Network request failed|cancelled|Non-Error promise rejection captured/i;
let clientErrors = { hour: 0, all: 0, by: new Map() };
function clientError(req, res) {
  res.status(204).end();
  const b = req.body || {};
  const msg = String(b.message || "").slice(0, 300);
  if (!msg || CLIENT_NOISE.test(msg) || CLIENT_NOISE.test(String(b.stack || ""))) return;
  const hour = Math.floor(Date.now() / 3600000);
  if (clientErrors.hour !== hour) clientErrors = { hour, all: 0, by: new Map() };
  const n = (clientErrors.by.get(req.ip) || 0) + 1;
  clientErrors.by.set(req.ip, n);
  if (n > 20 || ++clientErrors.all > 200) return;
  const err = new Error(`[браузер] ${msg}`);
  err.stack = `${err.message}\n${String(b.stack || "").split("\n").filter((l) => !l.includes(msg)).slice(0, 5).join("\n")}`;
  console.error(`client error: ${msg}`);
  reportError(err, `${String(b.page || "").slice(0, 100)} · ${b.phone ? "телефон" : "комп'ютер"} · ${String(req.get("user-agent") || "").replace(/\s*\(.*?\)\s*/g, " ").slice(0, 80)}`);
}
function alertOwner(subject, text) {
  const key = state.accounts[OWNER_ID]?.key;
  console.log(`alert: ${subject}`);
  if (!key) return;
  fetch(`${WEB_URL}/api/reader-alert`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: OWNER_ID, key, subject, text }), signal: AbortSignal.timeout(10000) }).catch((e) => console.error(`alert: ${e.message}`));
}
// The text sent to Claude, cut to what the reader's page ever sends (2 000 characters before a selection, 1 000
// after, a screen of text): a hand-made request could carry megabytes, and Opus is paid per word.
const ACCOUNT_FIELD_MAX = 12000;
const ACCOUNT_MESSAGE_MAX = 20000;
const ACCOUNT_TURNS_MAX = 40;
function trimAccountRequest(request) {
  const cut = (v, max) => (typeof v === "string" && v.length > max ? v.slice(0, max) : v);
  if (request.context && typeof request.context === "object") {
    const c = { ...request.context };
    for (const k of Object.keys(c)) if (k !== "image") c[k] = cut(c[k], ACCOUNT_FIELD_MAX);
    request.context = c;
  }
  if (Array.isArray(request.messages)) {
    let m = request.messages;
    if (m.length > ACCOUNT_TURNS_MAX) m = [m[0], ...m.slice(-(ACCOUNT_TURNS_MAX - 1))];
    request.messages = m.map((x) => {
      if (!x || typeof x !== "object") return x;
      if (typeof x.content === "string") return { ...x, content: cut(x.content, ACCOUNT_MESSAGE_MAX) };
      if (Array.isArray(x.content)) return { ...x, content: x.content.map((b) => (b && b.type === "text" ? { ...b, text: cut(b.text, ACCOUNT_MESSAGE_MAX) } : b)) };
      return x;
    });
  }
  return request;
}

// Reading time (Max, 2026-11-04: «трекати кількість хвилин, які люди проводять в читалці»; before that, since
// 2026-10-29, the gaps between page turns). The reader page counts the seconds a book is on screen, the tab is
// visible and the reader did something in the last few minutes (reading-time.js), and sends them about once a
// minute: POST /api/reading { books: { name: seconds } }. Kept per day: readSec[account] in total and
// readBooks[account][book]. Accounts only, as for explanations; guests and shared links are not counted.
const READ_GAP = 5 * 60 * 1000; // a pause this long ends a sitting (noteReadingNow)
const lastReading = new Map(); // account -> time of its last report, in memory only
// `at` (2026-11-08, offline reading): the start of an earlier hour whose seconds the page kept (read offline, or
// the app closed before they went). They count under that hour's day: at most an hour per report and
// READ_DAY_MAX a day, apart from the live budget below.
const READ_DAY_MAX = 16 * 3600;
function recordReading(acct, books, at) {
  const now = Date.now();
  const past = at && at < now - 60 * 1000 && at > now - 14 * 86400000;
  let budget;
  if (!past) {
    // No more than the time since the previous report (two devices at once, or a page that sends too much).
    const since = lastReading.has(acct) ? (now - lastReading.get(acct)) / 1000 + 10 : 600;
    lastReading.set(acct, now);
    budget = Math.min(600, since);
  }
  const day = statsDay(past ? at : now);
  const stats = (state.stats ??= { since: day, days: {} });
  const d = (stats.days[day] ??= { explains: 0, users: {}, guests: 0, models: {} });
  if (past) budget = Math.max(0, Math.min(3600, READ_DAY_MAX - (d.readSec?.[acct] || 0)));
  for (const [name, sec] of Object.entries(books)) {
    const add = Math.round(Math.min(budget, sec));
    if (!(add > 0)) continue;
    budget -= add;
    (d.readSec ??= {})[acct] = (d.readSec[acct] || 0) + add;
    const mine = ((d.readBooks ??= {})[acct] ??= {});
    mine[name] = (mine[name] || 0) + add;
  }
}

// Minutes per reader and book over the last 30 days, for the admin page (newest reading first).
function readingByBook(days, dayKeys, today, weekAgo, monthAgo) {
  const rows = new Map();
  for (const day of dayKeys.filter((k) => k >= monthAgo)) {
    for (const [acct, books] of Object.entries(days[day].readBooks || {})) {
      for (const [name, sec] of Object.entries(books)) {
        const r = rows.get(`${acct}\n${name}`) || { id: acct, name: accountName(acct), username: state.accounts[acct]?.username || "", book: name, ...bookInfo(acct, name), today: 0, week: 0, month: 0, last: day };
        r.month += sec;
        if (day >= weekAgo) r.week += sec;
        if (day === today) r.today += sec;
        if (day > r.last) r.last = day;
        rows.set(`${acct}\n${name}`, r);
      }
    }
  }
  const min = (sec) => Math.round(sec / 60);
  return [...rows.values()].map((r) => ({ ...r, today: min(r.today), week: min(r.week), month: min(r.month) })).filter((r) => r.month > 0).sort((a, b) => b.month - a.month);
}

async function collectStats() {
  const stats = state.stats || { since: null, days: {} };
  const today = statsDay();
  const weekAgo = statsDay(Date.now() - 7 * 86400000);
  const dayKeys = Object.keys(stats.days).sort().reverse();
  const sumUser = (id, from) => dayKeys.filter((k) => !from || k >= from).reduce((a, k) => a + (stats.days[k].users[id] || 0), 0);
  const sumAll = (from) => dayKeys.filter((k) => !from || k >= from).reduce((a, k) => a + stats.days[k].explains, 0);

  const monthAgo = statsDay(Date.now() - 30 * 86400000);
  const minutesOf = (id, from) => Math.round(dayKeys.filter((k) => !from || k >= from).reduce((a, k) => a + (stats.days[k].readSec?.[id] || 0), 0) / 60);
  const costOf = (id) => dayKeys.filter((k) => k >= monthAgo).reduce((a, k) => a + (stats.days[k].userCost?.[id] || 0), 0);
  const ids = [...new Set([...Object.keys(state.users), ...Object.keys(state.accounts)])].filter((id) => ACCOUNT_ID.test(id));
  const noteTimes = new Map();
  for (const r of store.items.noteTimes()) (noteTimes.get(r.acct) || noteTimes.set(r.acct, []).get(r.acct)).push(Number(r.at) || 0);
  const users = ids
    .map((id) => [id, state.users[id] || {}])
    .map(([id, u]) => {
      const lastSeen = Math.max(0, state.accounts[id]?.seen || 0, ...Object.values(u.opened || {}));
      const started = new Set(Object.keys(u.positions || {}).map((p) => p.replace(/#reflow$/, ""))).size;
      // Notes saved (Max, 2026-11-04: another sign the reader is really used), counted from their createdAt.
      const made = noteTimes.get(id) || [];
      const notesToday = made.filter((t) => t && statsDay(t) === today).length;
      const notesWeek = made.filter((t) => t && statsDay(t) >= weekAgo).length;
      return { id, notesToday, notesWeek, notesTotal: made.length, name: accountName(id), username: state.accounts[id]?.username || "", off: !!state.accounts[id]?.off, owner: id === OWNER_ID, cost30: costOf(id), readToday: minutesOf(id, today), readWeek: minutesOf(id, weekAgo), read30: minutesOf(id, monthAgo), books: countBooks(id), today: sumUser(id, today), week: sumUser(id, weekAgo), total: sumUser(id), started, lastSeen, lastBook: u.lastBook, lastOpened: u.opened?.[u.lastBook] || 0, activeWeek: lastSeen > Date.now() - 7 * 86400000 };
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
    notes: { today: users.reduce((a, x) => a + x.notesToday, 0), week: users.reduce((a, x) => a + x.notesWeek, 0), all: users.reduce((a, x) => a + x.notesTotal, 0) },
    users,
    books,
    days,
    models,
    // Disk, memory and the database of the reader's machine, for the site's Performance block (storage.js).
    storage: storage.now(DATA_DIR, ["reader.db"]),
    guestsToday: Object.keys(gu.guests).length,
    guestExplainsToday: gu.total,
    guestTotalLimit: GUEST_TOTAL_LIMIT,
    accountCap: ACCOUNT_DAILY_CAP,
    wishes: wishStats(library),
    reading: readingByBook(stats.days, dayKeys, today, weekAgo, monthAgo),
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
  if (req.free) return [{ dir: freeDir(req.free), name: req.free }];
  return demoBooks();
}

let freeShelf = [];
try {
  freeShelf = JSON.parse(fs.readFileSync(path.join(FREE_DIR, "shelf.json"), "utf8"));
} catch {
  /* no manifest: the files' own titles, one group */
}
// A book whose author's rights run out later waits for its day: { "from": "2027-01-01" } (Остап Вишня, †1956).
const notYet = (name) => {
  const from = freeShelf.find((f) => f.name === name)?.from;
  return !!from && statsDay() < from;
};
// [{ dir, name }] of the free books, the repo's first.
function freeBooks() {
  const seen = new Set();
  return [FREE_DIR, FREE_VOLUME_DIR].flatMap((dir) => {
    try {
      return fs.readdirSync(dir).filter((n) => !n.startsWith(".") && BOOK_EXT.test(n) && !notYet(n) && !seen.has(n) && seen.add(n)).sort().map((name) => ({ dir, name }));
    } catch {
      return [];
    }
  });
}
const isFree = (name) => !!name && freeBooks().some((f) => f.name === name);
const freeDir = (name) => freeBooks().find((f) => f.name === name)?.dir || FREE_DIR;
// Publishers' books: on the volume, read chapter by chapter, the beginning only outside the app (server/protected.js).
const prot = createProtected({ dir: path.join(DATA_DIR, "protected"), day: () => statsDay() });
const inApp = (req) => /ChytaiApp/.test(req.get("user-agent") || "");
// A free book's cover when its file has none: free/covers/<book name without .epub>.<jpg|png|webp>.
function freeCover(name) {
  const dir = path.join(FREE_DIR, "covers");
  const base = name.replace(/\.[^.]+$/, "");
  const file = fs.existsSync(dir) && fs.readdirSync(dir).find((f) => f.replace(/\.[^.]+$/, "") === base);
  return file ? path.join(dir, file) : null;
}
// The file a signed-in reader opens by this name: their own copy first, else the shelf's.
function readerFile(lib, name) {
  if (!name) return null;
  const own = bookFile(lib, name);
  if (fs.existsSync(own)) return own;
  if (isFree(name)) return path.join(freeDir(name), name);
  return prot.has(name) ? path.join(prot.dir, name) : own;
}

function protectedNames() {
  try {
    return fs.readdirSync(prot.dir).filter((n) => /\.epub$/i.test(n));
  } catch {
    return [];
  }
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
//
// Sessions (security review 2026-11-04, Max OK): the cookie is `<account>.<session>.<signature>`, and the session
// must still be in state.sessions (kept by a hash of its id). So «Вийти» ends it for real, and the site's «Вийти на
// всіх пристроях» (or a deleted account) ends all of an account's sessions through /api/site-signout. A cookie
// from before (`<account>.<signature>`, no session) still works once and is swapped for a session cookie on the
// way (req.upgradeSession), unless the account was signed out everywhere since (accounts[id].legacyOff).
const sessionHash = (sid) => crypto.createHash("sha256").update(`reader-session:${sid}`).digest("hex");
const safeEqual = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
function currentAccount(req) {
  const cookies = parseCookies(req);
  const raw = cookies[COOKIE];
  const parts = raw ? raw.split(".") : [];
  if (parts.length < 2) {
    if (!(cookies[OLD_COOKIE] && cookies[OLD_COOKIE] === `${OWNER_LEGACY_NAME}.${sign(OWNER_LEGACY_NAME)}`) || state.accounts[OWNER_ID]?.legacyOff) return null;
    req.upgradeSession = OWNER_ID;
    return OWNER_ID;
  }
  const id = parts[0];
  if (!ACCOUNT_ID.test(id)) return null;
  if (parts.length === 3) {
    const sid = parts[1];
    if (!/^[a-f0-9]{32}$/.test(sid) || !safeEqual(parts[2], sign(`sess:${id}:${sid}`))) return null;
    const sess = state.sessions?.[sessionHash(sid)];
    if (!sess || sess.acct !== id) return null;
    // When it was last used, to forget the ones nobody used for a year; written to disk with the next save.
    if (Date.now() - (sess.seen || 0) > 86400000) sess.seen = Date.now();
    return id;
  }
  if (parts.length !== 2 || !safeEqual(parts[1], sign(`acct:${id}`)) || state.accounts[id]?.legacyOff) return null;
  req.upgradeSession = id;
  return id;
}
function newSession(id) {
  const sid = crypto.randomBytes(16).toString("hex");
  state.sessions ??= {};
  const now = Date.now();
  for (const [h, x] of Object.entries(state.sessions)) if (now - (x.seen || x.at || 0) > COOKIE_DAYS * 86400000) delete state.sessions[h];
  state.sessions[sessionHash(sid)] = { acct: id, at: now, seen: now };
  saveState();
  return `${id}.${sid}.${sign(`sess:${id}:${sid}`)}`;
}
function endSession(req) {
  const parts = String(parseCookies(req)[COOKIE] || "").split(".");
  if (parts.length === 3 && state.sessions?.[sessionHash(parts[1])]) delete state.sessions[sessionHash(parts[1])], saveState();
}
function endAllSessions(id) {
  for (const [h, x] of Object.entries(state.sessions || {})) if (x.acct === id) delete state.sessions[h];
  (state.accounts[id] ??= {}).legacyOff = Date.now();
  saveState();
}

const accountName = (id) => state.accounts[id]?.name || (id === OWNER_ID ? OWNER_LEGACY_NAME : "Читач");

function cookieHeader(req, cookie, value, days) {
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  return `${cookie}=${encodeURIComponent(value)}; Path=/; Max-Age=${days * 86400}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

function setLoginCookie(req, res, id) {
  // Signing in ends any guest session on this device, and the family password's old cookie.
  res.setHeader("Set-Cookie", [cookieHeader(req, COOKIE, newSession(id), COOKIE_DAYS), cookieHeader(req, GUEST_COOKIE, "", 0), cookieHeader(req, OLD_COOKIE, "", 0)]);
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

// «Увійти»: the site's sign-in, which comes back here with a ticket. The app opens every address that is
// not the reader's in Safari, so there the sign-in goes through /app-login instead (below).
const siteSignIn = (req) => `${WEB_URL}/reader-login?back=${encodeURIComponent(`${req.protocol}://${req.get("host")}`)}`;
// Since 2026-11-04 the landing signs in on the page itself, so «Увійти» is just /login.
const signInUrl = (req) => (inApp(req) ? "/app-login" : "/login");

// opts.button { href, label } replaces «Увійти» (and the demo link) for someone already signed in.
function loginPage(req, error, opts = {}) {
  const signIn = signInUrl(req);
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
  ${opts.button ? `<a class="btn" href="${esc(opts.button.href)}">${esc(opts.button.label)}</a>` : `<a class="btn" href="${esc(signIn)}">Увійти</a>`}
</form></body></html>`;
}

const smallPage = (body) => `<!doctype html>
<html lang="uk"><head><meta charset="utf-8"><title>Chytai</title>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<link rel="icon" href="/icon.png">
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; background: #f6efe0; color: #3b2f1e; }
  main { box-sizing: border-box; width: min(360px, 90vw); padding: 28px 24px; border-radius: 16px; background: rgba(255,255,255,0.5); box-shadow: 0 8px 30px rgba(0,0,0,0.12); }
  @media (prefers-color-scheme: dark) { body { background: #1e1e20; color: #e6e6e6; } main { background: #2a2a2d; } }
  h1 { margin: 0 0 8px; font-size: 22px; } p { margin: 0 0 18px; opacity: 0.8; }
  .btn { display: block; box-sizing: border-box; width: 100%; padding: 11px; font: inherit; font-weight: 600; text-align: center; text-decoration: none; color: #fff; background: #b7791f; border: none; border-radius: 8px; }
</style></head><body><main>${body}</main></body></html>`;

// Signing in inside the iPhone and Android apps (Max, 2026-11-04): the e-mail, the code and, for a new
// address, the name, right here, no Safari. The page calls the site's /api/reader-login/* (the same codes and
// limits as chytai.org.ua/login) and gets a ticket for /auth. One account with the site; a new reader gets a
// username made from the name and only meets it on the site.
function appSignInPage() {
  return smallPage(`<h1>Chytai</h1><p>Читалка з поясненнями від Claude</p>
<div id="signin" data-web="${esc(WEB_URL)}">
  <form id="f-email" novalidate>
    <input type="email" name="email" enterkeyhint="send" required autocomplete="email" inputmode="email" autocapitalize="off" placeholder="Ваша пошта">
    <p class="err" role="alert"></p>
    <button class="btn" type="submit">Отримати код</button>
    <p class="note">Пароля немає: код для входу прийде на пошту. Акаунт спільний з chytai.org.ua.</p>
  </form>
  <form id="f-code" hidden>
    <p class="lab">Код надіслали на <b class="shown"></b></p>
    <input class="code" name="code" enterkeyhint="go" required inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" maxlength="7" placeholder="······">
    <p class="err" role="alert"></p>
    <button class="btn" type="submit">Увійти</button>
    <p class="note">Лист іде до хвилини, перевірте й «Спам». <a href="#" data-back>Інша пошта</a></p>
  </form>
  <form id="f-name" hidden>
    <p class="lab">Ви тут уперше. Як вас звати?</p>
    <input name="name" enterkeyhint="done" required maxlength="60" autocomplete="name" placeholder="Ім'я">
    <p class="err" role="alert"></p>
    <button class="btn" type="submit">Готово</button>
  </form>
  <p class="note" id="f-done" hidden>Відкриваю ваші книжки…</p>
</div>
<style>
  input { box-sizing: border-box; width: 100%; padding: 11px 12px; margin: 0 0 12px; font: inherit; color: inherit; background: rgba(255,255,255,0.8); border: 1px solid rgba(59,47,30,0.25); border-radius: 8px; }
  @media (prefers-color-scheme: dark) { input { background: #1e1e20; border-color: rgba(255,255,255,0.2); } }
  input.code { font-size: 22px; letter-spacing: .3em; text-align: center; font-variant-numeric: tabular-nums; }
  .btn:disabled { opacity: .6; }
  .lab { margin: 0 0 10px; opacity: 1; }
  .err { margin: -4px 0 10px; color: #c0392b; opacity: 1; } .err:empty { display: none; }
  .note { margin: 12px 0 0; font-size: 14px; opacity: .65; }
  .note a { color: #b7791f; font-weight: 600; }
</style>
<script>
(function () {
  var web = document.getElementById("signin").dataset.web;
  // The Android app sometimes opens here although signed in: on a cold start its first requests can go out
  // without the sign-in cookie, and a restart was enough (Max, 2026-11-05). A moment later the cookie is there,
  // so this page asks once more and goes to the books if the server now sees the account.
  if (/Android/.test(navigator.userAgent)) setTimeout(function () {
    fetch("/app-login", { redirect: "manual", credentials: "same-origin", cache: "no-store" })
      .then(function (r) { if (r.type === "opaqueredirect" && !email) location.replace("/"); })
      .catch(function () {});
  }, 1200);
  // Where this person first came from (kept 30 days from the first visit), sent with the sign-up so the site
  // knows it was dev.ua and not «Напряму» (Max, 2026-11-04).
  var came = { ref: document.referrer, url: location.href };
  if (came.ref.indexOf(location.origin + "/") === 0) came.ref = "";
  try {
    var kept = JSON.parse(localStorage.getItem("chytai_came") || "null");
    if (kept && kept.day && Date.now() - Date.parse(kept.day) < 30 * 864e5) came = kept;
    else if (came.ref || /[?&]utm_source=/.test(location.search)) { came.day = new Date().toISOString().slice(0, 10); localStorage.setItem("chytai_came", JSON.stringify(came)); }
  } catch (e) {}
  var forms = { email: document.getElementById("f-email"), code: document.getElementById("f-code"), name: document.getElementById("f-name") };
  var done = document.getElementById("f-done");
  var email = "", signup = "";
  // Enter sends the step, whatever the browser does by itself (a reader on an iPhone, 2026-11-04: Enter after the
  // e-mail did nothing). While a step is on its way the button is off, and Enter waits too.
  Object.keys(forms).forEach(function (k) {
    var f = forms[k];
    f.querySelector("input").addEventListener("keydown", function (e) {
      if (e.key !== "Enter" || e.isComposing) return;
      e.preventDefault();
      if (!f.querySelector("button").disabled) f.dispatchEvent(new Event("submit", { cancelable: true }));
    });
  });
  var DOWN = "Сайт chytai.org.ua зараз не відповідає. Спробуйте ще раз за хвилину.";
  function show(step) {
    Object.keys(forms).forEach(function (k) { forms[k].hidden = k !== step; forms[k].querySelector(".err").textContent = ""; });
    done.hidden = step !== "in";
    if (forms[step]) setTimeout(function () { forms[step].querySelector("input").focus(); }, 0);
  }
  function call(form, what, body) {
    var err = form.querySelector(".err"), btn = form.querySelector("button");
    err.textContent = ""; btn.disabled = true; var label = btn.textContent; btn.textContent = "Хвилинку…";
    return fetch(web + "/api/reader-login/" + what, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (res) { return res.json().catch(function () { return {}; }).then(function (d) { if (!res.ok || d.error) throw new Error(d.error || DOWN); return d; }); })
      .catch(function (e) { err.textContent = e instanceof TypeError ? DOWN : e.message; return null; })
      .then(function (d) { btn.disabled = false; btn.textContent = label; return d; });
  }
  function enter(ticket) { show("in"); location.href = "/auth?ticket=" + encodeURIComponent(ticket); }
  forms.email.addEventListener("submit", function (e) {
    e.preventDefault();
    var input = forms.email.elements.email;
    if (!input.value.trim() || !input.checkValidity()) { forms.email.querySelector(".err").textContent = "Вкажіть пошту, наприклад olena@ukr.net."; return; }
    call(forms.email, "email", { email: input.value }).then(function (r) {
      if (!r) return;
      email = r.email || input.value.trim();
      forms.code.querySelector(".shown").textContent = email;
      forms.code.elements.code.value = "";
      show("code");
    });
  });
  forms.code.addEventListener("submit", function (e) {
    e.preventDefault();
    call(forms.code, "code", { email: email, code: forms.code.elements.code.value }).then(function (r) {
      if (!r) return;
      if (r.ticket) return enter(r.ticket);
      signup = r.signup; show("name");
    });
  });
  forms.name.addEventListener("submit", function (e) {
    e.preventDefault();
    call(forms.name, "signup", { signup: signup, name: forms.name.elements.name.value, came: came }).then(function (r) { if (r && r.ticket) enter(r.ticket); });
  });
  forms.code.querySelector("[data-back]").addEventListener("click", function (e) { e.preventDefault(); show("email"); });
})();
</script>`);
}

// Readers' words on the landing (Max, 2026-10-23). Add one more { text, author } to show it; author may be left out.
const TESTIMONIALS = [
  { text: "AI нотатки і пояснення — афігенна фіча, і навіть елементарний зміст по книжці значно зручніше чим ті читалки що я дивився", author: "Микола Я" },
];

// The first thing someone not signed in sees (Max, 2026-11-04): one screen, signing in right there (server/landing.js).
// The Mac link is not shown inside the apps. Android is hidden for now: the app is still raw (Max, 2026-11-04);
// /android on the site still works.
function landingPage(req) {
  const ua = req.get("user-agent") || "";
  const inside = /Chytai(Mac|App)\//.test(ua);
  // Google refuses sign-in inside an app's embedded browser, so the button is for real browsers only, and for the
  // Mac app from 2.0 (Swift), which opens it in the browser and gets the ticket back by chytai:// (mac/Chytai.swift).
  const google = (!inside || /ChytaiMac\/([2-9]|\d\d)/.test(ua)) && !/; wv\)/.test(ua);
  return renderLanding({ webUrl: WEB_URL, mac: !inside, android: false, google, testimonials: TESTIMONIALS });
}

// ---------- App ----------

const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");
// The visitor's address is the one Fly saw (Fly-Client-IP, set by Fly's proxy): with "trust proxy" alone
// req.ip was the first X-Forwarded-For entry, which the visitor writes, so per-address limits (sign-in codes,
// guests' explanations) could be dodged by sending a new one each time (security review 2026-11-04).
// And a few headers every page should carry: HTTPS only, no framing by other sites, no type guessing.
app.use((req, res, next) => {
  const fly = req.get("fly-client-ip");
  if (fly) Object.defineProperty(req, "ip", { value: fly, configurable: true });
  res.set({ "Strict-Transport-Security": "max-age=31536000", "X-Frame-Options": "SAMEORIGIN", "X-Content-Type-Options": "nosniff" });
  next();
});

// Threads see the reader's production, read only (Max, 2026-11-09; server/agent.js, CLAUDE.md «Прод»): who holds a
// Fly token that can see this app. Its errors are on the site's /agent/health (they go there via /api/reader-alert).
{
  const agent = require("./agent");
  const ok = agent.guard(process.env.FLY_APP_NAME || "chytai");
  const sql = agent.sqlRunner(path.join(DATA_DIR, "reader.db"));
  const started = new Date().toISOString();
  app.use("/agent", (req, res, next) => (res.set("Cache-Control", "no-store"), next()));
  app.get("/agent/health", ok, (req, res) => res.json({ now: new Date().toISOString(), commit: process.env.GIT_SHA || "", image: process.env.FLY_IMAGE_REF || "", started, memoryMb: Math.round(process.memoryUsage().rss / 1048576), storage: storage.now(DATA_DIR, ["reader.db"]), accounts: Object.keys(state.accounts || {}).length }));
  app.all("/agent/sql", ok, express.json(), async (req, res) => res.json(await sql(req.body?.q || req.query.q)));
}

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

app.post("/api/client-error", express.json({ limit: "8kb", type: () => true }), clientError);

// Public: icon and manifest, so the phone can show them before login.
app.get("/icon.png", (_req, res) => res.sendFile(path.join(ROOT, "build", "icon.png")));
for (const f of ["landing-desk.mp4", "landing-phone.mp4", "landing-desk-poster.jpg", "landing-phone-poster.jpg"]) app.get(`/${f}`, (_req, res) => res.sendFile(path.join(ROOT, "build", f), { maxAge: "7d" }));
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
  // The reader's fonts: Literata for books, Source Serif 4 and Onest for the home screen (design «3a»).
  const fontCss = ["@fontsource-variable/literata/wght.css", "@fontsource-variable/literata/wght-italic.css", "@fontsource-variable/source-serif-4/opsz.css", "@fontsource-variable/onest/wght.css"];
  const fontFiles = fontCss.flatMap((f) =>
    [...fs.readFileSync(path.join(ROOT, "node_modules", f), "utf8").matchAll(/url\(\.\/([^)]+)\)/g)].map((m) => `${path.dirname(f)}/${m[1]}`),
  );
  const libs = [
    "jszip/dist/jszip.min.js",
    "epubjs/dist/epub.min.js",
    "marked/lib/marked.umd.js",
    "dompurify/dist/purify.min.js",
    "qrcode-generator/dist/qrcode.js",
    "pdfjs-dist/legacy/build/pdf.mjs",
    "pdfjs-dist/legacy/build/pdf.worker.mjs",
    "pdfjs-dist/legacy/web/pdf_viewer.mjs",
    "pdfjs-dist/legacy/web/pdf_viewer.css",
    ...fontCss,
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
// Signed out: the landing with signing in, at / itself (Max 2026-11-04: «чому не на головній?») and at /login.
// It is marked so the service worker never keeps it as the reader's page (sw.js).
function signedOutPage(req, res) {
  if (safeNext(req.query.next)) res.setHeader("Set-Cookie", cookieHeader(req, NEXT_COOKIE, safeNext(req.query.next), 1 / 96));
  res.set({ "Cache-Control": "no-store", "X-Chytai-Landing": "1" });
  if (inApp(req)) return res.type("html").send(appSignInPage());
  // From the site («Читати» on a book): whoever is signed in there comes in without a code.
  if (String(req.get("referer") || "").startsWith(WEB_URL)) return res.redirect(siteSignIn(req));
  res.type("html").send(landingPage(req));
}
app.get("/login", (req, res) => {
  if (currentAccount(req)) return res.redirect(safeNext(req.query.next) || "/");
  signedOutPage(req, res);
});
// The phone apps sign in on their own page (appSignInPage, 2026-11-04). The Safari round trip of 2026-11-02
// (/auth?app=<code>, then the app picked the account up from /api/app-login) is gone: the code came in the
// link, so anyone could send a signed-in reader a link with their own code and pick up that reader's account
// (security review 2026-11-04).
app.get("/app-login", (req, res) => {
  if (!inApp(req)) return res.redirect(signInUrl(req));
  if (currentAccount(req)) return res.redirect(safeNext(parseCookies(req)[NEXT_COOKIE]) || "/");
  res.setHeader("Cache-Control", "no-store");
  res.type("html").send(appSignInPage());
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
  endSession(req);
  res.setHeader("Set-Cookie", [cookieHeader(req, COOKIE, "", 0), cookieHeader(req, GUEST_COOKIE, "", 0), cookieHeader(req, OLD_COOKIE, "", 0), cookieHeader(req, SHARE_COOKIE, "", 0), cookieHeader(req, FREE_COOKIE, "", 0)]);
  res.redirect("/login");
});

// /demo is gone (Max, 2026-11-04: «не потрібен зараз, коли є реєстрація»); old links go to sign-in.
app.get("/demo", (req, res) => res.redirect(currentAccount(req) ? "/" : "/login"));

// /free/<file> opens a book of the free shelf from the site. Without an account it opens as a guest who
// sees only that book and gets no explanations (svoloshyn, Max 2026-10-26: a child reading «Лис Микита» needs
// no account; the explanations cost tokens, so they wait for a sign-in).
app.get("/free/:name", (req, res) => {
  const name = safeBookName(req.params.name);
  if (!name || !isFree(name)) return res.redirect("/");
  const open = `/?open=${encodeURIComponent(name)}`;
  if (currentAccount(req)) return res.redirect(open); // the shelf's copy, nothing to copy any more
  if (!GUEST_ENABLED || currentShare(req)) return res.redirect(`/login?next=${encodeURIComponent(`/free/${encodeURIComponent(name)}`)}`);
  const cookies = [cookieHeader(req, FREE_COOKIE, `${name}.${sign(`free:${name}`)}`, 30)];
  const guest = currentGuest(req);
  if (guest) guestState(guest).lastBook = name;
  else {
    const id = crypto.randomBytes(12).toString("hex");
    cookies.push(cookieHeader(req, GUEST_COOKIE, `${id}.${sign(`guest:${id}`)}`, 30));
  }
  res.setHeader("Set-Cookie", cookies);
  res.redirect("/");
});
// The file itself, for «Завантажити EPUB» on the site: no account needed.
// Not the books shared by their author's permission («З дозволу автора»): those are read here only (Max, 2026-10-26).
const fileAllowed = (name) => ((f) => !f?.permission && f?.group !== "З дозволу автора")(freeShelf.find((f) => f.name === name));
app.get("/free-file/:name", (req, res) => {
  const name = safeBookName(req.params.name);
  if (!name || !isFree(name) || !fileAllowed(name)) return res.status(404).end();
  res.download(path.join(freeDir(name), name), name);
});
// The free book this guest reads, while it is still on the shelf.
function currentFree(req) {
  const raw = parseCookies(req)[FREE_COOKIE];
  const i = raw ? raw.lastIndexOf(".") : -1;
  if (i < 0) return null;
  const name = safeBookName(raw.slice(0, i));
  const sig = raw.slice(i + 1);
  const expected = name && sign(`free:${name}`);
  return expected && sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) && isFree(name) ? name : null;
}

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
  if (acct) return res.type("html").send(loginPage(req, "Це посилання для читання без акаунта, а ви вже в Читалці під своїм. Відкрийте його на іншому пристрої.", { button: { href: "/", label: "Відкрити мою бібліотеку" } }));
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

// The site's «Вийти на всіх пристроях», or a deleted account: every reader session of the account ends.
// Signed with that account's key (the HMAC the site gave the reader at sign-in).
app.post("/api/site-signout", express.json(), (req, res) => {
  const id = String(req.body?.id || "");
  const want = state.accounts[id]?.key;
  if (!ACCOUNT_ID.test(id) || !want || !safeEqual(String(req.body?.key || ""), want)) return res.status(403).json({ error: "key" });
  endAllSessions(id);
  console.log(`reader: all sessions of ${id} ended`);
  res.json({ ok: true });
});

// The reader's stats live in the site's admin (chytai.org.ua/admin/reader; Max, 2026-11-02). The site asks for
// them with the owner's reader key (the HMAC it gave this reader at sign-in), so no new secret is needed.
const siteOwnerOk = (req) => {
  const want = state.accounts[OWNER_ID]?.key;
  const key = String(req.get("x-reader-key") || "");
  return !!want && key.length === want.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(want));
};
app.get("/api/site-admin", async (req, res, next) => {
  if (!siteOwnerOk(req)) return res.status(403).json({ error: "key" });
  try {
    res.json(await collectStats());
  } catch (err) {
    next(err);
  }
});
// One day's numbers for the site's morning report in Telegram (web/dailyreport.js), per account so the site can
// leave out the owner and test accounts: seconds read, explanations, notes saved, and the books read with titles.
app.get("/api/site-admin/day", (req, res) => {
  if (!siteOwnerOk(req)) return res.status(403).json({ error: "key" });
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.day || "")) ? String(req.query.day) : statsDay(Date.now() - 86400000);
  const d = state.stats?.days?.[day] || {};
  const notes = {};
  for (const r of store.items.noteTimes()) if (Number(r.at) && statsDay(Number(r.at)) === day) notes[r.acct] = (notes[r.acct] || 0) + 1;
  const books = []; // one row per account and book; the site puts its own titles on readers' files (reader_files)
  for (const [acct, list] of Object.entries(d.readBooks || {})) for (const [name, sec] of Object.entries(list)) books.push({ acct, name, title: bookInfo(acct, name).title || "", sec });
  res.json({ day, readSec: d.readSec || {}, explains: d.users || {}, notes, cost: d.cost || 0, books });
});
// Switch the reader off (or on again) for one account: { id, off: true | false }.
app.post("/api/site-admin/off", express.json(), (req, res) => {
  if (!siteOwnerOk(req)) return res.status(403).json({ error: "key" });
  const id = String(req.body?.id || "");
  if (!ACCOUNT_ID.test(id) || id === OWNER_ID) return res.status(400).json({ error: "id" });
  const a = (state.accounts[id] ??= {});
  if (req.body.off) a.off = Date.now();
  else delete a.off;
  saveState();
  res.json({ ok: true, off: !!a.off });
});

// «Попросити книжку» (site's asks.js, Max 2026-11-08: «він просто додає її в читалку … і вона автоматом з'являється
// в моїй читалці»): the site, asked by the owner of the file, puts their book into another account's library: the
// same file (a hard link through store.writeBook), its corrected title and author and its own cover.
function giveBook(from, to, name) {
  const src = libOf(from);
  const dst = libOf(to);
  const file = bookFile(src, name);
  if (!fs.existsSync(file)) return false;
  if (!fs.existsSync(bookFile(dst, name))) {
    fs.mkdirSync(dst.dir, { recursive: true });
    store.writeBook(bookFile(dst, name), fs.readFileSync(file));
  }
  if (dst.meta.trash?.[name]) fs.rmSync(trashFile(dst, name), { force: true }), delete dst.meta.trash[name];
  if (src.meta.bookMeta?.[name]) (dst.meta.bookMeta ??= {})[name] = { ...src.meta.bookMeta[name] };
  (dst.meta.added ??= {})[name] = { by: from, at: Date.now(), gift: true };
  const key = customCoverKey(name);
  if (fs.existsSync(src.covers)) {
    for (const f of fs.readdirSync(src.covers)) {
      if (f.split(".")[0] === key) fs.mkdirSync(dst.covers, { recursive: true }), fs.copyFileSync(path.join(src.covers, f), path.join(dst.covers, f));
    }
  }
  saveState();
  warmCovers(dst, [name]);
  tellSite(to);
  console.log(`give: ${from} → ${to}: ${name}`);
  return true;
}
const giveArgs = (q) => {
  const from = String(q?.from || "");
  const to = String(q?.to || "");
  const name = safeBookName(String(q?.name || ""));
  return ACCOUNT_ID.test(from) && ACCOUNT_ID.test(to) && from !== to && name && !state.accounts[to]?.off && !state.accounts[from]?.off ? { from, to, name } : null;
};
app.post("/api/site-admin/give", express.json(), (req, res) => {
  if (!siteOwnerOk(req)) return res.status(403).json({ error: "key" });
  const g = giveArgs(req.body);
  if (!g) return res.status(400).json({ error: "args" });
  if (!giveBook(g.from, g.to, g.name)) return res.status(404).json({ error: "book" });
  res.json({ ok: true, name: g.name });
});
// «Завантажити й поділитися»: the file the asked one chose on the site, under the same rules as an upload here
// (size, language, no pornography), goes into their library and then the asker's.
app.post("/api/site-admin/give-file", express.raw({ type: () => true, limit: 100 * 1024 * 1024 }), async (req, res) => {
  if (!siteOwnerOk(req)) return res.status(403).json({ error: "key" });
  const g = giveArgs(req.query);
  if (!g) return res.status(400).json({ error: "Підтримуються лише EPUB і PDF." });
  if (!req.body?.length) return res.status(400).json({ error: "Порожній файл." });
  const lib = libOf(g.from);
  if (!fs.existsSync(bookFile(lib, g.name))) {
    const lang = await bookLanguage(g.name, req.body);
    if (lang === "ru") return res.status(400).json({ error: "Книжки російською мовою в Chytai не завантажуються." });
    if (lang === "other") return res.status(400).json({ error: "Поки що Chytai читає книжки українською та англійською." });
    if ((await checkUpload(g.name, req.body)).blocked) return res.status(400).json({ error: "Схоже, це порнографія чи еротика, тому Chytai не додав книжку." });
    fs.mkdirSync(lib.dir, { recursive: true });
    store.writeBook(bookFile(lib, g.name), req.body);
    (lib.meta.added ??= {})[g.name] = { by: g.from, at: Date.now() };
    saveState();
    warmCovers(lib, [g.name]);
    tellSite(g.from);
  }
  giveBook(g.from, g.to, g.name);
  res.json({ ok: true, name: g.name });
});

// The site's watchman (Max, 2026-11-04: «а у нас зараз немає такої перевірки?»): every 5 minutes the reader opens
// chytai.org.ua; two misses in a row go to the owner's Telegram bot, and so does the site coming back. The site
// checks the reader the same way (web/telegram.js), so each watches the other. TELEGRAM_BOT_TOKEN in this app's
// secrets; the chat is the one the site linked, sent here by the site with the owner's key.
app.post("/api/site-admin/telegram", express.json(), (req, res) => {
  if (!siteOwnerOk(req)) return res.status(403).json({ error: "key" });
  const chat = String(req.body?.chat || "");
  if (!/^-?\d{1,20}$/.test(chat)) return res.status(400).json({ error: "chat" });
  if (state.telegramChat !== chat) (state.telegramChat = chat), saveState();
  res.json({ ok: true, token: !!process.env.TELEGRAM_BOT_TOKEN });
});
function telegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !state.telegramChat) return;
  fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: state.telegramChat, text, disable_web_page_preview: true }), signal: AbortSignal.timeout(15000) }).catch((e) => console.error(`telegram: ${e.message}`));
}
if (process.env.TELEGRAM_BOT_TOKEN && process.env.FLY_APP_NAME) {
  let misses = 0;
  let downSince = 0;
  setInterval(async () => {
    let ok = false;
    try {
      ok = (await fetch(`${WEB_URL}/`, { signal: AbortSignal.timeout(20000), headers: { "User-Agent": "ChytaiReaderWatch" } })).status < 500;
    } catch {}
    misses = ok ? 0 : misses + 1;
    if (misses === 2 && !downSince) {
      downSince = Date.now() - 5 * 60000;
      telegram(`Сайт не відповідає: ${WEB_URL}`);
    } else if (ok && downSince) {
      telegram(`Сайт знову працює (не відповідав з ${new Date(downSince).toLocaleTimeString("uk-UA", { timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit" })}).`);
      downSince = 0;
    }
  }, 5 * 60000).unref();
}

// The reader's scripts, styles and fonts need no account (the code is public on GitHub anyway): the
// service worker fetches them for the offline copy, and in the Android app its requests came without
// the sign-in cookie, so it got the /login page back as style.css and the reader showed unstyled.
// Only the page itself (/) stays behind the sign-in below.
const publicRenderer = express.static(path.join(ROOT, "src", "renderer"), { index: false });
app.use("/node_modules", express.static(path.join(ROOT, "node_modules"), { index: false, maxAge: "7d" }));
app.use((req, res, next) => (req.path === "/index.html" ? next() : publicRenderer(req, res, next)));

// ---------- OPDS: a reader's books on an e-ink reader (Max, XT-Ink with CrossPoint, 2026-11-05) ----------
// The device keeps a catalog address; the secret token in it stands for the account (no cookie, no
// e-mail code there). Only the reader's own EPUBs and free-shelf books they took: a PDF or a publisher's
// book stays in the reader. A new address in the settings turns the old one off.
const opds = require("./opds");
const opdsAcct = (token) => {
  const o = /^[A-Za-z0-9_-]{20,64}$/.test(token || "") ? state.opds[token] : null;
  return o && !state.accounts[o.acct]?.off ? o : null;
};
async function opdsBooks(acct) {
  const lib = libOf(acct);
  const u = userState(acct);
  const added = lib.meta.added || {};
  const books = (await scanLibrary(lib))
    .filter((b) => b.ext === "epub")
    .map((b) => {
      const name = path.relative(lib.dir, b.path);
      return { name, file: b.path, title: b.title, authors: b.authors, at: u.opened?.[name] || added[name]?.at || b.mtime || 0 };
    });
  const own = new Set(books.map((b) => b.name));
  const shelf = new Map(freeShelf.map((f) => [f.name, f]));
  const free = await library.scan([FREE_DIR, FREE_VOLUME_DIR].filter((d) => fs.existsSync(d)), FREE_CACHE).catch(() => []);
  for (const b of free) {
    const name = path.basename(b.path);
    if (own.has(name) || !/\.epub$/i.test(name) || notYet(name) || !(u.opened?.[name] || u.taken?.[name] || u.positions?.[name])) continue;
    const m = shelf.get(name) || {};
    books.push({ name, file: b.path, title: m.title || b.title, authors: m.authors?.length ? m.authors : b.authors, at: u.opened?.[name] || u.taken?.[name] || 0, free: true });
  }
  for (const b of books) b.id = customCoverKey(b.name);
  return books.sort((x, y) => y.at - x.at || x.title.localeCompare(y.title, "uk"));
}
// The cover's file and type, if the device can show it (JPEG or PNG).
async function opdsCover(acct, b) {
  const custom = b.free ? freeCover(b.name) : customCover(libOf(acct), b.name);
  if (custom) return /\.(jpe?g|png)$/i.test(custom) ? { file: custom, type: COVER_TYPES[path.extname(custom).slice(1).toLowerCase()] } : null;
  try {
    const cached = await coverFile(b.file);
    const ext = path.extname(cached).slice(1);
    return ["jpg", "jpeg", "png"].includes(ext) ? { file: path.join(COVER_DIR, cached), type: COVER_TYPES[ext] } : null;
  } catch {
    return null;
  }
}
app.get("/opds/:token", async (req, res, next) => {
  const o = opdsAcct(req.params.token);
  if (!o) return res.status(404).type("text").send("Адреса каталогу застаріла. Нову можна взяти в налаштуваннях Читалки.");
  try {
    const q = String(req.query.q || "").trim().slice(0, 100);
    const all = await opdsBooks(o.acct);
    const books = q ? opds.search(all, q) : all;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const shown = books.slice((page - 1) * opds.PAGE, page * opds.PAGE);
    for (const b of shown) b.cover = (await opdsCover(o.acct, b))?.type || "";
    if (Date.now() - (o.used || 0) > 3600e3) console.log("opds feed", o.acct, all.length, "books");
    o.used = Date.now();
    saveState();
    res.type(opds.FEED).send(opds.feed({ base: `/opds/${req.params.token}`, books, page, q, updated: all[0]?.at }));
  } catch (err) {
    next(err);
  }
});
app.get("/opds/:token/cover/:id", async (req, res) => {
  const o = opdsAcct(req.params.token);
  const b = o && (await opdsBooks(o.acct)).find((x) => x.id === req.params.id);
  const cover = b && (await opdsCover(o.acct, b));
  if (!cover) return res.status(404).end();
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.type(cover.type).sendFile(cover.file);
});
app.get("/opds/:token/book/:file", async (req, res) => {
  const o = opdsAcct(req.params.token);
  const id = req.params.file.replace(/\.epub$/i, "");
  const b = o && (await opdsBooks(o.acct)).find((x) => x.id === id);
  if (!b || !fs.existsSync(b.file)) return res.status(404).end();
  o.downloads = (o.downloads || 0) + 1;
  saveState();
  console.log("opds download", o.acct, b.name);
  res.type("application/epub+zip").sendFile(b.file);
});

app.use((req, res, next) => {
  const acct = currentAccount(req);
  const share = acct ? null : currentShare(req);
  const guest = acct ? null : share ? `share:${share.token}` : currentGuest(req);
  if (!acct && !guest) {
    if (req.path.startsWith("/api/")) return res.status(401).json({ error: "login" });
    if (req.path === "/" && req.method === "GET") return signedOutPage(req, res);
    return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
  // Max can switch the reader off for one account (/admin); the site stays theirs.
  if (acct && state.accounts[acct]?.off) {
    if (req.path.startsWith("/api/")) return res.status(403).json({ error: "Читалку для цього акаунта вимкнено." });
    return res.status(403).type("html").send(loginPage(req, "Читалку для цього акаунта вимкнено. Якщо це помилка, напишіть Максові."));
  }
  // Only on the page itself, so the many calls a page makes at once don't each start a session.
  if (acct && req.upgradeSession === acct && req.method === "GET" && req.path === "/") res.append("Set-Cookie", [cookieHeader(req, COOKIE, newSession(acct), COOKIE_DAYS), cookieHeader(req, OLD_COOKIE, "", 0)]);
  req.acct = acct || null;
  req.owner = acct === OWNER_ID;
  req.user = acct ? accountName(acct) : "Гість";
  req.guest = guest;
  req.share = share;
  req.free = guest && !share ? currentFree(req) : null;
  // A free book's guest reads; explanations and notes come with an account.
  if (req.free && req.method !== "GET" && /^\/api\/(explain|notes)/.test(req.path)) return res.status(403).json({ error: "Пояснення і нотатки працюють після входу." });
  req.lib = acct ? libOf(acct) : null;
  next();
});

const guestsCannot = (message) => (req, res, next) => (req.guest ? res.status(403).json({ error: message }) : next());

// The dashboard moved to the site's admin (Max, 2026-11-02).
app.get("/admin", (_req, res) => res.redirect(`${WEB_URL}/admin/reader`));

// Static renderer: index.html at /, its scripts next to it, node_modules at /node_modules
// (so the renderer's ../../node_modules/… paths resolve, as they do under file:// in Electron).
app.get("/", (_req, res) => res.sendFile(path.join(ROOT, "src", "renderer", "index.html")));

// ---------- API ----------

const api = express.Router();
api.use(express.json({ limit: "20mb" }));

api.get("/settings", (req, res) => res.json(settingsFor(req)));

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

// Seconds of reading since the last report, per book (reading-time.js; sendBeacon sends text/plain).
api.post("/reading", express.text({ limit: "16kb" }), (req, res) => {
  let body = req.body;
  if (typeof body === "string") try { body = JSON.parse(body); } catch { body = null; }
  const books = body?.books;
  if (!books || typeof books !== "object" || Array.isArray(books)) return res.status(400).json({ error: "bad request" });
  if (req.guest) return res.json({ ok: true });
  const clean = {};
  for (const [name, sec] of Object.entries(books).slice(0, 20)) if (name && name.length <= 500 && Number.isFinite(sec) && sec > 0) clean[name.replace(/#reflow$/, "")] = (clean[name.replace(/#reflow$/, "")] || 0) + Math.min(sec, body.at ? 3600 : 600);
  recordReading(req.acct, clean, Number(body.at) || 0);
  saveState();
  res.json({ ok: true });
});
api.put("/position", (req, res) => {
  const { path: bookPath, cfi, pct, chapter, part, parts } = req.body || {};
  if (typeof bookPath !== "string" || typeof cfi !== "string") return res.status(400).json({ error: "bad request" });
  const u = req.guest ? guestState(req.guest) : userState(req.acct);
  const name = bookPath.replace(/#reflow$/, "");
  u.positions ??= {};
  u.positions[bookPath] = cfi;
  (u.opened ??= {})[name] = Date.now();
  if (!req.guest && !req.share) noteReadingNow(req.acct, name);
  if (u.setAside) delete u.setAside[name];
  // How far in and which chapter, for the home screen: the position itself is a CFI it cannot read.
  if (Number.isFinite(pct)) {
    (u.progress ??= {})[name] = { pct: Math.max(0, Math.min(100, Math.round(pct))), chapter: typeof chapter === "string" ? chapter.slice(0, 200) : "", ...(Number.isInteger(part) && Number.isInteger(parts) && part > 0 && part <= parts && parts < 10000 ? { part, parts } : {}) };
  }
  if (!req.guest || req.share) saveState();
  res.json({ ok: true });
});

// ---------- Notes: passages a reader saved with "В нотатки", per person and per book ----------

const NOTE_TEXT_MAX = 4000;

// «Цей тиждень» (Max 2026-11-06): your own minutes, never anyone else's. Seconds per day of this week (Monday
// first, Kyiv time), per book this week, and last week's total for the page behind the panel's block.
// No streaks and no nudges: it only counts. 14 day lookups, nothing stored.
const READ_EXACT_FROM = "2026-11-04";
api.get("/week", (req, res) => {
  if (req.guest) return res.json({ days: [], books: [], weeks: [] });
  const days = state.stats?.days || {};
  const today = statsDay();
  const noon = (d) => Date.parse(`${d}T12:00:00Z`);
  const monday = noon(today) - ((new Date(noon(today)).getUTCDay() + 6) % 7) * 86400000;
  const key = (t) => new Date(t).toISOString().slice(0, 10);
  // Before 2026-11-04 minutes were guessed from the gaps between page turns, in total only, with no books:
  // those days would make the week bigger than its books (Max 2026-11-06), so they are left out.
  const secOf = (t) => (key(t) >= READ_EXACT_FROM ? days[key(t)]?.readSec?.[req.acct] || 0 : 0);
  const week = [...Array(7)].map((_, i) => secOf(monday + i * 86400000));
  const books = new Map();
  for (let i = 0; i < 7; i++) {
    if (key(monday + i * 86400000) < READ_EXACT_FROM) continue;
    for (const [name, sec] of Object.entries(days[key(monday + i * 86400000)]?.readBooks?.[req.acct] || {})) books.set(name, (books.get(name) || 0) + sec);
  }
  const weeks = [...Array(2)].map((_, w) => {
    const from = monday - w * 7 * 86400000;
    return { from: key(from), sec: [...Array(7)].reduce((a, _, i) => a + secOf(from + i * 86400000), 0) };
  });
  res.json({
    today: (new Date(noon(today)).getUTCDay() + 6) % 7,
    days: week,
    books: [...books].sort((a, b) => b[1] - a[1]).map(([name, sec]) => ({ name, sec, ...bookInfo(req.acct, name) })),
    weeks,
  });
});

api.get("/notes", (req, res) => {
  res.json({ notes: bookItems(req, "notes", String(req.query.path || "")) });
});

// Every note of this reader, for the home screen's Нотатки: { "<book>": [note, …] }.
api.get("/notes/all", (req, res) => {
  res.json({ books: allBookItems(req, "notes") });
});

// The panel's search goes past titles: the reader's notes and talks with Claude (server/search.js).
api.get("/search", (req, res) => {
  const q = String(req.query.q || "").slice(0, 200);
  const u = req.guest ? guestState(req.guest) : userState(req.acct);
  const mine = Object.fromEntries(store.KINDS.map((k) => [k, allBookItems(req, k)]));
  res.json({ hits: searchReader({ ...u, ...mine }, q) });
});

api.post("/notes", (req, res) => {
  const { path: bookPath, cfi, posKey, text, chapter } = req.body || {};
  if (typeof bookPath !== "string" || typeof cfi !== "string" || typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "bad request" });
  }
  const existing = bookItems(req, "notes", bookPath).find((n) => n.cfi === cfi);
  if (existing) return res.json({ note: existing });
  const note = {
    id: crypto.randomBytes(6).toString("hex"),
    cfi,
    posKey: typeof posKey === "string" ? posKey : bookPath,
    text: text.trim().slice(0, NOTE_TEXT_MAX),
    chapter: typeof chapter === "string" ? chapter.slice(0, 200) : "",
    comment: "",
    createdAt: Date.now(),
    // A quote from a paper book's page photo (paper.js), drawn as a quote among the notes.
    ...(req.body.quote === true ? { quote: true } : {}),
  };
  putBookItem(req, "notes", bookPath, note);
  if (!req.guest && (note.quote || !paper.NAME.test(bookPath))) tellQuotes(req.acct, bookPath);
  res.json({ note });
});

api.patch("/notes/:id", (req, res) => {
  const bookPath = String(req.query.path || "");
  const list = bookItems(req, "notes", bookPath);
  const note = list.find((n) => n.id === req.params.id);
  if (!note) return res.status(404).json({ error: "Нотатки немає." });
  if (typeof req.body?.comment === "string") note.comment = req.body.comment.slice(0, NOTE_TEXT_MAX);
  // A paper book's note is the reader's own words, so its text can be edited too (Max 2026-11-03).
  // So is a note an e-book reader wrote with «+ Нотатка» (cfi «mine:…», 2026-11-03).
  if ((paper.NAME.test(String(req.query.path || "")) || String(note.cfi).startsWith("mine:")) && typeof req.body?.text === "string" && req.body.text.trim()) note.text = req.body.text.trim().slice(0, NOTE_TEXT_MAX);
  // «Цитата» / «Не цитата» on a paper book's note (Max 2026-11-04).
  if (paper.NAME.test(String(req.query.path || "")) && typeof req.body?.quote === "boolean") {
    if (req.body.quote) note.quote = true;
    else delete note.quote;
  }
  // And its page (Max 2026-11-04: the page it was added on is usually right, not always).
  if (paper.NAME.test(String(req.query.path || "")) && req.body?.page !== undefined) {
    const n = Math.floor(Number(req.body.page));
    note.chapter = n > 0 && n < 100000 ? `стор. ${n}` : "";
  }
  saveBookItems(req, "notes", bookPath, list);
  if (!req.guest) tellQuotes(req.acct, bookPath);
  res.json({ note });
});

api.delete("/notes/:id", (req, res) => {
  const bookPath = String(req.query.path || "");
  saveBookItems(req, "notes", bookPath, bookItems(req, "notes", bookPath).filter((n) => n.id !== req.params.id));
  if (!req.guest) tellQuotes(req.acct, bookPath);
  res.json({ ok: true });
});

// Explanations and answers asked in a book, kept (Max 2026-11-03: «так само зберігати пояснення і відповіді
// для звичайних електронних», as for paper books): u.chats[book] = [{ id, cfi, posKey, mode, sel, chapter,
// turns: [{ q, a }], messages, model, at }]. Reopening the book brings the cards and the marks back; follow-ups
// go on from the kept talk. A guest's live only as long as the guest's session, like the guest's notes.
const BOOK_CHATS_MAX = 500;
api.get("/chats", (req, res) => {
  res.json({ chats: bookItems(req, "chats", String(req.query.path || "")) });
});
api.put("/chats/:id", (req, res) => {
  const { path: bookPath, cfi, posKey, mode, sel, chapter, turns, messages, model, at } = req.body || {};
  if (typeof bookPath !== "string" || !bookPath || typeof cfi !== "string" || !cfi || !/^[A-Za-z0-9_-]{4,40}$/.test(req.params.id) || !Array.isArray(turns) || !turns.length) {
    return res.status(400).json({ error: "bad request" });
  }
  const chat = {
    id: req.params.id,
    cfi: cfi.slice(0, 2000),
    posKey: typeof posKey === "string" ? posKey.slice(0, 2000) : bookPath,
    mode: mode === "translate" ? "translate" : "explain",
    sel: typeof sel === "string" ? sel.slice(0, 4000) : "",
    chapter: typeof chapter === "string" ? chapter.slice(0, 200) : "",
    turns: turns.slice(-50).map((t) => ({ q: String(t?.q || "").slice(0, 4000), a: String(t?.a || "").slice(0, 20000) })),
    messages: Array.isArray(messages) ? messages : null,
    model: typeof model === "string" ? model.slice(0, 80) : "",
    at: Number.isFinite(at) ? at : Date.now(),
  };
  // A long talk keeps its turns for reading, but no longer goes on from where it was.
  if (JSON.stringify(chat.messages || "").length > CHAT_BYTES) chat.messages = null;
  putBookItem(req, "chats", bookPath, chat, BOOK_CHATS_MAX);
  res.json({ ok: true });
});
// One explanation («Очистити розмову»), or with no id every one in the book (the panel's «Очистити»).
api.delete(["/chats/:id", "/chats"], (req, res) => {
  const bookPath = String(req.query.path || "");
  saveBookItems(req, "chats", bookPath, req.params.id ? bookItems(req, "chats", bookPath).filter((c) => c.id !== req.params.id) : []);
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
      store.items.dropAccount(id);
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

// Quotes go to the site, which shows one of them at random on the book's page (Max, 2026-11-06): a paper book's
// notes marked «Цитата», and an e-book's saved passages («Зберегти»; not a note the reader wrote, cfi «mine:»).
// Only the quoted words and the page; the whole list of the book each time, so a quote unmarked, edited or
// deleted (or the book gone) is gone there too. Sent a moment after the last change.
const quoteTimers = new Map();
const QUOTE_PAGE = /^стор\. (\d+)/;
function tellQuotes(acct, bookPath) {
  const name = String(bookPath || "").replace(/#reflow$/, "");
  if (!acct || !name || !state.accounts[acct]?.key) return;
  const k = `${acct}\t${name}`;
  clearTimeout(quoteTimers.get(k));
  quoteTimers.set(k, setTimeout(() => {
    quoteTimers.delete(k);
    sendQuotes(acct, name).catch((err) => console.error(`reader-quotes ${acct}:`, err.message));
  }, 2000));
}
function quotesOf(acct, name) {
  if (paper.NAME.test(name)) {
    if (!state.users[acct]?.paper?.[name]) return [];
    return store.items.list(acct, "notes", name).filter((n) => n.quote && n.text).map((n) => ({ id: n.id, text: n.text, page: Number(QUOTE_PAGE.exec(n.chapter || "")?.[1]) || 0 }));
  }
  return [name, `${name}#reflow`].flatMap((b) => store.items.list(acct, "notes", b)).filter((n) => n.text && !String(n.cfi).startsWith("mine:")).map((n) => ({ id: n.id, text: n.text, page: 0 }));
}
async function sendQuotes(acct, name) {
  const pb = paper.NAME.test(name) ? state.users[acct]?.paper?.[name] : null;
  const info = bookInfo(acct, name);
  const book = { name, title: info.title, authors: info.authors, href: pb?.href || "" };
  const res = await fetch(`${WEB_URL}/api/reader-quotes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: acct, key: state.accounts[acct].key, book, quotes: quotesOf(acct, name) }), signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${res.status}`);
}
// The quotes kept before this went to the site, once (2: e-books' saved passages too).
setTimeout(async () => {
  if (store.meta.get("quotes:sent2")) return;
  try {
    const books = new Set(store.quoteBooks().map(({ acct, book }) => `${acct}\t${book.replace(/#reflow$/, "")}`));
    for (const k of books) {
      const [acct, name] = k.split("\t");
      if (state.accounts[acct]?.key) await sendQuotes(acct, name);
    }
    store.meta.set("quotes:sent2", new Date().toISOString());
  } catch (err) {
    console.error("reader-quotes (all):", err.message);
  }
}, 90 * 1000).unref();

// «Читаю зараз» on the site follows the reader (Max, 2026-11-01: «Автоматом встановлювати Читаю зараз з
// читалки»): a book read here for a few minutes goes to the site once a day; the site puts it on «Читаю зараз»
// unless the account turned that off in its settings there or already has the book as «Прочитано».
const NOW_AFTER = 3 * 60 * 1000;
// What the reader knows of a book without opening it: paper books, the free shelf, publishers' books.
function bookInfo(acct, name) {
  const pb = paper.NAME.test(name) ? state.users[acct]?.paper?.[name] : null;
  const info = pb ? { title: pb.title, author: pb.author } : freeShelf.find((f) => f.name === name) || prot.meta(name) || {};
  return { title: info.title || "", authors: Array.isArray(info.authors) ? info.authors : info.author ? [info.author] : [], paper: !!pb };
}
const readingSince = new Map(); // "acct\tbook" -> { from, last, told: day }
function noteReadingNow(acct, name) {
  if (!state.accounts[acct]?.key || !name) return;
  const key = `${acct}\t${name}`;
  const t = Date.now();
  let r = readingSince.get(key);
  if (!r || t - r.last > READ_GAP * 4) r = { from: t, last: t, told: r?.told };
  r.last = t;
  readingSince.set(key, r);
  const day = statsDay(t);
  if (r.told === day || t - r.from < NOW_AFTER) return;
  r.told = day;
  const info = bookInfo(acct, name);
  const book = { name, title: info.title, authors: info.authors };
  fetch(`${WEB_URL}/api/reader-now`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: acct, key: state.accounts[acct].key, book }), signal: AbortSignal.timeout(20000) })
    .then((res) => res.ok || console.error(`reader-now ${acct}: ${res.status}`))
    .catch((err) => console.error(`reader-now ${acct}:`, err.message));
}
setInterval(() => {
  for (const [k, r] of readingSince) if (Date.now() - r.last > 24 * 3600 * 1000) readingSince.delete(k);
}, 3600 * 1000).unref();

// Chapters of publishers' protected books read here go to the site for the publishers' reports (reads.js).
const reads = require("./reads");
reads.init({ dataDir: DATA_DIR, webUrl: WEB_URL, keyOf: (id) => state.accounts[id]?.key, info: (name) => prot.meta(name), list: () => prot.metas() });

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
  if (paper.NAME.test(base)) return base;
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
      ...b, dir: undefined, path: name, cloud: false, openedAt, aside, finished: !!u.finished?.[name],
      started: !aside && !!(positions[name] || positions[`${name}#reflow`]),
      pct: progress ? progress.pct : null,
      chapter: progress?.chapter || "",
      part: progress?.part || 0, parts: progress?.parts || 0,
      // Who put the book in the library and when; books from before this was recorded have only the file's date.
      addedAt: added[name]?.at || b.mtime || 0,
      addedBy: who(added[name]?.by),
      // When a cover was set by hand, so the cover's address changes with it.
      coverAt: custom ? Math.round(fs.statSync(path.join(coverDir, custom)).mtimeMs) : 0,
      seen: !!(openedAt || aside || u.seen?.[name]) || (!!req.acct && added[name]?.by === req.acct),
    };
  });
  // «Вільна полиця»: everyone's, except the books this reader has a copy of. One taken from it (opened and
  // not put aside) is also among the reader's books, so it shows in «Продовжити» and the library.
  let free = [];
  if (!req.guest) {
    const own = new Set(list.map((b) => b.path));
    const shelf = new Map(freeShelf.map((f, i) => [f.name, { ...f, order: i }]));
    const scanned = await library.scan([FREE_DIR, FREE_VOLUME_DIR].filter((d) => fs.existsSync(d)), FREE_CACHE).catch(() => []);
    free = scanned
      .filter((b) => !notYet(path.basename(b.path)))
      .map((b) => {
        const name = path.basename(b.path);
        const m = shelf.get(name) || {};
        const progress = u.progress?.[name];
        const aside = !!u.setAside?.[name];
        return {
          ...b, path: name, cloud: false, free: true, group: m.group || "", order: m.order ?? 1e6,
          title: m.title || b.title, authors: m.authors?.length ? m.authors : b.authors, year: m.year || b.year,
          openedAt: aside ? 0 : u.opened?.[name] || 0, aside, finished: !!u.finished?.[name],
          started: !aside && !!positions[name], pct: aside || !progress ? null : progress.pct, chapter: (!aside && progress?.chapter) || "", part: progress?.part || 0, parts: progress?.parts || 0,
          addedAt: u.taken?.[name] || 0, addedBy: "", coverAt: freeCover(name) ? Math.round(fs.statSync(freeCover(name)).mtimeMs) : 0, seen: true,
        };
      })
      .filter((b) => !own.has(b.path))
      .sort((x, y) => x.order - y.order || x.title.localeCompare(y.title, "uk"));
    list.push(...free.filter((b) => b.openedAt || b.started || (b.addedAt && !b.aside)));
    // A publisher's book shows among the reader's own once opened (from its page on the site).
    const pub = (await library.scan([prot.dir], path.join(DATA_DIR, "protected-cache.json")).catch(() => [])).filter((b) => !own.has(path.basename(b.path)));
    for (const b of pub) {
      const name = path.basename(b.path);
      const aside = !!u.setAside?.[name];
      const progress = u.progress?.[name];
      const openedAt = aside ? 0 : u.opened?.[name] || 0;
      if (!openedAt && !positions[name]) continue;
      const m = prot.meta(name);
      list.push({
        ...b, title: m.title || b.title, authors: m.authors?.length ? m.authors : b.authors, path: name, cloud: false, protected: true, openedAt, aside, finished: !!u.finished?.[name],
        started: !aside && !!positions[name], pct: aside || !progress ? null : progress.pct, chapter: (!aside && progress?.chapter) || "", part: progress?.part || 0, parts: progress?.parts || 0,
        addedAt: 0, addedBy: "", coverAt: 0, seen: true,
      });
    }
  }
  if (!req.guest) for (const [name, p] of Object.entries(u.paper || {})) list.push(paper.listEntry(name, p, u));
  res.json({ folders: [], books: list, free, lastBook: u.lastBook || (req.guest ? guestBooks(req)[0]?.name : null) || null });
});

api.get("/book", (req, res) => {
  const name = safeBookName(req.query.path);
  const demo = req.guest ? guestBooks(req).find((d) => d.name === name) : null;
  const file = req.guest ? demo && path.join(demo.dir, demo.name) : readerFile(req.lib, name);
  if (!file || !fs.existsSync(file)) return res.status(404).json({ error: "Книжки немає на сервері." });
  // keep=1: the page fetches a book in progress onto the device for offline reading (web-bridge.js keepOnDevice).
  // Just the file: the book is not marked as opened, and a publisher's book is never kept on a device.
  if (req.query.keep) return file.startsWith(prot.dir + path.sep) ? res.status(204).end() : res.sendFile(file);
  const u = req.guest ? guestState(req.guest) : userState(req.acct);
  u.lastBook = name;
  (u.opened ??= {})[name] = Date.now();
  if (u.setAside) delete u.setAside[name];
  if (!req.guest || req.share) saveState();
  res.setHeader("X-Book-Position", encodeURIComponent(u.positions?.[name] || ""));
  res.setHeader("X-Book-Reflow-Position", encodeURIComponent(u.positions?.[`${name}#reflow`] || ""));
  // A publisher's book: never the file, only where to read it from.
  if (file.startsWith(prot.dir + path.sep)) return res.json({ ...prot.info(inApp(req)), base: `/api/pbook/${encodeURIComponent(name)}/` });
  res.sendFile(file);
});

// One entry of a publisher's book: GET /api/pbook/<book>/<path inside the EPUB>.
api.get("/pbook/:name/*entry", async (req, res, next) => {
  if (req.guest) return res.status(403).json({ error: "login" });
  const name = safeBookName(req.params.name);
  if (!name || fs.existsSync(bookFile(req.lib, name)) || isFree(name)) return res.status(404).end();
  try {
    await prot.serve(req, res, { reader: req.acct, name, entry: [].concat(req.params.entry).join("/"), full: inApp(req) });
  } catch (err) {
    next(err);
  }
});
// The page shows a chapter of a publisher's book: POST /api/pbook-read { path, chapter } (publishers' reports).
api.post("/pbook-read", async (req, res) => {
  if (req.guest) return res.status(204).end();
  const chapter = Number(req.body?.chapter);
  if (Number.isInteger(chapter) && chapter >= 0) await prot.read({ reader: req.acct, name: safeBookName(req.body?.path), chapter }).catch(() => {});
  res.status(204).end();
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

// What the reader shows is a small copy: a book's own cover is often 1400×2100 or more, about 12 MB once an
// iPhone decodes it, and a shelf of thirty covers was enough for iOS to unload the app's page for memory (Max
// 2026-11-05). 400 pixels wide is sharp on a phone's 3× screen and on a computer's grid. Made once, kept beside.
const THUMB_W = 400;
let sharp = null;
try {
  sharp = require("sharp");
  sharp.cache(false);
  sharp.concurrency(1);
} catch (err) {
  console.warn("sharp", err.message);
}
const thumbJobs = new Map();
async function thumbFile(src) {
  if (!sharp) return null;
  const st = fs.statSync(src);
  const key = crypto.createHash("sha1").update(`${src}:${st.size}:${st.mtimeMs}:${THUMB_W}`).digest("hex").slice(0, 16);
  const out = path.join(COVER_DIR, `t-${key}.webp`);
  if (fs.existsSync(out)) return fs.statSync(out).size ? out : null;
  if (!thumbJobs.has(out)) {
    thumbJobs.set(out, (async () => {
      fs.mkdirSync(COVER_DIR, { recursive: true });
      try {
        const buf = await sharp(src, { limitInputPixels: 60_000_000 }).rotate().resize({ width: THUMB_W, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
        fs.writeFileSync(out, buf);
        return out;
      } catch (err) {
        console.warn("thumb", path.basename(src), err.message);
        fs.writeFileSync(out, ""); // a picture sharp cannot read is sent as it is from now on
        return null;
      } finally {
        thumbJobs.delete(out);
      }
    })());
  }
  return thumbJobs.get(out);
}
async function sendCover(res, file, type) {
  res.setHeader("Cache-Control", "private, max-age=2592000, immutable");
  const thumb = await thumbFile(file).catch(() => null);
  if (thumb) return res.type("image/webp").sendFile(thumb);
  res.type(type).sendFile(file);
}

// Covers are taken out of the books ahead of time (at start and on upload), so nobody waits for the first one.
async function warmCovers(lib, names) {
  for (const name of names) {
    try {
      if (!/\.epub$/i.test(name)) continue;
      const cached = await coverFile(bookFile(lib, name));
      if (!cached.endsWith(".none")) await thumbFile(path.join(COVER_DIR, cached));
    } catch (err) {
      console.warn("cover", name, err.message);
    }
  }
}

// Cleaning up after the caches (Max 2026-11-06: «будь-яку кількість місця можна забити, якщо ніколи не робити
// прибирання»). COVER_DIR had grown to 560 MB of the 3 GB volume: covers of books deleted or replaced, and small
// copies of covers that changed (the repo's free-shelf covers get a new date with every deploy). Once a day it keeps
// what some book or picture still on the disk would ask for and removes the rest, if untouched for a day (a cover
// being made right now is never caught). A wrongly removed one would only be taken out of its book again.
// The «як книжка» copies of PDFs (reflow/) have the reader's version in their name, so they go after 60 days
// unread instead (GET /reflow marks one as read).
const REFLOW_DAYS = 60;
function sweepCaches() {
  const t0 = Date.now();
  const keep = new Set();
  const coverKey = (file, st) => crypto.createHash("sha1").update(`${file}:${st.size}:${st.mtimeMs}`).digest("hex").slice(0, 16);
  const thumbKey = (file, st) => crypto.createHash("sha1").update(`${file}:${st.size}:${st.mtimeMs}:${THUMB_W}`).digest("hex").slice(0, 16);
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const file = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (file !== REFLOW_DIR && e.name !== "reflow" && e.name !== "node_modules") walk(file);
        continue;
      }
      if (dir === COVER_DIR) continue;
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (/\.epub$/i.test(e.name)) keep.add(coverKey(file, st));
      else if (/\.(jpe?g|png|gif|webp)$/i.test(e.name)) keep.add(`t-${thumbKey(file, st)}`);
    }
  };
  for (const dir of [DATA_DIR, FREE_DIR, ...DEMO_DIRS]) walk(dir);
  // The covers taken out of the books that stay, and their small copies.
  let names = [];
  try {
    names = fs.readdirSync(COVER_DIR, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  } catch {}
  for (const n of names) {
    if (n.startsWith("t-") || !keep.has(n.split(".")[0])) continue;
    try {
      keep.add(`t-${thumbKey(path.join(COVER_DIR, n), fs.statSync(path.join(COVER_DIR, n)))}`);
    } catch {}
  }
  const dayAgo = Date.now() - 864e5;
  let n = 0, bytes = 0;
  const drop = (file, st) => {
    try {
      fs.rmSync(file, { force: true });
      n++, (bytes += st.size);
    } catch {}
  };
  for (const name of names) {
    if (keep.has(name.split(".")[0])) continue;
    const file = path.join(COVER_DIR, name);
    try {
      const st = fs.statSync(file);
      if (st.mtimeMs < dayAgo) drop(file, st);
    } catch {}
  }
  const reflowOld = Date.now() - REFLOW_DAYS * 864e5;
  let accounts = [];
  try {
    accounts = fs.readdirSync(ACCOUNTS_DIR);
  } catch {}
  for (const dir of [REFLOW_DIR, ...accounts.map((id) => path.join(ACCOUNTS_DIR, id, "reflow"))]) {
    let files = [];
    try {
      files = fs.readdirSync(dir);
    } catch {}
    for (const f of files) {
      try {
        const st = fs.statSync(path.join(dir, f));
        if (st.isFile() && st.mtimeMs < reflowOld) drop(path.join(dir, f), st);
      } catch {}
    }
  }
  console.log(`caches: ${n} files removed, ${(bytes / 1e6).toFixed(1)} MB, ${Date.now() - t0} ms`);
  return { n, bytes };
}
setTimeout(sweepCaches, 10 * 60 * 1000).unref();
setInterval(sweepCaches, 24 * 3600 * 1000).unref();

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
  let file = req.guest ? demo && path.join(demo.dir, demo.name) : readerFile(req.lib, name);
  // A book in «Нещодавно видалені» keeps its cover there.
  if (file && !fs.existsSync(file) && !req.guest && req.lib.meta.trash?.[name]) file = trashFile(req.lib, name);
  if (!file || !fs.existsSync(file)) return res.status(404).end();
  const custom = !req.guest && (customCover(req.lib, name) || ([FREE_DIR, FREE_VOLUME_DIR].some((d) => file.startsWith(d + path.sep)) && freeCover(name)));
  if (custom) return sendCover(res, custom, COVER_TYPES[path.extname(custom).slice(1)]);
  if (!/\.epub$/i.test(file)) return res.status(404).end();
  try {
    const cached = await coverFile(file);
    const ext = path.extname(cached).slice(1);
    if (ext === "none") return res.status(404).end();
    // The URL carries the file's date, so a replaced book gets a new address.
    await sendCover(res, path.join(COVER_DIR, cached), COVER_TYPES[ext]);
  } catch {
    res.status(404).end();
  }
});

// Set a book's cover by hand: PUT /api/cover?path=<book> with a JPEG, PNG or WebP image as the body.
api.put("/cover", guestsCannot("Без входу не можна змінювати обкладинки."), express.raw({ type: () => true, limit: "5mb" }), (req, res) => {
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

// The address of the reader's OPDS catalog: GET /api/opds { url }, POST /api/opds makes a new one (the old stops).
const opdsUrl = (req, token) => (token ? `${READER_DOMAIN ? `https://${READER_DOMAIN}` : `${req.protocol}://${req.get("host")}`}/opds/${token}` : null);
const myOpds = (req) => Object.keys(state.opds).find((t) => state.opds[t].acct === req.acct);
api.get("/opds", guestsCannot("Без входу каталогу немає."), (req, res) => res.json({ url: opdsUrl(req, myOpds(req)) }));
api.post("/opds", guestsCannot("Без входу каталогу немає."), (req, res) => {
  for (const t of Object.keys(state.opds)) if (state.opds[t].acct === req.acct) delete state.opds[t];
  const token = crypto.randomBytes(18).toString("base64url");
  state.opds[token] = { acct: req.acct, created: Date.now() };
  saveState();
  console.log("opds address", req.acct);
  res.json({ url: opdsUrl(req, token) });
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

// «Додати» on a free-shelf book (design v2, Max 2026-11-02): it joins your books without being opened.
api.post("/library/take", (req, res) => {
  if (req.guest) return res.status(403).json({ error: "Гість не може додавати книжки." });
  const u = userState(req.acct);
  const name = safeBookName(req.body?.path);
  if (!name) return res.status(400).json({ error: "bad request" });
  (u.taken ??= {})[name] = Date.now();
  if (u.setAside) delete u.setAside[name];
  saveState();
  res.json({ ok: true });
});

// «Позначити прочитаною» (Max, 2026-11-01): the book shows as read on Головна, and on the site's shelf it
// becomes «Прочитано» (an account with a site key; a guest's mark stays here). Unmarking only clears it here.
api.post("/library/finished", (req, res) => {
  const u = req.guest ? guestState(req.guest) : userState(req.acct);
  const name = safeBookName(req.body?.path);
  if (!name) return res.status(400).json({ error: "bad request" });
  if (req.body?.done === false) delete u.finished?.[name];
  else {
    (u.finished ??= {})[name] = Date.now();
    if (!req.guest && !req.share && state.accounts[req.acct]?.key) {
      const info = freeShelf.find((f) => f.name === name) || prot.meta(name) || req.lib?.meta?.bookMeta?.[name] || u.paper?.[name] || {};
      const book = { name, title: info.title || "", authors: Array.isArray(info.authors) ? info.authors : info.author ? [info.author] : [] };
      fetch(`${WEB_URL}/api/reader-read`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: req.acct, key: state.accounts[req.acct].key, book }), signal: AbortSignal.timeout(20000) })
        .then((r) => r.ok || console.error(`reader-read ${req.acct}: ${r.status}`))
        .catch((err) => console.error(`reader-read ${req.acct}:`, err.message));
    }
  }
  if (!req.guest || req.share) saveState();
  res.json({ ok: true });
});

// The «Клуб» tab (Max, 2026-11-01): the site's /api/club-feed (what others read now, the Club's talks), kept a minute.
let clubFeed = { at: 0, data: null };
api.get("/club", async (req, res) => {
  if (Date.now() - clubFeed.at > 60 * 1000 || !clubFeed.data) {
    try {
      const r = await fetch(`${WEB_URL}/api/club-feed`, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error(`site ${r.status}`);
      clubFeed = { at: Date.now(), data: await r.json() };
    } catch (err) {
      if (!clubFeed.data) return res.status(502).json({ error: err.message });
    }
  }
  res.json(clubFeed.data);
});

// "Хочу прочитати": each reader's own list of books to get; the home screen shows when one arrives.
const clean = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
// «Про книжку» in the book menu: the site's short summary of the book (/api/reader-about), kept here for a day
// and on the device by the page (web-bridge.js), so it opens offline too.
const aboutCache = new Map();
api.get("/about", async (req, res) => {
  const title = clean(req.query.title, 300);
  const author = clean(req.query.author, 300);
  if (!title) return res.status(400).json({ error: "title" });
  const key = `${title}\n${author}`;
  const hit = aboutCache.get(key);
  if (hit && Date.now() - hit.at < 24 * 3600 * 1000) return res.json(hit.data);
  try {
    const r = await fetch(`${WEB_URL}/api/reader-about?${new URLSearchParams({ title, author })}`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`site ${r.status}`);
    const data = await r.json();
    if (aboutCache.size > 5000) aboutCache.clear();
    aboutCache.set(key, { at: Date.now(), data });
    res.json(data);
  } catch (err) {
    if (hit) return res.json(hit.data);
    res.status(502).json({ error: err.message });
  }
});

// «Додати книжку»: the site's catalog for what was typed (/api/reader-find), kept ten minutes.
const findCache = new Map();
api.get("/find", async (req, res) => {
  const q = clean(req.query.q, 100);
  if (q.length < 2) return res.json({ books: [] });
  const hit = findCache.get(q);
  if (hit && Date.now() - hit.at < 600 * 1000) return res.json(hit.data);
  try {
    const r = await fetch(`${WEB_URL}/api/reader-find?${new URLSearchParams({ q })}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`site ${r.status}`);
    const data = await r.json();
    if (findCache.size > 2000) findCache.clear();
    findCache.set(q, { at: Date.now(), data });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

api.get("/wish", (req, res) => res.json({ wish: req.guest ? [] : userState(req.acct).wish || [] }));
api.post("/wish", guestsCannot("Без входу список бажаного недоступний."), (req, res) => {
  const title = clean(req.body?.title, 300);
  if (!title) return res.status(400).json({ error: "Вкажіть назву." });
  const u = userState(req.acct);
  const item = { id: crypto.randomBytes(6).toString("hex"), title, author: clean(req.body?.author, 300), addedAt: Date.now() };
  u.wish = [item, ...(u.wish || [])].slice(0, 500);
  saveState();
  res.json({ item, wish: u.wish });
});
api.delete("/wish/:id", guestsCannot("Без входу список бажаного недоступний."), (req, res) => {
  const u = userState(req.acct);
  u.wish = (u.wish || []).filter((w) => w.id !== req.params.id);
  saveState();
  res.json({ wish: u.wish });
});

// Guests read the demo book and nothing else: no uploads, no edits, no shared caches.
api.put("/books/:name", guestsCannot("Без входу не можна додавати книжки. Увійдіть, щоб завантажити свою."));
api.patch("/books/:name", guestsCannot("Без входу не можна редагувати книжки."));
api.delete("/books/:name", guestsCannot("Без входу не можна видаляти книжки."));
api.post("/trash/restore", guestsCannot("Без входу нема видалених книжок."));
api.post("/trash/forget", guestsCannot("Без входу нема видалених книжок."));
api.post("/books/:name/epub", guestsCannot("Без входу книжки не змінюються."));
api.put("/reflow", guestsCannot("Без входу конвертація PDF не зберігається."));
api.get("/reflow", (req, res, next) => (req.guest ? res.status(204).end() : next()));

// Upload: PUT /api/books/<file name> with the raw file as the body.
// Uploads (security review 2026-11-04, Max OK): a file is read whole into memory on a 512 MB machine with a
// 3 GB disk, so one account could bring the reader down for everyone. Now a reader's file is at most 100 MB,
// their library (books, trash, PDF text versions) at most 1 GB, two uploads run at a time, and none starts
// when the disk would have under 300 MB left. The owner keeps the old 300 MB and no quota.
// 2026-11-05 (scaling review, Max OK): a library at most 300 MB, since all readers share one 3 GB disk; a file
// someone already uploaded is kept once (store.writeBook), so a popular book costs the disk only once.
const UPLOAD_MAX = 100 * 1024 * 1024;
const ACCOUNT_QUOTA = 300 * 1024 * 1024;
const DISK_RESERVE = 300 * 1024 * 1024;
let uploadsRunning = 0;
function dirSize(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) n += fs.statSync(path.join(e.parentPath ?? e.path, e.name)).size;
  }
  return n;
}
const mb = (n) => Math.round(n / 1048576);
const uploadGuard = (req, res, next) => {
  const len = Number(req.get("content-length")) || 0;
  if (!req.owner) {
    if (len > UPLOAD_MAX) return res.status(413).json({ error: `Файл завеликий: до ${mb(UPLOAD_MAX)} МБ.` });
    const root = path.join(ACCOUNTS_DIR, req.acct);
    const used = fs.existsSync(root) ? dirSize(root) : 0;
    if (used + len > ACCOUNT_QUOTA) return res.status(413).json({ error: `У бібліотеці вже ${mb(used)} МБ із ${mb(ACCOUNT_QUOTA)}. Видаліть щось і очистіть «Нещодавно видалені».` });
  }
  try {
    const st = fs.statfsSync(DATA_DIR);
    if (st.bavail * st.bsize - len < DISK_RESERVE) {
      console.log(`upload refused: disk nearly full (${mb(st.bavail * st.bsize)} MB free)`);
      return res.status(507).json({ error: "На сервері закінчується місце. Спробуйте пізніше, ми вже знаємо." });
    }
  } catch {}
  if (uploadsRunning >= 2) return res.status(429).json({ error: "Зараз завантажується інша книжка. Спробуйте за хвилину." });
  uploadsRunning++;
  let done = false;
  const release = () => done || ((done = true), uploadsRunning--);
  res.on("finish", release);
  res.on("close", release);
  next();
};
const uploadBody = (req, res, next) => express.raw({ type: () => true, limit: req.owner ? MAX_UPLOAD : UPLOAD_MAX })(req, res, (err) => (err ? res.status(err.status || 400).json({ error: err.type === "entity.too.large" ? `Файл завеликий: до ${mb(UPLOAD_MAX)} МБ.` : "Файл не дійшов. Спробуйте ще раз." }) : next()));
api.put("/books/:name", uploadGuard, uploadBody, async (req, res) => {
  const name = safeBookName(req.params.name);
  if (!name) return res.status(400).json({ error: "Підтримуються лише EPUB і PDF." });
  if (!req.body?.length) return res.status(400).json({ error: "Порожній файл." });
  // Chytai does not take books in Russian: the file is refused, not kept.
  const lang = await bookLanguage(name, req.body);
  if (lang === "ru") return res.status(400).json({ error: "Книжки російською мовою в Chytai не завантажуються." });
  // Nor other languages for now (Max 2026-11-08): explanations cost tokens.
  if (lang === "other") {
    console.log("upload refused (language)", name, req.user);
    return res.status(400).json({ error: "Поки що Chytai читає книжки українською та англійською." });
  }
  // Nor pornography (the family library was shared with a child; the rule stays for everyone).
  const check = await checkUpload(name, req.body);
  if (check.blocked) {
    console.log("upload refused", name, req.user, check.reason);
    return res.status(400).json({ error: "Схоже, це порнографія чи еротика, тому Chytai не додав книжку до бібліотеки. Якщо це помилка, напишіть Максові." });
  }
  store.writeBook(bookFile(req.lib, name), req.body);
  // The same file again while its old copy waits in the trash: the new one stays, the old one goes.
  if (req.lib.meta.trash?.[name]) fs.rmSync(trashFile(req.lib, name), { force: true }), delete req.lib.meta.trash[name];
  (req.lib.meta.added ??= {})[name] = { by: req.acct, at: Date.now() };
  saveState();
  warmCovers(req.lib, [name]);
  tellSite(req.acct);
  res.json({ path: name });
});

// A PDF added before every upload became an EPUB (2026-11-01) becomes one now (Max, 2026-11-02, «Одіссея»):
// the browser sends the text version it reads «як книжку» (pdf-reflow.js), so the place and the notes made
// there move to the EPUB unchanged. The PDF goes to «Нещодавно видалені».
api.post("/books/:name/epub", uploadGuard, uploadBody, (req, res) => {
  const name = safeBookName(req.params.name);
  if (!name || !/\.pdf$/i.test(name) || !fs.existsSync(bookFile(req.lib, name))) return res.status(404).json({ error: "Книжки немає на сервері." });
  if (!req.body?.length) return res.status(400).json({ error: "Порожній файл." });
  let epub = name.replace(/\.pdf$/i, ".epub");
  if (fs.existsSync(bookFile(req.lib, epub))) epub = name.replace(/\.pdf$/i, " (з PDF).epub");
  if (!safeBookName(epub)) return res.status(400).json({ error: "Не вдалося назвати файл." });
  store.writeBook(bookFile(req.lib, epub), req.body);
  const meta = req.lib.meta;
  for (const key of ["added", "bookMeta"]) if (meta[key]?.[name]) meta[key][epub] = meta[key][name];
  const u = userState(req.acct);
  const from = `${name}#reflow`;
  if (u.positions?.[from]) u.positions[epub] = u.positions[from];
  for (const key of ["progress", "opened", "finished", "seen", "fontSizes"]) if (u[key]?.[name] !== undefined) u[key][epub] = u[key][name];
  for (const kind of ["notes", "chats"]) {
    const list = bookItems(req, kind, name);
    const moved = list.filter((n) => n.posKey === from);
    if (!moved.length) continue;
    saveBookItems(req, kind, epub, [...bookItems(req, kind, epub), ...moved.map((n) => ({ ...n, posKey: epub }))]);
    saveBookItems(req, kind, name, list.filter((n) => n.posKey !== from));
  }
  if (u.lastBook === name) u.lastBook = epub;
  const key = customCoverKey(name);
  if (fs.existsSync(req.lib.covers)) {
    for (const f of fs.readdirSync(req.lib.covers)) {
      if (f.split(".")[0] === key) fs.copyFileSync(path.join(req.lib.covers, f), path.join(req.lib.covers, customCoverKey(epub) + f.slice(key.length)));
    }
  }
  fs.mkdirSync(path.dirname(trashFile(req.lib, name)), { recursive: true });
  fs.renameSync(bookFile(req.lib, name), trashFile(req.lib, name));
  (meta.trash ??= {})[name] = { at: Date.now() };
  saveState();
  warmCovers(req.lib, [epub]);
  tellSite(req.acct);
  res.json({ path: epub });
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

// Deleting your own book (Max, 2026-11-01, now that every library is one reader's): no question asked, the
// file goes to the library's trash for 30 days, like Apple Notes' «Recently Deleted», and can come back from
// there as it was. Only then does it go for good, with everything kept about it (purgeTrash below).
const TRASH_DAYS = 30;
const trashFile = (lib, name) => path.join(lib === OWNER_LIB ? path.join(DATA_DIR, "trash") : path.join(path.dirname(lib.dir), "trash"), name);
api.delete("/books/:name", (req, res) => {
  const name = safeBookName(req.params.name);
  const file = name && bookFile(req.lib, name);
  if (!file || !fs.existsSync(file)) return res.status(404).json({ error: "Книжки немає на сервері." });
  fs.mkdirSync(path.dirname(trashFile(req.lib, name)), { recursive: true });
  fs.renameSync(file, trashFile(req.lib, name));
  (req.lib.meta.trash ??= {})[name] = { at: Date.now() };
  const u = userState(req.acct);
  if (u.lastBook === name) delete u.lastBook;
  saveState();
  tellSite(req.acct);
  res.json({ ok: true });
});
// «Нещодавно видалені»: GET /api/trash, POST /api/trash/restore { path }.
api.get("/trash", async (req, res) => {
  if (req.guest) return res.json({ books: [], days: TRASH_DAYS });
  const trash = req.lib.meta.trash || {};
  const names = Object.keys(trash).filter((n) => fs.existsSync(trashFile(req.lib, n)));
  if (!names.length) return res.json({ books: [], days: TRASH_DAYS });
  const dir = path.dirname(trashFile(req.lib, names[0]));
  const scanned = await library.scan([dir], path.join(dir, ".cache.json")).catch(() => []);
  const meta = req.lib.meta.bookMeta || {};
  const books = names.map((n) => {
    const b = scanned.find((x) => path.basename(x.path) === n) || { title: n.replace(/\.[^.]+$/, ""), authors: [] };
    const m = meta[n];
    const custom = customCover(req.lib, n);
    return {
      path: n, title: m?.title || b.title, authors: m?.authors?.length ? m.authors : b.authors || [], deletedAt: trash[n].at, until: trash[n].at + TRASH_DAYS * 864e5,
      ext: path.extname(n).slice(1).toLowerCase(), mtime: b.mtime || 0, coverAt: custom ? Math.round(fs.statSync(custom).mtimeMs) : 0,
    };
  }).sort((x, y) => y.deletedAt - x.deletedAt);
  res.json({ books, days: TRASH_DAYS });
});
api.post("/trash/restore", (req, res) => {
  const name = safeBookName(req.body?.path);
  const from = name && trashFile(req.lib, name);
  if (!from || !fs.existsSync(from)) return res.status(404).json({ error: "Цієї книжки вже немає в нещодавно видалених." });
  if (fs.existsSync(bookFile(req.lib, name))) return res.status(409).json({ error: "У бібліотеці вже є книжка з таким файлом." });
  fs.renameSync(from, bookFile(req.lib, name));
  delete req.lib.meta.trash?.[name];
  saveState();
  tellSite(req.acct);
  res.json({ ok: true, path: name });
});
// «Видалити назавжди» in «Нещодавно видалені» (design «3a», Max 2026-11-01): gone now rather than in 30 days.
api.post("/trash/forget", (req, res) => {
  const name = safeBookName(req.body?.path);
  if (!name || !req.lib.meta.trash?.[name]) return res.status(404).json({ error: "Цієї книжки вже немає в нещодавно видалених." });
  forgetBook(req.lib, req.acct, name);
  saveState();
  res.json({ ok: true });
});
// Gone for good: the file and everything this library and its reader kept about the book (the place, progress,
// notes, a corrected title, a hand-set cover, the links that lent it out).
function forgetBook(lib, acct, name) {
  fs.rmSync(trashFile(lib, name), { force: true });
  for (const key of ["added", "bookMeta", "trash"]) delete lib.meta[key]?.[name];
  const u = state.users[acct];
  if (u) {
    for (const key of ["positions", "progress", "opened", "setAside", "seen", "notes", "finished"]) {
      delete u[key]?.[name];
      delete u[key]?.[`${name}#reflow`];
    }
    if (u.lastBook === name) delete u.lastBook;
  }
  store.items.dropBook(acct, "notes", name);
  store.items.dropBook(acct, "notes", `${name}#reflow`);
  tellQuotes(acct, name);
  for (const [t, sh] of Object.entries(state.shares)) if (sh.acct === acct && sh.book === name) delete state.shares[t];
  const key = customCoverKey(name);
  if (fs.existsSync(lib.covers)) for (const f of fs.readdirSync(lib.covers)) if (f.split(".")[0] === key) fs.rmSync(path.join(lib.covers, f), { force: true });
}
function purgeTrash() {
  const old = Date.now() - TRASH_DAYS * 864e5;
  let n = 0;
  const each = (id, meta) => {
    for (const [name, t] of Object.entries(meta?.trash || {})) if (t.at < old) forgetBook(libOf(id), id, name), n++;
  };
  each(OWNER_ID, state.shared);
  for (const [id, meta] of Object.entries(state.libs || {})) if (id !== OWNER_ID) each(id, meta);
  if (n) saveState(), console.log(`trash: ${n} books deleted for good`);
}
setTimeout(purgeTrash, 60 * 1000).unref();
setInterval(purgeTrash, 6 * 3600 * 1000).unref();

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
    const now = new Date();
    fs.utimes(file, now, now, () => {}); // read: sweepCaches keeps it another 60 days
    res.type("application/epub+zip").sendFile(file);
  } catch {
    res.status(404).end();
  }
});

api.put("/reflow", uploadGuard, uploadBody, (req, res) => {
  const name = safeBookName(req.query.path);
  try {
    fs.writeFileSync(reflowFile(req.lib, name, String(req.query.version || "")), req.body);
    res.json({ ok: true });
  } catch {
    res.status(404).end();
  }
});

// Streams an explanation as newline-delimited JSON events, the same events the Electron renderer gets.
// ---------- Paper books (Max, 2026-11-02): see server/paper.js ----------
const PAPER_MAX = 200;
const intOr = (v, max) => (Number.isInteger(v) && v >= 0 && v <= max ? v : undefined);
api.post("/paper", guestsCannot("Без входу не можна додавати книжки."), (req, res) => {
  const u = userState(req.acct);
  const title = clean(req.body?.title, 300);
  if (!title) return res.status(400).json({ error: "Немає назви." });
  u.paper ??= {};
  if (Object.keys(u.paper).length >= PAPER_MAX) return res.status(400).json({ error: "Забагато паперових книжок." });
  const href = typeof req.body?.href === "string" && /^https:\/\/chytai\.org\.ua\//.test(req.body.href) ? req.body.href.slice(0, 500) : "";
  // The same book from the catalog twice is the one already there.
  const same = Object.entries(u.paper).find(([, p]) => (href && p.href === href) || (!href && p.title === title));
  if (same) {
    if (u.setAside) delete u.setAside[same[0]];
    (u.opened ??= {})[same[0]] = Date.now();
    saveState();
    return res.json({ path: same[0] });
  }
  const name = `paper-${crypto.randomBytes(5).toString("hex")}.paper`;
  const cover = typeof req.body?.cover === "string" && /^https:\/\//.test(req.body.cover) ? req.body.cover.slice(0, 1000) : "";
  u.paper[name] = { title, author: clean(req.body?.author, 300), cover, href, pages: intOr(req.body?.pages, 20000) || 0, page: 0, chapter: "", addedAt: Date.now() };
  (u.opened ??= {})[name] = Date.now();
  saveState();
  res.json({ path: name });
});
api.patch("/paper/:name", guestsCannot("Без входу паперових книжок немає."), (req, res) => {
  const u = userState(req.acct);
  const p = u.paper?.[req.params.name];
  if (!p) return res.status(404).json({ error: "Книжки немає." });
  const { page, pages, chapter, title, author } = req.body || {};
  if (intOr(page, 20000) !== undefined) p.page = page;
  if (intOr(pages, 20000) !== undefined) p.pages = pages;
  if (typeof chapter === "string") p.chapter = chapter.trim().slice(0, 200);
  if (typeof title === "string" && title.trim()) p.title = clean(title, 300);
  if (typeof author === "string") p.author = clean(author, 300);
  (u.opened ??= {})[req.params.name] = Date.now();
  if (u.setAside) delete u.setAside[req.params.name];
  saveState();
  if (typeof title === "string" || typeof author === "string") tellQuotes(req.acct, req.params.name);
  res.json(paper.listEntry(req.params.name, p, u));
});
// A paper book's page open and in use (pinged each minute while the reader does something on it): a few
// minutes of it put the book on «Читаю зараз» on the site, as reading an e-book does (Max 2026-11-02).
api.post("/paper/:name/seen", guestsCannot("Без входу паперових книжок немає."), (req, res) => {
  if (!userState(req.acct).paper?.[req.params.name]) return res.status(404).json({ error: "Книжки немає." });
  noteReadingNow(req.acct, req.params.name);
  res.json({ ok: true });
});
// Questions about a paper book with their answers (v2, Max: «треба щоб питання зберігалися»), kept with the
// talk so far so «Уточнити» can go on: u.paperChats[name] = [{ id, turns: [{ q, a }], messages, sel, page, at }].
const CHATS_MAX = 300;
const CHAT_BYTES = 200 * 1024;
// The small picture of a question's page lives in a file of its own, not in state.json, which is written
// whole on every change (Max 2026-11-05): accounts/<id>/paper-img/<book hex>-<chat id>.jpg.
const PAPER_IMG = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/;
const paperImgFile = (acct, name, id) => path.join(ACCOUNTS_DIR, acct, "paper-img", `${name.slice(6, 16)}-${id}.jpg`);
function savePaperImg(acct, name, id, img) {
  const m = typeof img === "string" && img.length < 120 * 1024 && PAPER_IMG.exec(img);
  if (!m) return false;
  const file = paperImgFile(acct, name, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(m[1], "base64"));
  return true;
}
function dropPaperImgs(acct, name, chats) {
  for (const c of chats || []) if (c?.imgFile) fs.rmSync(paperImgFile(acct, name, c.id), { force: true });
}
// Once: the pictures kept inside state.json before move out into files.
{
  let moved = 0;
  for (const [acct, u] of Object.entries(state.users || {})) {
    if (!ACCOUNT_ID.test(acct)) continue;
    for (const [name, list] of Object.entries(u.paperChats || {})) {
      if (!paper.NAME.test(name)) continue;
      for (const c of list || []) {
        if (!c?.img) continue;
        try {
          if (savePaperImg(acct, name, c.id, c.img)) (c.imgFile = true), moved++;
          delete c.img;
        } catch (err) {
          console.error("paper img move:", err.message);
        }
      }
    }
  }
  if (moved) console.log(`paper: ${moved} pictures moved out of state.json`), saveState();
}
api.get("/paper/:name/chats", guestsCannot("Без входу паперових книжок немає."), (req, res) => {
  const list = bookItems(req, "paperChats", req.params.name);
  const url = (c) => `/api/paper/${encodeURIComponent(req.params.name)}/chats/${c.id}/img`;
  res.json({ chats: list.map(({ imgFile, ...c }) => ({ ...c, img: imgFile ? url(c) : c.img || "" })) });
});
api.get("/paper/:name/chats/:id/img", guestsCannot("Без входу паперових книжок немає."), (req, res) => {
  const c = bookItems(req, "paperChats", req.params.name).find((x) => x.id === req.params.id);
  if (!c?.imgFile) return res.status(404).end();
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  res.sendFile(paperImgFile(req.acct, req.params.name, c.id), (err) => err && !res.headersSent && res.status(404).end());
});
api.put("/paper/:name/chats/:id", guestsCannot("Без входу паперових книжок немає."), (req, res) => {
  const u = userState(req.acct);
  if (!u.paper?.[req.params.name]) return res.status(404).json({ error: "Книжки немає." });
  const { turns, messages, sel, page, at, img } = req.body || {};
  if (!/^[a-z0-9]{4,40}$/.test(req.params.id) || !Array.isArray(turns) || !turns.length) return res.status(400).json({ error: "bad request" });
  const chat = {
    id: req.params.id,
    turns: turns.slice(-50).map((t) => ({ q: String(t?.q || "").slice(0, 4000), a: String(t?.a || "").slice(0, 20000) })),
    messages: paper.stripImages(messages),
    sel: typeof sel === "string" ? sel.slice(0, 4000) : "",
    page: intOr(page, 20000) || 0,
    at: Number.isFinite(at) ? at : Date.now(),
  };
  // A long talk keeps its turns for reading, but no longer goes on from where it was.
  if (JSON.stringify(chat.messages || "").length > CHAT_BYTES) chat.messages = null;
  const list = bookItems(req, "paperChats", req.params.name);
  const i = list.findIndex((c) => c.id === chat.id);
  // A small picture of the marked page (v3), shown with the question: a new one comes as a data URL,
  // a kept one comes back as its address and stays as it is.
  try {
    if (savePaperImg(req.acct, req.params.name, chat.id, img) || list[i]?.imgFile) chat.imgFile = true;
  } catch (err) {
    console.error("paper img:", err.message);
  }
  if (i >= 0) list[i] = chat;
  else list.push(chat);
  if (list.length > CHATS_MAX) dropPaperImgs(req.acct, req.params.name, list.splice(0, list.length - CHATS_MAX));
  saveBookItems(req, "paperChats", req.params.name, list);
  (u.opened ??= {})[req.params.name] = Date.now();
  saveState();
  res.json({ ok: true });
});
// Questions to ask next (v3): from the book and the page, or following on from the last question. Kept a day.
const aiBudget = (req, res, next) => {
  const denied = aiBudgetDenied(req);
  return denied ? res.status(429).json({ error: denied }) : next();
};
const suggestCache = new Map();
api.post("/paper/:name/suggest", guestsCannot("Без входу паперових книжок немає."), aiBudget, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const u = userState(req.acct);
  const p = u.paper?.[req.params.name];
  if (!p || !apiKey) return res.json({ questions: [] });
  const chats = bookItems(req, "paperChats", req.params.name);
  const lastChat = [...chats].sort((x, y) => (y.at || 0) - (x.at || 0))[0];
  const turn = lastChat?.turns?.[lastChat.turns.length - 1];
  const last = turn ? { q: turn.q || lastChat.sel || "", a: turn.a || "" } : null;
  const key = `${req.acct}\t${req.params.name}\t${p.page || 0}\t${lastChat?.id || ""}\t${lastChat?.turns?.length || 0}`;
  const hit = suggestCache.get(key);
  if (hit && Date.now() - hit.at < 86400000) return res.json({ questions: hit.questions });
  try {
    const r = await paper.suggest(apiKey, { title: p.title, author: p.author, page: p.page, last });
    recordExplain(req, { model: r.model, usage: r.usage });
    if (suggestCache.size > 5000) suggestCache.clear();
    suggestCache.set(key, { at: Date.now(), questions: r.questions });
    res.json({ questions: r.questions });
  } catch (err) {
    res.json({ questions: [], error: describeError(err) });
  }
});
// Dictation tidied into sentences (Max 2026-11-03).
api.post("/paper/:name/tidy", guestsCannot("Без входу паперових книжок немає."), aiBudget, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const p = userState(req.acct).paper?.[req.params.name];
  const text = String(req.body?.text || "").trim().slice(0, 3000);
  if (!p || !apiKey || !text) return res.json({ text });
  try {
    const r = await paper.tidy(apiKey, { title: p.title, author: p.author, text });
    recordExplain(req, { model: r.model, usage: r.usage });
    res.json({ text: r.text });
  } catch (err) {
    res.json({ text, error: describeError(err) });
  }
});
// The same for an e-book's question field (2026-11-03): the reader's page sends the book's title and author.
api.post("/tidy", guestsCannot("Без входу диктування не доопрацьовується."), aiBudget, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const text = String(req.body?.text || "").trim().slice(0, 3000);
  if (!apiKey || !text) return res.json({ text });
  try {
    const r = await paper.tidy(apiKey, { title: String(req.body?.title || "").slice(0, 300), author: String(req.body?.author || "").slice(0, 200), text, ebook: true });
    recordExplain(req, { model: r.model, usage: r.usage });
    res.json({ text: r.text });
  } catch (err) {
    res.json({ text, error: describeError(err) });
  }
});
api.delete("/paper/:name/chats/:id", guestsCannot("Без входу паперових книжок немає."), (req, res) => {
  const list = bookItems(req, "paperChats", req.params.name);
  dropPaperImgs(req.acct, req.params.name, list.filter((c) => c.id === req.params.id));
  saveBookItems(req, "paperChats", req.params.name, list.filter((c) => c.id !== req.params.id));
  res.json({ ok: true });
});
// A paper book has no file to keep in «Нещодавно видалені»: it goes with its notes.
api.delete("/paper/:name", guestsCannot("Без входу паперових книжок немає."), (req, res) => {
  const u = userState(req.acct);
  const name = req.params.name;
  if (!u.paper?.[name]) return res.status(404).json({ error: "Книжки немає." });
  delete u.paper[name];
  dropPaperImgs(req.acct, name, bookItems(req, "paperChats", name));
  for (const kind of ["notes", "paperChats"]) store.items.dropBook(req.acct, kind, name);
  for (const key of ["positions", "progress", "opened", "setAside", "seen", "finished"]) delete u[key]?.[name];
  saveState();
  tellQuotes(req.acct, name);
  res.json({ ok: true });
});
// A photo of a cover (?kind=cover), of a page (?kind=page) or of the text marked on it (?kind=marked), JPEG or PNG, read by Claude. The photo is not kept.
api.post("/paper/scan", guestsCannot("Без входу фото не розпізнаються."), aiBudget, express.raw({ type: () => true, limit: "8mb" }), async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "На сервері не налаштовано ключ Claude API." });
  const kind = ["page", "marked", "pagenum"].includes(req.query.kind) ? req.query.kind : "cover";
  const type = String(req.headers["content-type"] || "");
  const mediaType = /png/.test(type) ? "image/png" : /webp/.test(type) ? "image/webp" : "image/jpeg";
  if (!Buffer.isBuffer(req.body) || req.body.length < 1000) return res.status(400).json({ error: "Немає фото." });
  if (!req.owner && (state.stats?.days?.[statsDay()]?.users?.[req.acct] || 0) >= ACCOUNT_DAILY_CAP) return res.status(429).json({ error: "На сьогодні запитів забагато. Завтра все запрацює знову." });
  try {
    const r = kind === "pagenum" ? await paper.readPageNumber(apiKey, req.body, mediaType) : kind !== "cover" ? await paper.readPage(apiKey, req.body, mediaType, kind === "marked") : await paper.readCover(apiKey, req.body, mediaType);
    const { usage, model, ...out } = r;
    recordExplain(req, { model, usage });
    res.json(out);
  } catch (err) {
    res.status(502).json({ error: describeError(err) });
  }
});

api.post("/explain", async (req, res) => {
  const request = req.body?.request;
  if (!request || typeof request !== "object") return res.status(400).json({ error: "bad request" });
  // A photo of a paper book's page with the reader's marks (v3): accounts only, one picture of a few MB at most.
  if (request.context?.image != null && (req.guest || typeof request.context.image !== "string" || request.context.image.length > 4 * 1024 * 1024 || !/^[A-Za-z0-9+/=]+$/.test(request.context.image)))
    return res.status(400).json({ error: "Фото не підходить." });
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
  const denied = aiBudgetDenied(req);
  if (denied) {
    send({ type: "error", message: denied });
    return res.end();
  }
  if (!req.guest && !req.owner) trimAccountRequest(request);
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
      model: request.mode === "translate" ? shared.translateModel : shared.model,
      language: shared.language,
      // «Стиль пояснень» is gone (Max, 2026-11-02: nobody used it); «простіше» or «коротше» goes in the question.
      style: "default",
      customStyle: "",
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

app.use((err, req, res, _next) => {
  console.error(err);
  if (!(err.status >= 400 && err.status < 500)) reportError(err, `${req.method} ${String(req.originalUrl || "").split("?")[0].slice(0, 200)}`);
  if (res.headersSent) return res.end();
  res.status(err.status || 500).json({ error: err.message || "server error" });
});

// The reader's disk and memory near their limit: a message to the owner (storage.js), checked while it runs.
storage.watch(() => storage.problems(storage.now(DATA_DIR, ["reader.db"]), "Читалка"), (subject, text) => alertOwner(subject, text));

// Once: state.json into reader.db (server/db.js). Here at the end, after every one-time fix above ran on the
// state as read from the file (the paper-book pictures moved out, 2026-11-05), and before any request.
if (!store.migrated()) {
  const t = Date.now();
  store.migrate(state);
  console.log(`state.json moved into reader.db in ${Date.now() - t} ms`);
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Chytai web on http://0.0.0.0:${PORT}, books in ${BOOKS_DIR}`);
  warmCovers(OWNER_LIB, fs.readdirSync(BOOKS_DIR));
});

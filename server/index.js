// Web version of Chytai (AI Reader): the same renderer served to phones, with a small API that keeps the
// Claude key, the shared library and everyone's reading positions on the server.
//
// Env: ANTHROPIC_API_KEY, READER_PASSWORD (one family password), READER_SECRET (signs the login
// cookie), DATA_DIR (default ./data; /data on Fly), PORT (default 8080).
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { explain } = require("../src/ai");
const library = require("../src/library");

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
const BOOK_EXT = /\.(epub|pdf)$/i;
const MAX_UPLOAD = "300mb";

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

const SHARED_DEFAULTS = { model: "claude-opus-5-5", deepModel: "claude-fable-5-1", language: "українська" };
const USER_DEFAULTS = { autoExplain: true, pageTaps: false, font: "literata", margins: "normal", pdfMode: "reflow", fontSizes: {}, theme: "light", lastBook: null, positions: {} };
const SHARED_KEYS = new Set(Object.keys(SHARED_DEFAULTS));
const USER_KEYS = new Set(Object.keys(USER_DEFAULTS));

let state = { shared: {}, users: {} };
try {
  state = { shared: {}, users: {}, ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) };
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

function settingsFor(name) {
  const u = userState(name);
  return {
    ...SHARED_DEFAULTS,
    ...state.shared,
    ...USER_DEFAULTS,
    ...u,
    positions: u.positions || {},
    user: name,
    hasApiKey: !!process.env.ANTHROPIC_API_KEY,
    apiKeyFromEnv: true,
    web: true,
  };
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

function setLoginCookie(req, res, name) {
  const value = `${name}.${sign(name)}`;
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=${COOKIE_DAYS * 86400}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`
  );
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
</style></head>
<body><form method="post" action="/login">
  <h1>Chytai</h1><p>Читалка з поясненнями від Claude</p>
  ${error ? `<div class="err">${esc(error)}</div>` : ""}
  <label>Ім'я <input name="name" required autocomplete="username" autocapitalize="words" placeholder="Макс"></label>
  <label>Пароль <input name="password" type="password" required autocomplete="current-password"></label>
  <button>Увійти</button>
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
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; Max-Age=0`);
  res.redirect("/login");
});

app.use((req, res, next) => {
  const user = currentUser(req);
  if (!user) {
    if (req.path.startsWith("/api/")) return res.status(401).json({ error: "login" });
    return res.redirect("/login");
  }
  req.user = user;
  next();
});

// Static renderer: index.html at /, its scripts next to it, node_modules at /node_modules
// (so the renderer's ../../node_modules/… paths resolve, as they do under file:// in Electron).
app.get("/", (_req, res) => res.sendFile(path.join(ROOT, "src", "renderer", "index.html")));
app.use("/node_modules", express.static(path.join(ROOT, "node_modules"), { index: false, maxAge: "7d" }));
app.use(express.static(path.join(ROOT, "src", "renderer"), { index: false }));

// ---------- API ----------

const api = express.Router();
api.use(express.json({ limit: "20mb" }));

api.get("/settings", (req, res) => res.json(settingsFor(req.user)));

api.patch("/settings", (req, res) => {
  const u = userState(req.user);
  for (const [k, v] of Object.entries(req.body || {})) {
    if (SHARED_KEYS.has(k)) state.shared[k] = v;
    else if (USER_KEYS.has(k) && k !== "positions") u[k] = v;
  }
  saveState();
  res.json(settingsFor(req.user));
});

api.put("/position", (req, res) => {
  const { path: bookPath, cfi } = req.body || {};
  if (typeof bookPath !== "string" || typeof cfi !== "string") return res.status(400).json({ error: "bad request" });
  const u = userState(req.user);
  u.positions ??= {};
  u.positions[bookPath] = cfi;
  (u.opened ??= {})[bookPath.replace(/#reflow$/, "")] = Date.now();
  saveState();
  res.json({ ok: true });
});

// Book names are the file names inside BOOKS_DIR; a name is never allowed to escape it.
function safeBookName(name) {
  const base = path.basename(String(name || "")).normalize("NFC");
  if (!base || base.startsWith(".") || !BOOK_EXT.test(base)) return null;
  return base;
}
const bookFile = (name) => path.join(BOOKS_DIR, name);

api.get("/library", async (req, res) => {
  const books = await library.scan([BOOKS_DIR], path.join(DATA_DIR, "library-cache.json"));
  const positions = userState(req.user).positions || {};
  const list = books.map((b) => {
    const name = path.relative(BOOKS_DIR, b.path);
    const openedAt = userState(req.user).opened?.[name] || 0;
    return { ...b, path: name, cloud: false, openedAt, started: !!(positions[name] || positions[`${name}#reflow`]) };
  });
  res.json({ folders: [], books: list, lastBook: userState(req.user).lastBook || null });
});

api.get("/book", (req, res) => {
  const name = safeBookName(req.query.path);
  if (!name || !fs.existsSync(bookFile(name))) return res.status(404).json({ error: "Книжки немає на сервері." });
  const u = userState(req.user);
  u.lastBook = name;
  (u.opened ??= {})[name] = Date.now();
  saveState();
  res.setHeader("X-Book-Position", encodeURIComponent(u.positions?.[name] || ""));
  res.setHeader("X-Book-Reflow-Position", encodeURIComponent(u.positions?.[`${name}#reflow`] || ""));
  res.sendFile(bookFile(name));
});

// Upload: PUT /api/books/<file name> with the raw file as the body.
api.put("/books/:name", express.raw({ type: () => true, limit: MAX_UPLOAD }), (req, res) => {
  const name = safeBookName(req.params.name);
  if (!name) return res.status(400).json({ error: "Підтримуються лише EPUB і PDF." });
  if (!req.body?.length) return res.status(400).json({ error: "Порожній файл." });
  fs.writeFileSync(bookFile(name), req.body);
  res.json({ path: name });
});

api.delete("/books/:name", (req, res) => {
  const name = safeBookName(req.params.name);
  if (name) fs.rmSync(bookFile(name), { force: true });
  res.json({ ok: true });
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
  const controller = new AbortController();
  // The request's own "close" fires once its body is read; the response closes when the phone goes away.
  res.on("close", () => !res.writableEnded && controller.abort());
  const shared = { ...SHARED_DEFAULTS, ...state.shared };
  try {
    const result = await explain({
      apiKey,
      model: request.deep ? shared.deepModel : shared.model,
      language: shared.language,
      request,
      signal: controller.signal,
      onText: (text) => send({ type: "text", text }),
    });
    send({ type: "done", ...result });
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

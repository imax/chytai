// Chytai web: the platform part (library, Discovery, recommendations), separate from the reader
// in server/index.js. Plain Express, server-rendered HTML, JSON on disk.
//
// Env: DATA_DIR (default ./data; the library lives in DATA_DIR/web/library.json), PORT (default 8090),
// WEB_LOGIN_TOKEN (the magic link: opening /login/<token> once signs this browser in as the owner),
// ANTHROPIC_API_KEY (for «Що почитати», optional), RECOMMEND_MODEL (default claude-opus-5-5).
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Store } = require("./store");
const pages = require("./pages");
const { recommend } = require("./recommend");

const ROOT = path.join(__dirname, "..");
loadDotEnv(path.join(ROOT, ".env"));

const PORT = Number(process.env.PORT) || 8090;
const DATA_DIR = path.join(process.env.DATA_DIR || path.join(ROOT, "data"), "web");
const TOKEN = process.env.WEB_LOGIN_TOKEN || "";
const OWNER = process.env.WEB_OWNER || "Макс І";
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
  req.user = cookies(req)[COOKIE] === session ? OWNER : null;
  next();
});
const owner = (req, res, next) => (req.user ? next() : res.status(403).send("Спочатку відкрийте своє посилання для входу."));

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

function inLibraryMap() {
  return new Map(Object.entries(store.lib.entries));
}

app.get("/", (req, res) => {
  res.send(pages.discoveryPage({ shelves: store.shelves, subscriptions: store.lib.subscriptions, user: req.user, owner: OWNER, libraryCount: store.library().length, inLibrary: inLibraryMap(), fetched: store.shelvesFetched, ownerStrip: store.library().filter((r) => r.rating >= 5 && r.book.cover).slice(0, 5).map((r) => r.book) }));
});

app.get("/me", (req, res) => {
  const rows = store.library();
  let prev;
  for (const r of rows) {
    r._prevYear = prev;
    prev = r.year ?? null;
  }
  res.send(pages.libraryPage({ rows, user: req.user, owner: OWNER, subscriptions: store.lib.subscriptions }));
});

app.get("/shelf/:id", (req, res) => {
  const shelf = store.shelf(req.params.id);
  if (!shelf) return res.status(404).send(pages.messagePage({ title: "Немає такої полиці", text: "", user: req.user }));
  res.send(pages.shelfPage({ shelf, subscribed: store.subscribed(shelf.id), user: req.user, inLibrary: inLibraryMap() }));
});

app.get("/book/:id", (req, res) => {
  const book = store.book(req.params.id);
  if (!book) return res.status(404).send(pages.messagePage({ title: "Немає такої книжки", text: "", user: req.user }));
  res.send(pages.bookPage({ book, entry: store.entry(book.id), user: req.user, shelf: book.shelf ? store.shelf(book.shelf) : null }));
});

app.get("/recommend", owner, async (req, res) => {
  try {
    res.send(await recommend({ store, user: req.user, topic: String(req.query.topic || ""), refresh: "refresh" in req.query, pages }));
  } catch (e) {
    console.error(e);
    res.status(500).send(pages.messagePage({ title: "Не вийшло", text: e.message, user: req.user }));
  }
});

// ---- writes (owner only) ----

const back = (req, res, fallback) => res.redirect(req.body.back ? req.get("referer") || fallback : fallback);

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
  back(req, res, `/book/${encodeURIComponent(req.params.id)}`);
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
  res.redirect(`/book/${encodeURIComponent(b.id)}`);
});

app.post("/api/subscribe/:id", owner, (req, res) => {
  if (store.toggleSubscription(req.params.id) === null) return res.status(404).send("Немає такої полиці");
  res.redirect(req.get("referer") || "/");
});

app.listen(PORT, () => console.log(`Chytai web on http://localhost:${PORT}  (library: ${store.file})`));

// Errors readers ran into, for the owner (risk review 2026-11-05: «помилок сайту ніхто не бачить»). A page that
// failed with a 500, a crash of the site or jobs process, an error in the reader app (it posts them to
// /api/reader-alert): each is kept in the `errors` table (the last 30 days, at most 500 rows) and goes to the
// owner's Telegram at most once an hour for the same message. /admin shows the last day's in its status block.
// Never readers' e-mail addresses or the text they wrote: the message, the stack's top lines, the address asked for.
const telegram = require("./telegram");

let db = null;
const KEEP_DAYS = 30;
const KEEP_ROWS = 500;

function init(database) {
  db = database;
  db.exec("CREATE TABLE IF NOT EXISTS errors (at TEXT NOT NULL, place TEXT NOT NULL, msg TEXT NOT NULL, url TEXT NOT NULL DEFAULT '', stack TEXT NOT NULL DEFAULT '')");
}

// The same error with different ids or numbers in it counts as one (for Telegram's once an hour and /admin).
const kind = (place, msg) => `${place}:${String(msg).replace(/\d+/g, "N").slice(0, 120)}`;
// An address with its query and long ids cut: what was asked for, not who asked.
const cleanUrl = (url) => String(url || "").split("?")[0].slice(0, 200);
const PLACES = { site: "на сайті", jobs: "у фонових задачах сайту", reader: "у Читалці" };

// place: "site" | "jobs" | "reader"; err: an Error or a message; url: "GET /path" or "".
function record(place, err, url = "") {
  const noMail = (t) => t.replace(/[^\s@<>"'`(),:;]+@[^\s@<>"'`(),:;]+\.[a-z]{2,}/gi, "…@…");
  const msg = noMail(String(err?.message || err || "без опису")).slice(0, 500);
  const stack = String(err?.stack || "").split("\n").slice(1).map((l) => l.trim()).filter((l) => !/node_modules|node:internal/.test(l)).slice(0, 5).join("\n").slice(0, 1000);
  console.error(`[error] ${place} ${url} ${msg}${stack ? `\n${stack}` : ""}`);
  if (!db) return;
  try {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO errors (at, place, msg, url, stack) VALUES (?, ?, ?, ?, ?)").run(now, place, msg, url.slice(0, 220), stack);
    db.prepare("DELETE FROM errors WHERE at < ?").run(new Date(Date.now() - KEEP_DAYS * 86400000).toISOString());
    db.prepare("DELETE FROM errors WHERE rowid NOT IN (SELECT rowid FROM errors ORDER BY at DESC LIMIT ?)").run(KEEP_ROWS);
    const n = db.prepare("SELECT COUNT(*) AS n FROM errors WHERE place = ? AND msg = ? AND at >= ?").get(place, msg, new Date(Date.now() - 86400000).toISOString()).n;
    return telegram.sendOnce(`error:${kind(place, msg)}`, 1, `Помилка ${PLACES[place] || place}: ${msg}${url ? `\n${url}` : ""}${n > 1 ? `\nЗа добу разів: ${n}` : ""}${stack ? `\n\n${stack.split("\n")[0]}` : ""}\n\nУсі помилки: https://chytai.org.ua/admin`);
  } catch (e) {
    console.error(`[error] could not record: ${e.message}`);
  }
}

// The last day's errors, grouped by message, the most frequent first: [{ place, msg, url, n, last }].
function lastDay() {
  if (!db) return [];
  const since = new Date(Date.now() - 86400000).toISOString();
  return db.prepare("SELECT place, msg, MAX(url) AS url, COUNT(*) AS n, MAX(at) AS last FROM errors WHERE at >= ? GROUP BY place, msg ORDER BY n DESC, last DESC LIMIT 20").all(since);
}

// An Express error handler: records 5xx (a bad request from the visitor, 4xx, is theirs, not ours) and answers.
function handler(place, page) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, _next) => {
    const status = Number(err?.status || err?.statusCode) || 500;
    if (status >= 500) record(place, err, `${req.method} ${cleanUrl(req.originalUrl)}`);
    if (res.headersSent) return res.end();
    res.status(status);
    if (/^\/api\//.test(req.path) || req.xhr || !req.accepts("html")) return res.json({ error: status >= 500 ? "Щось зламалося. Ми вже знаємо." : err.message || "Помилка" });
    res.send(page ? page(status, req) : status >= 500 ? "Щось зламалося. Ми вже знаємо." : "Помилка в запиті.");
  };
}

// A crash of the whole process: recorded, sent, and then the process ends as Node would end it (main.js or Fly
// starts it again). A second crash while the first is being sent ends it at once.
function watchProcess(place) {
  let dying = false;
  const die = (err) => {
    if (dying) process.exit(1);
    dying = true;
    const sent = record(place, err, "процес упав");
    Promise.race([sent, new Promise((r) => setTimeout(r, 3000))]).finally(() => process.exit(1));
  };
  process.on("uncaughtException", die);
  process.on("unhandledRejection", (reason) => die(reason instanceof Error ? reason : new Error(`unhandled rejection: ${String(reason)}`)));
}

module.exports = { init, record, lastDay, handler, watchProcess, cleanUrl };

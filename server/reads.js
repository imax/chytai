// What readers read of publishers' protected books, for the publishers' monthly reports (Max, 2026-10-30,
// docs/publisher-requirements.md, task 3). The protected shelf (protected.js) calls record() for every full
// chapter it serves to a signed-in reader; each one is a line in DATA_DIR/reads.jsonl on the volume, and
// every minute the new lines go to the site (WEB_URL/api/reads), signed with each account's key, as
// /api/reader-library is. The site keeps one row per reader, book, chapter and day, so sending a line twice
// (after a restart or a failed call) counts it once; the reports and the letters are made there (web/reports.js).
// Only counts: the site sees which account read which chapter, publishers see numbers.
const fs = require("fs");
const path = require("path");

const FLUSH_MS = 60 * 1000;
const BATCH = 2000; // lines in one call to the site
const dayKyiv = (d) => d.toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });

let cfg = null; // { file, offsetFile, webUrl, keyOf(id), info(book), list() }
let timer = null;

// dataDir: the volume; webUrl: the site; keyOf(id): the account's key from signing in; info(book): what the
// shelf knows of a book (its shelf.json entry: title, authors, publisher, bookId), any of them;
// list(): every book on the shelf as its shelf.json entry ({ name, … }), sent once a day, so a report counts the publisher's
// books nobody opened yet. That call is signed with the owner's key.
function init({ dataDir, webUrl, keyOf, info = () => null, list = null }) {
  cfg = { file: path.join(dataDir, "reads.jsonl"), offsetFile: path.join(dataDir, "reads.offset"), webUrl, keyOf, info, list };
  setTimeout(flush, 30 * 1000).unref();
  setTimeout(sendShelf, 2 * 60 * 1000).unref();
  setInterval(sendShelf, 24 * 3600 * 1000).unref();
}

async function sendShelf() {
  const key = cfg?.list && cfg.keyOf("owner");
  if (!key) return;
  try {
    const books = Object.fromEntries(cfg.list().filter((b) => b?.name).map((b) => [b.name, b]));
    const res = await fetch(`${cfg.webUrl}/api/reads`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "owner", key, reads: [], books, shelf: true }), signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`reads ${res.status}`);
  } catch (err) {
    console.error("reads shelf:", err.message);
  }
}

// One full chapter served: reader = account id, book = file name on the shelf, chapter = spine index,
// chars = its plain-text length, chapters = the spine's length, total = the whole book's text length.
function record({ reader, book, chapter, chars, chapters, total }) {
  if (!cfg || !reader || !book || !Number.isInteger(chapter) || chapter < 0) return;
  const line = { reader: String(reader), book: String(book), chapter, chars: Math.max(0, Math.round(Number(chars) || 0)), chapters: Math.max(0, Math.round(Number(chapters) || 0)), total: Math.max(0, Math.round(Number(total) || 0)), day: dayKyiv(new Date()) };
  try {
    fs.appendFileSync(cfg.file, JSON.stringify(line) + "\n");
  } catch (err) {
    return console.error("reads:", err.message);
  }
  if (!timer) timer = setTimeout(flush, FLUSH_MS);
  timer.unref?.();
}

let flushing = false;
async function flush() {
  timer = null;
  if (!cfg || flushing) return;
  flushing = true;
  try {
    let offset = Number(readOr(cfg.offsetFile, "0")) || 0;
    let size;
    try {
      size = fs.statSync(cfg.file).size;
    } catch {
      return;
    }
    if (offset > size) offset = 0;
    if (offset === size) {
      // All sent: start the file over rather than let it grow.
      if (size > 1 << 20) (fs.writeFileSync(cfg.file, ""), fs.writeFileSync(cfg.offsetFile, "0"));
      return;
    }
    const fd = fs.openSync(cfg.file, "r");
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    const text = buf.toString("utf8");
    const end = text.lastIndexOf("\n") + 1; // a line still being written waits for the next time
    const lines = text.slice(0, end).split("\n").filter(Boolean).slice(0, BATCH);
    const used = lines.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
    const byReader = new Map();
    for (const l of lines) {
      try {
        const r = JSON.parse(l);
        if (!byReader.has(r.reader)) byReader.set(r.reader, []);
        byReader.get(r.reader).push(r);
      } catch {}
    }
    const books = {};
    for (const rs of byReader.values()) for (const r of rs) if (!(r.book in books)) books[r.book] = cfg.info(r.book) || {};
    for (const [id, reads] of byReader) {
      const key = cfg.keyOf(id);
      if (!key) continue; // an account that never signed in here again since keys came; nothing to sign with
      const res = await fetch(`${cfg.webUrl}/api/reads`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, key, reads, books: Object.fromEntries(reads.map((r) => [r.book, books[r.book]])) }), signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`reads ${res.status}`);
    }
    fs.writeFileSync(cfg.offsetFile, String(offset + used));
    if (lines.length === BATCH) timer = setTimeout(flush, 1000);
  } catch (err) {
    console.error("reads:", err.message);
    timer = setTimeout(flush, 10 * FLUSH_MS); // the site is down or restarting: everything waits in the file
  } finally {
    flushing = false;
    timer?.unref?.();
  }
}

function readOr(file, dflt) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return dflt;
  }
}

module.exports = { init, record, flush };

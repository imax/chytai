// Publishers' books (Лабораторія, 2026-10-30): the file never leaves the server. The reader opens the book
// unpacked, epub.js asking for one entry at a time (container.xml, the OPF, a chapter, a picture), and each
// request is checked here. In a browser only the beginning of the book is readable (about PREVIEW of its
// text); the rest comes as a one-paragraph page saying the book continues in the app, because a desktop
// makes screenshots too easy (Max: «на сайті в браузері можна прочитати не всю книжку, якщо вона
// захищена, а тільки початок»). The app (ChytaiApp in its user agent) gets every chapter.
// The books live on the volume, DATA_DIR/protected/<name>.epub, never in the repo. DATA_DIR/protected/shelf.json
// describes them: [{ "name": "<file>.epub", "title": "…", "authors": ["…"], "publisher": "Лабораторія",
// "bookId": "<the site's catalog id>" }] (the publishers' reports group by publisher).
// Plan: docs/publisher-requirements.md.
const fs = require("fs");
const path = require("path");
const JSZip = require("jszip");

const PREVIEW = 0.1;
const CACHE_MAX = 8; // books kept unpacked in memory
// Against pulling books out by script: entries per reader per hour, and books per reader per day.
const HOURLY_MAX = 2000; // opening a book loads every chapter once (page count, search)
const DAILY_BOOKS_MAX = 10;

const TYPES = {
  xhtml: "application/xhtml+xml", html: "application/xhtml+xml", htm: "application/xhtml+xml", xml: "application/xml",
  opf: "application/oebps-package+xml", ncx: "application/x-dtbncx+xml", css: "text/css",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2",
};

// Called once a reader has actually seen a chapter of a protected book (the page reports it; epub.js also
// loads chapters it only measures or searches, so serving one is not reading it). Deduplicated here per
// reader, book, chapter and day. The publishers' reports (thread «Зробити звіти про читання для видавців»)
// fill this in.
// eslint-disable-next-line no-unused-vars
function recordRead({ reader, book, chapter, chars, chapters }) {}

function createProtected({ dir, day }) {
  const cache = new Map(); // name -> { mtime, zip, spine: [{ path, chars }], open: count of readable spine items }
  const served = new Map(); // `${reader}\n${book}` -> Set of chapter indexes served in full today
  const seen = new Set(); // `${day}\n${reader}\n${book}\n${chapter}` already passed to recordRead
  let usage = { hour: "", n: new Map(), day: "", books: new Map() };

  const file = (name) => (name && /\.epub$/i.test(name) ? path.join(dir, name) : null);
  const has = (name) => !!file(name) && fs.existsSync(file(name));

  async function load(name) {
    const f = file(name);
    const mtime = fs.statSync(f).mtimeMs;
    const hit = cache.get(name);
    if (hit?.mtime === mtime) {
      cache.delete(name), cache.set(name, hit);
      return hit;
    }
    const zip = await JSZip.loadAsync(fs.readFileSync(f));
    const container = await zip.file("META-INF/container.xml")?.async("string");
    const opfPath = container?.match(/full-path="([^"]+)"/)?.[1];
    const opf = opfPath && (await zip.file(opfPath)?.async("string"));
    if (!opf) throw new Error("not an EPUB");
    const attr = (tag, a) => tag.match(new RegExp(`\\b${a}="([^"]*)"`))?.[1] || "";
    const hrefs = new Map([...opf.matchAll(/<(?:opf:)?item\b[^>]*>/g)].map((m) => [attr(m[0], "id"), attr(m[0], "href")]));
    const spine = [];
    for (const m of opf.matchAll(/<(?:opf:)?itemref\b[^>]*>/g)) {
      const href = hrefs.get(attr(m[0], "idref"));
      if (!href) continue;
      const p = path.posix.normalize(path.posix.join(path.posix.dirname(opfPath), decodeURIComponent(href)));
      const text = (await zip.file(p)?.async("string")) || "";
      const chars = text.replace(/<head[\s\S]*?<\/head>/i, "").replace(/<[^>]+>/g, "").replace(/&[#\w]+;/g, " ").replace(/\s+/g, "").length;
      spine.push({ path: p, chars });
    }
    // The beginning: whole chapters up to PREVIEW of the text, and at least the first one with text in it.
    const total = spine.reduce((s, c) => s + c.chars, 0);
    let open = 0;
    for (let sum = 0; open < spine.length && (sum < total * PREVIEW || sum === 0); open++) sum += spine[open].chars;
    const book = { mtime, zip, spine, open };
    cache.set(name, book);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return book;
  }

  // false, or why this reader may not have one more entry now.
  function overLimit(reader, name) {
    const now = new Date().toISOString().slice(0, 13);
    if (usage.hour !== now) usage = { ...usage, hour: now, n: new Map() };
    if (usage.day !== day()) usage = { ...usage, day: day(), books: new Map() }, served.clear(), seen.clear();
    const n = (usage.n.get(reader) || 0) + 1;
    usage.n.set(reader, n);
    const books = usage.books.get(reader) || new Set();
    books.add(name);
    usage.books.set(reader, books);
    if (n > HOURLY_MAX) return "Забагато сторінок за годину. Спробуйте трохи пізніше.";
    if (books.size > DAILY_BOOKS_MAX) return "Сьогодні відкрито забагато захищених книжок. Спробуйте завтра.";
    return false;
  }

  const stub = () =>
    Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" lang="uk"><head><title>Далі в додатку</title></head>
<body><p style="margin-top:30vh;text-align:center">Далі книжку можна читати в додатку Chytai.</p></body></html>`);

  // GET <base>/<entry>: one entry of the book. full: the whole book may be read (the app).
  async function serve(req, res, { reader, name, entry, full }) {
    if (!has(name)) return res.status(404).end();
    const why = overLimit(reader, name);
    if (why) return res.status(429).json({ error: why });
    const book = await load(name);
    const p = path.posix.normalize(entry);
    if (p.startsWith("..") || path.posix.isAbsolute(p)) return res.status(404).end();
    const index = book.spine.findIndex((c) => c.path === p);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Robots-Tag", "noindex");
    const ext = path.extname(p).slice(1).toLowerCase();
    if (index >= 0 && !full && index >= book.open) return res.type(TYPES[ext] || "application/xhtml+xml").send(stub());
    const data = await book.zip.file(p)?.async("nodebuffer");
    if (!data) return res.status(404).end();
    if (index >= 0) {
      const key = `${reader}\n${name}`;
      if (!served.has(key)) served.set(key, new Set());
      served.get(key).add(index);
    }
    res.type(TYPES[ext] || "application/octet-stream").send(data);
  }

  // The page says a chapter is on screen: counted if it was served to this reader in full.
  async function read({ reader, name, chapter }) {
    if (!has(name) || !served.get(`${reader}\n${name}`)?.has(chapter)) return false;
    const key = `${day()}\n${reader}\n${name}\n${chapter}`;
    if (seen.has(key)) return true;
    if (seen.size > 200000) seen.clear();
    seen.add(key);
    const book = await load(name);
    recordRead({ reader, book: name, chapter, chars: book.spine[chapter].chars, chapters: book.spine.length });
    return true;
  }

  // A book's entry in shelf.json, or {}.
  let shelf = { mtime: 0, list: [] };
  function meta(name) {
    const f = path.join(dir, "shelf.json");
    try {
      const mtime = fs.statSync(f).mtimeMs;
      if (mtime !== shelf.mtime) shelf = { mtime, list: JSON.parse(fs.readFileSync(f, "utf8")) };
    } catch {
      shelf = { mtime: 0, list: [] };
    }
    return shelf.list.find((b) => b.name === name) || {};
  }

  // What the page needs to open it: whether it gets the whole book here.
  const info = (full) => ({ protected: true, preview: !full });

  return { has, serve, read, info, meta, dir };
}

module.exports = { createProtected, recordRead };

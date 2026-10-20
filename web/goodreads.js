// Import of a Goodreads library (Max, 2026-10-20: «утиліта імпорту з Goodreads»). Goodreads lets a reader
// export their whole library as one CSV (My Books → Import and export → Export Library); a reader uploads
// that file here, sees what would land on their shelf, and confirms. Each row becomes an entry: the
// exclusive shelf is the status (read / currently-reading / to-read), My Rating the rating, Date Read the
// year, My Review the note. A row joins a book the catalog or the library already has (by ISBN, then by
// title and author); the rest become the reader's own books, as if typed in by hand. The file itself is
// read once and thrown away; Private Notes and anything else in it are never kept.

const CHYTAI_STATUS = { read: "read", "currently-reading": "reading", "to-read": "want" };

// ---- the CSV (RFC 4180: quotes, doubled quotes, newlines inside quotes) ----
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  text = text.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") (row.push(cell), (cell = ""));
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x !== "")) rows.push(row);
  return rows;
}

// Goodreads writes ISBNs as ="0316556343" so spreadsheets keep the leading zero.
const isbnOf = (s) => String(s || "").replace(/[^0-9Xx]/g, "").toUpperCase();
// «Harry Potter and the Philosopher's Stone (Harry Potter, #1)»: the series goes, the title stays.
const cleanTitle = (t) =>
  String(t || "")
    .replace(/\s*\(([^()]*#\s*\d[^()]*|[^()]*,\s*(book|vol\.?|volume|частина|книга|том)\s*\d+[^()]*)\)\s*$/i, "")
    .trim();
// A review is written in Goodreads' editor: <br/> for line breaks, sometimes <b> and <i>.
const reviewText = (s) =>
  String(s || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(b|strong)>/gi, "**")
    .replace(/<\/?(i|em)>/gi, "*")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
const dateOf = (s) => {
  const m = String(s || "").match(/^(\d{4})\/(\d{2})\/(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
};

// The rows of a Goodreads export as entries-to-be: { title, author, isbns, status, rating, year, note, copy, added, read, goodreadsId }.
function parseExport(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { error: "Файл порожній." };
  const head = rows[0].map((h) => h.trim());
  const col = (name) => head.indexOf(name);
  const need = ["Title", "Author", "Exclusive Shelf"];
  if (need.some((n) => col(n) < 0)) return { error: "Це не схоже на експорт Goodreads: у файлі немає колонок Title, Author і Exclusive Shelf." };
  const get = (r, name) => (col(name) >= 0 ? String(r[col(name)] ?? "").trim() : "");
  const books = [];
  for (const r of rows.slice(1)) {
    const title = cleanTitle(get(r, "Title"));
    if (!title) continue;
    const shelf = get(r, "Exclusive Shelf");
    const rating = Number(get(r, "My Rating")) || 0;
    const read = dateOf(get(r, "Date Read"));
    const added = dateOf(get(r, "Date Added"));
    const owned = Number(get(r, "Owned Copies")) || 0;
    const binding = get(r, "Binding").toLowerCase();
    books.push({
      goodreadsId: get(r, "Book Id"),
      title,
      fullTitle: get(r, "Title"),
      author: get(r, "Author").replace(/\s+/g, " "),
      isbns: [isbnOf(get(r, "ISBN13")), isbnOf(get(r, "ISBN"))].filter((x) => x.length >= 10),
      status: CHYTAI_STATUS[shelf] || "",
      rating: rating > 0 ? rating : null,
      year: read ? Number(read.slice(0, 4)) : null,
      note: reviewText(get(r, "My Review")),
      copy: owned > 0 ? (/kindle|ebook|e-book|digital/.test(binding) ? "ebook" : "paper") : "",
      added,
      read,
    });
  }
  if (!books.length) return { error: "У файлі немає жодної книжки." };
  return { books };
}

// ---- the preview: what each row would become on this reader's shelf ----
// plan(store, reader, books) -> { rows: [{ ...book, match: { id, title, author, href } | null, own: entry | null }], counts }
function plan(store, reader, books) {
  const rows = books.map((b) => {
    const id = store.findWork(b);
    const match = id ? store.book(id) : null;
    return { ...b, match: match ? { id: match.id, title: match.title, author: match.author, href: match.href, cover: match.cover } : null, own: match ? store.entry(reader, match.id) : null };
  });
  // Two Goodreads rows for one work (two editions): the second is folded into the first.
  const seen = new Map();
  const out = [];
  for (const r of rows) {
    const key = r.match ? r.match.id : `new:${r.title.toLowerCase()}|${r.author.toLowerCase()}`;
    if (seen.has(key)) {
      seen.get(key).also = (seen.get(key).also || 0) + 1;
      continue;
    }
    seen.set(key, r);
    out.push(r);
  }
  const counts = {
    all: out.length,
    matched: out.filter((r) => r.match && !r.own).length,
    own: out.filter((r) => r.own).length,
    fresh: out.filter((r) => !r.match).length,
    folded: rows.length - out.length,
    read: out.filter((r) => r.status === "read").length,
    reading: out.filter((r) => r.status === "reading").length,
    want: out.filter((r) => r.status === "want").length,
    rated: out.filter((r) => r.rating != null).length,
    notes: out.filter((r) => r.note).length,
  };
  return { rows: out, counts };
}

// ---- multipart/form-data with one file, without a dependency (Express 5 has no parser for it) ----
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!m) return null;
  const boundary = Buffer.from(`--${m[1] || m[2]}`);
  const parts = {};
  let pos = buf.indexOf(boundary);
  while (pos >= 0) {
    pos += boundary.length;
    if (buf.slice(pos, pos + 2).toString() === "--") break;
    const headEnd = buf.indexOf("\r\n\r\n", pos);
    if (headEnd < 0) break;
    const head = buf.slice(pos, headEnd).toString("utf8");
    const next = buf.indexOf(boundary, headEnd);
    if (next < 0) break;
    const body = buf.slice(headEnd + 4, next - 2); // before the \r\n that precedes the next boundary
    const name = /name="([^"]*)"/i.exec(head)?.[1];
    const filename = /filename="([^"]*)"/i.exec(head)?.[1];
    if (name) parts[name] = filename != null ? { filename, body } : body.toString("utf8");
    pos = next;
  }
  return parts;
}

module.exports = { parseCsv, parseExport, plan, parseMultipart, cleanTitle, reviewText };

// Import of an Apple Books library (Max, 2026-10-20: «те саме, тільки з Apple Books»). Apple Books has no
// export and no API; on a Mac its library is a Core Data SQLite file,
//   ~/Library/Containers/com.apple.iBooksX/Data/Documents/BKLibrary/BKLibrary-*.sqlite  (+ -wal, -shm),
// so a reader with a Mac drags those files into the form. From ZBKLIBRARYASSET we take the title, the
// author, how far the book was read and when it was finished; the rest of the file is never kept. Apple
// Books has no ratings or reviews, so only books and statuses come over. The -wal file matters: Books
// writes there first and the .sqlite alone can be months behind, hence all three files are asked for.
const fs = require("fs");
const os = require("os");
const path = require("path");

// Core Data dates: seconds since 2001-01-01.
const dateOf = (s) => (s ? new Date((s + 978307200) * 1000).toISOString().slice(0, 10) : "");
const authorOf = (a) => String(a || "").replace(/^(UnknownAuthor|MultipleAuthors)$/i, "").split(";").map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean).join(", ");

// The uploaded files ({ filename, body }) as entries-to-be, the same shape goodreads.js makes:
// { title, author, isbns, status, rating, year, note, copy, added, read, appleId }.
function parseLibrary(files) {
  const main = files.find((f) => /\.sqlite$/i.test(f.filename));
  if (!main) return { error: "Серед файлів немає BKLibrary-….sqlite. Виберіть усі файли з теки BKLibrary." };
  if (main.body.slice(0, 15).toString() !== "SQLite format 3") return { error: "Це не схоже на базу Apple Books." };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bk-"));
  try {
    // The files are put down under one name, so the -wal and -shm belong to the .sqlite.
    fs.writeFileSync(path.join(dir, "lib.sqlite"), main.body);
    for (const f of files) {
      const m = /\.sqlite-(wal|shm)$/i.exec(f.filename);
      if (m) fs.writeFileSync(path.join(dir, `lib.sqlite-${m[1].toLowerCase()}`), f.body);
    }
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(path.join(dir, "lib.sqlite"));
    let rows;
    try {
      rows = db
        .prepare(
          `SELECT ZTITLE title, ZAUTHOR author, ZCONTENTTYPE type, ZISSTOREAUDIOBOOK audio, ZISSAMPLE sample, ZISHIDDEN hidden,
                  ZDATASOURCEIDENTIFIER source, ZISFINISHED finished, ZBOOKHIGHWATERMARKPROGRESS high, ZREADINGPROGRESS progress,
                  ZDATEFINISHED finishedAt, ZLASTENGAGEDDATE engagedAt, ZPURCHASEDATE boughtAt, ZCREATIONDATE createdAt, ZASSETID assetId, ZSTOREID storeId
           FROM ZBKLIBRARYASSET`
        )
        .all();
    } catch (e) {
      return { error: "У файлі немає таблиці книжок Apple Books. Перевірте, що це BKLibrary-….sqlite." };
    } finally {
      db.close();
    }
    const books = [];
    let skipped = 0;
    for (const r of rows) {
      const title = String(r.title || "").replace(/\s+/g, " ").trim();
      // Content type 1 is a book (3 a PDF, 5 a series folder); Apple's free «classics» series items the
      // reader never bought are cloud-only rows from the series data source; samples and hidden books go too.
      const series = /DataSourceSeries$/.test(r.source || "") || Number(r.type) === 5;
      if (!title || Number(r.type) === 3 || series || r.sample || r.hidden) {
        if (title && !series) skipped++;
        continue;
      }
      const high = Math.max(Number(r.high) || 0, Number(r.progress) || 0);
      const status = r.finished || high >= 0.98 ? "read" : high >= 0.05 ? "reading" : "want";
      const read = status === "read" ? dateOf(r.finishedAt) || dateOf(r.engagedAt) : "";
      const touched = dateOf(r.engagedAt);
      books.push({
        appleId: String(r.assetId || r.storeId || ""),
        title,
        fullTitle: title,
        author: authorOf(r.author),
        isbns: [],
        status,
        rating: null,
        year: read ? Number(read.slice(0, 4)) : null,
        note: "",
        copy: r.audio ? "" : "ebook",
        added: dateOf(r.boughtAt) || dateOf(r.createdAt),
        read,
        touched,
        progress: Math.round(high * 100),
      });
    }
    if (!books.length) return { error: "У цій бібліотеці не знайшлося книжок (PDF ми не переносимо)." };
    return { books, skipped };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { parseLibrary };

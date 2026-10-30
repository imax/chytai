// Reading reports for publishers (Max, 2026-10-30, docs/publisher-requirements.md, task 3): how many of a
// publisher's books are in Chytai and how much each was read, so the publisher can settle with authors and
// rights holders. Max chose the simplest form: a letter on the 1st of every month for the month before, to the
// publisher's addresses with a copy to him, the table in the letter and as CSV. No publisher accounts.
//
// The reader (server/reads.js) sends every chapter of a protected book a reader actually had on screen; here
// it is one row per reader, book, chapter and Kyiv day. Per book and month:
//   - readers: accounts that read any of it that month,
//   - started: readers who passed 10% of its text that month, finished: who passed 90% (each reader once ever),
//   - pages: text read for the first time that month, in pages of 1500 characters (as Kindle Unlimited counts).
// What the contract pays for is the publisher's choice; the letter gives them all. Publishers never see who read.
const START = 0.1;
const FINISH = 0.9;
const PAGE = 1500;
const SEND_HOUR = 10; // Kyiv, on the 1st

const dayKyiv = (d) => d.toLocaleDateString("sv-SE", { timeZone: "Europe/Kyiv" });
const hourKyiv = (d) => Number(d.toLocaleString("en-US", { timeZone: "Europe/Kyiv", hour: "numeric", hourCycle: "h23" }));
const MONTHS = ["січень", "лютий", "березень", "квітень", "травень", "червень", "липень", "серпень", "вересень", "жовтень", "листопад", "грудень"];
const monthName = (m) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const prevMonth = (m) => {
  const [y, n] = m.split("-").map(Number);
  return n === 1 ? `${y - 1}-12` : `${y}-${String(n - 1).padStart(2, "0")}`;
};
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const csvCell = (v) => (/[",\n;]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const num = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");

class Reports {
  // auth: sends letters; ownerEmail(): where Max's copy goes.
  constructor({ db, auth, ownerEmail, log = console.log }) {
    Object.assign(this, { db, auth, ownerEmail, log });
    db.exec(`
CREATE TABLE IF NOT EXISTS reads (reader TEXT NOT NULL, book TEXT NOT NULL, chapter INTEGER NOT NULL, day TEXT NOT NULL, chars INTEGER NOT NULL, PRIMARY KEY (reader, book, chapter, day));
CREATE INDEX IF NOT EXISTS reads_day ON reads (day);
CREATE TABLE IF NOT EXISTS read_books (book TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', authors TEXT NOT NULL DEFAULT '', publisher TEXT NOT NULL DEFAULT '', site_id TEXT NOT NULL DEFAULT '', chapters INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0, on_shelf INTEGER NOT NULL DEFAULT 1);
`);
  }

  // From the reader: reads = [{ book, chapter, chars, chapters, total, day }], books = { file: shelf entry };
  // shelf = true when books is the whole shelf (a book missing from it has left the shelf).
  add(reader, reads, books, shelf = false) {
    const ok = (s) => /^\d{4}-\d\d-\d\d$/.test(s);
    this.db.tx(() => {
      const put = this.db.prepare("INSERT OR IGNORE INTO reads (reader, book, chapter, day, chars) VALUES (?, ?, ?, ?, ?)");
      const size = this.db.prepare("INSERT INTO read_books (book, chapters, total) VALUES (?, ?, ?) ON CONFLICT (book) DO UPDATE SET chapters = MAX(chapters, excluded.chapters), total = CASE WHEN excluded.total > 0 THEN excluded.total ELSE total END");
      for (const r of reads.slice(0, 5000)) {
        const book = String(r?.book || "").slice(0, 300);
        if (!book || !Number.isInteger(r.chapter) || r.chapter < 0 || !ok(String(r.day))) continue;
        put.run(reader, book, r.chapter, r.day, Math.max(0, Number(r.chars) || 0));
        size.run(book, Math.max(0, Number(r.chapters) || 0), Math.max(0, Number(r.total) || 0));
      }
      const meta = this.db.prepare("INSERT INTO read_books (book, title, authors, publisher, site_id, on_shelf) VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT (book) DO UPDATE SET title = excluded.title, authors = excluded.authors, publisher = excluded.publisher, site_id = excluded.site_id, on_shelf = 1");
      for (const [book, b] of Object.entries(books || {}).slice(0, 5000)) {
        if (!book || !b || typeof b !== "object") continue;
        const authors = (Array.isArray(b.authors) ? b.authors : [b.authors]).filter(Boolean).map(String).join(", ");
        meta.run(book.slice(0, 300), String(b.title || "").slice(0, 300), authors.slice(0, 300), String(b.publisher || "").trim().slice(0, 100), String(b.bookId || "").slice(0, 100));
      }
      if (shelf) {
        const names = new Set(Object.keys(books || {}));
        for (const { book } of this.db.prepare("SELECT book FROM read_books WHERE on_shelf = 1").all()) if (!names.has(book)) this.db.prepare("UPDATE read_books SET on_shelf = 0 WHERE book = ?").run(book);
      }
    });
  }

  // Per book, for one month ('2026-11'): [{ book, title, authors, publisher, site_id, readers, started, finished, pages }].
  month(m, publisher = null) {
    const books = this.db.prepare("SELECT * FROM read_books").all().filter((b) => publisher === null || b.publisher === publisher);
    const from = `${m}-01`, to = `${m}-31`;
    const out = [];
    for (const b of books) {
      const rows = this.db.prepare("SELECT reader, chapter, MIN(day) AS first, MAX(chars) AS chars FROM reads WHERE book = ? GROUP BY reader, chapter").all(b.book);
      const active = new Set(this.db.prepare("SELECT DISTINCT reader FROM reads WHERE book = ? AND day BETWEEN ? AND ?").all(b.book, from, to).map((r) => r.reader));
      const byReader = new Map();
      for (const r of rows) (byReader.get(r.reader) || byReader.set(r.reader, []).get(r.reader)).push(r);
      let started = 0, finished = 0, chars = 0;
      for (const list of byReader.values()) {
        list.sort((a, c) => (a.first < c.first ? -1 : a.first > c.first ? 1 : 0));
        // The day the reader passed a share of the book: by text when the reader sent its length, else by chapters.
        let sum = 0;
        const shares = list.map((r, i) => (sum += r.chars, b.total ? sum / b.total : b.chapters ? (i + 1) / b.chapters : 0));
        const passed = (t) => list[shares.findIndex((x) => x >= t)]?.first || null;
        const s = passed(START), f = passed(FINISH);
        if (s && s >= from && s <= to) started++;
        if (f && f >= from && f <= to) finished++;
        for (const r of list) if (r.first >= from && r.first <= to) chars += r.chars;
      }
      out.push({ ...b, readers: active.size, started, finished, pages: Math.round(chars / PAGE) });
    }
    return out.sort((a, c) => c.readers - a.readers || c.pages - a.pages || a.title.localeCompare(c.title, "uk"));
  }

  // Publishers on the protected shelf, with the addresses Max set: [{ name, emails, books (on the shelf) }].
  publishers() {
    const set = this.settings();
    const names = new Map();
    for (const r of this.db.prepare("SELECT publisher, SUM(on_shelf) AS n FROM read_books WHERE publisher != '' GROUP BY publisher").all()) names.set(r.publisher, r.n);
    for (const n of Object.keys(set)) if (!names.has(n)) names.set(n, 0);
    return [...names].map(([name, books]) => ({ name, books, emails: set[name]?.emails || [] })).sort((a, b) => a.name.localeCompare(b.name, "uk"));
  }
  settings() {
    try {
      return JSON.parse(this.db.get("reports:publishers") || "{}");
    } catch {
      return {};
    }
  }
  setEmails(name, emails) {
    const set = this.settings();
    const list = String(emails || "").split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)).slice(0, 10);
    set[name] = { ...(set[name] || {}), emails: list };
    this.db.set("reports:publishers", JSON.stringify(set));
    return list;
  }

  // The letter for one publisher and month: { subject, text, html, csv, filename }.
  letter(name, m) {
    const rows = this.month(m, name).filter((r) => r.on_shelf || r.readers);
    const books = this.db.prepare("SELECT COUNT(*) AS n FROM read_books WHERE publisher = ? AND on_shelf = 1").get(name).n;
    const head = ["Книжка", "Автор", "Читачів", "Прочитали ≥10%", "Дочитали", "Сторінок"];
    const line = (r) => [r.title || r.book, r.authors, r.readers, r.started, r.finished, r.pages];
    const total = rows.reduce((t, r) => (t.readers += r.readers, t.started += r.started, t.finished += r.finished, t.pages += r.pages, t), { readers: 0, started: 0, finished: 0, pages: 0 });
    const subject = `Chytai: звіт за ${monthName(m)}, «${name}»`;
    const intro = `Ваших книжок у Chytai: ${books}.`;
    const note = "Читачів: скільки людей читали книжку цього місяця. Прочитали ≥10% і дочитали (≥90% тексту): кожна людина рахується один раз, у місяці, коли пройшла цю межу. Сторінок: текст, прочитаний уперше цього місяця, сторінка = 1500 знаків. Рахуємо лише розділи, які людина відкрила в читалці. Хто саме читав, ми не передаємо.";
    const text = [subject, "", intro, "", ...rows.map((r) => `${r.title || r.book}${r.authors ? ` (${r.authors})` : ""}: читачів ${r.readers}, прочитали ≥10% ${r.started}, дочитали ${r.finished}, сторінок ${r.pages}`), rows.length > 1 ? `Разом: читачів ${total.readers}, прочитали ≥10% ${total.started}, дочитали ${total.finished}, сторінок ${total.pages}` : "", "", note, "", "Таблиця також у CSV у вкладенні.", "", "Chytai, https://chytai.org.ua"].filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n");
    const td = (v, right) => `<td style="padding:6px 10px;border-bottom:1px solid #e5e0d8;${right ? "text-align:right;" : ""}">${v}</td>`;
    const th = (v, right) => `<th style="padding:6px 10px;border-bottom:2px solid #d8d0c4;font-weight:600;${right ? "text-align:right;" : "text-align:left;"}">${v}</th>`;
    const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#222;font-size:15px;line-height:1.5;max-width:680px">
<h2 style="font-size:19px;margin:0 0 8px">Звіт за ${esc(monthName(m))}, «${esc(name)}»</h2>
<p style="margin:0 0 14px">${esc(intro)}</p>
<table style="border-collapse:collapse;width:100%;font-size:14px"><thead><tr>${th("Книжка")}${th("Читачів", 1)}${th("Прочитали ≥10%", 1)}${th("Дочитали", 1)}${th("Сторінок", 1)}</tr></thead><tbody>
${rows.map((r) => `<tr>${td(`${esc(r.title || r.book)}${r.authors ? `<br><span style="color:#777;font-size:13px">${esc(r.authors)}</span>` : ""}`)}${td(num(r.readers), 1)}${td(num(r.started), 1)}${td(num(r.finished), 1)}${td(num(r.pages), 1)}</tr>`).join("\n")}
${rows.length > 1 ? `<tr style="font-weight:600">${td("Разом")}${td(num(total.readers), 1)}${td(num(total.started), 1)}${td(num(total.finished), 1)}${td(num(total.pages), 1)}</tr>` : ""}
</tbody></table>
<p style="color:#666;font-size:13px;margin:14px 0">${esc(note)}</p>
<p style="color:#666;font-size:13px;margin:0">Таблиця також у CSV у вкладенні. <a href="https://chytai.org.ua" style="color:#666">Chytai</a></p>
</div>`;
    const csv = "﻿" + [head, ...rows.map(line)].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
    const slug = String(name).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "publisher";
    return { subject, text, html, csv, filename: `chytai-${slug}-${m}.csv`, rows, books };
  }

  async send(name, m, to) {
    const l = this.letter(name, m);
    await this.auth.send(to, l.subject, l.text, { html: l.html, attachments: [{ filename: l.filename, content: Buffer.from(l.csv).toString("base64") }] });
    return l;
  }

  // On the 1st from 10:00 Kyiv, last month's letters to every publisher with an address, and Max's copy of each.
  // A publisher already sent to for that month is skipped, so a restart in the middle sends the rest.
  async run(now = new Date()) {
    const m = prevMonth(dayKyiv(now).slice(0, 7));
    const sent = new Set(JSON.parse(this.db.get(`reports:sent:${m}`) || "[]"));
    const owner = this.ownerEmail();
    for (const p of this.publishers()) {
      if (sent.has(p.name) || !p.emails.length || !p.books) continue;
      for (const to of p.emails) await this.send(p.name, m, to);
      if (owner && !p.emails.includes(owner)) await this.send(p.name, m, owner);
      sent.add(p.name);
      this.db.set(`reports:sent:${m}`, JSON.stringify([...sent]));
      this.log(`reports: ${m} sent to «${p.name}» (${p.emails.join(", ")})`);
    }
    return { month: m, sent: [...sent] };
  }
  sentFor(m) {
    return JSON.parse(this.db.get(`reports:sent:${m}`) || "[]");
  }

  schedule() {
    const tick = () => {
      const now = new Date();
      if (dayKyiv(now).slice(8) !== "01" || hourKyiv(now) < SEND_HOUR) return;
      this.run(now).catch((e) => this.log(`reports run failed: ${e.message}`));
    };
    setInterval(tick, 30 * 60 * 1000).unref();
    setTimeout(tick, 2 * 60 * 1000).unref();
  }
}

module.exports = { Reports, monthName, prevMonth, dayKyiv };

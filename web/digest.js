// The weekly letter (Max, 2026-10-20: «weekly email digest, щоб повертати користувачів на сайт»; proposal in
// /mnt/project-files/chytai-digest/proposal.md). Every Friday at 9:00 Kyiv time each reader with an e-mail
// gets one letter about their own shelves since the last one: what the readers they follow did, what is new
// on the publisher shelves they subscribe to, which of their «хочу прочитати» books turned up in a library or
// a catalog, a nudge about a book they have been reading for weeks, and one reader's note about a book they
// don't have. A letter goes out only when the first three have something in them; nothing is sold and nothing
// is tracked (no open or click tracking, plain links to the site). «Відписатися» is one click, without
// signing in, and a switch in /settings; the mail client's own unsubscribe button works too
// (List-Unsubscribe). Everyone who has not switched it off gets it (Max looked at his own first and said
// «Включаємо на всіх», 2026-10-20); WEB_DIGEST_TO=owner sends it to the owner alone.
// Max's own text on top of the letter (2026-10-22: «editorial текст, який йде наверх розсилки»): he writes it on
// /admin/letter; it goes out with the next Friday letter, to the readers he picks there, and then moves to the
// archive so it never goes twice. A reader whose shelves had nothing new still gets the letter when it has his
// text. Max writes every word of it; nothing here writes it for him.
const crypto = require("crypto");
const { marked } = require("marked");
const pages = require("./pages");
const { isRussian } = require("./store");

const DAY = 86400000;
const SEND_DAY = 5; // Friday
const SEND_HOUR = 9; // Kyiv time (TZ=Europe/Kyiv on Fly; the check uses local time)
const READING_WEEKS = 3; // «Ви зараз читаєте» after this long
const MAX_FEED = 6;
const MAX_NEW = 5;
const MAX_WANT = 6;
const WANT_LOOKUPS = 30; // how many «хочу прочитати» books get a library lookup per letter

// Who gets Max's text (the others still get their letter when their shelves have news, without it).
const AUDIENCES = {
  all: "усім, хто не відписався",
  books: "тим, у кого на полиці є хоч одна книжка",
  returning: "тим, хто заходив на сайт хоча б двічі (у різні дні)",
};

const esc = pages.esc;
const attr = esc;
const MONTHS = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
const plural = (n, one, few, many) => (n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many);
const count = (n, one, few, many) => `${n} ${plural(n, one, few, many)}`;
const kyiv = (d) => new Date(d.toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
const uk = (n) => String(n).replace(".", ",");
const starsText = (r) => (r == null ? "" : "★".repeat(Math.floor(r)) + (r - Math.floor(r) >= 0.4 ? "½" : ""));
// «13–19 жовтня» or «28 вересня – 4 жовтня».
function period(from, to) {
  const a = kyiv(from), b = kyiv(to);
  return a.getMonth() === b.getMonth() ? `${a.getDate()}–${b.getDate()} ${MONTHS[b.getMonth()]}` : `${a.getDate()} ${MONTHS[a.getMonth()]} – ${b.getDate()} ${MONTHS[b.getMonth()]}`;
}
// What a reader did, as the site's feed says it (no guessing the reader's gender from the name).
// «читає зараз», as the feed says it since 2026-10-22.
const did = (status) => ({ read: "прочитано", reading: "читає зараз", want: "хоче прочитати" }[status] || "оцінка");

class Digest {
  constructor({ store, auth, social, libraries, site, log = console.log, to = "owner", ownerId = "owner" }) {
    this.store = store;
    this.auth = auth;
    this.social = social;
    this.libraries = libraries;
    this.site = site; // https://chytai.org.ua
    this.log = log;
    this.to = to;
    this.ownerId = ownerId;
    const db = store.db;
    db.exec("CREATE TABLE IF NOT EXISTS digest_log (reader TEXT PRIMARY KEY, sent TEXT NOT NULL, state TEXT NOT NULL DEFAULT '{}')");
    if (!db.prepare("PRAGMA table_info(readers)").all().some((c) => c.name === "digest")) db.exec("ALTER TABLE readers ADD COLUMN digest INTEGER NOT NULL DEFAULT 1");
  }

  // ---- on and off ----

  // The unsubscribe link carries a signature of the reader id, so it works without signing in and
  // cannot be guessed; the secret is made once and kept in the database.
  secret() {
    let s = this.store.db.get("digest:secret");
    if (!s) this.store.db.set("digest:secret", (s = crypto.randomBytes(24).toString("hex")));
    return s;
  }
  token(readerId) {
    return crypto.createHmac("sha256", this.secret()).update(String(readerId)).digest("hex").slice(0, 32);
  }
  check(readerId, token) {
    const t = this.token(readerId);
    return typeof token === "string" && token.length === t.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(t));
  }
  unsubscribeUrl(readerId) {
    return `${this.site}/digest/unsubscribe/${encodeURIComponent(readerId)}/${this.token(readerId)}`;
  }
  enabled(readerId) {
    const r = this.auth.reader(readerId);
    return !!r && r.digest !== 0;
  }
  setEnabled(readerId, on) {
    this.store.db.prepare("UPDATE readers SET digest = ? WHERE id = ?").run(on ? 1 : 0, readerId);
  }

  // ---- Max's text ----

  // The text for the next letter: { subject, text, audience, updated } or null. `audience` is who gets it.
  editorial() {
    const e = JSON.parse(this.store.db.get("digest:editorial") || "null");
    return e && e.text && e.text.trim() ? e : null;
  }
  setEditorial({ subject = "", text = "", audience = "all" }) {
    const e = { subject: subject.trim(), text: text.replace(/\r\n/g, "\n").trim(), audience: AUDIENCES[audience] ? audience : "all", updated: new Date().toISOString() };
    this.store.db.set("digest:editorial", e.text ? JSON.stringify(e) : "null");
  }
  // The texts that went out, newest first.
  sentEditorials() {
    return JSON.parse(this.store.db.get("digest:editorials") || "[]");
  }
  // Who an audience is, as reader ids among the recipients.
  audience(kind) {
    const db = this.store.db;
    const all = this.recipients();
    if (kind === "books") {
      const has = new Set(db.prepare("SELECT DISTINCT reader FROM entries").all().map((r) => r.reader));
      return new Set(all.filter((r) => has.has(r.id)).map((r) => r.id));
    }
    if (kind === "returning") {
      const back = new Set(db.prepare("SELECT reader FROM visits GROUP BY reader HAVING COUNT(*) >= 2").all().map((r) => r.reader));
      return new Set(all.filter((r) => back.has(r.id) || r.id === this.ownerId).map((r) => r.id));
    }
    return new Set(all.map((r) => r.id));
  }
  audienceCounts() {
    return Object.fromEntries(Object.keys(AUDIENCES).map((k) => [k, this.audience(k).size]));
  }

  // ---- what goes in ----

  // The letter's content for a reader since their last one (or the last week): sections and the state
  // to remember. `null` when there is nothing worth a letter.
  async build(readerId, { now = new Date() } = {}) {
    const store = this.store;
    const log = store.db.prepare("SELECT sent, state FROM digest_log WHERE reader = ?").get(readerId);
    const prev = log ? JSON.parse(log.state || "{}") : null;
    const since = log ? new Date(log.sent) : new Date(now - 7 * DAY);
    const sinceIso = since.toISOString();
    const sinceDay = sinceIso.slice(0, 10);
    const own = store.inLibrary(readerId);
    const entries = store.entriesOf(readerId);

    // 1. The readers they follow: entries changed since the last letter, newest first.
    const followed = new Set(this.auth.following(readerId));
    const feedAll = followed.size ? this.social.feed({ limit: 200, readers: followed }).filter((x) => (x.entry.updated || "") > sinceIso) : [];
    // A book a followed reader put in «Читаю зараз» since the last letter: a line of its own, unless the feed
    // already has that book from them (putting a book already in «Читаю» there changes no entry).
    for (const fid of followed) {
      const n = this.auth.nowOf(fid).books[0];
      if (!n || !n.since || n.since < sinceDay) continue;
      const id = store.canonical(n.id);
      const book = store.book(id);
      const entry = store.entry(fid, id);
      const reader = this.social.who(fid);
      if (!book || !entry || !reader || entry.status === "abandoned" || isRussian(book) || feedAll.some((x) => x.reader.id === fid && store.canonical(x.id) === id)) continue;
      feedAll.push({ reader, id, book, entry: { ...entry, status: "reading", rating: null, note: "", updated: `${n.since}T12:00:00Z` } });
    }
    feedAll.sort((a, b) => ((b.entry.updated || "") > (a.entry.updated || "") ? 1 : -1));
    const feed = feedAll.slice(0, MAX_FEED);

    // 2. New books on the shelves they subscribe to, the ones not already on their shelf.
    const seen = store.seen();
    const fresh = [];
    for (const sid of store.subscriptions(readerId)) {
      const shelf = store.shelf(sid);
      if (!shelf || shelf.draft) continue;
      for (const it of store.visible(shelf)) if (it.isNew && (seen[it.id] || "") > sinceDay && !own.has(it.id) && !own.has(store.canonical(it.id))) fresh.push({ shelf, item: it, book: store.book(it.id), at: seen[it.id] });
    }
    fresh.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    const news = fresh.filter((x) => x.book).slice(0, MAX_NEW);

    // 3. «Хочу прочитати» books that are now somewhere they were not: a library (looked up, a day's cache)
    // or a catalog shelf. The first letter only remembers where things are; from the second on it compares.
    const wants = store
      .library(readerId)
      .filter((r) => r.status === "want")
      .sort((a, b) => ((b.updated || b.added || "") > (a.updated || a.added || "") ? 1 : -1))
      .slice(0, WANT_LOOKUPS);
    const avail = {};
    const found = [];
    // Library lookups go five books at a time (each is cached for a day in libraries.js).
    const holdingsOf = new Map();
    for (let i = 0; i < wants.length; i += 5) await Promise.all(wants.slice(i, i + 5).map(async (r) => {
      const book = store.book(r.id);
      if (!book) return;
      try {
        holdingsOf.set(r.id, await this.libraries.holdings(store.db, book, { log: this.log }));
      } catch (e) {
        this.log(`digest: libraries for ${book.id}: ${e.message}`);
      }
    }));
    for (const r of wants) {
      const book = store.book(r.id);
      if (!book) continue;
      const places = [];
      const shelves = [book.shelf, ...(book.editions || []).map((e) => e.shelf?.id || e.shelf)].filter(Boolean).map((s) => (typeof s === "string" ? store.shelf(s) : s)).filter((s) => s && !s.draft);
      for (const s of shelves) if (!places.some((p) => p.key === `shelf:${s.id}`)) places.push({ key: `shelf:${s.id}`, name: s.name, url: `${this.site}${book.href}` });
      for (const h of holdingsOf.get(r.id) || []) {
        const branches = [...new Set(h.records.flatMap((rec) => rec.branches.filter((b) => b.onShelf > 0).map((b) => b.branch)))];
        if (branches.length) places.push({ key: `lib:${h.id}`, name: h.name, where: branches.slice(0, 2).join(", "), url: h.records[0].url });
      }
      avail[r.id] = places.map((p) => p.key);
      const before = prev?.avail?.[r.id];
      if (before) {
        const fresh = places.filter((p) => !before.includes(p.key));
        if (fresh.length) found.push({ book, places: fresh });
      }
    }
    const want = found.slice(0, MAX_WANT);

    // 4. The book in the reader's «Читаю зараз» status for weeks: one line (Max, 2026-10-22: the status, not
    // the longest of the shelf's «Читаю» books, which may be ten read side by side). No status, no line.
    const n = this.auth.nowOf(readerId).books[0];
    const nowId = n && store.canonical(n.id);
    const weeks = n?.since ? Math.floor((now - new Date(`${n.since}T12:00:00Z`)) / (7 * DAY)) : 0;
    const reading = n && weeks >= READING_WEEKS && entries[nowId] && store.book(nowId) ? { id: nowId, entry: entries[nowId], book: store.book(nowId), weeks } : null;

    // 5. One reader's note about a well rated book they don't have (the home page's «Книжка навмання»).
    const pick = this.social.picks(40).find((x) => x.reader.id !== readerId && !own.has(x.id)) || null;

    const state = { avail };
    const site = this.siteWeek(now);
    const empty = !feed.length && !news.length && !want.length;
    return { empty, state, since, now, site, feed, feedMore: feedAll.length - feed.length, news, newsMore: fresh.filter((x) => x.book).length - news.length, want, reading, pick };
  }

  // The site's week in numbers (Max, 2026-10-22: «скільки додалось читачів, скільки додалось книжок»): the last
  // seven days, the same for every reader. Imports count as books added; that is what happened on the shelves.
  siteWeek(now = new Date()) {
    const db = this.store.db;
    const from = new Date(now - 7 * DAY).toISOString();
    const one = (sql, ...a) => db.prepare(sql).get(...a).n;
    const reviews = (() => {
      try {
        return one("SELECT COUNT(*) AS n FROM reviews WHERE added_by != '' AND seen >= ?", from);
      } catch {
        return 0;
      }
    })();
    return {
      readers: one("SELECT COUNT(*) AS n FROM readers"),
      newReaders: one("SELECT COUNT(*) AS n FROM readers WHERE created >= ?", from),
      added: one("SELECT COUNT(*) AS n FROM entries WHERE added >= ?", from),
      read: one("SELECT COUNT(*) AS n FROM entries WHERE status = 'read' AND updated >= ?", from),
      notes: one("SELECT COUNT(*) AS n FROM entries WHERE note != '' AND updated >= ?", from),
      reviews,
    };
  }

  // ---- the letter ----

  // `editorial` is Max's text for this reader's letter, or null.
  render(reader, d, editorial = null) {
    const site = this.site;
    const url = (href) => (href.startsWith("http") ? href : site + href);
    const when = period(d.since, d.now);
    const unsub = this.unsubscribeUrl(reader.id);
    const bits = []; // the subject and the lead are made of the same pieces
    const short = (t) => (t.length > 48 ? `${t.slice(0, 45).replace(/[\s:,.—-]+$/, "")}…` : t); // long titles, in the subject only
    if (d.feed.length) {
      const f = d.feed[0];
      bits.push(`${f.reader.name.split(/\s+/)[0]}: «${f.book.title}» ${did(f.entry.status)}`);
    }
    if (d.news.length) {
      const by = new Map();
      for (const x of d.news) by.set(x.shelf.name, (by.get(x.shelf.name) || 0) + 1);
      const [name, n] = [...by.entries()].sort((a, b) => b[1] - a[1])[0];
      bits.push(`${count(n + (by.size === 1 ? d.newsMore : 0), "новинка", "новинки", "новинок")} у «${name}»`);
    }
    if (d.want.length) bits.push(`«${d.want[0].book.title}» ${d.want[0].places[0].key.startsWith("lib:") ? "є в бібліотеці" : "з'явилась у каталозі"}`);
    // The subject takes the pieces that fit in about 90 characters, the first one always.
    const auto = bits.map((b) => b.replace(/«([^»]+)»/g, (_, t) => `«${short(t)}»`)).reduce((acc, b) => (!acc ? b : `${acc}, ${b}`.length <= 90 ? `${acc}, ${b}` : acc), "");
    const subject = editorial?.subject || auto || `Chytai: тиждень ${when}`;
    const lead = bits.length ? `${bits.map((b, i) => (i ? b : b.charAt(0).toUpperCase() + b.slice(1))).join(", ")}.` : "";

    const cover = (book) => (book.cover ? `<img src="${attr(book.cover)}" width="44" height="64" alt="" style="width:44px;height:64px;object-fit:cover;border-radius:3px;display:block;background:#ded8cb">` : `<div style="width:44px;height:64px;border-radius:3px;background:#ded8cb"></div>`);
    const row = (book, who, note = "") => `<tr><td style="padding:12px 0;border-bottom:1px solid #e4dfd5;vertical-align:top;width:44px">${cover(book)}</td><td style="padding:12px 0 12px 14px;border-bottom:1px solid #e4dfd5;vertical-align:top">
  <a href="${attr(url(book.href))}" style="font-family:'Source Serif 4',Georgia,serif;font-size:17px;line-height:1.3;color:#1b1a17;text-decoration:none">${esc(book.title)}</a>
  <div style="font-size:13px;color:#6b675f;margin-top:3px">${who}</div>${note ? `<div style="font-family:'Source Serif 4',Georgia,serif;font-size:15px;line-height:1.45;color:#3d3a33;margin-top:6px">${note}</div>` : ""}</td></tr>`;
    const label = (text, aside = "") => `<div style="border-top:1px solid #1b1a17;padding-top:9px;margin:30px 0 4px;font-size:12px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:#1b1a17">${text}${aside ? `<span style="float:right;font-weight:400;letter-spacing:0;text-transform:none"><a href="${attr(aside[1])}" style="color:#6b675f">${aside[0]} →</a></span>` : ""}</div>`;
    const table = (rows) => `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse">${rows.join("")}</table>`;
    const muted = (t) => `<div style="font-size:13px;color:#6b675f;margin-top:10px">${t}</div>`;
    const stars = (r) => (r == null ? "" : ` · <span style="color:#3d7a55;letter-spacing:1px">${starsText(r)}</span>`);
    const b = (t) => `<b style="color:#1b1a17;font-weight:500">${esc(t)}</b>`;
    const html = [];
    const text = [`Chytai, ${when}`, ""];
    // Max's text: Markdown paragraphs (a single line break stays one), links allowed.
    const paras = editorial ? editorial.text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean) : [];
    if (paras.length) text.push(paras.map((p) => p.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => (u.replace(/^https?:\/\//, "").startsWith(t) ? u : `${t} (${u})`))).join("\n\n"), "");
    const own = paras.map((p) => `<p style="font-family:'Source Serif 4',Georgia,serif;font-size:17px;line-height:1.55;color:#1b1a17;margin:0 0 16px">${marked.parseInline(esc(p).replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m) => m.replace(/&amp;/g, "&"))).replace(/<a /g, '<a style="color:#1b1a17" ').replace(/\n/g, "<br>")}</p>`).join("\n  ");
    const shelvesNews = d.feed.length || d.news.length || d.want.length;
    if (shelvesNews) text.push(...(paras.length ? ["—", "", "ЩО СТАЛОСЯ НА ВАШИХ ПОЛИЦЯХ"] : []), lead, "");

    if (d.feed.length) {
      html.push(label("Читачі, за якими ви стежите", ["стрічка", `${site}/community`]));
      html.push(table(d.feed.map((x) => row(x.book, `<a href="${attr(url(x.reader.href))}" style="color:#1b1a17;text-decoration:none">${b(x.reader.name)}</a> ${did(x.entry.status)}${stars(x.entry.rating)}`, x.entry.note ? pages.inline(x.entry.note) : ""))));
      if (d.feedMore > 0) html.push(muted(`і ще ${count(d.feedMore, "запис", "записи", "записів")} у <a href="${site}/community" style="color:#6b675f">стрічці</a>`));
      text.push("ЧИТАЧІ, ЗА ЯКИМИ ВИ СТЕЖИТЕ", ...d.feed.map((x) => `• ${x.book.title} — ${x.reader.name} ${did(x.entry.status)}${x.entry.rating != null ? ` ${uk(x.entry.rating)}/5` : ""}${x.entry.note ? `\n  ${x.entry.note.replace(/\s+/g, " ").slice(0, 300)}` : ""}\n  ${url(x.book.href)}`), ...(d.feedMore > 0 ? [`  …і ще ${d.feedMore}: ${site}/community`] : []), "");
    }
    if (d.news.length) {
      html.push(label("Нове у видавництв", ["усі полиці", `${site}/publishers`]));
      html.push(table(d.news.map((x) => row(x.book, [esc(x.shelf.name), esc(x.book.author), esc((x.book.tags || []).find((t) => t !== "українською") || "")].filter(Boolean).join(" · ")))));
      if (d.newsMore > 0) html.push(muted(`і ще ${count(d.newsMore, "новинка", "новинки", "новинок")} на полицях, на які ви підписані`));
      text.push("НОВЕ У ВИДАВНИЦТВ", ...d.news.map((x) => `• ${x.book.title}${x.book.author ? ` — ${x.book.author}` : ""} (${x.shelf.name})\n  ${url(x.book.href)}`), ...(d.newsMore > 0 ? [`  …і ще ${d.newsMore}: ${site}/publishers`] : []), "");
    }
    if (d.want.length) {
      html.push(label("Хотіли прочитати, і ось де є"));
      const where = (p) => (p.key.startsWith("lib:") ? `з'явилась у ${b(p.name)}${p.where ? ` (${esc(p.where)})` : ""}` : `з'явилась у ${b(p.name)}`);
      html.push(table(d.want.map((x) => row(x.book, [esc(x.book.author), x.places.map((p) => `<a href="${attr(p.url)}" style="color:#6b675f;text-decoration:none">${where(p)}</a>`).join("; ")].filter(Boolean).join(" · ")))));
      text.push("ХОТІЛИ ПРОЧИТАТИ, І ОСЬ ДЕ Є", ...d.want.map((x) => `• ${x.book.title}: ${x.places.map((p) => `${p.name}${p.where ? ` (${p.where})` : ""}`).join("; ")}\n  ${url(x.book.href)}`), "");
    }
    if (d.reading) {
      const r = d.reading;
      html.push(label("Ви зараз читаєте"));
      html.push(`<p style="font-size:15px;line-height:1.5;color:#3d3a33;margin:12px 0 0">«<a href="${attr(url(r.book.href))}" style="color:#1b1a17">${esc(r.book.title)}</a>» уже ${count(r.weeks, "тиждень", "тижні", "тижнів")}. Коли дочитаєте, <a href="${attr(url(`/me/book/${encodeURIComponent(r.id)}`))}" style="color:#1b1a17">поставте оцінку</a> — це допоможе іншим читачам вибрати. А якщо не йде, її можна позначити «Покинуто» і взятися за іншу.</p>`);
      text.push("ВИ ЗАРАЗ ЧИТАЄТЕ", `«${r.book.title}» уже ${count(r.weeks, "тиждень", "тижні", "тижнів")}. Коли дочитаєте, поставте оцінку; якщо не йде, позначте «Покинуто» і візьміться за іншу: ${url(`/me/book/${encodeURIComponent(r.id)}`)}`, "");
    }
    if (d.pick) {
      const p = d.pick;
      html.push(label("Одна книжка на вихідні"));
      html.push(`<div style="border:1px solid #e4dfd5;border-radius:10px;padding:16px 18px;margin-top:12px">
  <p style="font-family:'Source Serif 4',Georgia,serif;font-size:16px;line-height:1.45;color:#1b1a17;margin:0 0 8px">${pages.inline(p.entry.note)}</p>
  <div style="font-size:13px;color:#6b675f"><a href="${attr(url(p.reader.href))}" style="color:#1b1a17;text-decoration:none">${b(p.reader.name)}</a> про «<a href="${attr(url(p.book.href))}" style="color:#6b675f">${esc(p.book.title)}</a>»${p.book.author ? ` ${esc(p.book.author)}` : ""}${stars(p.entry.rating)}</div>
  <a href="${attr(url(p.book.href))}" style="display:inline-block;border:1px solid #1b1a17;color:#1b1a17;border-radius:999px;padding:8px 18px;font-size:14px;font-weight:500;text-decoration:none;margin-top:12px">Відкрити книжку</a>
</div>`);
      text.push("ОДНА КНИЖКА НА ВИХІДНІ", `${p.reader.name} про «${p.book.title}»${p.book.author ? ` (${p.book.author})` : ""}${p.entry.rating != null ? `, ${uk(p.entry.rating)}/5` : ""}:`, p.entry.note.replace(/\s+/g, " ").slice(0, 400), url(p.book.href), "");
    }
    // The site's week: numbers that are not zero, in one small block at the end.
    const w = d.site;
    const nums = w ? [
      [w.newReaders, plural(w.newReaders, "новий читач", "нових читачі", "нових читачів"), `усього ${w.readers}`],
      [w.added, plural(w.added, "книжку додали на полиці", "книжки додали на полиці", "книжок додали на полиці")],
      [w.read, plural(w.read, "книжку позначили прочитаною", "книжки позначили прочитаними", "книжок позначили прочитаними")],
      [w.notes, plural(w.notes, "нотатку про книжку", "нотатки про книжки", "нотаток про книжки")],
      [w.reviews, plural(w.reviews, "огляд додали до книжок", "огляди додали до книжок", "оглядів додали до книжок")],
    ].filter(([n]) => n > 0) : [];
    if (nums.length) {
      html.push(label("Chytai за тиждень"));
      html.push(`<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin-top:6px">${nums.map(([n, l, sub]) => `<tr><td style="padding:7px 14px 7px 0;width:1%;white-space:nowrap;text-align:right;font-family:'Source Serif 4',Georgia,serif;font-size:22px;color:#1b1a17;vertical-align:baseline">${n}</td><td style="padding:7px 0;font-size:15px;color:#3d3a33;vertical-align:baseline">${l}${sub ? ` <span style="color:#6b675f;font-size:13px">· ${sub}</span>` : ""}</td></tr>`).join("")}</table>`);
      text.push("CHYTAI ЗА ТИЖДЕНЬ", ...nums.map(([n, l, sub]) => `${n} ${l}${sub ? ` (${sub})` : ""}`), "");
    }
    text.push("—", "Цей лист приходить раз на тиждень, у п'ятницю вранці, і лише коли є що розповісти.", `Відписатися: ${unsub}`, `Налаштування: ${site}/settings/mail`);

    const page = `<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(subject)}</title></head>
<body style="margin:0;background:#f7f4ee;color:#1b1a17;font-family:Onest,-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased">
<div style="max-width:560px;margin:0 auto;padding:32px 20px 40px">
  <div style="font-weight:600;font-size:15px"><a href="${site}" style="color:#1b1a17;text-decoration:none">Chytai</a> <span style="color:#6b675f;font-weight:400;margin-left:10px">${esc(when)}</span></div>
  ${own ? `<div style="margin:24px 0 10px">
  ${own}
  </div>` : ""}
  ${shelvesNews ? `<h${own ? 2 : 1} style="font-family:'Source Serif 4',Georgia,serif;font-weight:500;font-size:${own ? 21 : 26}px;line-height:1.25;margin:${own ? "34px" : "22px"} 0 6px">Що сталося на ваших полицях за тиждень</h${own ? 2 : 1}>
  <p style="color:#3d3a33;font-size:15px;line-height:1.5;margin:0 0 26px">${esc(lead)}</p>` : ""}
  ${html.join("\n")}
  <div style="border-top:1px solid #1b1a17;margin-top:36px;padding-top:14px;font-size:12px;line-height:1.6;color:#6b675f">
    Цей лист приходить раз на тиждень, у п'ятницю вранці, і лише коли є що розповісти.<br>
    <a href="${attr(unsub)}" style="color:#6b675f">Відписатися</a> · <a href="${site}/settings/mail" style="color:#6b675f">Налаштування</a> · <a href="${site}" style="color:#6b675f">chytai.org.ua</a>
  </div>
</div></body></html>`;
    // Links inside notes (pages.inline) are relative to the site.
    return { subject, html: page.replace(/href="\//g, `href="${site}/`), text: text.join("\n"), unsubscribe: unsub };
  }

  // ---- sending ----

  // The readers who get the letter: those with an e-mail who have not switched it off; while
  // WEB_DIGEST_TO is «owner», the owner alone.
  recipients() {
    return this.auth.readers().filter((r) => r.email && r.digest !== 0 && (this.to === "all" || r.id === this.ownerId));
  }

  // `editorial`: Max's text when this reader is in its audience (the run decides), else null.
  async sendTo(reader, { now = new Date(), dry = false, force = false, editorial = null } = {}) {
    const d = await this.build(reader.id, { now });
    if (!dry) this.store.db.prepare("INSERT INTO digest_log (reader, sent, state) VALUES (?, ?, ?) ON CONFLICT (reader) DO UPDATE SET sent = excluded.sent, state = excluded.state").run(reader.id, now.toISOString(), JSON.stringify(d.state));
    if (d.empty && !editorial && !force) return { sent: false, reason: "nothing new" };
    if (d.empty && !editorial) return { sent: false, reason: "nothing new (forced: still nothing to show)" };
    const letter = this.render(reader, d, editorial);
    await this.auth.send(reader.email, letter.subject, letter.text, { html: letter.html, headers: { "List-Unsubscribe": `<${letter.unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } });
    return { sent: true, subject: letter.subject };
  }

  // The weekly run: every recipient in turn; one failure does not stop the rest.
  async run({ now = new Date() } = {}) {
    if (this.running) return this.running;
    const out = { started: now.toISOString(), sent: 0, skipped: 0, errors: [] };
    // Max's text is read once, at the start, so an edit during the run does not split the letters.
    const editorial = this.editorial();
    const audience = editorial ? this.audience(editorial.audience) : new Set();
    let withText = 0;
    this.running = (async () => {
      for (const r of this.recipients()) {
        try {
          const res = await this.sendTo(r, { now, editorial: audience.has(r.id) ? editorial : null });
          if (res.sent && audience.has(r.id)) withText++;
          res.sent ? out.sent++ : out.skipped++;
          this.log(`digest @${r.username}: ${res.sent ? `sent «${res.subject}»` : res.reason}`);
        } catch (e) {
          out.errors.push(`@${r.username}: ${e.message}`);
          this.log(`digest @${r.username} failed: ${e.message}`);
        }
      }
      out.finished = new Date().toISOString();
      // The text went out: into the archive, so the next letter starts without it.
      if (editorial && withText) {
        out.editorial = withText;
        const db = this.store.db;
        db.set("digest:editorials", JSON.stringify([{ ...editorial, sent: out.started, readers: withText }, ...this.sentEditorials()]));
        if (JSON.stringify(this.editorial()) === JSON.stringify(editorial)) db.set("digest:editorial", "null");
      }
      this.store.db.set("digest:last", JSON.stringify(out));
      return out;
    })().finally(() => (this.running = null));
    return this.running;
  }

  // Friday 9:00 Kyiv time: checked every ten minutes (the machine is always on since 2026-10-20), once a day.
  schedule() {
    const tick = () => {
      const t = kyiv(new Date());
      const today = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
      if (t.getDay() !== SEND_DAY || t.getHours() < SEND_HOUR || this.store.db.get("digest:lastRun") === today) return;
      this.store.db.set("digest:lastRun", today);
      this.run().catch((e) => this.log(`digest run failed: ${e.message}`));
    };
    setInterval(tick, 10 * 60 * 1000).unref();
    setTimeout(tick, 60 * 1000).unref();
  }
}

module.exports = { Digest, AUDIENCES };

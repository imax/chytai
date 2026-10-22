// HTML for the web platform: plain template strings, no framework. Every page goes through
// layout(). The look is Max's Claude Design handoff of 2026-10-20 («Chytai.org.ua веб-дизайн», direction
// 2b and screens 3a–3h): paper, Source Serif 4 for titles and notes, Onest for the rest, a green accent.
// Readers first: lists show what readers made of a book; shops, prices and formats are on the book page.
const { marked } = require("marked");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
// Static files are cached for an hour; their address carries a hash of the content so a deploy reaches
// browsers at once.
const asset = (name) => `/${name}?v=${crypto.createHash("sha1").update(fs.readFileSync(path.join(__dirname, "public", name))).digest("hex").slice(0, 8)}`;
const ASSETS = { css: asset("style.css"), js: asset("app.js") };
// The public origin for canonical and Open Graph addresses (search engines want absolute ones).
const ORIGIN = `https://${process.env.WEB_DOMAIN || "chytai.org.ua"}`;
// Pages nobody should find through a search engine: one's own, the sign-in flow, the owner's tools and
// search results (an endless set of addresses). Public pages name their canonical address instead.
const NOINDEX = new Set(["/search", "/login", "/settings", "/welcome", "/me", "/admin", "/import"]);
const FONTS = "https://fonts.googleapis.com/css2?family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;1,8..60,400&family=Onest:wght@400;500;600&display=swap";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const attr = esc;
const plural = (n, one, few, many) => (n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many);
const count = (n, one, few, many) => `${n} ${plural(n, one, few, many)}`;
const uk = (n) => String(n).replace(".", ",");
const BOOKS = ["книжка", "книжки", "книжок"];
const books = (n) => count(n, ...BOOKS);

// «Покинуто» (a reader's idea, 2026-10-21): a book put down for good. Not read, and quiet: it stays on the
// reader's shelf, public like the other tabs (Max, 2026-10-22), but never reaches the feed, the letters, a
// book's «У читачів» or its rating (social.js).
const STATUS = { read: "Прочитано", reading: "Читаю", want: "Хочу прочитати", abandoned: "Покинуто" };
const COPY = { paper: "На папері", ebook: "E-book", seeking: "Шукаю на папері" };
// What a reader did, as the feed says it: «Оля К. оцінка ★★★★», «Андрій читає».
const VERB = { read: "прочитано", reading: "читає", want: "хоче прочитати", abandoned: "покинуто" };
const GENRES = ["художня", "фантастика", "детективи", "трилери", "бізнес", "компанії", "менеджмент", "продукт", "гроші", "розробка", "історія", "війна", "біографії", "наука", "саморозвиток", "суспільство"];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const CYR = /[а-яіїєґ]/i;
// Is the book in Ukrainian? A reader's own books can be in any language («Ненасильственное общение»,
// imported from Apple Books, was shown as «українською», 2026-10-20). The catalog's language word wins;
// otherwise the letters: ы э ъ ё are Russian only, і ї є ґ Ukrainian only. Cyrillic with neither
// («Солярис») is Ukrainian for a catalog or Books.md book (they all are) and unknown for a book a reader
// typed in or imported, and an unknown language is not called Ukrainian.
const RU_ONLY = /[ыэъё]/i;
const UK_ONLY = /[іїєґ]/i;
const OWN_SOURCES = new Set(["manual", "goodreads", "apple-books", "office", "list"]);
function isUk(book) {
  const lang = String(book.language || "").toLowerCase();
  if (lang) return /^(uk|укр)/.test(lang);
  const text = `${book.title || ""} ${book.author || ""}`;
  if (!CYR.test(text)) return false;
  if (UK_ONLY.test(text)) return true;
  if (RU_ONLY.test(text)) return false;
  return !OWN_SOURCES.has(book.source);
}
const norm = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
// The language word of a foreign book in the kicker («Англійською»), from the word Open Library gave it.
const LANG_ADV = { англійська: "англійською", російська: "російською", польська: "польською", німецька: "німецькою", французька: "французькою", іспанська: "іспанською", італійська: "італійською" };
const host = (url) => String(url || "").replace(/^https?:\/\/(www\.)?/, "").replace(/\/.*$/, "");
// Availability as shown: «є» goes without saying; an announced book says when it is expected.
const avail = (e) => (!e.status || e.status === "є" ? "" : e.status === "анонс" && e.expected ? `анонс, орієнтовно ${e.expected.toLowerCase()}` : e.status);

// Stars in the accent colour, as many as the rating, a half star half filled; then the number («4,5»).
function stars(r, { num = true } = {}) {
  if (r == null) return "";
  const full = Math.floor(r), half = r - full >= 0.4;
  return `<span class="stars" title="${uk(r)} з 5">${"★".repeat(full)}${half ? "<i>★</i>" : ""}</span>${num ? `<span class="num">${uk(r)}</span>` : ""}`;
}

// A cover, or a coloured block with the title when there is none or the picture fails.
// Sizes: xl 200×300, lg 120×180, md 64×96, sm 52×78, xs 40×60, feed 48×72, card (the grid's width).
function cover(book, size = "md") {
  const hue = [...String(book.title)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
  const ph = `<span class="ph">${esc(book.title)}</span>`;
  return `<span class="cover ${size}" style="--h:${hue}">${ph}${book.cover ? `<img src="${attr(book.cover)}" alt="" loading="lazy" onerror="this.remove()">` : ""}</span>`;
}

// A section heading: a rule, a small green label and, on the right, a quiet aside (a link, a switch).
const label = (text, aside = "") => `<div class="label"><h2>${text}</h2>${aside ? `<div class="aside">${aside}</div>` : ""}</div>`;

// The logo is the way home (Max, 2026-10-20: «для чого Відкрити в навбар?»).
const NAV = [
  ["/community", "Читачі", (p) => p === "/community" || p === "/@"],
  // «Популярне» took the publishers' place (Max, 2026-10-22); they are in the footer and on the homepage.
  ["/popular", "Популярне", (p) => p === "/popular"],
];

function layout({ title, body, user, path = "", description = "", q = "", home = false, canonical = "", image = "", noindex = false, jsonld = null, type = "website" }) {
  const on = (p) => (p ? ' class="on"' : "");
  const nav = [
    ...NAV.map(([href, name, is]) => `<a href="${href}"${on(is(path))}>${name}</a>`),
    // Settings live on one's own shelf, not in the menu (Max, 2026-10-20).
    // Adding books is a page of its own in the menu, not something hidden in the profile (Max, 2026-10-22).
    ...(user ? [`<a href="/add"${on(path === "/add")}>Додати книжки</a>`] : []),
    user ? `<a href="${attr(user.href || "/me")}"${on(path === "/me" || path === "/settings")}>Моє</a>` : `<a href="/login"${on(path === "/login")}>Увійти</a>`,
  ].join("");
  const find = home || path === "/search" ? "" : `<form class="find" action="/search" role="search"><input type="search" name="q" value="${attr(q)}" placeholder="назва, автор, жанр або видавництво" autocomplete="off" aria-label="Пошук"></form>`;
  return `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title ? `${title} · Chytai` : "Chytai · читай більше")}</title>
${description ? `<meta name="description" content="${attr(description.slice(0, 200))}">` : ""}
${noindex || NOINDEX.has(path) ? `<meta name="robots" content="noindex">` : ""}
${canonical ? `<link rel="canonical" href="${attr(ORIGIN + canonical)}">
<meta property="og:url" content="${attr(ORIGIN + canonical)}">` : ""}
<meta property="og:site_name" content="Chytai">
<meta property="og:locale" content="uk_UA">
<meta property="og:type" content="${attr(type)}">
<meta property="og:title" content="${attr(title || "Chytai · читай більше")}">
${description ? `<meta property="og:description" content="${attr(description.slice(0, 200))}">` : ""}
<meta property="og:image" content="${attr(image || `${ORIGIN}/icon.png`)}">
<meta name="twitter:card" content="summary">
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, "\\u003c")}</script>` : ""}
${path === "/" ? `<meta name="google-site-verification" content="5cswdBTj0bCY9oY1I-PTqyMBiCpQJ1Xu6CzQLOEYwRI">` : ""}
<link rel="icon" href="/icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<link rel="stylesheet" href="${ASSETS.css}">
</head>
<body>
<header class="top${home ? " home" : ""}">
  <div class="bar">
    <a class="brand" href="/">Chytai</a>${home ? `<span class="motto">читай більше</span>` : ""}
    ${find}
    <button class="menu" type="button" aria-expanded="false">Меню</button>
    <nav>${nav}</nav>
  </div>
</header>
<main class="${home ? "home" : ""}">
${body}
</main>
<footer class="foot"><div class="bar"><span class="motto">Chytai.org.ua: читай більше.</span><a href="/publishers">Видавництва</a><a href="https://app.chytai.org.ua">Читалка</a><a href="/updates">Що нового</a><a href="/privacy">Приватність</a><a href="mailto:ischenko@gmail.com">Написати нам</a>${user?.owner ? `<a href="/admin">Адмінка</a>` : ""}</div></footer>
<script src="${ASSETS.js}"></script>
</body>
</html>`;
}

// ---- pieces shared by the pages ----

function stripMd(s) {
  return s.replace(/\*\*/g, "").replace(/\[(.+?)\]\((.+?)\)/g, "$1");
}
// Set by the server: (markdown, own book id) -> markdown with mentioned titles linked (store.linkTitles).
let titleLinks = (md) => md;
const setTitleLinks = (fn) => (titleLinks = fn);
// Set by the server too: author name -> their /author/ page, or null.
let authorHref = () => null;
const setAuthorLinks = (fn) => (authorHref = fn);
// And: book id -> { avg, rated, want, readers } across readers (social.js).
let statsOf = () => ({ avg: null, rated: 0, want: 0, readers: 0, finished: 0, dropped: 0 });
const setStats = (fn) => (statsOf = fn);

// The author line with each name linked to its page (shortened like byline() past three names).
function authorLinks(author) {
  const { splitAuthors } = require("./authors");
  const names = splitAuthors(author);
  if (!names.length) return esc(author || "");
  const link = (n) => (authorHref(n) ? `<a href="${attr(authorHref(n))}">${esc(n)}</a>` : esc(n));
  return names.length > 3 ? `${names.slice(0, 2).map(link).join(", ")} та ще ${names.length - 2}` : names.map(link).join(", ");
}

// An anthology's long list of authors on a card: the first two and how many more.
function byline(author) {
  const names = String(author || "").split(/,\s*/).filter(Boolean);
  return names.length > 3 ? `${names.slice(0, 2).join(", ")} та ще ${names.length - 2}` : String(author || "");
}

// A note's first paragraph as inline HTML.
function inline(md) {
  const first = md.split(/\n\s*\n/)[0];
  return marked.parseInline(first).replace(/<a href="http/g, '<a target="_blank" rel="noopener" href="http');
}
const noteOf = (e, id) => (e.note ? inline(titleLinks(e.note, e.via ? e.via.id : id)) : "");

// «Хочу прочитати» as one tap: a form for a signed-in reader, the sign-in page for a guest.
function wantButton(book, user, { size = "small", label: text = "Хочу прочитати", primary = false, status = "want" } = {}) {
  const cls = `btn ${primary ? "primary" : ""} ${size}`;
  if (!user) return `<a class="${cls}" href="/login?next=${attr(encodeURIComponent(book.href || ""))}">${text}</a>`;
  return `<form method="post" action="/api/entry/${attr(encodeURIComponent(book.id))}" class="inline"><input type="hidden" name="status" value="${status}"><input type="hidden" name="back" value="1"><button class="${cls}">${text}</button></form>`;
}
// «Хочу прочитати» and «Прочитано» side by side, for rows in search and on shelves: marking a book read
// should not need its page (a reader's feedback, 2026-10-20).
// A book the signed-in reader already has: their status, quietly, where the buttons would be (search, shelves).
const myStatus = (e) => `<span class="muted small">${esc(e.status ? STATUS[e.status].toLowerCase() : "на полиці")}${e.via ? `, як «${esc(e.via.title)}»` : ""}</span>`;
const markButtons = (book, user) => `<span class="marks">${wantButton(book, user)}${wantButton(book, user, { label: "Прочитано", status: "read" })}</span>`;

// The status, rating and copy of an entry as one quiet line: «★★★★★ 5 · прочитано · на папері».
function entryMeta(e) {
  const bits = [e.status ? VERB[e.status] : "", e.copy ? COPY[e.copy].toLowerCase() : ""].filter(Boolean);
  return `${stars(e.rating)}${bits.length ? `<span>${e.rating != null ? " · " : ""}${esc(bits.join(" · "))}</span>` : ""}`;
}

// A book in a list (shelves, search): cover, title, author, stars and the note, an action on the right.
function bookRow(book, { entry = null, meta = "", action = "", id = "", data = "" } = {}) {
  const alt = book.altTitle ? ` · ${esc(book.altTitle)}` : "";
  // The card that stands for a whole series is called by the series («Експансія», not «Експансія. Кн. 1. …»).
  const ser = book.series;
  const head = ser?.volumes > 1 && ser.items.find((i) => i.id === ser.head);
  const title = head && (head.id === book.id || head.work === book.id) ? ser.name : book.title;
  return `<article class="row"${id ? ` id="${attr(id)}"` : ""}${data}>
  <a class="cover-link" href="${attr(book.href)}">${cover(book, "md")}</a>
  <div class="row-body">
    <h3><a href="${attr(book.href)}">${esc(title)}</a>${book.series?.volumes ? ` <span class="badge">серія · ${count(book.series.volumes, "том", "томи", "томів")}</span>` : ""}</h3>
    <p class="by">${book.author ? authorLinks(book.author) : ""}${alt}</p>
    ${meta || entry ? `<p class="meta">${meta || entryMeta(entry)}</p>` : ""}
    ${entry?.note ? `<p class="note">${noteOf(entry, book.id)}</p>` : ""}
  </div>
  ${action ? `<div class="row-act">${action}</div>` : ""}
</article>`;
}

// What readers think of a book in one line: «★★★★★ 5 · 1 читач».
function readersMeta(id) {
  const s = statsOf(id);
  if (!s.readers) return "";
  return `${stars(s.avg)}<span>${s.avg != null ? " · " : ""}${count(s.readers, "читач", "читачі", "читачів")}</span>`;
}

// A book in a grid: cover, title, author, readers' stars.
function card(book, { avg, extra = "", data = "" } = {}) {
  const r = avg !== undefined ? avg : statsOf(book.id).avg;
  return `<article class="card"${data}>
  <a class="cover-link" href="${attr(book.href)}">${cover(book, "card")}</a>
  <h3><a href="${attr(book.href)}">${esc(book.title)}</a></h3>
  ${book.author ? `<p class="by">${esc(byline(book.author))}</p>` : ""}
  ${r != null ? `<p class="meta">${stars(r)}</p>` : ""}${extra}
</article>`;
}

// A small book in a sidebar: «Читали це, сподобалось і це», «Тобі може зайти».
function mini(book, size = "sm") {
  const r = statsOf(book.id).avg;
  return `<a class="mini" href="${attr(book.href)}">${cover(book, size)}<span><b>${esc(book.title)}</b>${book.author ? `<span class="by">${esc(byline(book.author))}</span>` : ""}${r != null ? `<span class="meta">${stars(r, { num: false })}</span>` : ""}</span></a>`;
}
const minis = (list, size) => (list.length ? `<div class="minis">${list.map((b) => mini(b, size)).join("")}</div>` : "");

// When an entry changed, as people say it: «сьогодні», «вчора», «3 дні тому», «12 жовтня».
const MONTHS = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
function when(e) {
  const at = e.updated || e.added;
  if (!at) return e.status === "read" && e.year ? String(e.year) : "";
  const d = new Date(at.length === 10 ? `${at}T12:00:00Z` : at);
  const days = Math.floor((Date.now() - d) / 86400000);
  if (days < 1 && new Date().toDateString() === d.toDateString()) return "сьогодні";
  if (days < 2) return "вчора";
  if (days < 7) return `${count(days, "день", "дні", "днів")} тому`;
  if (days < 14) return "тиждень тому";
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : ""}`;
}
// What the reader did, for the feed: «оцінка ★★★★», «читає», «хоче прочитати».
// «Читає» alone read like a habit; the feed says «читає зараз» (Max, 2026-10-22).
const did = (e) => (e.rating != null ? `оцінка ${stars(e.rating, { num: false })}` : e.status === "reading" ? "читає зараз" : esc(VERB[e.status] || ""));

// ---- «Читаю зараз» ----
// A reader's status (Max, 2026-10-22): the book they have in hand, under their name. Set by hand, so it
// says how long it has been up: «з 12 жовтня». No comment line (Max: «спростимо, без коментарів»).
function since(day) {
  if (!day) return "";
  const d = new Date(`${day}T12:00:00Z`);
  const days = Math.floor((Date.now() - d) / 86400000);
  if (days < 1) return "з сьогодні";
  if (days < 2) return "з учора";
  return `з ${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : ""}`;
}
function nowBlock(now, { own = false } = {}) {
  if (!now || !now.books.length) return own ? `<p class="now-empty"><a class="text-link" href="/me/now">Що читаєш зараз?</a> <span class="muted">Постав статус, його побачать на твоїй сторінці.</span></p>` : "";
  // No date (Max, 2026-10-22); only a status up for two weeks or more says so by the heading.
  const [first] = now.books;
  const weeks = first.since ? Math.floor((Date.now() - new Date(`${first.since}T12:00:00Z`)) / (7 * 86400000)) : 0;
  const long = weeks >= 2 ? `<span class="now-age">вже ${count(weeks, "тиждень", "тижні", "тижнів")}</span>` : "";
  const books = now.books.map(({ book, entry: e }) => `<a class="now-book" href="${attr(book.href)}">${cover(book, "xs")}<span><b>${esc(book.title)}</b>${book.author ? `<span class="by">${esc(byline(book.author))}</span>` : ""}${e.status === "read" ? `<span class="meta">перечитує</span>` : ""}</span></a>`).join("");
  return `<div class="now">
  <p class="now-head"><span class="kicker">${own ? "Читаю зараз" : "Зараз читає"}</span>${long}${own ? `<a class="text-link small" href="/me/now">змінити</a>` : ""}</p>
  <div class="now-books">${books}</div>
</div>`;
}
// One short line for lists of readers (/community): «зараз читає Цирцея, The Road».
const nowLine = (now) => (now?.books.length ? `<p class="now-line"><span class="muted">зараз читає</span> ${now.books.map(({ book }) => `<a href="${attr(book.href)}">${esc(book.title)}</a>`).join(", ")}</p>` : "");

// One line of the activity feed. `wide` is the /community layout (who first, then the book).
function feedRow({ reader, book, entry: e }, { wide = false, followed = null } = {}) {
  const t = when(e);
  const who = `<span class="who"><a href="${attr(reader.href)}#${attr(book.id)}"><b>${esc(reader.name)}</b></a> ${did(e)}${t ? ` · ${esc(t)}` : ""}</span>`;
  const title = `<a class="title" href="${attr(book.href)}">${esc(book.title)}</a>`;
  return `<article class="feed-row${wide ? " wide" : ""}${e.note ? " noted" : ""}${followed?.has(reader.id) ? " followed" : ""}" data-rating="${e.rating ?? ""}">
  <a class="cover-link" href="${attr(book.href)}">${cover(book, wide ? "feed" : "xs")}</a>
  <div>${wide ? `${who}${title}${book.author ? `<span class="by">${esc(byline(book.author))}</span>` : ""}` : `${title}${who}`}${e.note ? `<p class="note">${noteOf(e, book.id)}</p>` : ""}</div>
</article>`;
}
const feedList = (items, opts) => (items.length ? `<div class="feed">${items.map((it) => feedRow(it, opts)).join("")}</div>` : `<p class="muted">Поки тихо.</p>`);

// Page head: a green label, the title, a line under it; an action on the right.
const pageHead = ({ crumbs = "", kicker = "", title, sub = "", action = "", lead = "", extra = "" }) => `
<section class="page-head">
  <div>
    ${crumbs ? `<p class="crumbs">${crumbs}</p>` : ""}
    ${kicker ? `<p class="kicker">${kicker}</p>` : ""}
    <h1>${title}</h1>
    ${lead ? `<p class="lead">${lead}</p>` : ""}
    ${sub ? `<p class="sub">${sub}</p>` : ""}
    ${extra}
  </div>
  ${action ? `<div class="head-act">${action}</div>` : ""}
</section>`;

// ---- home (/) ----

// «Що почитати?»: the search, a random well rated book, the feed, recommendations, new books.
function homePage({ user, picks, feed, recs, showcase, fetched, libraries = [] }) {
  const pick = (p, i) => `<article class="pick${i ? " hidden" : ""}">
  <a class="cover-link" href="${attr(p.book.href)}">${cover(p.book, "xl")}</a>
  <div class="pick-body">
    <h3><a href="${attr(p.book.href)}">${esc(p.book.title)}</a></h3>
    ${p.book.author ? `<p class="by">${authorLinks(p.book.author)}</p>` : ""}
    <p class="quote">${noteOf(p.entry, p.book.id)}</p>
    <p class="said">— <a href="${attr(p.reader.href)}#${attr(p.book.id)}"><b>${esc(p.reader.name)}</b></a>, ${stars(p.entry.rating)}${p.entry.year ? ` · ${p.entry.year}` : ""}</p>
    <div class="acts">${wantButton(p.book, user, { size: "", primary: true })}${picks.length > 1 ? `<button type="button" class="text-link" data-next-pick>Ще одну →</button>` : ""}</div>
  </div>
</article>`;
  const seedTabs = recs.length > 1 ? `<span class="tabs">${recs.map((r, i) => `<button type="button" class="tab${i ? "" : " on"}" data-seed="${i}">${esc(r.seed.title)}</button>`).join("")}</span>` : "";
  const recTitle = (r) => (user && r.own ? "Схожі на те, що тобі сподобалось" : `Якщо сподобалась «${esc(r.seed.title)}»`);
  const body = `
<section class="hero">
  <h1>Що почитати?</h1>
  <form class="search-box big" action="/search" role="search"><input type="search" name="q" placeholder="назва, автор, жанр або видавництво" aria-label="Пошук" autocomplete="off"><span class="enter">Enter ↵</span></form>
  <p class="starts"><span>або почни з</span> ${["фантастика", "Madeline Miller", "війна", "біографії", "українською"].map((s) => `<a href="/search?q=${attr(encodeURIComponent(s))}">${esc(s)}</a>`).join(" ")}</p>
</section>
<div id="live"></div>
<div id="browse">
<div class="split home-top">
  ${picks.length ? `<section class="picks">
    ${label("Книжка навмання", "оцінка 4,5 і вище")}
    ${picks.map(pick).join("")}
  </section>` : "<div></div>"}
  <section>
    ${label("Зараз читають", `<a href="/community">усі читачі</a>`)}
    ${feedList(feed)}
  </section>
</div>
${recs.length ? `<section class="recs">
  ${recs.map((r, i) => `<div class="rec${i ? " hidden" : ""}" data-seed="${i}">${label(recTitle(r), seedTabs)}<div class="grid six">${r.books.map((x) => card(x.book, { avg: x.avg })).join("")}</div></div>`).join("")}
</section>` : ""}
${showcase.length ? `<section class="showcase">
  ${label("Вітрина · нове в українських видавництвах", fetched ? `оновлено ${esc(fetched)}` : "")}
  <div class="shop-cols">${showcase.map((s) => showcaseColumn(s, user)).join("")}</div>
  <p class="end-note"><a class="text-link" href="/publishers">Усі видавництва →</a></p>
</section>` : ""}
${librariesBlock(libraries)}
</div>`;
  return layout({ title: "", body, user, path: "/", home: true, canonical: "/", description: "Що почитати далі: книжки з оцінками й нотатками читачів і новинки українських видавництв.", jsonld: { "@context": "https://schema.org", "@type": "WebSite", name: "Chytai", url: ORIGIN, inLanguage: "uk", potentialAction: { "@type": "SearchAction", target: { "@type": "EntryPoint", urlTemplate: `${ORIGIN}/search?q={q}` }, "query-input": "required name=q" } } });
}

function showcaseColumn({ shelf, items, fresh, total, subscribed }, user) {
  return `<div class="shop">
  <div class="shop-head"><h3><a href="/publishers/${attr(shelf.id)}">${esc(shelf.name)}</a></h3>${subscribeLink(shelf.id, subscribed, user)}</div>
  <p class="sub">${esc(shelf.tagline)} · ${books(total)}${fresh ? ` · ${fresh} ${plural(fresh, "нова", "нові", "нових")}` : ""}</p>
  <div class="grid five">${items.map((it) => `<a class="tiny" href="${attr(it.href)}">${cover(it, "card")}<b>${esc(it.title)}</b><span class="t-by">${esc(byline(it.author))}</span></a>`).join("")}</div>
</div>`;
}

// Libraries with open catalogs: each book page says whether a copy is on their shelves now.
function librariesBlock(libraries) {
  if (!libraries.length) return "";
  return `<section class="libraries">
  ${label("Бібліотеки", "на сторінці книжки видно, чи є вона на полиці")}
  <div class="lib-list">${libraries.map((l) => `<a href="${attr(l.home || l.base)}" target="_blank" rel="noopener"><b>${esc(l.name)} ↗</b><span>${esc(l.city)}</span></a>`).join("")}</div>
</section>`;
}

// ---- book (/book/:id) ----

// Schema.org for the book page: the work with its rating and readers' notes as reviews (they are public
// on the page already; structured data lets Google show the stars and lets AI search quote them).
function bookLd(book, shelf, s, readers) {
  const { splitAuthors } = require("./authors");
  const isbn = book.isbn || (book.editions || []).map((e) => e.isbn).find(Boolean) || "";
  const ld = {
    "@context": "https://schema.org",
    "@type": "Book",
    name: book.title,
    url: ORIGIN + book.href,
    ...(book.altTitle ? { alternateName: book.altTitle } : {}),
    ...(book.author ? { author: splitAuthors(book.author).map((n) => ({ "@type": "Person", name: n, ...(authorHref(n) ? { url: ORIGIN + authorHref(n) } : {}) })) } : {}),
    ...(isbn ? { isbn } : {}),
    ...(isUk(book) ? { inLanguage: "uk" } : {}),
    ...(book.cover ? { image: book.cover } : {}),
    ...(book.published ? { datePublished: String(book.published) } : {}),
    ...(book.pages ? { numberOfPages: book.pages } : {}),
    ...(shelf ? { publisher: { "@type": "Organization", name: shelf.name } } : {}),
    ...(book.blurb ? { description: book.blurb.replace(/\s+/g, " ").slice(0, 500) } : {}),
  };
  if (s.avg != null && s.rated) ld.aggregateRating = { "@type": "AggregateRating", ratingValue: s.avg, ratingCount: s.rated, bestRating: 5, worstRating: 1 };
  const reviews = readers.filter((r) => r.entry.note).slice(0, 5).map((r) => ({ "@type": "Review", author: { "@type": "Person", name: r.name, url: ORIGIN + r.href.replace(/#.*$/, "") }, reviewBody: stripMd(r.entry.note).slice(0, 1000), ...(r.entry.rating != null ? { reviewRating: { "@type": "Rating", ratingValue: r.entry.rating, bestRating: 5, worstRating: 1 } } : {}) }));
  if (reviews.length) ld.review = reviews;
  return ld;
}

// The book, the reader's own buttons, where to get it, what readers said, what it is about.
function bookPage({ book, entry, now = false, user, shelf, inLibrary = new Map(), readers = [], also = [], writings = [], reviewError = "", readUrl = "" }) {
  const s = statsOf(book.id);
  const kicker = [book.tags?.find((t) => t !== "українською"), isUk(book) ? "українською" : LANG_ADV[String(book.language || "").toLowerCase()] || ""].filter(Boolean).map(cap).join(" · ");
  const sub = [book.altTitle ? esc(book.altTitle) : "", book.author ? `<span class="authors">${authorLinks(book.author)}</span>` : "", book.published ? String(book.published) : "", book.pages ? `${book.pages} с.` : ""].filter(Boolean).join(" · ");
  // «Дочитали 12, покинули 3»: only once someone gave up, and only numbers.
  const bits = [s.avg != null ? `${stars(s.avg, { num: false })} <b>${uk(s.avg.toFixed(1))}</b> від ${count(s.rated, "читача", "читачів", "читачів")}` : "", s.want ? `${s.want} ${plural(s.want, "хоче", "хочуть", "хочуть")} прочитати` : "", s.dropped ? `дочитали ${s.finished || 0}, покинули ${s.dropped}` : ""].filter(Boolean);
  const score = bits.length ? `<p class="score">${bits.join(" · ")}</p>` : "";
  const [first, ...rest] = readers;
  const body = `
<div class="split">
  <div>
    <article class="book-top">
      <div class="book-cover">${cover(book, "xl")}</div>
      <div class="book-main">
        ${shelf ? `<p class="crumbs"><a href="/publishers/${attr(shelf.id)}">${esc(shelf.name)}</a></p>` : ""}
        ${kicker ? `<p class="kicker">${esc(kicker)}</p>` : ""}
        <h1>${esc(book.title)}</h1>
        ${sub ? `<p class="book-by">${sub}</p>` : ""}
        ${score}
        ${twins(book)}
        ${mine(book, entry, user, now)}
        ${readUrl ? `<p class="read-here"><a class="btn primary" href="${attr(readUrl)}">Читати</a><span class="muted">ваш файл у читалці Chytai</span></p>` : ""}
        ${where(book)}
      </div>
    </article>
    ${series(book, inLibrary)}
    ${first ? `<section class="block">
      ${label("У читачів")}
      ${first.entry.note ? quote(first, book.id) : ""}
      ${(first.entry.note ? rest : readers).length ? `<div class="others">${(first.entry.note ? rest : readers).map((r) => readerLine(r, book.id)).join("")}</div>` : ""}
    </section>` : ""}
    ${writings.length || user ? `<section class="block" id="writings">
      ${label("Огляди")}
      ${writings.length ? writingsList(writings, book, user) : ""}
      ${user ? addWriting(book, reviewError) : ""}
    </section>` : ""}
    ${book.blurb || book.ukTitle ? `<section class="block">
      ${label("Про книжку")}
      ${book.blurb ? `<div class="about">${book.blurb.split(/\n\n+/).map((t) => `<p>${esc(t)}</p>`).join("")}</div>` : ""}
      <p class="small muted">${[book.blurb ? (book.blurbSource ? `Опис: ${esc(book.blurbSource)}` : `Опис з сайту ${esc(shelf ? shelf.name : book.source)}`) : "", book.ukTitle ? `Українською: «${esc(book.ukTitle)}», у каталогах поки немає` : ""].filter(Boolean).join(" · ")}</p>
    </section>` : ""}
  </div>
  <aside>
    ${also.length ? `${label("Читали це, сподобалось і це")}${minis(also)}` : ""}
  </aside>
</div>`;
  const description = [book.author, book.blurb?.replace(/\s+/g, " ") || stripMd(readers.find((r) => r.entry.note)?.entry.note || "")].filter(Boolean).join(". ");
  return layout({ title: book.title, body, user, path: "/book", description, canonical: book.href, image: book.cover || "", type: "book", noindex: require("./store").isRussian(book), jsonld: bookLd(book, shelf, s, readers) });
}

// «Огляди» (reviews.js): three links, the rest under «Ще N»; the owner, or the reader who added it, can take one off.
function writingsList(writings, book, user) {
  const line = (w) => writingLine(w, user && (user.owner || w.by === user.id) ? `<span class="writing-tools">${reviewForm("/api/reviews/remove", { work: book.id, url: w.url }, "Прибрати зі сторінки")}</span>` : "");
  const rest = writings.slice(3);
  return `<div class="others">${writings.slice(0, 3).map(line).join("")}${rest.length ? `<details class="more-writings"><summary>Ще ${rest.length}</summary>${rest.map(line).join("")}</details>` : ""}</div>`;
}
// «+ Додати огляд» under the links, for any signed-in reader (Max, 2026-10-22), like «Додати книжку».
function addWriting(book, error) {
  return `<details class="add-writing"${error ? " open" : ""}><summary class="text-link">+ Додати огляд чи відео</summary>
<form class="form review-add" method="post" action="/api/reviews/add"><input type="hidden" name="book" value="${attr(book.id)}"><input type="hidden" name="back" value="book">
  <label>Посилання на огляд чи відео про цю книжку<input name="url" type="url" required placeholder="https://…"></label>
  <label>Коли вийшов огляд<input name="date" type="date"><span class="hint">Можна не заповнювати: тоді дата зі сторінки огляду, якщо вона там є.</span></label>
  ${error ? `<p class="error">${esc(error)}</p>` : ""}
  <button class="btn primary">Додати</button>
</form></details>`;
}
const reviewForm = (action, fields, text, cls = "text-link") => `<form method="post" action="${action}">${Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${k}" value="${attr(v)}">`).join("")}<button class="${cls}">${text}</button></form>`;
// A review or a video about the book: its title, where, when and its first sentence.
const WRITING_KIND = { youtube: "відео", site: "" };
const writingDate = (date) => {
  const d = date ? new Date(`${date}T12:00:00Z`) : null;
  return d ? `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : ""}` : "";
};
function writingLine(w, tools = "") {
  const where = [w.source, WRITING_KIND[w.kind], writingDate(w.date)].filter(Boolean).join(" · ");
  return `<div class="writing"><a href="${attr(w.url)}" target="_blank" rel="noopener">${esc(w.title)}</a><span class="muted">${esc(where)}</span>${w.quote ? `<span class="writing-quote">${esc(w.quote)}</span>` : ""}${tools}</div>`;
}

// The owner's form for reviews (/admin/reviews): a link and its book, and every link added so far.
function reviewsAdminPage({ user, list, error = "", done = null }) {
  const body = `<div class="admin reviews-admin"><h1>Огляди</h1>
${done ? `<p class="flash">Додано до <a href="${attr(done.href)}">«${esc(done.title)}»</a>.</p>` : ""}
<form class="form review-add" method="post" action="/api/reviews/add">
  <label>Посилання на огляд чи відео<input name="url" type="url" required placeholder="https://…"></label>
  <label>Книжка: назва або посилання на її сторінку<input name="book" required placeholder="Інтернат Жадан або https://chytai.org.ua/book/…"></label>
  <label>Коли вийшов огляд<input name="date" type="date"><span class="hint">Можна не заповнювати: тоді дата зі сторінки огляду, якщо вона там є.</span></label>
  ${error ? `<p class="error">${esc(error)}</p>` : ""}
  <button class="btn primary">Додати</button>
</form>
${list.length ? `<h2>Додано: ${list.length}</h2>
<div class="others">${list.map((w) => writingLine(w, `<span class="queue-book"><a href="${attr(w.book.href || "")}">${esc(w.book.title)}</a> <span class="muted">${esc(w.book.author || "")}</span>${w.adder && !w.adder.owner ? ` <span class="muted">· додав(ла) <a href="${attr(w.adder.href)}">${esc(w.adder.name)}</a></span>` : ""}</span><span class="writing-tools"><form method="post" action="/api/reviews/date" class="review-date"><input type="hidden" name="url" value="${attr(w.url)}"><input type="date" name="date" value="${attr(w.date || "")}"><button class="text-link">Зберегти дату</button></form>${reviewForm("/api/reviews/remove", { work: w.book.id, url: w.url, back: "admin" }, "Прибрати")}</span>`)).join("")}</div>` : ""}
</div>`;
  return layout({ title: "Огляди", user, path: "/admin", body, noindex: true });
}

// A book's other-language pages (Max, 2026-10-21: «дві сторінки і спільні оцінки»): the original under a
// Ukrainian edition, the Ukrainian edition under the original; the readers and ratings are shared.
const twinLabel = (book, t) => (CYR.test(book.title) && !CYR.test(t.title) ? "Оригінал" : !CYR.test(book.title) && CYR.test(t.title) ? "Українською" : "Інше видання");
function twins(book, list = book.translations || []) {
  return list.length ? `<div class="twins">${list.map((t) => `<a class="twin" href="${attr(t.href)}">${cover(t, "xs")}<span><span class="twin-label">${twinLabel(book, t)}</span><b>${esc(t.title)}</b></span></a>`).join("")}</div>` : "";
}

// The first reader's note as the big quote: «— Макс І, прочитано у 2026, на папері».
function quote({ name, href, entry: e, now }, id) {
  const long = stripMd(e.note).length > 280;
  const what = [now ? "читає зараз" : "", e.status && !now ? VERB[e.status] + (e.status === "read" && e.year ? ` у ${e.year}` : "") : "", e.copy ? COPY[e.copy].toLowerCase() : "", e.via ? `як «${e.via.title}»` : ""].filter(Boolean).join(", ");
  return `<blockquote class="big-quote${long ? " long" : ""}">${marked.parse(titleLinks(e.note, e.via ? e.via.id : id)).replace(/<a href="http/g, '<a target="_blank" rel="noopener" href="http')}</blockquote>
<p class="said">— <a href="${attr(href)}"><b>${esc(name)}</b></a>${e.rating != null ? ` ${stars(e.rating)}` : ""}${what ? `, ${esc(what)}` : ""}</p>`;
}
// Every other reader: name, what they did, their note if any.
function readerLine({ name, href, entry: e, now }, id) {
  const what = [now ? "читає зараз" : "", e.status && !now ? VERB[e.status] + (e.status === "read" && e.year ? ` у ${e.year}` : "") : "", e.copy ? COPY[e.copy].toLowerCase() : "", e.via ? `як «${e.via.title}»` : ""].filter(Boolean).join(" · ");
  return `<div class="reader-line"><a href="${attr(href)}"><b>${esc(name)}</b></a><span>${e.rating != null ? `${stars(e.rating)} ` : ""}<span class="muted">${esc(what)}</span>${e.note ? `<span class="note">${noteOf(e, id)}</span>` : ""}</span></div>`;
}

// The signed-in reader's own buttons: «Хочу прочитати», «Прочитано · оцінити», or where the book is
// in their library and «Змінити».
const nowButton = (book, on, user) =>
  user
    ? `<form method="post" action="/api/now/${attr(encodeURIComponent(book.id))}" class="inline"><input type="hidden" name="back" value="1"><button class="btn${on ? " on" : ""}" title="${on ? "Прибрати з «Читаю зараз»" : "Показати на своїй сторінці, що читаєш її зараз"}">${on ? "✓ Читаю зараз" : "Читаю зараз"}</button></form>`
    : `<a class="btn" href="/login?next=${attr(encodeURIComponent(book.href || ""))}">Читаю зараз</a>`;
function mine(book, entry, user, now = false) {
  // Read in another language: the mark comes from that book, and so does the edit link.
  const href = entry?.via ? entry.via.href : book.href;
  const edit = href ? `/me${href}` : `/me/book/${encodeURIComponent(entry?.via ? entry.via.id : book.id)}`;
  if (!entry) return `<div class="acts">${wantButton(book, user, { size: "", primary: true })}${nowButton(book, false, user)}<a class="btn" href="${attr(user ? edit : `/login?next=${encodeURIComponent(edit)}`)}">Прочитано · оцінити</a></div>`;
  const what = [entry.status ? STATUS[entry.status] + (entry.status === "read" && entry.year ? ` ${entry.year}` : "") : "У моїх книжках", entry.rating != null ? `${uk(entry.rating)} з 5` : "", entry.copy ? COPY[entry.copy] : ""].filter(Boolean).join(" · ");
  return `<div class="acts"><span class="have">✓ ${esc(what)}${entry.via ? ` <span class="muted">як <a href="${attr(entry.via.href)}">${esc(entry.via.title)}</a></span>` : ""}</span>${entry.via ? "" : nowButton(book, now, user).replace('class="btn', 'class="btn small')}<a class="btn small" href="${attr(edit)}">Змінити</a></div>`;
}

// «Де взяти»: every edition's shop (with its format, price and stock, the one place prices are shown),
// other links, and the libraries that hold the book (filled in by app.js from /api/libraries).
function where(book) {
  const seen = new Set();
  // In stock first, then the publisher's own over a shop reselling it (Старий Лев sells partners' books).
  const rank = (e) => (e.status === "є" ? 0 : e.status === "передзамовлення" ? 1 : 2) * 4 + (e.edition ? 2 : 0) + (e.format === "e-book" ? 1 : 0) + (e.format === "аудіо" ? 1 : 0);
  const eds = (book.editions || []).filter((e) => !seen.has(e.links[0].url) && seen.add(e.links[0].url)).sort((a, b) => rank(a) - rank(b));
  const links = (book.links || []).filter((l) => !seen.has(l.url));
  const shop = (e) => {
    const tail = [e.format, e.narrator ? `читає ${e.narrator}` : "", e.duration, e.edition, e.price, e.subscription ? "є в підписці" : "", avail(e)].filter(Boolean).join(", ");
    return `<a href="${attr(e.links[0].url)}" target="_blank" rel="noopener">${esc(e.shelf.name)}</a>${tail ? ` <span class="muted">${esc(tail)}</span>` : ""}`;
  };
  // Only where it can be had (Max, 2026-10-20: «показувати там де є, а не там де немає»); the shops
  // that are out of it fold into one quiet line, each named once.
  const gone = (e) => e.status === "немає";
  const shown = new Set(); // the same shop, format, edition and price twice is one row
  const have = eds.filter((e) => !gone(e) && ((k) => !shown.has(k) && shown.add(k))([e.shelf.id, e.format, e.edition, e.price, e.narrator].join("|")));
  const out = [...new Map(eds.filter(gone).map((e) => [e.shelf.id, e])).values()];
  const items = [
    ...have.map(shop),
    ...links.map((l) => `<a href="${attr(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`),
    ...(out.length ? [`<span class="muted">${have.length ? "немає:" : "зараз немає в наявності:"} </span>${out.map((e) => `<a class="muted" href="${attr(e.links[0].url)}" target="_blank" rel="noopener">${esc(e.shelf.name)}</a>`).join(", ")}`] : []),
  ];
  return `<div class="where${items.length ? "" : " hidden"}" data-src="/api/libraries/${attr(encodeURIComponent(book.id))}"><span class="where-label">Де взяти</span>${items.map((x) => `<span class="where-item">${x}</span>`).join("")}</div>`;
}

// The volumes of the series this book belongs to, each with its own page and where to get it.
function series(book, inLibrary) {
  const ser = book.series;
  if (!ser?.items) return "";
  // «Хроніки Амбера : у 10 кн. Кн. 2 : Рушниці Авалону» is «2. Рушниці Авалону».
  const numbered = (v) => { const p = require("./catalogs").volumeOf(v.title); return p?.subtitle && p.volume === v.volume ? `${p.volume}. ${cap(p.subtitle)}` : ""; };
  const name = (v) => (v.bundle ? `Комплект із ${count(ser.volumes, "тому", "томів", "томів")}` : numbered(v) || cap(v.title.replace(ser.name, "").replace(/^[\s,.:]+/, "")) || `Том ${v.volume}`);
  return `<section class="block series">${label(`Серія «${esc(ser.name)}», ${count(ser.volumes, "том", "томи", "томів")}`)}<ul>${ser.items
    .map((v) => {
      const has = inLibrary.get(v.work);
      const tail = [v.price, avail(v)].filter(Boolean).join(" · ");
      return `<li class="${v.work === book.id ? "this" : ""}"><a href="${attr(v.href)}">${esc(name(v))}</a>${has?.status ? ` <span class="muted small">${STATUS[has.status].toLowerCase()}</span>` : ""}<span class="muted small">${esc(tail)}</span><a class="text-link small" href="${attr(v.links[0].url)}" target="_blank" rel="noopener">${esc(v.shelf.name)} ↗</a></li>`;
    })
    .join("")}</ul></section>`;
}

// /admin/dupes (owner): works that look like one book twice, for a human to judge (Max, 2026-10-21:
// «потрібна нормальна адмінка, щоб я міг сказати що об'єднувати а що ні»). Each group has a button per
// book, «лишити цю» (the rest become its editions), and one «різні книжки»; decisions can be undone.
// The buttons post by fetch and the group leaves the page in place (Max: «щоб не перезавантажувала всю
// довгу сторінку»); the server answers such a post with the decisions list re-rendered.
function decidedList(decisions, book) {
  decisions = { translations: [], ...decisions };
  const name = (id) => {
    const b = book(id);
    return b ? `<a href="${attr(b.href)}" target="_blank">${esc(b.title)}</a>` : esc(id);
  };
  const undo = (kind, i) => `<form method="post" action="/admin/dupes/undo" class="inline"><input type="hidden" name="kind" value="${kind}"><input type="hidden" name="index" value="${i}"><button class="text-link small">скасувати</button></form>`;
  const n = decisions.same.length + decisions.different.length + decisions.translations.length;
  return `<h2 id="decided">Рішення <span class="muted">${n}</span></h2>
${n ? `<ul class="decided">${decisions.same.map(([k, d], i) => `<li>${name(d)} <span class="muted">→ видання</span> ${name(k)} ${undo("same", i)}</li>`).join("")}${decisions.translations.map(([a, b], i) => `<li>${name(a)} <span class="muted">— переклад</span> ${name(b)} ${undo("translations", i)}</li>`).join("")}${decisions.different.map(([a, b], i) => `<li>${name(a)} <span class="muted">і</span> ${name(b)} <span class="muted">— різні</span> ${undo("different", i)}</li>`).join("")}</ul>` : `<p class="muted">Поки жодного.</p>`}`;
}

// The script both admin pages share: a decision posts by fetch and its group leaves the page in place.
const decideScript = `<script>
(() => {
  const box = document.getElementById("decided-box");
  const count = document.getElementById("dupe-count");
  document.addEventListener("submit", async (e) => {
    const f = e.target;
    if (!f.matches(".dupe-row, .dupe-foot, .tr-row, form.inline")) return;
    e.preventDefault();
    const btn = f.querySelector("button");
    const group = f.closest(".dupe");
    const label = btn.textContent;
    // Saving relinks every edition and rebuilds the search index, a few seconds: show it.
    btn.textContent = group ? "Зберігаю…" : "скасовую…";
    for (const b of (group || f).querySelectorAll("button")) b.disabled = true;
    group?.classList.add("busy");
    try {
      const r = await fetch(f.action, { method: "POST", headers: { "X-Requested-With": "fetch" }, body: new URLSearchParams(new FormData(f)) });
      if (!r.ok) throw new Error(r.status);
      const d = await r.json();
      if (f.matches(".tr-row")) {
        const g = f.closest(".dupe");
        f.remove();
        if (!g.querySelector(".tr-row")) g.remove();
      } else if (f.matches(".dupe-row, .dupe-foot")) {
        f.closest(".dupe").remove();
        const n = document.querySelectorAll("#dupes .dupe").length;
        if (count) count.textContent = n;
        document.getElementById("dupe-none").hidden = n > 0;
      }
      box.innerHTML = d.decided;
    } catch (err) {
      btn.textContent = label;
      for (const b of (group || f).querySelectorAll("button")) b.disabled = false;
      group?.classList.remove("busy");
      alert("Не вдалося зберегти: " + err.message);
    }
  });
})();
</script>`;

function dupesPage({ user, groups, decisions = { same: [], different: [], translations: [] }, book = () => null, all = false }) {
  const shown = all ? groups : groups.filter((g) => g.some((b) => b.readers));
  const meta = (b) => [b.author, b.source, b.readers ? count(b.readers, "читач", "читачі", "читачів") : "", b.editions > 1 ? count(b.editions, "видання", "видання", "видань") : ""].filter(Boolean).join(" · ");
  const group = (g) => {
    const ids = g.map((b) => b.id).join(",");
    return `<div class="dupe">
${g.map((b) => `<form method="post" action="/admin/dupes/decide" class="dupe-row"><input type="hidden" name="ids" value="${attr(ids)}"><input type="hidden" name="keep" value="${attr(b.id)}"><input type="hidden" name="all" value="${all ? "1" : ""}"><span><a href="${attr(b.href)}" target="_blank">${esc(b.title)}</a><span class="muted"> · ${esc(meta(b))}</span></span><button class="btn small" title="Решта стануть виданнями цієї книжки">Лишити цю</button></form>`).join("")}
<form method="post" action="/admin/dupes/decide" class="dupe-foot"><input type="hidden" name="ids" value="${attr(ids)}"><input type="hidden" name="verdict" value="different"><input type="hidden" name="all" value="${all ? "1" : ""}"><button class="btn small ghost">Різні книжки</button></form>
</div>`;
  };
  const body = `<div class="admin" id="top">
<h1>Схожі на дублі <span class="muted" id="dupe-count">${shown.length}</span></h1>
<p class="muted">Один автор, одна головна назва, але різні сторінки. ${all ? `<a class="text-link" href="/admin/dupes">Лише ті, що є в читачів</a>` : `Тут лише ті, що є на чиїйсь полиці; <a class="text-link" href="/admin/dupes?all=1">усі ${groups.length}</a>`}. «Лишити цю» робить решту виданнями цієї книжки: їхні сторінки ведуть на неї, оцінки читачів з’їжджаються. «Різні книжки» прибирає пару зі списку. Переклади з’єднуються окремо: <a class="text-link" href="/admin/translations">/admin/translations</a>.</p>
<div id="dupes">${shown.map(group).join("")}</div>
<p class="muted" id="dupe-none"${shown.length ? " hidden" : ""}>Нічого схожого не лишилось.</p>
<div id="decided-box">${decidedList(decisions, book)}</div>
</div>
${decideScript}`;
  return layout({ title: "Схожі на дублі", body, user, path: "/admin" });
}

// /admin/translations (its own page since 2026-10-21, Max: «переклади зламали сторінку, давай їх на окремий
// урл»): authors with both a foreign-titled and a Cyrillic-titled book not yet linked; the owner picks the original.
function translationsPage({ user, translations = [], decisions = { same: [], different: [], translations: [] }, book = () => null }) {
  const body = `<div class="admin" id="top">
<h1>Переклади? <span class="muted">${translations.reduce((n, t) => n + t.uk.length, 0)}</span></h1>
<p class="muted">Автори, у яких є книжки і з іноземною, і з кириличною назвою, ще не з’єднані як переклад. Виберіть оригінал для перекладу: прочитане одне зарахується й за інше, а сторінка книжки покаже обидві. Дублі одного видання: <a class="text-link" href="/admin/dupes">/admin/dupes</a>.</p>
<div id="dupes">${translations
    .map(
      (t) => `<div class="dupe"><p class="dupe-author"><a href="${attr(t.author.href)}" target="_blank">${esc(t.author.name)}</a></p>
${t.uk
  .map(
    (b) => `<form method="post" action="/admin/dupes/translation" class="dupe-row tr-row"><input type="hidden" name="uk" value="${attr(b.id)}"><span><a href="${attr(b.href)}" target="_blank">${esc(b.title)}</a>${b.readers ? `<span class="muted"> · ${count(b.readers, "читач", "читачі", "читачів")}</span>` : ""}</span><span class="tr-pick"><select name="orig">${t.foreign.map((o) => `<option value="${attr(o.id)}">${esc(o.title)}</option>`).join("")}</select><button class="btn small pair-btn">Позначити як переклад</button></span></form>`
  )
  .join("")}</div>`
    )
    .join("")}</div>
<p class="muted" id="dupe-none"${translations.length ? " hidden" : ""}>Нічого не лишилось.</p>
<div id="decided-box">${decidedList(decisions, book)}</div>
</div>
${decideScript}`;
  return layout({ title: "Переклади", body, user, path: "/admin" });
}

// /me/book/:id: the one place to edit a book in your library.
function editPage({ book, entry, user }) {
  const body = `
<article class="book-top edit">
  <div class="book-cover">${cover(book, "lg")}</div>
  <div class="book-main">
    <p class="crumbs"><a href="/me">Моя полиця</a></p>
    <h1><a href="${attr(book.href)}">${esc(book.title)}</a></h1>
    ${book.author ? `<p class="book-by">${esc(book.author)}</p>` : ""}
    ${entryForm(book, entry)}
  </div>
</article>`;
  return layout({ title: book.title, body, user, path: "/me" });
}

const WHY = "Чому не пішла, якщо хочеться";
function entryForm(book, entry) {
  const e = entry || { status: "", rating: null, year: "", copy: "", note: "" };
  const ratings = [5, 4.5, 4, 3.5, 3, 2.5, 2, 1.5, 1];
  return `
<form method="post" action="/api/entry/${encodeURIComponent(book.id)}" class="form entry-form">
  <input type="hidden" name="next" value="/me#${attr(book.id)}">
  <h2>${entry ? "На моїй полиці" : "Додати на мою полицю"}</h2>
  <div class="three">
    <label>Статус <select name="status">
      <option value="" ${!e.status ? "selected" : ""}>без статусу</option>
      <option value="reading" ${e.status === "reading" ? "selected" : ""}>Читаю</option>
      <option value="read" ${e.status === "read" ? "selected" : ""}>Прочитано</option>
      <option value="want" ${e.status === "want" ? "selected" : ""}>Хочу прочитати</option>
      <option value="abandoned" ${e.status === "abandoned" ? "selected" : ""}>Покинуто</option>
    </select></label>
    <label>Оцінка <select name="rating">
      <option value="none" ${e.rating == null ? "selected" : ""}>без оцінки</option>
      ${ratings.map((r) => `<option value="${r}" ${e.rating === r ? "selected" : ""}>${uk(r)}</option>`).join("")}
      ${e.rating != null && !ratings.includes(e.rating) ? `<option value="${e.rating}" selected>${uk(e.rating)}</option>` : ""}
    </select></label>
    <label>Рік <input name="year" type="number" min="1990" max="${new Date().getFullYear()}" value="${attr(e.year || "")}" placeholder="без дати"></label>
  </div>
  <label>Примірник <select name="copy">
    <option value="" ${!e.copy ? "selected" : ""}>не вказано</option>
    <option value="paper" ${e.copy === "paper" ? "selected" : ""}>Є на папері</option>
    <option value="ebook" ${e.copy === "ebook" ? "selected" : ""}>Є e-book</option>
    <option value="seeking" ${e.copy === "seeking" ? "selected" : ""}>Шукаю на папері</option>
  </select></label>
  <label>Нотатка <textarea name="note" rows="5" placeholder="${e.status === "abandoned" ? WHY : "Кілька слів про книжку"}" data-why="${WHY}">${esc(e.note || "")}</textarea></label>
  <div class="actions">
    ${entry ? `<button type="submit" class="btn danger" formaction="/api/entry/${encodeURIComponent(book.id)}/remove" formnovalidate>Прибрати з полиці</button>` : ""}
    <span class="grow"></span>
    <button class="btn primary">Зберегти</button>
  </div>
</form>`;
}

// ---- shelves (/me and /@<username>) ----

// The same list twice: /me is the signed-in reader's own shelf with «змінити» on every row (the only
// place where status, rating and notes are edited); /@<username> is that reader's public shelf, where a
// signed-in visitor sees what they share and can want any book in one tap.
function libraryPage({ rows, user, reader, own = false, mineIds = null, recs = [], following = false, follows = { followers: [], following: [] }, now = null }) {
  const year = new Date().getFullYear();
  const read = rows.filter((r) => r.status === "read").length;
  const thisYear = rows.filter((r) => r.status === "read" && r.year === year);
  const rated = thisYear.filter((r) => r.rating != null);
  const common = mineIds && !own ? rows.filter((r) => mineIds.has(r.id)) : [];
  const genres = GENRES.filter((g) => rows.some((r) => (r.book.tags || []).includes(g)));
  // Another reader's tabs say what they did («Читає»), since we don't know how they'd say it themselves.
  const tabs = [
    ["", "Усі", rows.length],
    ["read", own ? "Прочитано" : "Прочитане", read],
    ["reading", own ? "Читаю" : "Читає", rows.filter((r) => r.status === "reading").length],
    ["want", own ? "Хочу прочитати" : "Хоче прочитати", rows.filter((r) => r.status === "want").length],
    ["abandoned", "Покинуто", rows.filter((r) => r.status === "abandoned").length],
    ["paper", "На папері", rows.filter((r) => r.copy === "paper").length],
    ["seeking", "Шукаю", rows.filter((r) => r.copy === "seeking").length],
    ...(common.length ? [["common", "Спільні", common.length]] : []),
  ].filter(([k, , n]) => !k || n || (own && ["read", "reading", "want"].includes(k)));
  const sub = [books(rows.length), count(read, "прочитана", "прочитані", "прочитаних"), thisYear.length ? `${thisYear.length} цього року` : "", common.length ? `<b>${common.length} ${plural(common.length, "спільна", "спільні", "спільних")} з тобою</b>` : "", follows.followers.length ? `<a href="#follows">${count(follows.followers.length, "читач стежить", "читачі стежать", "читачів стежать")}</a>` : "", own ? `<a href="${attr(reader.href)}?public">як бачать інші</a> · <a href="/settings">налаштування</a>` : `<span class="muted">@${esc(reader.username)}</span>`].filter(Boolean).join(" · ");
  // Who follows this reader and whom they follow, as rows of names (Max, 2026-10-20: lists and counts are fine).
  const names = (list) => `<p class="small">${list.map((r) => `<a href="${attr(r.href)}">${esc(r.name)}</a>`).join(", ")}</p>`;
  const followBlock = follows.followers.length || follows.following.length ? `<div id="follows">${follows.followers.length ? `${label(own ? "Стежать за тобою" : "Стежать", String(follows.followers.length))}${names(follows.followers)}` : ""}${follows.following.length ? `${label(own ? "Ти стежиш за" : "Стежить за", String(follows.following.length))}${names(follows.following)}` : ""}</div>` : "";
  const list = rows
    .map((r, i) => {
      const b = r.book;
      const head = r.year !== r._prevYear || i === 0 ? yearHead(r.year, rows) : "";
      const search = [b.title, b.altTitle, b.author, stripMd(r.note || "")].join(" ").toLowerCase();
      const data = ` data-status="${r.status || ""}" data-copy="${r.copy || ""}" data-common="${common.includes(r) ? 1 : ""}" data-tags="${attr((b.tags || []).join(" "))}" data-rating="${r.rating ?? ""}" data-title="${attr(b.title.toLowerCase())}" data-search="${attr(search)}" data-order="${i}"`;
      const edit = b.href ? `/me${b.href}` : `/me/book/${encodeURIComponent(r.id)}`;
      const action = own ? `<a class="text-link small" href="${attr(edit)}">змінити</a>` : user && mineIds ? (mineIds.has(r.id) ? myStatus(mineIds.get(r.id)) : markButtons(b, user)) : "";
      return head + bookRow(b, { entry: r, action, id: r.id, data });
    })
    .join("\n");
  const wants = own ? [] : rows.filter((r) => r.status === "want").slice(0, 3);
  const body = `
${pageHead({ crumbs: own ? "" : `<a href="/community">Читачі</a> / ${esc(reader.name)}`, kicker: own ? "Моя полиця" : "Полиця читача", title: esc(reader.name), sub, extra: nowBlock(now, { own }), action: own ? `<div class="acts"><a class="btn primary" href="/add">+ Додати книжки</a></div>` : user?.id === reader.id ? "" : followButton(reader, following, user) })}
<div class="split">
  <div>
    <div class="tabs-bar">
      <div class="tabs" data-filter="status">${tabs.map(([k, l, n]) => `<button type="button" class="tab${k === "" ? " on" : ""}" data-v="${k}">${l} <span>${n}</span></button>`).join("")}</div>
    </div>
    <div class="shelf-tools">
      <input type="search" id="q" placeholder="шукати на полиці: назва, автор, нотатка" autocomplete="off">
      <select id="genre" aria-label="Жанр"><option value="">усі жанри</option>${genres.map((g) => `<option value="${g}">${g}</option>`).join("")}</select>
      <select id="sort" aria-label="Порядок"><option value="order">за порядком</option><option value="rating">за оцінкою</option><option value="title">за назвою</option></select>
    </div>
    <section class="rows" id="rows">
${list}
    </section>
    <p class="empty hidden" id="empty">Нічого не знайшлося.</p>
    <p class="more hidden"><button type="button" class="text-link" id="more">Показати ще <span></span> →</button></p>
  </div>
  <aside>
    ${thisYear.length ? `${label("Цього року")}<div class="numbers">
      <p><b>${thisYear.length}</b>прочитано</p>
      ${rated.length ? `<p><b>${uk(Math.round((rated.reduce((s, r) => s + r.rating, 0) / rated.length) * 10) / 10)}</b>середня оцінка</p>` : ""}
      <p><b>${thisYear.filter((r) => isUk(r.book)).length}</b>українською</p>
      <p><b>${thisYear.filter((r) => r.note).length}</b>з нотатками</p>
    </div>` : ""}
    ${common.length ? `${label("Спільне з тобою")}<p class="small muted">${books(common.length)}, які ви обоє маєте на полиці.</p><div class="grid four">${common.slice(0, 4).map((r) => `<a href="${attr(r.book.href)}">${cover(r.book, "card")}</a>`).join("")}</div>` : ""}
    ${wants.length ? `${label("Хоче прочитати")}${minis(wants.map((r) => r.book), "xs")}` : ""}
    ${recs.length ? `${label("Тобі може зайти")}<p class="small muted">За твоїми п’ятірками</p>${minis(recs)}` : ""}
    ${followBlock}
  </aside>
</div>
`;
  return layout({ title: own ? "Моя полиця" : reader.name, body, user, path: own ? "/me" : "/@", canonical: own ? "" : reader.href, noindex: true, description: own ? "" : `Книжки, які читає ${reader.name}: ${books(rows.length)}, оцінки й нотатки.`, jsonld: own ? null : { "@context": "https://schema.org", "@type": "ProfilePage", mainEntity: { "@type": "Person", name: reader.name, url: ORIGIN + reader.href } } });
}

// «Стежити» on another reader's page (the design's secondary button); pressed, it reads «✓ Стежу».
// Whom one follows is private: it only puts their activity first in the feed.
function followButton(reader, on, user) {
  if (!user) return `<a class="btn" href="/login?next=${attr(encodeURIComponent(reader.href))}">Стежити</a>`;
  return `<form method="post" action="/api/follow/${attr(reader.username)}" class="inline"><button class="btn${on ? " on" : ""}" title="${on ? "Більше не стежити" : "Бачити книжки цього читача першими у стрічці"}">${on ? "✓ Стежу" : "Стежити"}</button></form>`;
}

function yearHead(year, rows) {
  const n = rows.filter((r) => (r.year ?? null) === (year ?? null)).length;
  return `<h2 class="year" data-year="${year ?? ""}">${year || "Без дати"} <span>${books(n)}</span></h2>`;
}

// ---- «Популярне» (/popular) ----

// What Chytai readers read, want and rate most (Max, 2026-10-22). Readers' numbers on the cards, no shops.
function popularPage({ user, pop }) {
  const n = (k, x) => {
    if (k === "reading") return `читають ${x.n}`;
    if (k === "want") return `${x.n} ${plural(x.n, "хоче", "хочуть", "хочуть")} прочитати`;
    if (k === "month") return `${count(x.n, "читач", "читачі", "читачів")} за місяць`;
    return count(x.rated, "оцінка", "оцінки", "оцінок");
  };
  const sections = [
    ["reading", "Зараз читають", "у статусі «Читаю»"],
    ["want", "Найбільше хочуть прочитати", "«Хочу прочитати»"],
    ["top", "Найвище оцінені", "середня оцінка читачів"],
    ["month", "Цього місяця", "додали, оцінили чи почали за 30 днів"],
  ].filter(([k]) => pop[k].length);
  const body = `
${pageHead({ kicker: "Читачі Chytai", title: "Популярне", sub: "Що читають, хочуть прочитати й найвище оцінюють читачі Chytai." })}
${sections.map(([k, title, aside]) => `<section class="block pop">
  ${label(title, esc(aside))}
  <div class="grid six">${pop[k].map((x) => card(x.book, { avg: x.avg, extra: `<p class="meta pop-n">${n(k, x)}</p>` })).join("")}</div>
</section>`).join("")}
${sections.length ? "" : `<p class="muted">Поки замало читачів, щоб щось порахувати.</p>`}`;
  return layout({ title: "Популярне", body, user, path: "/popular", canonical: "/popular", description: "Що читають, хочуть прочитати й найвище оцінюють читачі Chytai." });
}

// ---- readers (/community) ----

function readersPage({ user, feed, readers, totals, followed = new Set() }) {
  // A reader who follows someone gets a fourth filter: only those readers.
  const tabs = [["", "усе"], ...(followed.size ? [["followed", "за ким стежу"]] : []), ["notes", "з нотатками"], ["top", "оцінки 4,5+"]];
  const body = `
${pageHead({ kicker: "Спільнота", title: "Що читають інші", sub: `${count(totals.readers, "читач", "читачі", "читачів")} · ${books(totals.books)} на полицях · ${count(totals.notes, "нотатка", "нотатки", "нотаток")}`, action: user ? "" : `<a class="btn primary" href="/login">Завести полицю</a>` })}
<div class="split wide-aside">
  <section>
    ${label("Стрічка", `<span class="tabs" data-feed-filter>${tabs.map(([v, t]) => `<button type="button" class="tab${v ? "" : " on"}" data-v="${v}">${t}</button>`).join("")}</span>`)}
    ${feedList(feed, { wide: true, followed })}
  </section>
  <aside>
    ${label("Читачі")}
    <div class="people">${readers
      .map((r) => `<div class="person"><p class="person-head"><a href="${attr(r.reader.href)}">${esc(r.reader.name)}</a>${followed.has(r.reader.id) ? `<span>стежу</span>` : r.thisYear ? `<span>${r.thisYear} цього року</span>` : ""}</p><p class="sub">${books(r.count)}, ${count(r.read, "прочитана", "прочитані", "прочитаних")}</p>${nowLine(r.now)}${r.note ? `<p class="note">${r.note}</p>` : ""}</div>`)
      .join("")}</div>
    <p class="small muted">Полиці відкриті для всіх.</p>
  </aside>
</div>`;
  return layout({ title: "Читачі", body, user, path: "/community", canonical: "/community", description: "Що читають інші: оцінки й нотатки читачів Chytai." });
}

// ---- publishers (/publishers, /publishers/:id) ----

function subscribeLink(id, on, user) {
  if (!user) return `<a class="text-link small" href="/login?next=/publishers/${attr(id)}">підписатися</a>`;
  return `<form method="post" action="/api/subscribe/${attr(id)}" class="inline"><button class="text-link small${on ? " on" : ""}">${on ? "✓ підписано" : "підписатися"}</button></form>`;
}
function subscribeButton(id, on, user, primary = false) {
  const text = on ? "✓ Підписано" : primary ? "Підписатися на новинки" : "Підписатися";
  if (!user) return `<a class="btn${primary ? " primary" : ""}" href="/login?next=/publishers/${attr(id)}">${text}</a>`;
  return `<form method="post" action="/api/subscribe/${attr(id)}" class="inline"><button class="btn${primary && !on ? " primary" : ""}">${text}</button></form>`;
}

function publishersPage({ user, shelves, libraries = [] }) {
  const row = ({ shelf, items, total, fresh, subscribed }) => `<article class="pub" data-fresh="${fresh}" data-name="${attr(shelf.name.toLowerCase())}">
  <div>
    <h3><a href="/publishers/${attr(shelf.id)}">${esc(shelf.name)}</a></h3>
    <p class="tagline">${esc(shelf.tagline)}</p>
    <p class="sub">${books(total)}${fresh ? ` · ${fresh} ${plural(fresh, "нова", "нові", "нових")}` : ""}</p>
    <div class="acts">${subscribeButton(shelf.id, subscribed, user)}<a class="text-link" href="/publishers/${attr(shelf.id)}">Усі книжки →</a></div>
  </div>
  <div class="grid four">${items.map((it) => `<a class="tiny" href="${attr(it.href)}">${cover(it, "card")}<b>${esc(it.title)}</b></a>`).join("")}</div>
</article>`;
  const body = `
${pageHead({ kicker: "Вітрина", title: "Українські видавництва", sub: "Новинки підтягуються з сайтів видавництв щодня. Підпишись, щоб бачити їх на головній." })}
<section>
  ${label(count(shelves.length, "видавництво", "видавництва", "видавництв"), `<span class="tabs" data-sort-pubs><button type="button" class="tab on" data-v="fresh">за новинками</button><button type="button" class="tab" data-v="name">за назвою</button></span>`)}
  <div class="pubs">${shelves.map(row).join("")}</div>
  <p class="muted end-note">Видавництво, якого тут немає? <a class="text-link" href="mailto:ischenko@gmail.com">Напиши нам</a>, під’єднаємо.</p>
</section>
${librariesBlock(libraries)}`;
  return layout({ title: "Видавництва", body, user, path: "/publishers", canonical: "/publishers", description: "Новинки українських видавництв щодня." });
}

function publisherPage({ shelf, subscribed, user, fresh, feed, others, visible = (s) => s.items }) {
  const items = visible(shelf);
  // Filter chips from the publisher's own categories: only those with a few books that don't cover the
  // whole shelf, and only when there are at least two («Повне зібрання творів Лесі Українки 1» is a series,
  // not a genre; Комора's one real category alone filters nothing useful).
  let genres = [...items.flatMap((it) => it.genres || []).reduce((m, g) => m.set(g, (m.get(g) || 0) + 1), new Map())].filter(([, n]) => n >= 3 && n < items.length).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (genres.length < 2) genres = [];
  const statuses = [...new Set(items.map((it) => it.status))];
  const newCount = items.filter((it) => it.isNew).length;
  const body = `
${pageHead({ crumbs: `<a href="/publishers">Видавництва</a> / ${esc(shelf.name)}`, kicker: shelf.kind === "audio" ? "Аудіокнигарня" : "Видавництво", title: esc(shelf.name), lead: esc(shelf.tagline), sub: [books(items.length), newCount ? `${newCount} ${plural(newCount, "нова", "нові", "нових")}` : "", `<a href="${attr(shelf.url)}" target="_blank" rel="noopener">${esc(host(shelf.url))} ↗</a>`].filter(Boolean).join(" · "), action: subscribeButton(shelf.id, subscribed, user, true) })}
${fresh.length ? `<section class="block">
  ${label("Нове")}
  <div class="grid six">${fresh.map((it) => card(it)).join("")}</div>
  <p class="end-note"><a class="text-link" href="#catalog">Увесь каталог →</a></p>
</section>` : ""}
<div class="split">
  <section class="block" id="catalog">
    ${label(`Каталог · ${items.length}`)}
    <div class="shelf-tools">
      <input type="search" id="q" placeholder="назва або автор" autocomplete="off">
    </div>
    ${genres.length ? `<div class="tabs wrap" data-filter="genre"><button type="button" class="tab on" data-v="">Усі <span>${items.length}</span></button>${genres.map(([g, n]) => `<button type="button" class="tab" data-v="${attr(g)}">${esc(g)} <span>${n}</span></button>`).join("")}</div>` : ""}
    ${statuses.length > 1 ? `<div class="tabs wrap" data-filter="avail"><button type="button" class="tab on" data-v="">Будь-які</button>${statuses.map((s) => `<button type="button" class="tab" data-v="${attr(s)}">${esc(cap(s || "є"))}</button>`).join("")}</div>` : ""}
    <div class="grid four" id="rows">
${items.map((it) => card(it, { data: ` data-genre="${attr((it.genres || []).join("|"))}" data-avail="${attr(it.status || "")}" data-search="${attr([it.title, it.author, it.altTitle].join(" ").toLowerCase())}"` })).join("\n")}
    </div>
    <p class="empty hidden" id="empty">Нічого не знайшлося.</p>
    <p class="more hidden"><button type="button" class="text-link" id="more">Показати ще <span></span> →</button></p>
  </section>
  <aside>
    ${feed.length ? `${label(`Читачі про книжки ${esc(shelf.name)}`)}${feedList(feed)}` : ""}
    ${others.length ? `${label("Інші видавництва")}<div class="others-list">${others.map((o) => `<a href="/publishers/${attr(o.shelf.id)}"><b>${esc(o.shelf.name)}</b><span>${books(o.total)}</span></a>`).join("")}</div>` : ""}
  </aside>
</div>`;
  return layout({ title: shelf.name, body, user, path: "/publishers", canonical: `/publishers/${encodeURIComponent(shelf.id)}`, description: `${shelf.tagline}. ${books(items.length)} на Chytai: оцінки й нотатки читачів, де взяти.`, jsonld: { "@context": "https://schema.org", "@type": "Organization", name: shelf.name, url: shelf.url, ...(shelf.tagline ? { description: shelf.tagline } : {}) } });
}

// ---- search (/search) ----

function searchPage({ q, user, results }) {
  const body = `
<form class="search-box big query" action="/search" role="search"><input type="search" name="q" value="${attr(q)}" placeholder="назва, автор, жанр або видавництво" aria-label="Пошук" autocomplete="off"${q ? "" : " autofocus"}><span class="enter">Enter ↵</span></form>
<div id="live">${searchResults({ q, user, ...results })}</div>`;
  return layout({ title: q ? `${q} · Пошук` : "Пошук", body, user, path: "/search", q });
}

// The results in groups (books, authors, readers) with «схоже» on the side; also served alone by
// /api/search for search as you type.
function searchResults({ q, user, hits = [], authors = [], readers = [], shelves = [], similar = [], tag = "" }) {
  if (!q.trim()) return "";
  const n = hits.length + authors.length + readers.length + shelves.length;
  const addLink = user ? `<a class="text-link" href="/add?text=${attr(encodeURIComponent(q))}">Додати книжку, якої ще немає на Chytai</a>` : "";
  if (!n) return `<p class="found">Нічого не знайшлося за «${esc(q)}». ${addLink}</p>`;
  return `<p class="found">${count(n, "збіг", "збіги", "збігів")}${tag ? ` · жанр «${esc(tag)}»` : ""}</p>
<div class="split">
  <div>
    ${shelves.length ? `<section class="block">${label(`Видавництва · ${shelves.length}`)}<div class="name-rows">${shelves.map((s) => `<a class="name-row" href="/publishers/${attr(s.shelf.id)}"><b>${esc(s.shelf.name)}</b><span>${[books(s.total), s.shelf.tagline ? esc(s.shelf.tagline) : ""].filter(Boolean).join(" · ")}</span></a>`).join("")}</div></section>` : ""}
    ${hits.length ? `<section class="block">${label(`Книжки · ${hits.length}`)}<div class="rows">${hits.map((h) => bookRow(h.book, { meta: readersMeta(h.book.id), action: h.entry ? myStatus(h.entry) : markButtons(h.book, user) })).join("")}</div></section>` : ""}
    ${authors.length ? `<section class="block">${label(`Автори · ${authors.length}`)}<div class="name-rows">${authors.map((a) => `<a class="name-row" href="${attr(a.href)}"><b>${esc(a.name)}</b><span>${[books(a.books), a.readers ? count(a.readers, "читач", "читачі", "читачів") : ""].filter(Boolean).join(" · ")}</span></a>`).join("")}</div></section>` : ""}
    ${readers.length ? `<section class="block">${label(`Читачі · ${readers.length}`)}<div class="name-rows">${readers.map((r) => `<a class="name-row" href="${attr(r.reader.href)}"><b>${esc(r.reader.name)}</b><span>${books(r.count)}</span></a>`).join("")}</div></section>` : ""}
    ${user ? `<p class="muted end-note">Не те? ${addLink}</p>` : ""}
  </div>
  <aside>${similar.length ? `${label("Схоже на те, що шукаєш")}${minis(similar)}` : ""}</aside>
</div>`;
}

// ---- /author/<slug> ----

// The books we have, with what readers said; who reads them; then the works from Wikidata.
function authorPage({ author, works, hits, user, readers = [], also = [], pairing = null }) {
  // The owner pairs a translation with its original right here (Max, 2026-10-21); the same post as /admin/translations.
  const pair = (book) => {
    if (!pairing) return "";
    const l = pairing.linked[book.id];
    if (l) return l.index != null ? `<div class="pair muted small">пара з «${esc(l.title)}» · <form method="post" action="/admin/dupes/undo" class="inline"><input type="hidden" name="kind" value="translations"><input type="hidden" name="index" value="${l.index}"><button class="text-link small">скасувати</button></form></div>` : "";
    const options = pairing.foreign.filter((f) => f.id !== book.id);
    if (!options.length || !CYR.test(book.title)) return "";
    return `<form method="post" action="/admin/dupes/translation" class="pair tr-row"><input type="hidden" name="uk" value="${attr(book.id)}"><span class="tr-pick"><select name="orig">${options.map((o) => `<option value="${attr(o.id)}">${esc(o.title)}</option>`).join("")}</select><button class="btn small pair-btn">Позначити як переклад</button></span></form>`;
  };
  const ratings = hits.map((h) => statsOf(h.book.id)).filter((s) => s.avg != null);
  const avg = ratings.length ? Math.round((ratings.reduce((s, x) => s + x.avg, 0) / ratings.length) * 10) / 10 : null;
  const inUk = hits.filter((h) => isUk(h.book)).length;
  const sub = [`${books(hits.length)} на Chytai`, readers.length ? count(readers.length, "читач", "читачі", "читачів") : "", avg != null ? `середня оцінка <b>${uk(avg.toFixed(1))}</b>` : "", inUk && inUk < hits.length ? `${inUk} українською` : ""].filter(Boolean).join(" · ");
  const work = (w) => {
    const title = w.uk || w.en || w.orig;
    const orig = [w.orig, w.en].find((t) => t && t !== title) || "";
    const b = w.books[0];
    return `<li${b ? "" : ' class="none"'}><span class="year">${w.year || ""}</span> ${b ? `<a href="${attr(b.href)}">${esc(title)}</a>` : esc(title)}${orig ? ` <span class="alt">${esc(orig)}</span>` : ""}${!b && !w.uk ? ` <span class="small muted">· перекладу не знайшли</span>` : ""}</li>`;
  };
  const bigRow = (hit) => {
    const { book, entry } = hit;
    const s = statsOf(book.id);
    const top = readersWithNote(book.id);
    return `<article class="row big">
  <a class="cover-link" href="${attr(book.href)}">${cover(book, "lg")}</a>
  <div class="row-body">
    <h3><a href="${attr(book.href)}">${esc(book.title)}</a></h3>
    ${book.altTitle ? `<p class="orig">${esc(book.altTitle)}</p>` : ""}
    ${s.avg != null ? `<p class="meta">${stars(s.avg)}<span> · ${count(s.rated, "оцінка", "оцінки", "оцінок")}</span></p>` : ""}
    ${top ? `<p class="note">${noteOf(top.entry, book.id)}</p><p class="said">— <a href="${attr(top.href)}"><b>${esc(top.name)}</b></a>${top.entry.year ? `, ${top.entry.year}` : ""}</p>` : ""}
    <div class="acts">${entry ? myStatus(entry) : markButtons(book, user)}</div>
    ${pair(book)}
  </div>
</article>`;
  };
  const pairScript = pairing
    ? `<script>
document.addEventListener("submit", async (e) => {
  const f = e.target;
  if (!f.matches(".pair.tr-row, .pair form.inline")) return;
  e.preventDefault();
  const btn = f.querySelector("button");
  const label = btn.textContent;
  btn.textContent = f.matches(".tr-row") ? "Зберігаю…" : "скасовую…";
  btn.disabled = true;
  try {
    const r = await fetch(f.action, { method: "POST", headers: { "X-Requested-With": "fetch" }, body: new URLSearchParams(new FormData(f)) });
    if (!r.ok) throw new Error(r.status);
    const p = document.createElement("div");
    p.className = "pair muted small";
    p.textContent = f.matches(".tr-row") ? "переклад: " + f.querySelector("select option:checked").textContent + " ✓" : "зв’язок знято";
    f.closest(".pair").replaceWith(p);
  } catch (err) {
    btn.textContent = label;
    btn.disabled = false;
    alert("Не вдалося зберегти: " + err.message);
  }
});
</script>`
    : "";
  const body = `
${pageHead({ kicker: "Автор", title: esc(author.name), lead: author.other ? esc(author.other) : "", sub })}
<div class="split">
  <div>
    <section class="block">
      ${label("Книжки", "за оцінкою читачів")}
      ${hits.length ? `<div class="rows">${hits.map(bigRow).join("")}</div>` : `<p class="muted">Поки ні в каталогах, ні в читачів.</p>`}
    </section>
    ${works.length ? `<section class="block">
      ${label("Твори", author.qid ? `<a href="https://www.wikidata.org/wiki/${attr(author.qid)}" target="_blank" rel="noopener">Wikidata ↗</a>` : "")}
      <ul class="works">${works.map(work).join("")}</ul>
    </section>` : ""}
  </div>
  <aside>
    ${readers.length ? `${label("Хто читає")}<div class="others-list">${readers.map((r) => `<a href="${attr(r.reader.href)}"><b>${esc(r.reader.name)}</b><span>${books(r.count)}, ${count(r.read, "прочитана", "прочитані", "прочитаних")}</span></a>`).join("")}</div>` : ""}
    ${also.length ? `${label(`Читачі ${esc(lastName(author.name))} також люблять`)}${minis(also)}` : ""}
  </aside>
</div>${pairScript}`;
  const ld = { "@context": "https://schema.org", "@type": "Person", name: author.name, url: ORIGIN + author.href, ...(author.other ? { alternateName: author.other } : {}), ...(author.qid ? { sameAs: `https://www.wikidata.org/wiki/${author.qid}` } : {}) };
  return layout({ title: author.name, body, user, path: "/author", canonical: author.href, description: `Книжки ${author.name} на Chytai: ${books(hits.length)}${inUk && inUk < hits.length ? `, ${inUk} українською` : ""}, оцінки й нотатки читачів, де взяти.`, jsonld: ld });
}
const lastName = (name) => {
  const w = String(name).split(" ");
  return w.length > 1 && !CYR.test(name) ? w[w.length - 1] : name;
};
// The reader with the longest note on a book, for the author page.
let readersWithNote = () => null;
const setReadersWithNote = (fn) => (readersWithNote = fn);

// ---- sign in / sign up / settings ----

const hidden = (name, v) => (v ? `<input type="hidden" name="${name}" value="${attr(v)}">` : "");
const errorLine = (error) => (error ? `<p class="error">${esc(error)}</p>` : "");
function authLayout({ title, lead, form, user = null, path = "/login" }) {
  return layout({ title, user, path, body: `<section class="auth"><h1>${esc(title)}</h1>${lead ? `<p class="lead">${lead}</p>` : ""}${form}</section>` });
}

// Step one: the e-mail. The same page signs in and signs up; nobody has to know which they are doing.
function loginPage({ next = "", email = "", error = "" }) {
  return authLayout({
    title: "Увійти",
    lead: "Вкажіть пошту, і ми надішлемо код. Без паролів. Якщо ви тут уперше, акаунт створиться сам.",
    form: `<form method="post" action="/login" class="form">
  ${hidden("next", next)}${errorLine(error)}
  <label>Пошта<input type="email" name="email" value="${attr(email)}" required autofocus autocomplete="email" inputmode="email" placeholder="ви@пошта.ua"></label>
  <div class="actions"><button class="btn primary">Надіслати код</button></div>
</form>
<p class="muted small">Пошту ми використовуємо лише для входу. <a class="text-link" href="/privacy">Приватність</a>.</p>`,
  });
}

// Step two: the code from the letter.
function codePage({ next = "", email, error = "" }) {
  return authLayout({
    title: "Код з листа",
    lead: `Надіслали шість цифр на <b>${esc(email)}</b>. Код діє десять хвилин.`,
    form: `<form method="post" action="/login/code" class="form">
  ${hidden("next", next)}${hidden("email", email)}${errorLine(error)}
  <label>Код<input type="text" name="code" required autofocus inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" maxlength="7" placeholder="000000" class="code"></label>
  <div class="actions"><button class="btn primary">Увійти</button><a class="text-link small" href="/login${next ? `?next=${encodeURIComponent(next)}` : ""}">Інша пошта або новий код</a></div>
</form>`,
  });
}

// Step three, for a new address: who they are on the site.
function signupPage({ next = "", ticket, email, name = "", username = "", error = "" }) {
  return authLayout({
    title: "Як вас записати",
    lead: `Пошта <b>${esc(email)}</b> підтверджена. Лишилось ім'я і адреса вашої сторінки.`,
    form: `<form method="post" action="/login/signup" class="form" data-username>
  ${hidden("next", next)}${hidden("ticket", ticket)}${errorLine(error)}
  <label>Ім'я, як показувати іншим<input type="text" name="name" value="${attr(name)}" required autofocus maxlength="60" autocomplete="name" placeholder="Марія Коваль"></label>
  <label>Адреса сторінки<span class="prefix">chytai.org.ua/@<input type="text" name="username" value="${attr(username)}" maxlength="30" autocomplete="username" spellcheck="false" placeholder="maria.koval"></span><span class="hint">Латинські літери, цифри, крапка чи підкреслення. Порожнє поле: складемо з імені.</span></label>
  <div class="actions"><button class="btn primary">Готово</button></div>
</form>`,
  });
}

// /welcome: shown once, right after sign-up: what Chytai is and what one can do here (design 4a of
// 2026-10-20, texts by Max). «Почати» goes to the homepage, or back to where sign-up started.
function welcomePage({ user, next = "" }) {
  const mark = `<b class="wordmark">Chytai</b>`;
  const step = (n, title, text, href, link, ext = false) => `<li><span class="n">${n}</span><div><h3>${title}</h3><p>${text}</p></div><a class="text-link" href="${attr(href)}"${ext ? ' target="_blank" rel="noopener"' : ""}>${link} →</a></li>`;
  const body = `<section class="welcome">
  <div class="welcome-intro">
    <p class="kicker">Вітаємо</p>
    <h1>Вітаємо в ${mark}!</h1>
    <p class="lead">${mark} це проєкт для тих, хто любить книжки. Спільнота людей, каталоги українських видавництв, пошук і рекомендації.</p>
    <div class="acts"><a class="btn primary" href="/add">Додати книжки</a><a class="text-link" href="${attr(next || "/")}">Пізніше</a></div>
  </div>
  <ol class="welcome-steps">
    ${step("01", "Зберіть свою полицю", "Діліться своїми книжками, оцінками й рейтингами.", "/add", "Додати книжки")}
    ${step("02", "Дивіться, що читають інші", "Знаходьте людей зі схожими смаками і додавайте їх книжки собі.", "/community", "Спільнота")}
    ${step("03", "Знаходьте нові книжки для себе", "Пошук по каталогах українських видавництв, полицях читачів та офлайн бібліотеках.", "/", "Каталог")}
    ${step("04", "Читалка з AI-explainer (beta)", "Для зручного читання. Веб версія і мобільний застосунок (поки в TestFlight).", "https://app.chytai.org.ua/", "Читалка", true)}
  </ol>
  <div class="welcome-end"><a class="btn primary" href="/add">Додати книжки</a><a class="text-link" href="${attr(next || "/")}">Пізніше</a></div>
</section>`;
  return layout({ title: "Вітаємо", body, user, path: "/welcome" });
}

// /me/now: the status itself. The book in it, the shelf's other «Читаю» books, or none.
function nowPage({ user, now, candidates }) {
  const row = (book, on, meta = "") => `<label class="now-pick">${cover(book, "xs")}<span><b>${esc(book.title)}</b>${book.author ? `<span class="by">${esc(byline(book.author))}</span>` : ""}${meta ? `<span class="meta">${meta}</span>` : ""}</span><input type="radio" name="book" value="${attr(book.id)}"${on ? " checked" : ""}></label>`;
  const body = `
${pageHead({ crumbs: `<a href="${attr(user.href)}">Моя полиця</a>`, kicker: "Статус", title: "Читаю зараз", lead: "Що у тебе в руках зараз. Видно під твоїм ім’ям на сторінці й у списку читачів." })}
<form method="post" action="/me/now" class="form now-form">
  <h2>Книжка</h2>
  <div class="now-picks">
    ${now.books.map((n) => row(n.book, true, since(n.since))).join("")}
    ${candidates.map((r) => row(r.book, false, "на полиці «Читаю»")).join("")}
    ${now.books.length || candidates.length ? `<label class="now-pick"><span>Нічого зараз не читаю</span><input type="radio" name="book" value=""${now.books.length ? "" : " checked"}></label>` : ""}
  </div>
  ${!now.books.length && !candidates.length ? `<p class="muted small">На полиці немає книжок зі статусом «Читаю». Відкрий сторінку книжки і натисни «Читаю зараз».</p>` : `<p class="muted small">Іншої книжки тут немає? Відкрий її сторінку і натисни «Читаю зараз». Прочитана чи покинута книжка зникає зі статусу сама.</p>`}
  <div class="actions"><span class="grow"></span><button class="btn primary">Зберегти</button></div>
</form>`;
  return layout({ title: "Читаю зараз", body, user, path: "/me" });
}

function settingsPage({ user, values, error = "", suggested = "", saved = false }) {
  const form = `<form method="post" action="/settings" class="form" data-username>
  ${errorLine(error)}${saved ? `<p class="saved">Збережено.</p>` : ""}
  <label>Ім'я<input type="text" name="name" value="${attr(values.name || "")}" required maxlength="60"></label>
  <label>Адреса сторінки<span class="prefix">chytai.org.ua/@<input type="text" name="username" value="${attr(values.username || "")}" required maxlength="30" spellcheck="false" placeholder="${attr(suggested)}"></span><span class="hint">Якщо змінити, стара адреса перестане працювати.</span></label>
  <label>Пошта для входу<input type="email" name="email" value="${attr(values.email || "")}" ${user.owner ? "" : "required"} autocomplete="email"></label>
  <!-- Search-engine listing is always on for now (Max, 2026-10-21): readers.noindex stays in the database for later. The letters have their own tab, /settings/mail. -->
  <div class="actions"><button class="btn primary">Зберегти</button><a class="text-link small" href="${attr(user.href)}">Моя сторінка</a>${user.owner ? `<a class="text-link small" href="/admin">Статистика</a>` : ""}<span class="grow"></span><a class="text-link small" href="/logout">Вийти</a></div>
</form>
<section class="form import-box">
  <h2>Книжки</h2>
  <p class="muted small">Додати книжки на полицю: списком текстом, по одній або перенести з Goodreads чи Apple Books.</p>
  <div class="actions"><a class="btn" href="/add">Додати книжки</a></div>
</section>
${user.owner ? "" : `<form method="post" action="/settings/delete" class="form danger-zone" onsubmit="return confirm('Видалити акаунт разом з усіма книжками, оцінками й нотатками?')">
  <h2>Видалити акаунт</h2>
  <p class="muted small">Зітре всі ваші книжки, оцінки, нотатки й підписки. Назад не повернути.</p>
  <label>Впишіть ${esc(user.username)}, щоб підтвердити<input type="text" name="confirm" autocomplete="off"></label>
  <div class="actions"><button class="btn danger">Видалити назавжди</button></div>
</form>`}`;
  return authLayout({ title: "Налаштування", lead: "", form: settingsTabs("account") + form, user, path: "/settings" });
}

// The settings' two tabs: the account itself, and the letters (Max, 2026-10-22: «вкладку в налаштуваннях, де
// будуть різні імейли»).
const settingsTabs = (on) => `<nav class="tabs settings-tabs">${[["account", "/settings", "Акаунт"], ["mail", "/settings/mail", "Листи"]].map(([k, href, l]) => (k === on ? `<span class="tab on">${l}</span>` : `<a class="tab" href="${href}">${l}</a>`)).join("")}</nav>`;

// /settings/mail: every letter the site sends, the ones a reader can switch and the ones that come only when asked.
function mailSettingsPage({ user, values, saved = false }) {
  const sw = (name, title, hint) => `<label class="check"><span><input type="checkbox" name="${name}" value="1"${values[name] ? " checked" : ""}> ${title}</span><span class="hint">${hint}</span></label>`;
  const form = `${settingsTabs("mail")}<form method="post" action="/settings/mail" class="form">
  ${saved ? `<p class="saved">Збережено.</p>` : ""}
  ${user.email ? `<p class="muted small">Листи приходять на ${esc(user.email)}. <a class="text-link" href="/settings">Змінити пошту</a></p>` : `<p class="muted small">Пошти не вказано, тож листів не буде. <a class="text-link" href="/settings">Додати пошту</a></p>`}
  ${sw("digest", "Пʼятничний дайджест", "Новинки на сайті, полиці та видавництва, на які ви підписані.")}
  ${sw("follow_mail", "Новий читач стежить за вами", "Лист, коли хтось уперше почне стежити за вашою полицею.")}
  <div class="actions"><button class="btn primary">Зберегти</button></div>
</form>
<section class="form import-box">
  <h2>Ці листи приходять завжди</h2>
  <p class="muted small">Код для входу: лише коли ви самі входите на сайт.<br>Вітальний лист: після реєстрації.</p>
</section>`;
  return authLayout({ title: "Налаштування", lead: "", form, user, path: "/settings" });
}

// Max (2026-10-20): any new outside service that sees readers' data (mail, hosting, fonts, analytics, AI) must be added here.
function privacyPage({ user }) {
  return layout({ title: "Приватність", user, path: "/privacy", canonical: "/privacy", description: "Що Chytai.org.ua зберігає про читачів, хто це бачить і як усе видалити.", body: `<section class="auth prose"><h1>Приватність</h1>
<p>Chytai.org.ua це проєкт для тих, хто любить читати.</p>
<h2>Що ми зберігаємо</h2>
<p>Не зберігаємо нічого, якщо ви просто дивитесь сайт без реєстрації. Не ставимо кукіс і не підключаємо чужих лічильників, тільки загальна статистика відвідуваності: скільки сторінок за день відкрили в кожному розділі сайту (головна, книжки, видавництва тощо), без IP-адрес і без того, хто що дивився.</p>
<p><strong>Якщо ви завели полицю:</strong></p>
<p>Пошта, імʼя та нікнейм, вашу полицю з книгами і тд.</p>
<p>Зберігаємо кукіс на вхід та дату останнього входу на сайт.</p>
<p>Імпорт з Goodreads або Apple Books: файл експорту читаємо один раз і не зберігаємо. Беремо назву книги, опис, публічні нотатки, якщо вони є. Перед імпортом ви бачите список і вибираєте, що саме переносити.</p>
<p><strong>Якщо ви читаєте в читалці Chytai</strong> (вона входить тим самим акаунтом): книжки, які ви туди завантажили, де ви зупинились, нотатки й налаштування. Ваші файли бачите лише ви, ми не показуємо їх іншим читачам і нікому не передаємо.</p>
<h2>Що бачать інші</h2>
<p><strong>Ваша публічна полиця з книжками та оцінками.</strong> Будь-хто може відкрити chytai.org.ua/@нікнейм і побачити ваше ім’я, книжки, оцінки й нотатки. Так і задумано, бо Читай це про те, щоб знаходити цікаві книжки. Тож пишіть у нотатках лише те, чим готові поділитися.</p>
<h2>Розсилки</h2>
<p>У нас є щотижнева розсилка з новинками на сайті і ми також надсилаємо вам листа коли хтось починає стежити за вашою полицею. Вимкнути розсилки можна одним кліком за посиланням у листі або в <a class="text-link" href="/settings">налаштуваннях</a>.</p>
<h2>Видалення акаунту</h2>
<p>У <a class="text-link" href="/settings">налаштуваннях</a> є кнопка «Видалити акаунт». Вона стирає ваші дані і виходить з усіх пристроїв. Відновити це не можна, тільки створіть новий акаунт.</p>
<p>З резервних копій ваші дані зникнуть самі, коли старі копії видаляться (до 90 днів). Якщо хочете швидше — напишіть нам.</p>
<p>Там само в налаштуваннях можна змінити ім’я, нікнейм чи пошту.</p>
<h2>Хто ще має доступ</h2>
<p>Ми користуємося кількома сервісами, без яких сайт не працює:</p>
<ul>
<li><strong>Fly.io</strong> — сервери у Франкфурті (Німеччина), там лежить база сайту і книжки з читалки.</li>
<li><strong>Anthropic</strong> (Claude) — коли в читалці ви просите пояснити чи перекласти уривок, сам уривок і трохи тексту навколо йдуть в Anthropic, щоб Claude відповів. Вашої пошти й імені Anthropic не отримує.</li>
<li><strong>Resend</strong> — листи від code@chytai.org.ua.</li>
<li><strong>Google Fonts</strong> — шрифти сайту. Ваш браузер завантажує їх з серверів Google, тож Google бачить вашу IP-адресу, як і на більшості сайтів.</li>
<li><strong>Open Library</strong> (openlibrary.org, некомерційний проєкт Internet Archive) — для книжок, яких немає в каталогах, ми питаємо в нього обкладинку, ISBN, рік і опис.</li>
<li><strong>Google Books</strong> — те саме для книжок, яких Open Library не знає (зокрема російською й українською): туди йдуть лише назва й автор, обкладинки ваш браузер завантажує з books.google.com.</li>
<li><strong>GitHub</strong> — щоночі робимо зашифровану резервну копію бази й читалки і зберігаємо її там 90 днів. Без нашого ключа її не прочитати.</li>
</ul>
<p>Більше ніхто ваших даних не отримує. Ми нічого не продаємо і не передаємо рекламодавцям.</p>
<h2>Ваші права</h2>
<p>За Законом України «Про захист персональних даних» ви маєте право знати, які дані про вас є, виправити їх, заборонити їх обробку або вимагати видалення. Більшість цього можна зробити самостійно в налаштуваннях.</p>
<h2>Хто відповідає</h2>
<p>Власник сайту і даних — ФОП Іщенко М. Ф. Пишіть на <a class="text-link" href="mailto:ischenko@gmail.com">ischenko@gmail.com</a> — відповімо.</p>
<p>Якщо ми щось змінимо в цих правилах, оновимо цю сторінку і дату нижче.</p>
<p><em>Оновлено 22 жовтня 2026 року.</em></p>
</section>` });
}

// «Що нового»: Max edits web/updates.md (newest day on top); read again when the file changes.
let updatesCache = { mtime: 0, html: "" };
function updatesPage({ user }) {
  const file = path.join(__dirname, "updates.md");
  const mtime = fs.statSync(file).mtimeMs;
  if (mtime !== updatesCache.mtime) updatesCache = { mtime, html: marked.parse(fs.readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->/g, "")) };
  return layout({ title: "Що нового", user, path: "/updates", canonical: "/updates", description: "Що змінилось на Chytai.org.ua і куди він рухається.", body: `<section class="auth prose updates"><h1>Що нового</h1>
${updatesCache.html}
</section>` });
}

// ---- /add «Додати книжки» (design 4b of 2026-10-22, Max: «окрему сторінку для додавання, а не як зараз
// захована в профіль»). Reachable any time: the menu, the shelf, /welcome, the welcome letter. Left: what
// this is and the imports; right: a list to paste, one book per line, any shape. «Знайти книжки» shows
// what each line matched (addReviewPage), with one status for the whole list («Прочитано» by default).
function addAside() {
  const row = (href, name, what) => `<a class="add-imp" href="${href}"><span>${name}</span><span class="muted">${what} →</span></a>`;
  return `<div class="add-imports"><p class="add-k">Або імпортуйте</p>${row("/import/goodreads", "Goodreads", "Імпорт з CSV")}${row("/import/apple-books", "Apple Books", "Імпорт з Мака")}</div>`;
}
const addCrumbs = `<p class="add-k"><a href="/me">Моя полиця</a> · <b>Додати книжки</b></p>`;
// The example list shows a few shapes a line can take, so nobody thinks there is one right way (Max):
// «Назва, Автор», just the title, «Назва Прізвище», «Автор. Назва», all lower case.
function exampleLine(b, i) {
  const a = b.author || "";
  const last = a.split(" ").pop();
  if (!a) return b.title;
  return [`${b.title}, ${a}`, b.title, `${b.title} ${last}`, `${a}. ${b.title}`, b.title.toLowerCase()][i % 5];
}
function addPage({ user, text = "", popular = [], error = "" }) {
  const example = popular.length ? popular.map(exampleLine).join("\n") : "Кобзар Тарас Шевченко\nМісто Валер'ян Підмогильний";
  const body = `<section class="add">
  <div class="add-intro">
    ${addCrumbs}
    <h1>Мої книжки</h1>
    <p class="lead">Додайте книжки, які ви вже прочитали і хочете бачити на своїй полиці.</p>
    <div class="wide-only">${addAside()}</div>
  </div>
  <form method="post" action="/import/list" class="add-paste">
    ${errorLine(error)}
    <div class="add-field"><textarea name="text" required spellcheck="false" placeholder="${attr(example)}">${esc(text)}</textarea>${popular.length ? `<span class="add-hint">Популярне на Chytai — як приклад</span>` : ""}</div>
    <p class="small muted">Один рядок — одна книжка. Формат вільний: назва й автор або просто назва.</p>
    <button class="btn primary">Знайти книжки</button>
  </form>
  <div class="narrow-only">${addAside()}</div>
</section>`;
  return layout({ title: "Додати книжки", body, user, path: "/add", noindex: true });
}

// Step two of /add: every line with what it matched. A found book is ticked; «Інша книжка» looks for the right
// one (addFindResults); a line with no match can be looked for or added as the reader's own book, without a cover.
// One status for the whole list, picked right before «Додати» (Max: «один для всіх, не кожній окремо»):
// a pasted list can be books read, a pile of «Хочу прочитати» or the reader's paper shelf.
const ADD_STATUS = [["read", "Прочитано"], ["reading", "Читаю"], ["want", "Хочу прочитати"], ["abandoned", "Покинуто"], ["paper", "На папері"]];
function addReviewPage({ user, token, rows, text }) {
  const found = rows.filter((r) => r.match).length;
  // Found books first, then the ones already on the shelf, then what we could not find (Max: «щоб довго не гортати»).
  const rank = (r) => (r.match && !r.own ? 0 : r.own ? 1 : 2);
  const order = rows.map((r, i) => i).sort((a, b) => rank(rows[a]) - rank(rows[b]) || a - b);
  const line = (r, i) => {
    const own = !!r.own;
    const b = r.match;
    return `<li class="add-row${b ? "" : " missing"}${own ? " own" : ""}" data-i="${i}">
  <label class="add-tick"><input type="checkbox" name="keep" value="${i}"${b && !own ? " checked" : ""}${own ? " disabled" : ""}><span></span></label>
  <span class="add-cover">${b ? cover(b, "sm") : `<span class="cover-none"></span>`}</span>
  <span class="add-body">
    <b class="add-title">${esc(b ? b.title : r.title)}</b>
    <span class="add-by">${b ? esc(byline(b.author || "")) : "Не знайшли в каталозі"}${own ? ` · <span class="badge">вже на полиці</span>` : ""}</span>
    ${b ? `<span class="add-from">з рядка «${esc(r.line || r.title)}»</span>` : `<button type="button" class="text-link small" data-own>Додати без обкладинки</button>`}
  </span>
  <span class="add-act">${own ? "" : `<button type="button" class="text-link" data-find>${b ? "Інша книжка" : "Шукати"}</button>`}</span>
  <input type="hidden" name="swap_${i}" value=""><input type="hidden" name="ol_${i}" value="">
  <div class="add-find" hidden><input type="search" value="${attr(r.title)}" placeholder="назва або автор" autocomplete="off"><div class="add-found"></div></div>
</li>`;
  };
  const body = `<form method="post" action="/import/list/apply" class="add add-review">
  <input type="hidden" name="token" value="${attr(token)}">
  <div class="add-intro">
    ${addCrumbs}
    <h1>Знайшли ${found} з ${rows.length}</h1>
    <p class="lead">Перевірте :) «Інша книжка», якщо знайшли неправильно. «Шукати» знайде книжку в нашому каталозі або в Open Library, з обкладинкою.</p>
    <label class="add-status">Статус <select name="status">${ADD_STATUS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></label>
    <button class="btn primary" data-cta>Додати <span data-n></span> на полицю</button>
  </div>
  <ol class="add-rows">${order.map((i) => line(rows[i], i)).join("")}</ol>
</form>
<script>
(() => {
  const form = document.querySelector(".add-review");
  const word = (n) => (n % 10 === 1 && n % 100 !== 11 ? "книжку" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? "книжки" : "книжок");
  const count = () => { const n = form.querySelectorAll("input[name=keep]:checked").length; form.querySelectorAll("[data-n]").forEach((s) => (s.textContent = n + " " + word(n))); form.querySelectorAll("[data-cta]").forEach((b) => (b.disabled = !n)); };
  form.addEventListener("change", count);
  let timer;
  const look = (row) => {
    const box = row.querySelector(".add-found");
    const q = row.querySelector(".add-find input").value.trim();
    clearTimeout(timer);
    timer = setTimeout(async () => { box.innerHTML = q.length < 2 ? "" : await (await fetch("/api/add/find?q=" + encodeURIComponent(q))).text(); }, 200);
  };
  form.addEventListener("input", (e) => { const row = e.target.closest(".add-find") && e.target.closest(".add-row"); if (row) look(row); });
  form.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.closest(".add-find")) e.preventDefault(); });
  form.addEventListener("click", (e) => {
    const row = e.target.closest(".add-row");
    if (!row) return;
    if (e.target.closest("[data-find]")) { const f = row.querySelector(".add-find"); f.hidden = !f.hidden; if (!f.hidden) { f.querySelector("input").focus(); look(row); } }
    if (e.target.closest("[data-own]")) { row.querySelector("input[name=keep]").checked = true; row.classList.add("as-own"); count(); }
    const pick = e.target.closest("[data-pick], [data-ol]");
    if (pick) {
      row.querySelector("input[name=swap_" + row.dataset.i + "]").value = pick.dataset.pick || "";
      row.querySelector("input[name=ol_" + row.dataset.i + "]").value = pick.dataset.ol || "";
      row.querySelector(".add-cover").innerHTML = pick.querySelector(".cover").outerHTML;
      row.querySelector(".add-title").textContent = pick.dataset.title;
      row.querySelector(".add-by").textContent = pick.dataset.author;
      row.classList.remove("missing", "as-own");
      row.querySelector("[data-own]")?.remove();
      row.querySelector("[data-find]").textContent = "Інша книжка";
      row.querySelector(".add-find").hidden = true;
      row.querySelector("input[name=keep]").checked = true;
      count();
    }
  });
  count();
})();
</script>`;
  return layout({ title: "Додати книжки", body, user, path: "/add", noindex: true });
}
// «Інша книжка»: what the catalog has for the typed words, each a button that takes its place.
function addFindResults(hits, outside = []) {
  if (!hits.length && !outside.length) return `<p class="small muted">Нічого не знайшлося. Спробуйте інакше або додайте без обкладинки.</p>`;
  const ours = hits.map(({ book: b }) => `<button type="button" class="add-pick" data-pick="${attr(b.id)}" data-title="${attr(b.title)}" data-author="${attr(byline(b.author || ""))}">${cover(b, "xs")}<span><b>${esc(b.title)}</b><span class="muted">${esc(byline(b.author || ""))}</span></span></button>`).join("");
  const theirs = outside.map((b) => `<button type="button" class="add-pick" data-ol="${attr(JSON.stringify(b))}" data-title="${attr(b.title)}" data-author="${attr(b.author)}">${cover(b, "xs")}<span><b>${esc(b.title)}</b><span class="muted">${esc(b.author)}${b.published ? ` · ${b.published}` : ""}</span></span></button>`).join("");
  return `${ours}${theirs ? `<p class="add-src">Open Library</p>${theirs}` : ""}`;
}

// ---- import from elsewhere (/import/goodreads, /import/apple-books, /import/list) ----

const IMPORT_NAMES = { goodreads: "Goodreads", "apple-books": "Apple Books", list: "списку" };
const IMPORT_BACK = (source) => (source === "list" ? "/add" : `/import/${source}`);

// Step one: where to get the file and where to drop it.
function importPage({ user, source = "goodreads", error = "" }) {
  const apple = source === "apple-books";
  const steps = apple
    ? `<p class="lead">Працює лише з Mac: на iPhone Apple Books свою бібліотеку не віддає. Переносяться книжки і статуси (прочитано, читаю, не почато); оцінок і рецензій в Apple Books немає.</p>
<ol class="steps">
  <li>У Finder натисніть <b>⇧⌘G</b> («Перейти до теки») і вставте: <code class="path">~/Library/Containers/com.apple.iBooksX/Data/Documents/BKLibrary</code></li>
  <li>Відкриється тека з трьома файлами <code>BKLibrary-….sqlite</code>, <code>…sqlite-wal</code> і <code>…sqlite-shm</code>. Виділіть усі три (⌘A).</li>
  <li>Перетягніть їх у поле нижче (або натисніть його і виберіть ті самі три файли). Ми покажемо, що потрапить на полицю, і спитаємо підтвердження.</li>
</ol>`
    : `<ol class="steps">
  <li>На Goodreads відкрийте <a class="text-link" href="https://www.goodreads.com/review/import" target="_blank" rel="noopener">My Books → Import and export</a> і натисніть <b>Export Library</b>. У застосунку Goodreads на телефоні експорту немає, лише на сайті: з телефона відкрийте посилання в браузері.</li>
  <li>За хвилину-дві там з’явиться посилання на файл <code>goodreads_library_export.csv</code>. Завантажте його.</li>
  <li>Виберіть цей файл тут. Ми покажемо, що саме потрапить на полицю, і спитаємо підтвердження.</li>
</ol>`;
  return authLayout({
    title: `Імпорт з ${IMPORT_NAMES[source]}`,
    lead: apple ? "Перенесіть бібліотеку з Apple Books на Mac: що прочитали, що читаєте, що лежить непочате." : "Перенесіть свою бібліотеку з Goodreads: прочитане, оцінки, дати, рецензії і список «хочу прочитати».",
    user,
    path: "/add",
    form: `${steps}
<form method="post" action="/import/${source}" enctype="multipart/form-data" class="form">
  ${errorLine(error)}
  <label>${apple ? "Файли з теки BKLibrary" : "Файл експорту"}<input type="file" name="file" ${apple ? "multiple" : 'accept=".csv,text/csv"'} required></label>
  <div class="actions"><button class="btn primary">Переглянути</button><a class="text-link small" href="/add">Назад</a></div>
</form>
<p class="muted small">${apple ? "Файли читаються один раз і не зберігаються: з них ми беремо лише назви, авторів і прогрес читання." : "Файл читається один раз і не зберігається; приватних нотаток Goodreads ми не читаємо."} <a class="text-link" href="/privacy">Приватність</a>.</p>`,
  });
}

// Step two: every row of the file as it would land on the shelf, in three groups, each row with a tick.
function importPreviewPage({ user, source = "goodreads", token, rows, counts, filename = "" }) {
  const what = (r) => [r.status ? STATUS[r.status] : "", r.rating != null ? stars(r.rating) : "", r.year || "", r.progress > 0 && r.progress < 98 && r.status === "reading" ? `${r.progress}%` : "", r.copy ? COPY[r.copy].toLowerCase() : ""].filter(Boolean).join(" · ");
  const line = (r, i) => `<label class="imp-row">
  <input type="checkbox" name="keep" value="${i}" checked>
  <span class="imp-body">
    <span class="imp-title">${r.match ? `<a href="${attr(r.match.href)}">${esc(r.match.title)}</a>${norm(r.match.title) !== norm(r.title) ? ` <span class="muted">· ${esc(r.title)}</span>` : ""}` : esc(r.title)}</span>
    <span class="imp-by">${esc(r.match?.author || r.author)}${r.also ? ` · <span class="badge">${r.also + 1} видання в одне</span>` : ""}</span>
    <span class="imp-meta">${what(r)}${r.note ? ` · <span class="muted">${esc(r.note.length > 90 ? `${r.note.slice(0, 90)}…` : r.note)}</span>` : ""}</span>
  </span>
</label>`;
  // Each group has its own «зняти всі / вибрати всі» (Max, 2026-10-20: «імпортувати лише обране»), the bar has them for the whole list.
  const toggles = `<span class="imp-toggle"><button type="button" class="text-link small" data-all="1">вибрати всі</button> · <button type="button" class="text-link small" data-all="0">зняти всі</button></span>`;
  const group = (title, lead, list) => (list.length ? `<section class="imp-group"><h2>${title} <span>${list.length}</span>${toggles}</h2><p class="muted small">${lead}</p>${list.map(([r, i]) => line(r, i)).join("")}</section>` : "");
  const indexed = rows.map((r, i) => [r, i]);
  const skipped = counts.skipped ? ` · ${counts.skipped} PDF пропущено` : "";
  const body = `
${pageHead({ crumbs: `<a href="/add">Додати книжки</a> / <a href="${IMPORT_BACK(source)}">${source === "list" ? "Список" : `Імпорт з ${IMPORT_NAMES[source]}`}</a>`, title: "Що потрапить на полицю", sub: [books(counts.all), counts.read ? `${counts.read} прочитано` : "", counts.want ? `${counts.want} ${source === "apple-books" ? "не почато" : "хочу прочитати"}` : "", counts.reading ? `${counts.reading} читаю` : "", counts.abandoned ? `${counts.abandoned} покинуто` : "", counts.rated ? `${counts.rated} з оцінками` : "", counts.notes ? `${counts.notes} з рецензіями` : ""].filter(Boolean).join(" · ") + skipped })}
<form method="post" action="/import/${source}/apply" class="import-preview">
  <input type="hidden" name="token" value="${attr(token)}">
  <div class="imp-bar">
    <span class="small muted">${filename ? `${esc(filename)} · ` : ""}${source === "list" ? "переплутали автора з назвою? поправити можна буде на полиці · " : ""}зніміть галочку з того, що переносити не треба, або зніміть усі й виберіть лише обране</span>
    ${toggles}
    <span class="grow"></span>
    <button class="btn primary">Імпортувати <span id="imp-n">${counts.all}</span></button>
  </div>
  ${group("Є в каталозі", "Ці книжки ми знайшли за ISBN або назвою й автором; вони стануть на полицю як є, з обкладинкою і сторінкою.", indexed.filter(([r]) => r.match && !r.own))}
  ${group("Вже на вашій полиці", "Ці книжки у вас уже є. Те, що на полиці вже записано, лишиться; візьмемо лише те, чого бракує (оцінку, рік, рецензію).", indexed.filter(([r]) => r.own))}
  ${group("Нові книжки", "Таких у каталозі поки немає: додамо як ваші книжки, за назвою й автором, без обкладинки. Коли вони з’являться в якомусь каталозі, самі з’єднаються.", indexed.filter(([r]) => !r.match))}
  <div class="imp-bar bottom"><a class="text-link small" href="${IMPORT_BACK(source)}">${source === "list" ? "Інший список" : "Інший файл"}</a><span class="grow"></span><button class="btn primary">Імпортувати <span>${counts.all}</span></button></div>
</form>
<script>
(() => {
  const form = document.querySelector(".import-preview");
  const ns = form.querySelectorAll(".btn span");
  const count = () => { const n = form.querySelectorAll("input[name=keep]:checked").length; ns.forEach((s) => (s.textContent = n)); form.querySelectorAll(".btn.primary").forEach((b) => (b.disabled = !n)); };
  form.addEventListener("change", count);
  form.addEventListener("click", (e) => {
    const t = e.target.closest("[data-all]");
    if (!t) return;
    const scope = t.closest(".imp-group") || form;
    scope.querySelectorAll("input[name=keep]").forEach((c) => (c.checked = t.dataset.all === "1"));
    count();
  });
})();
</script>`;
  return layout({ title: source === "list" ? "Додати книжки" : `Імпорт з ${IMPORT_NAMES[source]}`, body, user, path: "/add" });
}

// Step three: done.
function importDonePage({ user, source = "goodreads", result, skipped = 0 }) {
  const bits = [result.added ? `${books(result.added)} додано` : "", result.updated ? `${result.updated} ${plural(result.updated, "доповнена", "доповнені", "доповнено")}` : "", result.created.length ? `${result.created.length} ${plural(result.created.length, "нова", "нові", "нових")} у каталозі` : "", skipped ? `${skipped} пропущено` : ""].filter(Boolean);
  return authLayout({
    title: "Готово",
    lead: bits.length ? `${cap(bits.join(", "))}.` : "Нічого не змінилося.",
    user,
    path: "/add",
    form: `<div class="form"><div class="actions"><a class="btn primary" href="${attr(user.href)}">Моя полиця</a><a class="text-link small" href="${IMPORT_BACK(source)}">${source === "list" ? "Додати ще" : "Імпортувати ще один файл"}</a></div></div>
${result.created.length ? `<p class="muted small" style="margin-top:24px">Нові книжки без обкладинок: якщо котрась із них насправді вже є в каталозі під іншою назвою, напишіть нам, з’єднаємо.</p>` : ""}`,
  });
}

// ---- misc ----

// After «Відписатися» in the weekly letter: done, with a way back.
function followMailPage({ on, action, user }) {
  const title = on ? "Листи знову приходять" : "Листів більше не буде";
  return layout({ title, user, body: `<section class="auth prose"><h1>${title}</h1>
<p>${on ? "Коли хтось почне стежити за вашою полицею, ви знову отримаєте лист." : "Листів про нових читачів більше не буде. Стежити за вами, як і раніше, можна."}</p>
<form method="post" action="${attr(action)}"><input type="hidden" name="page" value="1"><button class="btn">${on ? "Вимкнути" : "Увімкнути знову"}</button></form>
</section>` });
}
function digestPage({ on, action, user }) {
  const title = on ? "Листи знову приходять" : "Листів більше не буде";
  return layout({ title, user, body: `<section class="auth prose"><h1>${title}</h1>
<p>${on ? "Щотижневий лист знову приходитиме в п'ятницю вранці, коли буде що розповісти." : "Щотижневий лист вимкнено. Полиця, підписки й усе інше лишаються як були."}</p>
<form method="post" action="${attr(action)}"><input type="hidden" name="page" value="1"><button class="btn">${on ? "Вимкнути" : "Увімкнути знову"}</button></form>
</section>` });
}

// /admin/letter: Max's own text on top of the next Friday letter (digest.js). He writes it; the page only keeps it.
function letterEditorPage({ user, editorial: e, sent, audiences, counts, next, saved }) {
  const MONTHS = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
  const day = (d) => `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  const iso = (s) => day(new Date(s));
  const aud = e?.audience || "all";
  const body = `
${pageHead({ crumbs: `<a href="/admin">Статистика</a>`, kicker: "Щотижневий лист", title: "Твій текст у листі", sub: `Стоїть на початку листа, над тим, що сталося на полицях читача. Піде з листом у п’ятницю, ${day(next)}, о 9:00, і більше не повториться.` })}
<form method="post" action="/admin/letter" class="form">
  ${saved ? `<p class="saved">Збережено.</p>` : ""}
  <label>Тема листа<input type="text" name="subject" value="${attr(e?.subject || "")}" maxlength="120" placeholder="Як порожньо, тема складається сама з новин полиць"></label>
  <label>Текст<textarea name="text" rows="14" placeholder="Абзаци через порожній рядок. Посилання: [текст](https://…)">${esc(e?.text || "")}</textarea></label>
  <label>Кому<select name="audience">${Object.entries(audiences).map(([k, l]) => `<option value="${k}"${k === aud ? " selected" : ""}>${esc(l)} (${counts[k]})</option>`).join("")}</select><span class="hint">Решта отримають свій звичайний лист без цього тексту, якщо на їхніх полицях є новини.</span></label>
  <div class="actions"><button class="btn primary">Зберегти</button><button class="btn" name="preview" value="1">Зберегти й подивитись лист</button><span class="grow"></span>${e ? `<span class="muted small">Змінено ${iso(e.updated)}</span>` : ""}</div>
  <p class="muted small">Щоб нічого не додавати до листа, зітри текст і збережи.</p>
</form>
${sent.length ? `<section class="form"><h2>Уже надіслані</h2>${sent.map((x) => `<details><summary>${iso(x.sent)}${x.subject ? ` · ${esc(x.subject)}` : ""} · ${x.readers} ${x.readers % 10 === 1 && x.readers % 100 !== 11 ? "читачу" : "читачам"}</summary><p class="muted small" style="white-space:pre-wrap">${esc(x.text)}</p></details>`).join("")}</section>` : ""}`;
  return layout({ title: "Текст у листі", body, user, path: "/admin", noindex: true });
}

function messagePage({ title, text, user }) {
  return layout({ title, body: pageHead({ title: esc(title), sub: esc(text) }), user, noindex: true });
}

module.exports = {
  nowPage,
  letterEditorPage,
  mailSettingsPage,
  dupesPage,
  reviewsAdminPage,
  translationsPage,
  decidedList,
  welcomePage,
  addPage, addReviewPage, addFindResults,
  layout, homePage, bookPage, editPage, libraryPage, readersPage, popularPage, publishersPage, publisherPage, searchPage, searchResults, authorPage,
  loginPage, codePage, signupPage, settingsPage, privacyPage, updatesPage, messagePage, digestPage, followMailPage, importPage, importPreviewPage, importDonePage,
  esc, byline, STATUS, COPY, inline, isUk, setTitleLinks, setAuthorLinks, setStats, setReadersWithNote,
};

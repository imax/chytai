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
const FONTS = "https://fonts.googleapis.com/css2?family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;1,8..60,400&family=Onest:wght@400;500;600&display=swap";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const attr = esc;
const plural = (n, one, few, many) => (n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many);
const count = (n, one, few, many) => `${n} ${plural(n, one, few, many)}`;
const uk = (n) => String(n).replace(".", ",");
const BOOKS = ["книжка", "книжки", "книжок"];
const books = (n) => count(n, ...BOOKS);

const STATUS = { read: "Прочитав", reading: "Читаю", want: "Хочу прочитати" };
const COPY = { paper: "На папері", ebook: "E-book", seeking: "Шукаю на папері" };
// What a reader did, as the feed says it: «Оля К. оцінка ★★★★», «Андрій читає».
const VERB = { read: "прочитав", reading: "читає", want: "хоче прочитати" };
const GENRES = ["художня", "фантастика", "детективи", "трилери", "бізнес", "компанії", "менеджмент", "продукт", "гроші", "розробка", "історія", "війна", "біографії", "наука", "саморозвиток", "суспільство"];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const CYR = /[а-яіїєґ]/i;
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
  ["/readers", "Читачі", (p) => p === "/readers" || p === "/@"],
  ["/publishers", "Видавництва", (p) => p.startsWith("/publishers")],
];

function layout({ title, body, user, path = "", description = "", q = "", home = false }) {
  const on = (p) => (p ? ' class="on"' : "");
  const nav = [
    ...NAV.map(([href, name, is]) => `<a href="${href}"${on(is(path))}>${name}</a>`),
    user ? `<a href="${attr(user.href || "/me")}"${on(path === "/me")}>Моє</a>` : "",
    user ? `<a href="/settings"${on(path === "/settings")} title="Налаштування">${esc(user.name)}</a>` : `<a href="/login"${on(path === "/login")}>Увійти</a>`,
  ].join("");
  const find = home || path === "/search" ? "" : `<form class="find" action="/search" role="search"><input type="search" name="q" value="${attr(q)}" placeholder="назва, автор або «щось як…»" autocomplete="off" aria-label="Пошук"></form>`;
  return `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title ? `${title} · Chytai` : "Chytai")}</title>
${description ? `<meta name="description" content="${attr(description.slice(0, 200))}">` : ""}
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
<footer class="foot"><div class="bar"><span class="motto">Chytai.org.ua: читай більше.</span><a href="https://chytai.fly.dev">Читалка</a>${user ? "" : `<a href="/login">Завести полицю</a>`}<a href="/privacy">Приватність</a><a href="mailto:ischenko@gmail.com">Написати нам</a></div></footer>
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
let statsOf = () => ({ avg: null, rated: 0, want: 0, readers: 0 });
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
function wantButton(book, user, { size = "small", label: text = "Хочу прочитати", primary = false } = {}) {
  const cls = `btn ${primary ? "primary" : ""} ${size}`;
  if (!user) return `<a class="${cls}" href="/login?next=${attr(encodeURIComponent(book.href || ""))}">${text}</a>`;
  return `<form method="post" action="/api/entry/${attr(encodeURIComponent(book.id))}" class="inline"><input type="hidden" name="status" value="want"><input type="hidden" name="back" value="1"><button class="${cls}">${text}</button></form>`;
}

// The status, rating and copy of an entry as one quiet line: «★★★★★ 5 · прочитав · на папері».
function entryMeta(e) {
  const bits = [e.status ? VERB[e.status] : "", e.copy ? COPY[e.copy].toLowerCase() : ""].filter(Boolean);
  return `${stars(e.rating)}${bits.length ? `<span>${e.rating != null ? " · " : ""}${esc(bits.join(" · "))}</span>` : ""}`;
}

// A book in a list (shelves, search): cover, title, author, stars and the note, an action on the right.
function bookRow(book, { entry = null, meta = "", action = "", id = "", data = "" } = {}) {
  const alt = book.altTitle ? ` · ${esc(book.altTitle)}` : "";
  return `<article class="row"${id ? ` id="${attr(id)}"` : ""}${data}>
  <a class="cover-link" href="${attr(book.href)}">${cover(book, "md")}</a>
  <div class="row-body">
    <h3><a href="${attr(book.href)}">${esc(book.title)}</a>${book.series?.volumes ? ` <span class="badge">серія · ${count(book.series.volumes, "том", "томи", "томів")}</span>` : ""}</h3>
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
const did = (e) => (e.rating != null ? `оцінка ${stars(e.rating, { num: false })}` : esc(VERB[e.status] || ""));

// One line of the activity feed. `wide` is the /readers layout (who first, then the book).
function feedRow({ reader, book, entry: e }, { wide = false } = {}) {
  const t = when(e);
  const who = `<span class="who"><a href="${attr(reader.href)}#${attr(book.id)}"><b>${esc(reader.name)}</b></a> ${did(e)}${t ? ` · ${esc(t)}` : ""}</span>`;
  const title = `<a class="title" href="${attr(book.href)}">${esc(book.title)}</a>`;
  return `<article class="feed-row${wide ? " wide" : ""}${e.note ? " noted" : ""}" data-rating="${e.rating ?? ""}">
  <a class="cover-link" href="${attr(book.href)}">${cover(book, wide ? "feed" : "xs")}</a>
  <div>${wide ? `${who}${title}${book.author ? `<span class="by">${esc(byline(book.author))}</span>` : ""}` : `${title}${who}`}${e.note ? `<p class="note">${noteOf(e, book.id)}</p>` : ""}</div>
</article>`;
}
const feedList = (items, opts) => (items.length ? `<div class="feed">${items.map((it) => feedRow(it, opts)).join("")}</div>` : `<p class="muted">Поки тихо.</p>`);

// Page head: a green label, the title, a line under it; an action on the right.
const pageHead = ({ crumbs = "", kicker = "", title, sub = "", action = "", lead = "" }) => `
<section class="page-head">
  <div>
    ${crumbs ? `<p class="crumbs">${crumbs}</p>` : ""}
    ${kicker ? `<p class="kicker">${kicker}</p>` : ""}
    <h1>${title}</h1>
    ${lead ? `<p class="lead">${lead}</p>` : ""}
    ${sub ? `<p class="sub">${sub}</p>` : ""}
  </div>
  ${action ? `<div class="head-act">${action}</div>` : ""}
</section>`;

// ---- home (/) ----

// «Що почитати далі?»: the search, a random well rated book, the feed, recommendations, new books.
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
  <h1>Що почитати далі?</h1>
  <form class="search-box big" action="/search" role="search"><input type="search" name="q" placeholder="назва, автор або серія" aria-label="Пошук" autocomplete="off"><span class="enter">Enter ↵</span></form>
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
    ${label("Зараз читають", `<a href="/readers">усі читачі</a>`)}
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
  return layout({ title: "", body, user, path: "/", home: true, description: "Що почитати далі: книжки з оцінками й нотатками читачів і новинки українських видавництв." });
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
  <div class="lib-list">${libraries.map((l) => `<a href="${attr(l.base)}" target="_blank" rel="noopener"><b>${esc(l.name)} ↗</b><span>${esc(l.city)}</span></a>`).join("")}</div>
</section>`;
}

// ---- book (/book/:id) ----

// The book, the reader's own buttons, where to get it, what readers said, what it is about.
function bookPage({ book, entry, user, shelf, inLibrary = new Map(), readers = [], also = [] }) {
  const s = statsOf(book.id);
  const kicker = [book.tags?.find((t) => t !== "українською"), CYR.test(book.title) ? "українською" : ""].filter(Boolean).map(cap).join(" · ");
  const sub = [book.altTitle ? esc(book.altTitle) : "", book.author ? `<span class="authors">${authorLinks(book.author)}</span>` : ""].filter(Boolean).join(" · ");
  const score = s.avg != null || s.want ? `<p class="score">${s.avg != null ? `${stars(s.avg, { num: false })} <b>${uk(s.avg.toFixed(1))}</b> від ${count(s.rated, "читача", "читачів", "читачів")}` : ""}${s.want ? `${s.avg != null ? " · " : ""}${s.want} ${plural(s.want, "хоче", "хочуть", "хочуть")} прочитати` : ""}</p>` : "";
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
        ${mine(book, entry, user)}
        ${where(book)}
      </div>
    </article>
    ${series(book, inLibrary)}
    ${first ? `<section class="block">
      ${label("У читачів")}
      ${first.entry.note ? quote(first, book.id) : ""}
      ${(first.entry.note ? rest : readers).length ? `<div class="others">${(first.entry.note ? rest : readers).map((r) => readerLine(r, book.id)).join("")}</div>` : ""}
    </section>` : ""}
    ${book.blurb || book.translations?.length || book.ukTitle ? `<section class="block">
      ${label("Про книжку")}
      ${book.blurb ? `<div class="about"><p>${esc(book.blurb)}</p></div>` : ""}
      <p class="small muted">${[book.blurb ? `Опис з сайту ${esc(shelf ? shelf.name : book.source)}` : "", ...(book.translations || []).map((t) => `${CYR.test(book.title) && !CYR.test(t.title) ? "Оригінал" : "Переклад"}: <a href="${attr(t.href)}">${esc(t.title)}</a>`), book.ukTitle ? `Українською: «${esc(book.ukTitle)}», у каталогах поки немає` : ""].filter(Boolean).join(" · ")}</p>
    </section>` : ""}
  </div>
  <aside>
    ${also.length ? `${label("Читали це, сподобалось і це")}${minis(also)}` : ""}
  </aside>
</div>`;
  const description = [book.author, book.blurb || stripMd(readers.find((r) => r.entry.note)?.entry.note || "")].filter(Boolean).join(". ");
  return layout({ title: book.title, body, user, path: "/book", description });
}

// The first reader's note as the big quote: «— Макс І, прочитав у 2026, на папері».
function quote({ name, href, entry: e }, id) {
  const long = stripMd(e.note).length > 280;
  const what = [e.status ? VERB[e.status] + (e.status === "read" && e.year ? ` у ${e.year}` : "") : "", e.copy ? COPY[e.copy].toLowerCase() : "", e.via ? `як «${e.via.title}»` : ""].filter(Boolean).join(", ");
  return `<blockquote class="big-quote${long ? " long" : ""}">${marked.parse(titleLinks(e.note, e.via ? e.via.id : id)).replace(/<a href="http/g, '<a target="_blank" rel="noopener" href="http')}</blockquote>
<p class="said">— <a href="${attr(href)}"><b>${esc(name)}</b></a>${e.rating != null ? ` ${stars(e.rating)}` : ""}${what ? `, ${esc(what)}` : ""}</p>`;
}
// Every other reader: name, what they did, their note if any.
function readerLine({ name, href, entry: e }, id) {
  const what = [e.status ? VERB[e.status] + (e.status === "read" && e.year ? ` у ${e.year}` : "") : "", e.copy ? COPY[e.copy].toLowerCase() : "", e.via ? `як «${e.via.title}»` : ""].filter(Boolean).join(" · ");
  return `<div class="reader-line"><a href="${attr(href)}"><b>${esc(name)}</b></a><span>${e.rating != null ? `${stars(e.rating)} ` : ""}<span class="muted">${esc(what)}</span>${e.note ? `<span class="note">${noteOf(e, id)}</span>` : ""}</span></div>`;
}

// The signed-in reader's own buttons: «Хочу прочитати», «Прочитав · оцінити», or where the book is
// in their library and «Змінити».
function mine(book, entry, user) {
  // Read in another language: the mark comes from that book, and so does the edit link.
  const href = entry?.via ? entry.via.href : book.href;
  const edit = href ? `/me${href}` : `/me/book/${encodeURIComponent(entry?.via ? entry.via.id : book.id)}`;
  if (!entry) return `<div class="acts">${wantButton(book, user, { size: "", primary: true })}<a class="btn" href="${attr(user ? edit : `/login?next=${encodeURIComponent(edit)}`)}">Прочитав · оцінити</a></div>`;
  const what = [entry.status ? STATUS[entry.status] + (entry.status === "read" && entry.year ? ` ${entry.year}` : "") : "У моїх книжках", entry.rating != null ? `${uk(entry.rating)} з 5` : "", entry.copy ? COPY[entry.copy] : ""].filter(Boolean).join(" · ");
  return `<div class="acts"><span class="have">✓ ${esc(what)}${entry.via ? ` <span class="muted">як <a href="${attr(entry.via.href)}">${esc(entry.via.title)}</a></span>` : ""}</span><a class="btn small" href="${attr(edit)}">Змінити</a></div>`;
}

// «Де взяти»: every edition's shop (with its format, price and stock, the one place prices are shown),
// other links, and the libraries that hold the book (filled in by app.js from /api/libraries).
function where(book) {
  const seen = new Set();
  // In stock first, then the publisher's own over a shop reselling it (Старий Лев sells partners' books).
  const rank = (e) => (e.status === "є" ? 0 : e.status === "передзамовлення" ? 1 : 2) * 4 + (e.edition ? 2 : 0) + (e.format === "e-book" ? 1 : 0);
  const eds = (book.editions || []).filter((e) => !seen.has(e.links[0].url) && seen.add(e.links[0].url)).sort((a, b) => rank(a) - rank(b));
  const links = (book.links || []).filter((l) => !seen.has(l.url));
  const shop = (e) => {
    const tail = [e.format, e.edition, e.price, avail(e)].filter(Boolean).join(", ");
    return `<a href="${attr(e.links[0].url)}" target="_blank" rel="noopener">${esc(e.shelf.name)}</a>${tail ? ` <span class="muted">${esc(tail)}</span>` : ""}`;
  };
  const items = [...eds.map(shop), ...links.map((l) => `<a href="${attr(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`)];
  return `<div class="where${items.length ? "" : " hidden"}" data-src="/api/libraries/${attr(encodeURIComponent(book.id))}"><span class="where-label">Де взяти</span>${items.map((x) => `<span class="where-item">${x}</span>`).join("")}</div>`;
}

// The volumes of the series this book belongs to, each with its own page and where to get it.
function series(book, inLibrary) {
  const ser = book.series;
  if (!ser?.items) return "";
  const name = (v) => (v.bundle ? `Комплект із ${count(ser.volumes, "тому", "томів", "томів")}` : cap(v.title.replace(ser.name, "").replace(/^[\s,.:]+/, "")) || `Том ${v.volume}`);
  return `<section class="block series">${label(`Серія «${esc(ser.name)}», ${count(ser.volumes, "том", "томи", "томів")}`)}<ul>${ser.items
    .map((v) => {
      const has = inLibrary.get(v.work);
      const tail = [v.price, avail(v)].filter(Boolean).join(" · ");
      return `<li class="${v.work === book.id ? "this" : ""}"><a href="${attr(v.href)}">${esc(name(v))}</a>${has?.status ? ` <span class="muted small">${STATUS[has.status].toLowerCase()}</span>` : ""}<span class="muted small">${esc(tail)}</span><a class="text-link small" href="${attr(v.links[0].url)}" target="_blank" rel="noopener">${esc(v.shelf.name)} ↗</a></li>`;
    })
    .join("")}</ul></section>`;
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
      <option value="read" ${e.status === "read" ? "selected" : ""}>Прочитав</option>
      <option value="want" ${e.status === "want" ? "selected" : ""}>Хочу прочитати</option>
    </select></label>
    <label>Оцінка <select name="rating">
      <option value="none" ${e.rating == null ? "selected" : ""}>без оцінки</option>
      ${ratings.map((r) => `<option value="${r}" ${e.rating === r ? "selected" : ""}>${uk(r)}</option>`).join("")}
      ${e.rating != null && !ratings.includes(e.rating) ? `<option value="${e.rating}" selected>${uk(e.rating)}</option>` : ""}
    </select></label>
    <label>Рік <input name="year" type="number" min="1990" max="2100" value="${attr(e.year || "")}" placeholder="${new Date().getFullYear()}"></label>
  </div>
  <label>Примірник <select name="copy">
    <option value="" ${!e.copy ? "selected" : ""}>не вказано</option>
    <option value="paper" ${e.copy === "paper" ? "selected" : ""}>Є на папері</option>
    <option value="ebook" ${e.copy === "ebook" ? "selected" : ""}>Є e-book</option>
    <option value="seeking" ${e.copy === "seeking" ? "selected" : ""}>Шукаю на папері</option>
  </select></label>
  <label>Нотатка <textarea name="note" rows="5" placeholder="Кілька слів про книжку">${esc(e.note || "")}</textarea></label>
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
function libraryPage({ rows, user, reader, own = false, mineIds = null, recs = [] }) {
  const year = new Date().getFullYear();
  const read = rows.filter((r) => r.status === "read").length;
  const thisYear = rows.filter((r) => r.status === "read" && r.year === year);
  const rated = thisYear.filter((r) => r.rating != null);
  const common = mineIds && !own ? rows.filter((r) => mineIds.has(r.id)) : [];
  const genres = GENRES.filter((g) => rows.some((r) => (r.book.tags || []).includes(g)));
  // Another reader's tabs say what they did («Читає»), since we don't know how they'd say it themselves.
  const tabs = [
    ["", "Усі", rows.length],
    ["read", own ? "Прочитав" : "Прочитане", read],
    ["reading", own ? "Читаю" : "Читає", rows.filter((r) => r.status === "reading").length],
    ["want", own ? "Хочу прочитати" : "Хоче прочитати", rows.filter((r) => r.status === "want").length],
    ["paper", "На папері", rows.filter((r) => r.copy === "paper").length],
    ["seeking", "Шукаю", rows.filter((r) => r.copy === "seeking").length],
    ...(common.length ? [["common", "Спільні", common.length]] : []),
  ].filter(([k, , n]) => !k || n || (own && ["read", "reading", "want"].includes(k)));
  const sub = [books(rows.length), count(read, "прочитана", "прочитані", "прочитаних"), thisYear.length ? `${thisYear.length} цього року` : "", common.length ? `<b>${common.length} ${plural(common.length, "спільна", "спільні", "спільних")} з тобою</b>` : "", own ? `<a href="${attr(reader.href)}?public">як бачать інші</a>` : `<span class="muted">@${esc(reader.username)}</span>`].filter(Boolean).join(" · ");
  const list = rows
    .map((r, i) => {
      const b = r.book;
      const head = r.year !== r._prevYear || i === 0 ? yearHead(r.year, rows) : "";
      const search = [b.title, b.altTitle, b.author, stripMd(r.note || "")].join(" ").toLowerCase();
      const data = ` data-status="${r.status || ""}" data-copy="${r.copy || ""}" data-common="${common.includes(r) ? 1 : ""}" data-tags="${attr((b.tags || []).join(" "))}" data-rating="${r.rating ?? ""}" data-title="${attr(b.title.toLowerCase())}" data-search="${attr(search)}" data-order="${i}"`;
      const action = own ? `<a class="text-link small" href="${attr(b.href ? `/me${b.href}` : `/me/book/${encodeURIComponent(r.id)}`)}">змінити</a>` : user && mineIds && !mineIds.has(r.id) ? wantButton(b, user) : "";
      return head + bookRow(b, { entry: r, action, id: r.id, data });
    })
    .join("\n");
  const wants = own ? [] : rows.filter((r) => r.status === "want").slice(0, 3);
  const body = `
${pageHead({ crumbs: own ? "" : `<a href="/readers">Читачі</a> / ${esc(reader.name)}`, kicker: own ? "Моя полиця" : "Полиця читача", title: esc(reader.name), sub, action: own ? `<button class="btn primary" data-open="add">+ Додати книжку</button>` : "" })}
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
      <p><b>${thisYear.filter((r) => CYR.test(r.book.title)).length}</b>українською</p>
      <p><b>${thisYear.filter((r) => r.note).length}</b>з нотатками</p>
    </div>` : ""}
    ${common.length ? `${label("Спільне з тобою")}<p class="small muted">${books(common.length)}, які ви обоє маєте на полиці.</p><div class="grid four">${common.slice(0, 4).map((r) => `<a href="${attr(r.book.href)}">${cover(r.book, "card")}</a>`).join("")}</div>` : ""}
    ${wants.length ? `${label("Хоче прочитати")}${minis(wants.map((r) => r.book), "xs")}` : ""}
    ${recs.length ? `${label("Тобі може зайти")}<p class="small muted">За твоїми п’ятірками</p>${minis(recs)}` : ""}
  </aside>
</div>
${own ? addDialog() : ""}`;
  return layout({ title: own ? "Моя полиця" : reader.name, body, user, path: own ? "/me" : "/@", description: own ? "" : `Книжки, які читає ${reader.name}: оцінки й нотатки.` });
}

function yearHead(year, rows) {
  const n = rows.filter((r) => (r.year ?? null) === (year ?? null)).length;
  return `<h2 class="year" data-year="${year ?? ""}">${year || "Без дати"} <span>${books(n)}</span></h2>`;
}

function addDialog() {
  return `
<dialog id="add">
  <form method="post" action="/api/book" class="form">
    <h2>Нова книжка</h2>
    <label>Назва <input name="title" required autofocus></label>
    <label>Автор <input name="author"></label>
    <label>Обкладинка (URL) <input name="cover" type="url" placeholder="https://…"></label>
    <div class="two">
      <label>Статус <select name="status"><option value="">без статусу</option><option value="reading">Читаю</option><option value="read">Прочитав</option><option value="want" selected>Хочу прочитати</option></select></label>
      <label>Примірник <select name="copy"><option value="">не вказано</option><option value="paper">На папері</option><option value="ebook">E-book</option><option value="seeking">Шукаю на папері</option></select></label>
    </div>
    <div class="actions"><button type="button" class="btn" data-close>Скасувати</button><button class="btn primary">Додати</button></div>
  </form>
</dialog>`;
}

// ---- readers (/readers) ----

function readersPage({ user, feed, readers, totals }) {
  const body = `
${pageHead({ kicker: "Спільнота", title: "Що читають інші", sub: `${count(totals.readers, "читач", "читачі", "читачів")} · ${books(totals.books)} на полицях · ${count(totals.notes, "нотатка", "нотатки", "нотаток")}`, action: user ? "" : `<a class="btn primary" href="/login">Завести полицю</a>` })}
<div class="split wide-aside">
  <section>
    ${label("Стрічка", `<span class="tabs" data-feed-filter><button type="button" class="tab on" data-v="">усе</button><button type="button" class="tab" data-v="notes">з нотатками</button><button type="button" class="tab" data-v="top">оцінки 4,5+</button></span>`)}
    ${feedList(feed, { wide: true })}
  </section>
  <aside>
    ${label("Читачі")}
    <div class="people">${readers
      .map((r) => `<div class="person"><p class="person-head"><a href="${attr(r.reader.href)}">${esc(r.reader.name)}</a>${r.thisYear ? `<span>${r.thisYear} цього року</span>` : ""}</p><p class="sub">${books(r.count)}, ${count(r.read, "прочитана", "прочитані", "прочитаних")}</p>${r.note ? `<p class="note">${r.note}</p>` : ""}</div>`)
      .join("")}</div>
    <p class="small muted">Полиці відкриті для всіх.</p>
  </aside>
</div>`;
  return layout({ title: "Читачі", body, user, path: "/readers", description: "Що читають інші: оцінки й нотатки читачів Chytai." });
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
  return layout({ title: "Видавництва", body, user, path: "/publishers", description: "Новинки українських видавництв щодня." });
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
${pageHead({ crumbs: `<a href="/publishers">Видавництва</a> / ${esc(shelf.name)}`, kicker: "Видавництво", title: esc(shelf.name), lead: esc(shelf.tagline), sub: [books(items.length), newCount ? `${newCount} ${plural(newCount, "нова", "нові", "нових")}` : "", `<a href="${attr(shelf.url)}" target="_blank" rel="noopener">${esc(host(shelf.url))} ↗</a>`].filter(Boolean).join(" · "), action: subscribeButton(shelf.id, subscribed, user, true) })}
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
  return layout({ title: shelf.name, body, user, path: "/publishers" });
}

// ---- search (/search) ----

function searchPage({ q, user, results }) {
  const body = `
<form class="search-box big query" action="/search" role="search"><input type="search" name="q" value="${attr(q)}" placeholder="назва, автор або серія" aria-label="Пошук" autocomplete="off"${q ? "" : " autofocus"}><span class="enter">Enter ↵</span></form>
<div id="live">${searchResults({ q, user, ...results })}</div>`;
  return layout({ title: q ? `${q} · Пошук` : "Пошук", body, user, path: "/search", q });
}

// The results in groups (books, authors, readers) with «схоже» on the side; also served alone by
// /api/search for search as you type.
function searchResults({ q, user, hits = [], authors = [], readers = [], similar = [], tag = "" }) {
  if (!q.trim()) return "";
  const n = hits.length + authors.length + readers.length;
  if (!n) return `<p class="found">Нічого не знайшлося за «${esc(q)}». ${user ? `<button type="button" class="text-link" data-open="add">Додати книжку, якої ще немає на Chytai</button>` : ""}</p>${user ? addDialog() : ""}`;
  return `<p class="found">${count(n, "збіг", "збіги", "збігів")}${tag ? ` · жанр «${esc(tag)}»` : ""}</p>
<div class="split">
  <div>
    ${hits.length ? `<section class="block">${label(`Книжки · ${hits.length}`)}<div class="rows">${hits.map((h) => bookRow(h.book, { meta: readersMeta(h.book.id), action: h.entry ? `<span class="muted small">${esc(h.entry.status ? STATUS[h.entry.status].toLowerCase() : "на полиці")}</span>` : wantButton(h.book, user) })).join("")}</div></section>` : ""}
    ${authors.length ? `<section class="block">${label(`Автори · ${authors.length}`)}<div class="name-rows">${authors.map((a) => `<a class="name-row" href="${attr(a.href)}"><b>${esc(a.name)}</b><span>${[books(a.books), a.readers ? count(a.readers, "читач", "читачі", "читачів") : ""].filter(Boolean).join(" · ")}</span></a>`).join("")}</div></section>` : ""}
    ${readers.length ? `<section class="block">${label(`Читачі · ${readers.length}`)}<div class="name-rows">${readers.map((r) => `<a class="name-row" href="${attr(r.reader.href)}"><b>${esc(r.reader.name)}</b><span>${books(r.count)}</span></a>`).join("")}</div></section>` : ""}
    ${user ? `<p class="muted end-note">Не те? <button type="button" class="text-link" data-open="add">Додати книжку, якої ще немає на Chytai</button></p>${addDialog()}` : ""}
  </div>
  <aside>${similar.length ? `${label("Схоже на те, що шукаєш")}${minis(similar)}` : ""}</aside>
</div>`;
}

// ---- /author/<slug> ----

// The books we have, with what readers said; who reads them; then the works from Wikidata.
function authorPage({ author, works, hits, user, readers = [], also = [] }) {
  const ratings = hits.map((h) => statsOf(h.book.id)).filter((s) => s.avg != null);
  const avg = ratings.length ? Math.round((ratings.reduce((s, x) => s + x.avg, 0) / ratings.length) * 10) / 10 : null;
  const inUk = hits.filter((h) => CYR.test(h.book.title)).length;
  const sub = [`${books(hits.length)} на Chytai`, readers.length ? count(readers.length, "читач", "читачі", "читачів") : "", avg != null ? `середня оцінка <b>${uk(avg.toFixed(1))}</b>` : "", inUk && inUk < hits.length ? `${inUk} українською` : ""].filter(Boolean).join(" · ");
  const work = (w) => {
    const title = w.uk || w.en || w.orig;
    const orig = [w.orig, w.en].find((t) => t && t !== title) || "";
    const b = w.books[0];
    return `<li${b ? "" : ' class="none"'}><span class="year">${w.year || ""}</span> ${b ? `<a href="${attr(b.href)}">${esc(title)}</a>` : esc(title)}${orig ? ` <span class="alt">${esc(orig)}</span>` : ""}${!b && !w.uk ? ` <span class="small muted">· перекладу не знайшли</span>` : ""}</li>`;
  };
  const bigRow = ({ book, entry }) => {
    const s = statsOf(book.id);
    const top = readersWithNote(book.id);
    return `<article class="row big">
  <a class="cover-link" href="${attr(book.href)}">${cover(book, "lg")}</a>
  <div class="row-body">
    <h3><a href="${attr(book.href)}">${esc(book.title)}</a></h3>
    ${book.altTitle ? `<p class="orig">${esc(book.altTitle)}</p>` : ""}
    ${s.avg != null ? `<p class="meta">${stars(s.avg)}<span> · ${count(s.rated, "оцінка", "оцінки", "оцінок")}</span></p>` : ""}
    ${top ? `<p class="note">${noteOf(top.entry, book.id)}</p><p class="said">— <a href="${attr(top.href)}"><b>${esc(top.name)}</b></a>${top.entry.year ? `, ${top.entry.year}` : ""}</p>` : ""}
    <div class="acts">${entry ? `<span class="muted small">${esc(entry.status ? STATUS[entry.status].toLowerCase() : "на полиці")}</span>` : wantButton(book, user)}</div>
  </div>
</article>`;
  };
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
</div>`;
  return layout({ title: author.name, body, user, path: "/author" });
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

function settingsPage({ user, values, error = "", suggested = "", saved = false }) {
  const form = `<form method="post" action="/settings" class="form" data-username>
  ${errorLine(error)}${saved ? `<p class="saved">Збережено.</p>` : ""}
  <label>Ім'я<input type="text" name="name" value="${attr(values.name || "")}" required maxlength="60"></label>
  <label>Адреса сторінки<span class="prefix">chytai.org.ua/@<input type="text" name="username" value="${attr(values.username || "")}" required maxlength="30" spellcheck="false" placeholder="${attr(suggested)}"></span><span class="hint">Якщо змінити, стара адреса перестане працювати.</span></label>
  <label>Пошта для входу<input type="email" name="email" value="${attr(values.email || "")}" ${user.owner ? "" : "required"} autocomplete="email"></label>
  <div class="actions"><button class="btn primary">Зберегти</button><a class="text-link small" href="${attr(user.href)}">Моя сторінка</a><span class="grow"></span><a class="text-link small" href="/logout">Вийти</a></div>
</form>
${user.owner ? "" : `<form method="post" action="/settings/delete" class="form danger-zone" onsubmit="return confirm('Видалити акаунт разом з усіма книжками, оцінками й нотатками?')">
  <h2>Видалити акаунт</h2>
  <p class="muted small">Зітре всі ваші книжки, оцінки, нотатки й підписки. Назад не повернути.</p>
  <label>Впишіть ${esc(user.username)}, щоб підтвердити<input type="text" name="confirm" autocomplete="off"></label>
  <div class="actions"><button class="btn danger">Видалити назавжди</button></div>
</form>`}`;
  return authLayout({ title: "Налаштування", lead: "", form, user, path: "/settings" });
}

// Max (2026-10-20): any new outside service that sees readers' data (mail, hosting, fonts, analytics, AI) must be added here.
function privacyPage({ user }) {
  return layout({ title: "Приватність", user, path: "/privacy", description: "Що Chytai.org.ua зберігає про читачів, хто це бачить і як усе видалити.", body: `<section class="auth prose"><h1>Приватність</h1>
<p>Chytai.org.ua — некомерційний проєкт про книжки. Ми не продаємо даних, не показуємо реклами і не стежимо за вами. Тут коротко і чесно: що ми зберігаємо, навіщо і як це прибрати.</p>
<h2>Що ми зберігаємо</h2>
<p><strong>Якщо ви просто дивитесь сайт</strong> — нічого про вас. Без акаунта ми не ставимо жодних кукі й не підключаємо лічильників відвідувань.</p>
<p><strong>Якщо ви завели полицю:</strong></p>
<ul>
<li><strong>Пошту.</strong> Тільки щоб надіслати код для входу. Ми не робимо розсилок і нікому її не передаємо. Іншим читачам вашої пошти не видно.</li>
<li><strong>Ім’я та нікнейм</strong>, які ви самі вказали. Нікнейм — це адреса вашої полиці: chytai.org.ua/@нікнейм.</li>
<li><strong>Вашу полицю:</strong> книжки, статуси («Хочу прочитати», «Читаю», «Прочитав»), оцінки, рік прочитання, нотатки, у якому вигляді вона у вас є (папір, e-book), а також на які полиці ви підписані.</li>
<li><strong>Одну кукі для входу</strong> (<code>chytai_web</code>), щоб не просити код щоразу. Вона живе рік або до того, як ви вийдете. У ній лише випадковий ключ, сам ключ у нас не зберігається, тільки його відбиток.</li>
<li><strong>Коли ви заходили востаннє</strong> — дату, без історії переглядів.</li>
</ul>
<p>Код для входу діє 10 хвилин і після використання зникає. Щоб ніхто не засипав чужу пошту кодами, ми годину рахуємо спроби з однієї адреси та IP і потім забуваємо.</p>
<h2>Що бачать інші</h2>
<p><strong>Ваша полиця публічна.</strong> Будь-хто може відкрити chytai.org.ua/@нікнейм і побачити ваше ім’я, книжки, оцінки й нотатки. Ваші оцінки й нотатки також з’являються на сторінках книжок і на сторінці «Що читають інші». Так задумано: Chytai — про те, щоб читачі радили книжки одне одному. Тож пишіть у нотатках лише те, чим готові поділитися.</p>
<p>Пошта не показується нікому.</p>
<h2>Хто ще має доступ</h2>
<p>Ми користуємося кількома сервісами, без яких сайт не працює:</p>
<ul>
<li><strong>Fly.io</strong> — сервери у Франкфурті (Німеччина), там лежить база сайту.</li>
<li><strong>Resend</strong> — надсилає листи з кодом від code@chytai.org.ua. Бачить вашу пошту і сам лист.</li>
<li><strong>Google Fonts</strong> — шрифти сайту. Ваш браузер завантажує їх з серверів Google, тож Google бачить вашу IP-адресу, як і на більшості сайтів.</li>
<li><strong>GitHub</strong> — щоночі робимо зашифровану резервну копію бази і зберігаємо її там 90 днів. Без нашого ключа її не прочитати.</li>
</ul>
<p>Більше ніхто ваших даних не отримує. Ми нічого не продаємо і не передаємо рекламодавцям.</p>
<h2>Як усе видалити</h2>
<p>У <a class="text-link" href="/settings">налаштуваннях</a> є кнопка «Видалити акаунт». Вона одразу стирає вашу пошту, ім’я, полицю, оцінки, нотатки, підписки і виходить з усіх пристроїв. Відновити це вже не можна.</p>
<p>З резервних копій ваші дані зникнуть самі, коли старі копії видаляться (до 90 днів). Якщо хочете швидше — напишіть нам.</p>
<p>Там само в налаштуваннях можна змінити ім’я, нікнейм чи пошту.</p>
<h2>Ваші права</h2>
<p>За Законом України «Про захист персональних даних» ви маєте право знати, які дані про вас є, виправити їх, заборонити їх обробку або вимагати видалення. Більшість цього можна зробити самостійно в налаштуваннях. Решту — листом.</p>
<p>Ми обробляємо ваші дані, бо ви самі завели полицю і погодилися на це, і лише для того, щоб полиця працювала.</p>
<h2>Хто відповідає</h2>
<p>Власник сайту і даних — ФОП Іщенко М. Ф. Пишіть на <a class="text-link" href="mailto:ischenko@gmail.com">ischenko@gmail.com</a> — відповімо.</p>
<p>Якщо ми щось змінимо в цих правилах, оновимо цю сторінку і дату нижче.</p>
<p><em>Оновлено 20 жовтня 2026 року.</em></p>
</section>` });
}

// ---- misc ----

function messagePage({ title, text, user }) {
  return layout({ title, body: pageHead({ title: esc(title), sub: esc(text) }), user });
}

module.exports = {
  layout, homePage, bookPage, editPage, libraryPage, readersPage, publishersPage, publisherPage, searchPage, searchResults, authorPage,
  loginPage, codePage, signupPage, settingsPage, privacyPage, messagePage,
  esc, STATUS, COPY, inline, setTitleLinks, setAuthorLinks, setStats, setReadersWithNote,
};

// HTML for the web platform: plain template strings, no framework. Every page goes through
// layout(); the pieces below render the library, a shelf, a book and Discovery.
const { marked } = require("marked");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
// Static files are cached for an hour; their address carries a hash of the content so a deploy reaches
// browsers at once.
const asset = (name) => `/${name}?v=${crypto.createHash("sha1").update(fs.readFileSync(path.join(__dirname, "public", name))).digest("hex").slice(0, 8)}`;
const ASSETS = { css: asset("style.css"), js: asset("app.js") };

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const attr = esc;
const plural = (n, one, few, many) => (n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many);
const count = (n, one, few, many) => `${n} ${plural(n, one, few, many)}`;
const uk = (n) => String(n).replace(".", ",");

const STATUS = { read: "Прочитав", reading: "Читаю", want: "Хочу прочитати" };
const COPY = { paper: "На папері", ebook: "E-book", seeking: "Шукаю на папері" };
const GENRES = ["художня", "фантастика", "детективи", "трилери", "бізнес", "компанії", "менеджмент", "продукт", "гроші", "розробка", "історія", "війна", "біографії", "наука", "саморозвиток", "суспільство"];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function stars(r) {
  if (r == null) return "";
  const full = Math.floor(r), half = r - full >= 0.4;
  return `<span class="stars" title="${uk(r)}/5"><span class="on">${"★".repeat(full)}${half ? "<i>★</i>" : ""}</span><span class="off">${"★".repeat(Math.max(0, 5 - full - (half ? 1 : 0)))}</span></span><span class="rating-num">${uk(r)}</span>`;
}

function cover(book, size = "") {
  const src = book.cover;
  const hue = [...book.title].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
  if (src) return `<img class="cover ${size}" src="${attr(src)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'cover ph ${size}',style:'--h:${hue}',innerHTML:'<span>${attr(esc(book.title)).replace(/'/g, "&#39;")}</span>'}))">`;
  return `<div class="cover ph ${size}" style="--h:${hue}"><span>${esc(book.title)}</span></div>`;
}

function layout({ title, body, user, path = "/", wide = false, description = "", q = "" }) {
  return `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title ? `${title} · Chytai` : "Chytai")}</title>
${description ? `<meta name="description" content="${attr(description.slice(0, 200))}">` : ""}
<link rel="icon" href="/icon.png">
<link rel="stylesheet" href="${ASSETS.css}">
</head>
<body data-user="${user ? "1" : ""}">
<header class="top">
  <a class="brand" href="/">Chytai</a>
  <nav>
    <a href="/" class="${path === "/" || path.startsWith("/shelf") ? "on" : ""}">Discovery</a>
    ${user ? `<a href="/me" class="${path.startsWith("/me") ? "on" : ""}">Мої книжки</a>` : ""}
  </nav>
  ${path === "/search" || path === "/" ? "" : `<form class="find" action="/search" role="search"><input type="search" name="q" value="${attr(q)}" placeholder="Знайти книжку" autocomplete="off" aria-label="Пошук"></form>`}
  <div class="who">${user ? `<span>${esc(user)}</span> <a href="/logout" class="muted">вийти</a>` : `<span class="muted">гість</span>`}</div>
</header>
<main class="${wide ? "wide" : ""}">
${body}
</main>
<footer class="foot"><span>Chytai.org.ua: читай більше.</span> <a href="https://chytai.fly.dev">Читалка</a></footer>
<script src="${ASSETS.js}"></script>
</body>
</html>`;
}

// ---- library (/me) ----

// The same list twice: /me is the signed-in reader's own library with «Змінити» on every row (the only
// place where status, rating and notes are edited); /reader/<slug> is that reader's public shelf.
function libraryPage({ rows, user, owner, own = false, readerHref = "" }) {
  const read = rows.filter((r) => r.status === "read").length;
  const years = [...new Set(rows.map((r) => r.year).filter(Boolean))].sort((a, b) => b - a);
  const genres = GENRES.filter((g) => rows.some((r) => (r.book.tags || []).includes(g)));
  const chips = [
    ["", "Усі", rows.length],
    ["read", "Прочитав", read],
    ["reading", "Читаю", rows.filter((r) => r.status === "reading").length],
    ["want", "Хочу прочитати", rows.filter((r) => r.status === "want").length],
    ["paper", "На папері", rows.filter((r) => r.copy === "paper").length],
    ["seeking", "Шукаю", rows.filter((r) => r.copy === "seeking").length],
  ];
  const body = `
<section class="head">
  <div>
    ${own ? "" : `<p class="crumbs">Читач</p>`}
    <h1>${own ? "Мої книжки" : esc(owner)}</h1>
    <p class="muted">${count(rows.length, "книжка", "книжки", "книжок")}, ${count(read, "прочитана", "прочитані", "прочитаних")}${own ? ` · <a href="${attr(readerHref)}">як бачать інші</a>` : ""}</p>
  </div>
  ${own ? `<button class="btn primary" data-open="add">+ Додати книжку</button>` : ""}
</section>
<section class="toolbar" id="lib-tools">
  <input type="search" id="q" placeholder="Назва, автор, нотатка" autocomplete="off">
  <div class="chips" data-filter="status">${chips.map(([k, l, n]) => `<button class="chip ${k === "" ? "on" : ""}" data-v="${k}">${l} <b>${n}</b></button>`).join("")}</div>
  <div class="selects">
    <select id="genre"><option value="">Усі жанри</option>${genres.map((g) => `<option value="${g}">${cap(g)}</option>`).join("")}</select>
    <select id="sort"><option value="order">За порядком</option><option value="rating">За оцінкою</option><option value="title">За назвою</option></select>
  </div>
</section>
<section class="rows" id="rows">
${rows.map((r, i) => libraryRow(r, i, own)).join("\n")}
</section>
<p class="empty hidden" id="empty">Нічого не знайшлося.</p>
${own ? addDialog() : ""}`;
  return layout({ title: own ? "Мої книжки" : owner, body, user, path: own ? "/me" : "/reader", description: own ? "" : `Книжки, які читає ${owner}: оцінки й нотатки.` });
}

function libraryRow(r, i, own = false) {
  const b = r.book;
  const prev = r._prevYear;
  const search = [b.title, b.altTitle, b.author, stripMd(r.note || "")].join(" ").toLowerCase();
  const yearHead = r.year && prev !== r.year ? `<h2 class="year" data-year="${r.year}">${r.year}</h2>` : !r.year && prev !== null && i > 0 && prev !== undefined ? `<h2 class="year" data-year="">Без дати</h2>` : "";
  return `${yearHead}<article class="row" id="${attr(r.id)}" data-status="${r.status || ""}" data-copy="${r.copy || ""}" data-tags="${attr((b.tags || []).join(" "))}" data-rating="${r.rating ?? ""}" data-year="${r.year ?? ""}" data-title="${attr(b.title.toLowerCase())}" data-search="${attr(search)}" data-order="${i}">
  <a class="cover-link" href="${attr(b.href)}">${cover(b)}</a>
  <div class="row-body">
    <h3><a href="${attr(b.href)}">${esc(b.title)}</a>${b.series ? `<span class="badge">серія · ${count(b.series, "книжка", "книжки", "книжок")}</span>` : ""}</h3>
    <p class="by">${b.author ? esc(byline(b.author)) : ""}${b.altTitle ? `<span class="alt">${esc(b.altTitle)}</span>` : ""}</p>
    <p class="meta">${r.rating != null ? stars(r.rating) : ""}${r.status && r.status !== "read" ? `<span class="tag status-${r.status}">${STATUS[r.status]}</span>` : ""}${r.copy ? `<span class="tag copy-${r.copy}">${COPY[r.copy]}</span>` : ""}</p>
    ${r.note ? `<p class="note">${inline(titleLinks(r.note, r.id))}</p>` : ""}
  </div>
  ${own ? `<a class="btn small edit" href="${attr(b.href ? `/me${b.href}` : `/me/book/${encodeURIComponent(r.id)}`)}">Змінити</a>` : ""}
</article>`;
}

function stripMd(s) {
  return s.replace(/\*\*/g, "").replace(/\[(.+?)\]\((.+?)\)/g, "$1");
}
// Set by the server: (markdown, own book id) -> markdown with mentioned titles linked (store.linkTitles).
let titleLinks = (md) => md;
const setTitleLinks = (fn) => (titleLinks = fn);

function inline(md) {
  const first = md.split(/\n\s*\n/)[0];
  return marked.parseInline(first).replace(/<a href="http/g, '<a target="_blank" rel="noopener" href="http');
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

// ---- book (/book/:id) ----

// The book itself (description, editions, series), then the readers who have it. Nothing here edits a
// rating or a note: the signed-in reader sees where the book is in their library and a link to «Змінити».
function bookPage({ book, entry, user, shelf, inLibrary = new Map(), readers = [] }) {
  const edUrls = new Set((book.editions || []).map((e) => e.links[0].url));
  const links = (book.links || []).filter((l) => !edUrls.has(l.url));
  const body = `
<article class="book">
  <div class="book-cover">${cover(book, "big")}</div>
  <div class="book-main">
    ${shelf ? `<p class="crumbs"><a href="/shelf/${attr(shelf.id)}">${esc(shelf.name)}</a></p>` : ""}
    <h1>${esc(book.title)}</h1>
    ${book.altTitle ? `<p class="alt-title">${esc(book.altTitle)}</p>` : ""}
    ${book.author ? `<p class="by">${esc(book.author)}</p>` : ""}
    ${(book.tags || []).length ? `<p class="meta">${book.tags.map((t) => `<span class="tag genre">${esc(t)}</span>`).join("")}</p>` : ""}
    ${user ? mine(book, entry) : ""}
    ${book.blurb ? `<div class="prose blurb"><p>${esc(book.blurb)}</p><p class="muted small">Опис з сайту ${esc(shelf ? shelf.name : book.source)}</p></div>` : ""}
    ${(book.translations || []).length ? `<p class="translations muted">${book.translations.map((t) => `${/[а-яіїєґ]/i.test(book.title) && !/[а-яіїєґ]/i.test(t.title) ? "Оригінал" : "Переклад"}: <a href="${attr(t.href)}">${esc(t.title)}</a>`).join(" · ")}</p>` : ""}
    ${book.ukTitle ? `<p class="translations muted">Українською: «${esc(book.ukTitle)}», у каталогах поки немає</p>` : ""}
    ${editions(book)}
    ${series(book, inLibrary)}
    ${links.length ? `<p class="links">${links.map((l) => `<a href="${attr(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`).join('<span class="sep">·</span>')}</p>` : ""}
    ${readersBlock(readers, book.id)}
    <section class="libs hidden" data-src="/api/libraries/${attr(encodeURIComponent(book.id))}"><h2 class="sec">У бібліотеках</h2><div class="libs-list"></div></section>
  </div>
</article>`;
  const description = [book.author, book.blurb || stripMd(readers.find((r) => r.entry.note)?.entry.note || "")].filter(Boolean).join(". ");
  return layout({ title: book.title, body, user, path: "/book", description });
}

// An anthology's long list of authors on a card: the first two and how many more.
function byline(author) {
  const names = String(author || "").split(/,\s*/).filter(Boolean);
  return names.length > 3 ? `${names.slice(0, 2).join(", ")} та ще ${names.length - 2}` : String(author || "");
}

// The signed-in reader's own line: where the book is in their library, or one tap to want it.
function mine(book, entry) {
  // Read in another language: the mark comes from that book, and so does the edit link.
  const href = entry?.via ? entry.via.href : book.href;
  const edit = href ? `/me${href}` : `/me/book/${encodeURIComponent(entry?.via ? entry.via.id : book.id)}`;
  if (!entry) return `<div class="mine"><form method="post" action="/api/entry/${encodeURIComponent(book.id)}" class="inline"><input type="hidden" name="status" value="want"><input type="hidden" name="back" value="1"><button class="btn small">Хочу прочитати</button></form><a class="muted small" href="${edit}">Додати до моїх книжок…</a></div>`;
  const what = [entry.status ? STATUS[entry.status] + (entry.status === "read" && entry.year ? ` ${entry.year}` : "") : "У моїх книжках", entry.rating != null ? `${uk(entry.rating)}/5` : "", entry.copy ? COPY[entry.copy] : ""].filter(Boolean).join(" · ");
  return `<div class="mine"><span class="have">✓ ${esc(what)}</span>${entry.via ? `<span class="muted small">як <a href="${attr(entry.via.href)}">${esc(entry.via.title)}</a></span>` : ""}<a class="muted small" href="${edit}">Змінити</a></div>`;
}

// Readers who have the book, each with their status, rating and note, linked to their shelf.
function readersBlock(readers, bookId) {
  if (!readers.length) return "";
  return `<section class="readers"><h2 class="sec">У читачів</h2>${readers
    .map(({ name, href, entry: e }) => {
      const what = [e.status ? STATUS[e.status].toLowerCase() + (e.status === "read" && e.year ? ` у ${e.year}` : "") : "", e.copy ? COPY[e.copy].toLowerCase() : "", e.via ? `як «${e.via.title}»` : ""].filter(Boolean).join(" · ");
      return `<div class="reader"><p><a href="${attr(href)}"><b>${esc(name)}</b></a>${e.rating != null ? ` ${stars(e.rating)}` : ""}${what ? ` <span class="muted small">${esc(what)}</span>` : ""}</p>${e.note ? `<div class="prose">${marked.parse(titleLinks(e.note, e.via ? e.via.id : bookId)).replace(/<a href="http/g, '<a target="_blank" rel="noopener" href="http')}</div>` : ""}</div>`;
    })
    .join("")}</section>`;
}

// /me/book/:id: the one place to edit a book in your library.
function editPage({ book, entry, user }) {
  const body = `
<article class="book">
  <div class="book-cover">${cover(book, "big")}</div>
  <div class="book-main">
    <p class="crumbs"><a href="/me">Мої книжки</a></p>
    <h1><a href="${attr(book.href)}">${esc(book.title)}</a></h1>
    ${book.author ? `<p class="by">${esc(book.author)}</p>` : ""}
    ${entryForm(book, entry)}
  </div>
</article>`;
  return layout({ title: book.title, body, user, path: "/me" });
}

// Every edition of the book on the shelves links back to where it came from: the publisher's page,
// with the edition, price and availability. One edition gets a button; several get a short list.
// The best edition gets the button; the others are quiet rows under it, one per shop page.
function editions(book) {
  const seen = new Set();
  // In stock first, then the publisher's own over a shop reselling it (Старий Лев sells partners' books).
  const rank = (e) => (e.status === "є" ? 0 : e.status === "передзамовлення" ? 1 : 2) * 4 + (e.edition ? 2 : 0) + (e.format === "e-book" ? 1 : 0);
  const eds = (book.editions || []).filter((e) => !seen.has(e.links[0].url) && seen.add(e.links[0].url)).sort((a, b) => rank(a) - rank(b));
  if (!eds.length) return "";
  if (eds.length === 1) return buyButton(eds[0].shelf, eds[0]);
  const row = (e) => {
    const tail = [e.format, e.edition, e.price, e.status && e.status !== "є" ? e.status : ""].filter(Boolean).join(" · ");
    return `<li><a href="${attr(e.links[0].url)}" target="_blank" rel="noopener">${esc(e.shelf.name)} ↗</a> <span class="muted">${esc(tail)}</span></li>`;
  };
  const rest = eds.slice(1);
  const have = rest.filter((e) => e.status === "є" || e.status === "передзамовлення");
  const not = rest.filter((e) => !have.includes(e));
  const list = (title, items) => (items.length ? `<p class="muted small">${title}</p><ul>${items.map(row).join("")}</ul>` : "");
  return `${buyButton(eds[0].shelf, eds[0], false, true)}<div class="editions">${list("Також в наявності", have)}${list(have.length ? "Немає в наявності" : "Інші видання", not)}</div>`;
}

// The volumes of the series this book belongs to, each with its own page and buy link.
function series(book, inLibrary) {
  const ser = book.series;
  if (!ser) return "";
  const label = (v) => (v.bundle ? `Комплект із ${count(ser.volumes, "тому", "томів", "томів")}` : cap(v.title.replace(ser.name, "").replace(/^[\s,.:]+/, "")) || `Том ${v.volume}`);
  return `<div class="series"><p class="muted small">Серія «${esc(ser.name)}», ${count(ser.volumes, "том", "томи", "томів")}</p><ul>${ser.items
    .map((v) => {
      const has = inLibrary.get(v.work);
      const tail = [v.price, v.status && v.status !== "є" ? v.status : ""].filter(Boolean).join(" · ");
      return `<li class="${v.work === book.id ? "this" : ""}"><a href="${attr(v.href)}">${esc(label(v))}</a>${has?.status ? ` <span class="tag status-${has.status}">${STATUS[has.status]}</span>` : ""}<span class="muted small">${esc(tail)}</span><a class="btn small" href="${attr(v.links[0].url)}" target="_blank" rel="noopener">${v.status === "передзамовлення" ? "Замовити" : v.status === "немає" ? "Подивитися" : "Купити"} ↗</a></li>`;
    })
    .join("")}</ul></div>`;
}

function buyButton(shelf, book, compact = false, withFormat = false) {
  const host = shelf.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
  const verb = book.price === "безкоштовно" ? "Завантажити" : book.status === "передзамовлення" ? "Замовити" : book.status === "немає" ? "Подивитися" : "Купити";
  const tail = [compact || withFormat ? [book.format, book.edition].filter(Boolean).join(", ") : "", book.price, book.status && book.status !== "є" ? book.status : "", compact ? host : ""].filter(Boolean).join(" · ");
  return `<p class="buy"><a class="btn primary${compact ? " small" : ""}" href="${attr(book.links[0].url)}" target="_blank" rel="noopener">${verb}${compact ? "" : ` на ${esc(host)}`} ↗</a>${tail ? `<span class="muted">${esc(tail)}</span>` : ""}</p>`;
}

function entryForm(book, entry) {
  const e = entry || { status: "", rating: null, year: "", copy: "", note: "" };
  const ratings = [5, 4.5, 4, 3.5, 3, 2.5, 2, 1.5, 1];
  return `
<form method="post" action="/api/entry/${encodeURIComponent(book.id)}" class="form entry-form">
  <input type="hidden" name="next" value="/me#${attr(book.id)}">
  <h2>${entry ? "У моїх книжках" : "Додати до моїх книжок"}</h2>
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
  <label>Нотатка <textarea name="note" rows="5" placeholder="Кілька слів про книжку, як у Books.md">${esc(e.note || "")}</textarea></label>
  <div class="actions">
    ${entry ? `<button type="submit" class="btn danger" formaction="/api/entry/${encodeURIComponent(book.id)}/remove" formnovalidate>Прибрати з бібліотеки</button>` : ""}
    <span class="grow"></span>
    <button class="btn primary">Зберегти</button>
  </div>
</form>`;
}

// ---- discovery (/) ----

function discoveryPage({ shelves, subscriptions, user, owner, readerHref, libraryCount, inLibrary, fetched, ownerStrip = [], libraries = [], visible = (s) => s.items }) {
  const subs = user ? shelves.filter((s) => subscriptions.includes(s.id)) : [];
  const fresh = subs.flatMap((s) => visible(s).filter((it) => it.isNew).map((it) => ({ ...it, shelfName: s.name, shelfId: s.id })));
  const body = `
${searchBox("", false)}
<div id="live"></div>
<div id="browse">
<section class="head">
  <div>
    <h1>Discovery</h1>
    <p class="muted">Публічні полиці видавництв і читачів. Підпишися, і новинки з'являтимуться тут.</p>
  </div>
</section>
${subs.length ? `
<section>
  <h2 class="sec">Нове з підписок <span class="muted small">${subs.map((s) => esc(s.name)).join(", ")}</span></h2>
  ${fresh.length ? `<div class="grid">${fresh.slice(0, 24).map((it) => itemCard(it, inLibrary, user, it.shelfName)).join("")}</div>` : `<p class="muted">Поки нічого нового.</p>`}
</section>` : ""}
<section>
  <h2 class="sec">Видавництва</h2>
  <div class="shelves">
    ${shelves.map((s) => shelfCard({ ...s, items: visible(s) }, subscriptions.includes(s.id), user)).join("")}
  </div>
  <p class="muted small">Каталоги оновлено ${esc(fetched)}.</p>
</section>
<section>
  <h2 class="sec">Читачі</h2>
  <div class="shelves">
    <a class="shelf-card" href="${attr(readerHref)}">
      <span class="strip">${ownerStrip.map((b) => cover(b, "mini")).join("")}</span>
      <div class="shelf-kind">читач</div>
      <h3>${esc(owner)}</h3>
      <p class="muted">Прочитане з оцінками й нотатками</p>
      <p class="shelf-n">${count(libraryCount, "книжка", "книжки", "книжок")}</p>
    </a>
  </div>
</section>
${libraries.length ? `
<section>
  <h2 class="sec">Бібліотеки</h2>
  <div class="shelves">
    ${libraries.map((l) => `<a class="shelf-card" href="${attr(l.base)}" target="_blank" rel="noopener">
      <div class="shelf-kind">бібліотека · ${esc(l.city)}</div>
      <h3>${esc(l.name)} ↗</h3>
      <p class="muted">На сторінці книжки видно, в якій філії вона є на полиці</p>
    </a>`).join("")}
  </div>
</section>` : ""}
</div>`;
  return layout({ title: "", body, user, path: "/" });
}

const KIND = { publisher: "видавництво", free: "вільна бібліотека", reader: "читач" };

function shelfCard(s, on, user) {
  const fresh = s.items.filter((it) => it.isNew).length;
  const strip = s.items.filter((it) => it.cover).slice(0, 5);
  return `<div class="shelf-card">
  <a class="strip" href="/shelf/${attr(s.id)}">${strip.map((it) => cover(it, "mini")).join("")}</a>
  <div class="shelf-kind">${KIND[s.kind] || s.kind}</div>
  <h3><a href="/shelf/${attr(s.id)}">${esc(s.name)}</a></h3>
  <p class="muted">${esc(s.tagline)}</p>
  <p class="shelf-n">${count(s.items.length, "книжка", "книжки", "книжок")}${fresh ? ` · ${fresh} нов${plural(fresh, "а", "і", "их")}` : ""}</p>
  ${user ? subscribeButton(s.id, on) : ""}
</div>`;
}

function subscribeButton(id, on) {
  return `<form method="post" action="/api/subscribe/${attr(id)}" class="inline"><button class="btn sub ${on ? "on" : ""}">${on ? "✓ Підписано" : "Підписатися"}</button></form>`;
}

// ---- shelf (/shelf/:id) ----

function shelfPage({ shelf, subscribed, user, inLibrary, visible = (s) => s.items }) {
  shelf = { ...shelf, items: visible(shelf) };
  const genres = [...shelf.items.flatMap((it) => it.genres || []).reduce((m, g) => m.set(g, (m.get(g) || 0) + 1), new Map())].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const statuses = [...new Set(shelf.items.map((it) => it.status))];
  const body = `
<section class="head">
  <div>
    <p class="crumbs"><a href="/">Discovery</a></p>
    <h1>${esc(shelf.name)}</h1>
    <p class="muted">${esc(shelf.tagline)} · <a href="${attr(shelf.url)}" target="_blank" rel="noopener">${esc(shelf.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""))}</a></p>
  </div>
  ${user ? subscribeButton(shelf.id, subscribed) : ""}
</section>
<section class="toolbar">
  <input type="search" id="q" placeholder="Назва або автор" autocomplete="off">
  <div class="chips" data-filter="genre"><button class="chip on" data-v="">Усі <b>${shelf.items.length}</b></button>${genres.map(([g, n]) => `<button class="chip" data-v="${attr(g)}">${esc(g)} <b>${n}</b></button>`).join("")}</div>
  ${statuses.length > 1 ? `<div class="chips" data-filter="avail"><button class="chip on" data-v="">Будь-які</button>${statuses.map((s) => `<button class="chip" data-v="${attr(s)}">${esc(cap(s))}</button>`).join("")}</div>` : ""}
</section>
<section class="grid" id="rows">
${shelf.items.map((it) => itemCard(it, inLibrary, user)).join("\n")}
</section>
<p class="empty hidden" id="empty">Нічого не знайшлося.</p>`;
  return layout({ title: shelf.name, body, user, path: "/shelf", wide: true });
}

function itemCard(it, inLibrary, user, shelfName) {
  const has = inLibrary.get(it.id);
  const search = [it.title, it.author, it.altTitle].join(" ").toLowerCase();
  return `<article class="card" data-genre="${attr((it.genres || []).join("|"))}" data-avail="${attr(it.status || "")}" data-search="${attr(search)}">
  <a class="cover-link" href="${attr(it.href)}">${cover(it, "card")}</a>
  <h3><a href="${attr(it.href)}">${esc(it.title)}</a></h3>
  <p class="by">${esc(byline(it.author))}</p>
  <p class="meta small">${shelfName ? `<span class="muted">${esc(shelfName)} · </span>` : ""}${esc(it.price || "")}${it.status && it.status !== "є" ? ` · ${esc(it.status)}` : ""}${it.volumes > 1 ? ` · ${count(it.volumes, "том", "томи", "томів")}` : it.editions > 1 ? ` · ${count(it.editions, "видання", "видання", "видань")}` : ""}${it.isNew && !shelfName ? ` <span class="tag new">нове</span>` : ""}</p>
  ${has ? `<p class="small have">${has.status ? STATUS[has.status] : "У бібліотеці"}</p>` : user ? `<form method="post" action="/api/entry/${encodeURIComponent(it.id)}" class="inline"><input type="hidden" name="status" value="want"><input type="hidden" name="back" value="1"><button class="btn small">Хочу прочитати</button></form>` : ""}
</article>`;
}

// ---- search (/search) ----

function searchPage({ q, hits, user, inLibrary, owner, readerHref }) {
  const body = `
<section class="head">
  <div>
    <h1>Пошук</h1>
    <p class="muted">По каталогах видавництв і полицях читачів.</p>
  </div>
</section>
${searchBox(q, true)}
<div id="live">${searchResults({ q, hits, inLibrary, user, owner, readerHref })}</div>`;
  return layout({ title: q ? `${q} · Пошук` : "Пошук", body, user, path: "/search", q });
}

// The search box; typing renders results into #live without reloading (app.js asks /api/search).
function searchBox(q, autofocus) {
  return `<form class="search-box" action="/search" role="search" data-live="/api/search"><input type="search" name="q" value="${attr(q)}" placeholder="Назва, автор або серія" aria-label="Пошук" autocomplete="off"${autofocus ? " autofocus" : ""}></form>`;
}

function searchResults({ q, hits, inLibrary, user, owner, readerHref }) {
  if (!q.trim()) return "";
  return hits.length ? `<section class="rows" id="hits">${hits.map((h) => searchRow(h, inLibrary, user, owner, readerHref)).join("\n")}</section>` : `<p class="empty">Нічого не знайшлося за «${esc(q)}».</p>`;
}

// Where the book is: the shelves that sell it (format, price, availability) and whose library has it.
function searchRow({ book, entry }, inLibrary, user, owner, readerHref) {
  const where = (book.editions || []).map((e) => `<li><a href="${attr(e.links[0].url)}" target="_blank" rel="noopener">${esc(e.shelf.name)}</a> · ${esc(e.format)}${e.edition ? ` · ${esc(e.edition)}` : ""}${e.price ? ` · ${esc(e.price)}` : ""}${e.status && e.status !== "є" ? ` · ${esc(e.status)}` : e.status ? " · є" : ""}</li>`);
  const edUrls = new Set((book.editions || []).map((e) => e.links[0].url));
  for (const l of (book.links || []).filter((l) => !edUrls.has(l.url))) where.push(`<li><a href="${attr(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>${/amazon/i.test(l.url) ? " · Kindle" : ""}</li>`);
  if (entry) where.push(`<li><a href="${attr(readerHref)}#${attr(book.id)}">${esc(owner)}</a> · ${entry.status ? STATUS[entry.status].toLowerCase() : "у бібліотеці"}${entry.rating != null ? ` · ${uk(entry.rating)}/5` : ""}${entry.copy ? ` · ${COPY[entry.copy].toLowerCase()}` : ""}</li>`);
  return `<article class="row hit">
  <a class="cover-link" href="${attr(book.href)}">${cover(book)}</a>
  <div class="row-main">
    <h3><a href="${attr(book.href)}">${esc(book.title)}</a>${book.series ? ` <span class="badge">серія · ${count(book.series.volumes, "том", "томи", "томів")}</span>` : ""}</h3>
    ${book.altTitle ? `<p class="alt-title small">${esc(book.altTitle)}</p>` : ""}
    <p class="by">${esc(byline(book.author))}</p>
    ${where.length ? `<ul class="where small">${where.join("")}</ul>` : `<p class="muted small">Ніде поки немає.</p>`}
    ${user && !entry ? `<form method="post" action="/api/entry/${encodeURIComponent(book.id)}" class="inline"><input type="hidden" name="status" value="want"><input type="hidden" name="back" value="1"><button class="btn small">Хочу прочитати</button></form>` : ""}
  </div>
</article>`;
}

// ---- login / misc ----

function messagePage({ title, text, user }) {
  return layout({ title, body: `<section class="head"><div><h1>${esc(title)}</h1><p class="muted">${esc(text)}</p></div></section>`, user });
}

module.exports = {
  searchPage, searchResults, layout, libraryPage, bookPage, editPage, discoveryPage, shelfPage, messagePage, esc, STATUS, COPY, setTitleLinks };

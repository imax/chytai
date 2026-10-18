// HTML for the web platform: plain template strings, no framework. Every page goes through
// layout(); the pieces below render the library, a shelf, a book and Discovery.
const { marked } = require("marked");

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

function layout({ title, body, user, path = "/", wide = false }) {
  return `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title ? `${title} · Chytai` : "Chytai")}</title>
<link rel="icon" href="/icon.png">
<link rel="stylesheet" href="/style.css">
</head>
<body data-user="${user ? "1" : ""}">
<header class="top">
  <a class="brand" href="/">Chytai</a>
  <nav>
    <a href="/" class="${path === "/" || path.startsWith("/shelf") ? "on" : ""}">Discovery</a>
    <a href="/me" class="${path.startsWith("/me") || path.startsWith("/book") ? "on" : ""}">Мої книжки</a>
    ${user ? `<a href="/recommend" class="${path.startsWith("/recommend") ? "on" : ""}">Що почитати</a>` : ""}
  </nav>
  <div class="who">${user ? `<span>${esc(user)}</span> <a href="/logout" class="muted">вийти</a>` : `<span class="muted">гість</span>`}</div>
</header>
<main class="${wide ? "wide" : ""}">
${body}
</main>
<footer class="foot"><span>Chytai: читай більше.</span> <a href="https://chytai.fly.dev">Читалка</a></footer>
<script src="/app.js"></script>
</body>
</html>`;
}

// ---- library (/me) ----

function libraryPage({ rows, user, owner, subscriptions }) {
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
    <h1>${esc(owner)}</h1>
    <p class="muted">${count(rows.length, "книжка", "книжки", "книжок")} у бібліотеці, ${count(read, "прочитана", "прочитані", "прочитаних")}${years.length ? `, з ${years[years.length - 1]} року` : ""}</p>
  </div>
  ${user ? `<button class="btn primary" data-open="add">+ Додати книжку</button>` : ""}
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
${rows.map((r, i) => libraryRow(r, i)).join("\n")}
</section>
<p class="empty hidden" id="empty">Нічого не знайшлося.</p>
${user ? addDialog() : ""}`;
  return layout({ title: "Мої книжки", body, user, path: "/me" });
}

function libraryRow(r, i) {
  const b = r.book;
  const prev = r._prevYear;
  const search = [b.title, b.altTitle, b.author, stripMd(r.note || "")].join(" ").toLowerCase();
  const yearHead = r.year && prev !== r.year ? `<h2 class="year" data-year="${r.year}">${r.year}</h2>` : !r.year && prev !== null && i > 0 && prev !== undefined ? `<h2 class="year" data-year="">Без дати</h2>` : "";
  return `${yearHead}<article class="row" data-status="${r.status || ""}" data-copy="${r.copy || ""}" data-tags="${attr((b.tags || []).join(" "))}" data-rating="${r.rating ?? ""}" data-year="${r.year ?? ""}" data-title="${attr(b.title.toLowerCase())}" data-search="${attr(search)}" data-order="${i}">
  <a class="cover-link" href="/book/${encodeURIComponent(b.id)}">${cover(b)}</a>
  <div class="row-body">
    <h3><a href="/book/${encodeURIComponent(b.id)}">${esc(b.title)}</a>${b.series ? `<span class="badge">серія · ${count(b.series, "книжка", "книжки", "книжок")}</span>` : ""}</h3>
    <p class="by">${b.author ? esc(b.author) : ""}${b.altTitle ? `<span class="alt">${esc(b.altTitle)}</span>` : ""}</p>
    <p class="meta">${r.rating != null ? stars(r.rating) : ""}${r.status && r.status !== "read" ? `<span class="tag status-${r.status}">${STATUS[r.status]}</span>` : ""}${r.copy ? `<span class="tag copy-${r.copy}">${COPY[r.copy]}</span>` : ""}</p>
    ${r.note ? `<p class="note">${inline(r.note)}</p>` : ""}
  </div>
</article>`;
}

function stripMd(s) {
  return s.replace(/\*\*/g, "").replace(/\[(.+?)\]\((.+?)\)/g, "$1");
}
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

function bookPage({ book, entry, user, shelf }) {
  const links = book.links || [];
  const body = `
<article class="book">
  <div class="book-cover">${cover(book, "big")}</div>
  <div class="book-main">
    <p class="crumbs"><a href="/me">Мої книжки</a>${shelf ? ` · <a href="/shelf/${attr(shelf.id)}">${esc(shelf.name)}</a>` : ""}</p>
    <h1>${esc(book.title)}</h1>
    ${book.altTitle ? `<p class="alt-title">${esc(book.altTitle)}</p>` : ""}
    ${book.author ? `<p class="by">${esc(book.author)}</p>` : ""}
    <p class="meta">
      ${entry?.rating != null ? stars(entry.rating) : ""}
      ${entry?.status ? `<span class="tag status-${entry.status}">${STATUS[entry.status]}${entry.status === "read" && entry.year ? ` · ${entry.year}` : ""}</span>` : ""}
      ${entry?.copy ? `<span class="tag copy-${entry.copy}">${COPY[entry.copy]}</span>` : ""}
      ${(book.tags || []).map((t) => `<span class="tag genre">${esc(t)}</span>`).join("")}
    </p>
    ${entry?.note ? `<div class="prose">${marked.parse(entry.note).replace(/<a href="http/g, '<a target="_blank" rel="noopener" href="http')}</div>` : ""}
    ${!entry?.note && book.blurb ? `<div class="prose blurb"><p>${esc(book.blurb)}</p><p class="muted small">Опис з сайту ${esc(shelf ? shelf.name : book.source)}</p></div>` : ""}
    ${book.price ? `<p class="price">${esc(book.price)}${book.status && book.status !== "є" ? ` · ${esc(book.status)}` : ""}</p>` : ""}
    ${links.length ? `<p class="links">${links.map((l) => `<a href="${attr(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`).join('<span class="sep">·</span>')}</p>` : ""}
    ${user ? entryForm(book, entry) : !entry ? "" : ""}
  </div>
</article>`;
  return layout({ title: book.title, body, user, path: "/book" });
}

function entryForm(book, entry) {
  const e = entry || { status: "", rating: null, year: "", copy: "", note: "" };
  const ratings = [5, 4.5, 4, 3.5, 3, 2.5, 2, 1.5, 1];
  return `
<form method="post" action="/api/entry/${encodeURIComponent(book.id)}" class="form entry-form">
  <h2>${entry ? "У моїй бібліотеці" : "Додати до моїх книжок"}</h2>
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

function discoveryPage({ shelves, subscriptions, user, owner, libraryCount, inLibrary, fetched, ownerStrip = [] }) {
  const subs = shelves.filter((s) => subscriptions.includes(s.id));
  const fresh = subs.flatMap((s) => s.items.filter((it) => it.isNew).map((it) => ({ ...it, shelfName: s.name, shelfId: s.id })));
  const body = `
<section class="head">
  <div>
    <h1>Discovery</h1>
    <p class="muted">Публічні полиці видавництв, читачів і вільних бібліотек. Підпишися, і новинки з'являтимуться тут.</p>
  </div>
</section>
${subs.length ? `
<section>
  <h2 class="sec">Нове з підписок <span class="muted small">${subs.map((s) => esc(s.name)).join(", ")}</span></h2>
  ${fresh.length ? `<div class="grid">${fresh.slice(0, 24).map((it) => itemCard(it, inLibrary, user, it.shelfName)).join("")}</div>` : `<p class="muted">Поки нічого нового.</p>`}
</section>` : ""}
<section>
  <h2 class="sec">Полиці</h2>
  <div class="shelves">
    <a class="shelf-card" href="/me">
      <span class="strip">${ownerStrip.map((b) => cover(b, "mini")).join("")}</span>
      <div class="shelf-kind">читач</div>
      <h3>${esc(owner)}</h3>
      <p class="muted">Прочитане з оцінками й нотатками, паперова полиця в офісі</p>
      <p class="shelf-n">${count(libraryCount, "книжка", "книжки", "книжок")}</p>
    </a>
    ${shelves.map((s) => shelfCard(s, subscriptions.includes(s.id), user)).join("")}
  </div>
  <p class="muted small">Каталоги оновлено ${esc(fetched)}.</p>
</section>`;
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

function shelfPage({ shelf, subscribed, user, inLibrary }) {
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
  <a class="cover-link" href="/book/${encodeURIComponent(it.id)}">${cover(it, "card")}</a>
  <h3><a href="/book/${encodeURIComponent(it.id)}">${esc(it.title)}</a></h3>
  <p class="by">${esc(it.author || "")}</p>
  <p class="meta small">${shelfName ? `<span class="muted">${esc(shelfName)} · </span>` : ""}${esc(it.price || "")}${it.status && it.status !== "є" ? ` · ${esc(it.status)}` : ""}${it.isNew && !shelfName ? ` <span class="tag new">нове</span>` : ""}</p>
  ${has ? `<p class="small have">${has.status ? STATUS[has.status] : "У бібліотеці"}</p>` : user ? `<form method="post" action="/api/entry/${encodeURIComponent(it.id)}" class="inline"><input type="hidden" name="status" value="want"><input type="hidden" name="back" value="1"><button class="btn small">Хочу прочитати</button></form>` : ""}
</article>`;
}

// ---- login / misc ----

function messagePage({ title, text, user }) {
  return layout({ title, body: `<section class="head"><div><h1>${esc(title)}</h1><p class="muted">${esc(text)}</p></div></section>`, user });
}

module.exports = { layout, libraryPage, bookPage, discoveryPage, shelfPage, messagePage, esc, STATUS, COPY };

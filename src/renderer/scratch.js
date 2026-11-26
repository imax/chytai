// «Нотатки» (Max 2026-11-25, variant A «Теми» of canvas 66Ec9Ssa7vR6q7qjgKfMUm; began 2026-11-23 as «Scratchpad»): a
// research folder for reading, kept on the server so phone and computer see the same. Three views in one panel page
// (home.js page «scratch»):
// - the list: a field for a topic, an author, a book or a thought (words, voice or a photo), a search over topics,
//   notes and explanations, then «Теми», «Думки без теми» (what Opus could not place) and «З книжок» (every book with
//   notes or explanations);
// - a topic: what it is (Opus), «Мої думки» (each new thought asks Opus again; its `reply` says where to dig next),
//   «Книжки»: the reader's own books in it (Opus picks them from the library the page sends; «Додати свою» and the
//   book page's topic chips by hand) and Opus's books added with «Додати в тему» (`wanted`, only the topic: Max
//   2026-11-25, reading and «Хочу прочитати» have their own pages), then «Можуть підійти» (the rest);
// - a book: its notes and explanations (the same as the book's own «Нотатки»), «Перейти» opens the book there, and
//   the topics it is in.
// server/scratch.js reads entries with Opus. Taps count by data-act (reading-time.js): act-scr-*.
/* global showNotice */
(() => {
  const $ = (s) => document.querySelector(s);
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ESC[c]);
  const norm = (s) => String(s || "").toLowerCase().replace(/[«»"'’ʼ.,:;!?()—–-]/g, " ").replace(/\s+/g, " ").trim();
  const plural = (n, one, few, many) => {
    const t = n % 100;
    const u = n % 10;
    return t > 10 && t < 20 ? many : u === 1 ? one : u >= 2 && u <= 4 ? few : many;
  };
  const KIND = { topic: "Тема", era: "Епоха", author: "Автор", book: "Книжка", unclear: "" };
  const LANG = { en: "англійською", uk: "українською", fr: "французькою", de: "німецькою", pl: "польською", es: "іспанською", it: "італійською" };
  const MIC = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>`;
  const CAM = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>`;
  const LENS = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>`;
  const SPIN = `<span class="spinner"></span>`;
  const FIELDS = ["scr-text", "scr-think", "scr-q", "scr-pick"];

  let items = null; // null until the server answers; the last list stays while asked again
  let byBook = {}; // book → { notes, chats, at, quote, comment, own }
  let open = null; // the topic shown, by id
  let book = null; // the book shown, by path; `from` = the topic it was opened from
  let from = null;
  let bookData = null; // { path, notes, chats } of the book shown
  let tab = "notes";
  let allBooks = false; // «З книжок» unfolded
  let more = false; // a topic's «Про тему» unfolded
  let suggesting = null; // the topic whose «Порадити ще» is being answered
  let showOlder = false; // «Раніше радили» unfolded
  let picking = ""; // "book" (own books into a topic) | "topic" (a book into topics)
  let pickQ = "";
  let draft = "";
  let thought = "";
  let voice = false; // the draft was dictated
  let thoughtVoice = false;
  let photo = null; // { blob, url } waiting in the form
  let sending = false;
  let q = ""; // the search
  let found = { q: "", hits: [] };
  let poll = null;
  let failed = false;
  let sure = null; // «Видалити тему» pressed once

  const shown = () => document.querySelector("#shell")?.dataset.page === "scratch";
  const typing = () => FIELDS.includes(document.activeElement?.id);
  // Not while a field has the finger: the page drawn anew would take the field away (the next poll draws it).
  const rerender = () => shown() && !typing() && window.Shell.rerender();
  const redraw = () => shown() && window.Shell.rerender();
  const byId = (id) => (items || []).find((x) => x.id === id);
  const lib = () => window.Shell.books?.() || [];
  const libBook = (p) => lib().find((b) => b.path === p);
  const author = (b) => (b.authors || [b.author])[0] || "";
  // The last time the reader did something in a topic (`touched`: a thought, a book in or out, «Порадити ще»; older
  // entries: their thoughts), the newest on top (Max 2026-11-26).
  const updated = (x) => Math.max(x.touched || 0, x.at || 0, ...(x.thoughts || []).map((t) => t.at || 0), ...Object.values(x.added || {}).map(Number).filter(Boolean), ...(x.ai?.books || []).map((b) => b.wanted || 0));
  const topics = () => (items || []).filter((x) => !(x.status === "ok" && x.ai?.kind === "unclear") && x.status !== "fail").sort((a, b) => updated(b) - updated(a));
  const loose = () => (items || []).filter((x) => (x.status === "ok" && x.ai?.kind === "unclear") || x.status === "fail");

  async function load() {
    try {
      const r = await window.reader.scratchList();
      items = r.items || [];
      byBook = r.books || {};
      failed = false;
    } catch {
      failed = !items;
    }
    rerender();
    watch();
  }
  // Asked again every 3 s while an answer is being made and the page is on screen.
  function watch() {
    clearTimeout(poll);
    if ((items || []).some((x) => x.status === "wait") && shown() && document.visibilityState === "visible") poll = setTimeout(load, 3000);
  }
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && shown() && load());

  const title = (it) => (it.status === "ok" && it.ai?.title && it.ai.kind !== "unclear" ? it.ai.title : it.text || "Фото");
  // The catalog's title without its subtitle («Психологія грошей. Нетлінні уроки…»).
  const bookTitle = (b) => (b.href && b.ctitle ? b.ctitle.split(/[.:] /)[0] : "") || b.title_uk || b.title;
  const bookAuthor = (b) => (b.href && b.cauthor) || b.author_uk || b.author;
  const aiCover = (b) => window.Shell.rcover({ title: bookTitle(b), authors: [bookAuthor(b)] }, b.cover || null);
  // A suggested book that is one of the reader's own: by its catalog page, else by its title.
  // Another edition counts too: «Бойня номер п'ять, або Дитячий хрестовий похід» = «Бойня номер п'ять» by the same
  // author (the title's head before «, або» or «(»; Max 2026-11-25). A long head alone is enough.
  const thead = (s) => norm(String(s || "").split(/,\s*(?:або|or)\s|\s\(/i)[0]);
  const surnames = (b) => [bookAuthor(b), b.author, b.author_uk].flatMap((a) => norm(a).split(" ")).filter((w) => w.length > 3);
  const same = (b, t, a) => {
    const ts = [bookTitle(b), b.title, b.title_uk].filter(Boolean);
    if (ts.some((x) => norm(x) === norm(t))) return true;
    const h = thead(t);
    if (!h || !ts.some((x) => thead(x) === h)) return false;
    const by = norm(Array.isArray(a) ? a.join(" ") : a);
    return h.length >= 12 || surnames(b).some((w) => by.includes(w));
  };
  const ownOf = (b) => lib().find((x) => (b.href && x.href === b.href) || same(b, x.title, x.authors || x.author));
  const added = (b) => !!b.wanted;

  // A topic's own books: Opus's picks and the ones put in by hand, minus the ones taken out, plus suggested books
  // the reader already has; only books still in the library.
  function ownIn(it) {
    const out = [...(it.mine || []), ...(it.ai?.have || [])];
    for (const b of it.ai?.books || []) {
      const o = ownOf(b);
      if (o) out.push(o.path);
    }
    const no = new Set(it.notMine || []);
    return [...new Set(out)].filter((p) => !no.has(p) || (it.mine || []).includes(p)).map(libBook).filter(Boolean);
  }
  const state = (b) => (b.finished ? "read" : b.pct > 0 || b.started || b.page || byBook[b.path] ? "reading" : "new");
  const STATE = { read: "прочитано", reading: "читаю", new: "ще не почато" };
  const counts = (p) => {
    const n = byBook[p];
    if (!n) return "";
    return [n.notes ? `${n.notes} ${plural(n.notes, "нотатка", "нотатки", "нотаток")}` : "", n.chats ? `${n.chats} ${plural(n.chats, "пояснення", "пояснення", "пояснень")}` : ""].filter(Boolean).join(" · ");
  };
  const topicsOf = (p) => topics().filter((it) => ownIn(it).some((b) => b.path === p));

  // A topic's books in four kinds: the reader's own files, Opus's added by hand, the site's shelf (less those the
  // reader has as files), and the suggestions not taken yet.
  function topicBooks(it) {
    const own = ownIn(it);
    const books = (it.ai?.books || []).map((b, i) => [b, i]).filter(([b]) => !b.onShelf && !ownOf(b));
    const shelfs = (it.ai?.shelf || []).map((s, j) => [s, j]).filter(([s]) => !lib().some((x) => same({ title: s.t, author: s.a }, x.title, x.authors || x.author)));
    return { own, picked: books.filter(([b]) => added(b)), rest: books.filter(([b]) => !added(b) && !b.later), older: books.filter(([b]) => !added(b) && b.later), shelfs };
  }

  // The topic's line in the list (Max 2026-11-25): «7 книжок по темі · 2 прочитано · 3 можуть підійти · 2 думки».
  function sub(it) {
    if (it.status === "wait") return `${SPIN}Розбираємо…`;
    if (it.status === "limit") return "Розберемо завтра";
    const { own, picked, rest, shelfs } = topicBooks(it);
    const n = own.length + picked.length + shelfs.length;
    const read = own.filter((b) => state(b) === "read").length + shelfs.filter(([s]) => SHELF_STATE[s.s] === "read").length;
    const th = (it.thoughts || []).length + (it.ask || []).length;
    const parts = [
      n ? `${n} ${plural(n, "книжка", "книжки", "книжок")} по темі` : "",
      read ? `${read} прочитано` : "",
      rest.length ? `${rest.length} можуть підійти` : "",
      th ? `${th} ${plural(th, "думка", "думки", "думок")}` : "",
    ].filter(Boolean);
    if (!parts.length) parts.push(KIND[it.ai?.kind] || "");
    return parts.filter(Boolean).join(" · ");
  }
  function fan(it) {
    const t = topicBooks(it);
    const covers = [...t.own.map((b) => window.Shell.rcover(b)), ...t.picked.map(([b]) => aiCover(b)), ...t.shelfs.map(([s]) => window.Shell.rcover({ title: s.t, authors: [s.a] }, s.cover || null)), ...(it.status === "ok" ? t.rest.map(([b]) => aiCover(b)) : [])];
    if (covers.length) return `<span class="r-scr-fan n${Math.min(3, covers.length)}" aria-hidden="true">${covers.slice(0, 3).join("")}</span>`;
    if (it.photo) return `<span class="r-scr-fan"><img class="r-scr-thumb" src="/api/scratch/${it.id}/photo" alt="" loading="lazy"></span>`;
    return "";
  }
  const row = (it) => `<button type="button" class="r-scr-item" data-scr-open="${it.id}">
      <span class="r-scr-x"><b>${esc(title(it))}</b><span class="r-scr-m">${sub(it)}</span></span>${fan(it)}</button>`;
  const head = (t, aside = "") => `<div class="r-sec-head"><h2>${t}</h2>${aside}</div>`;
  const when = (at) => (at ? esc(window.Shell.when?.(at) || "") : "");

  function formHtml() {
    return `<form class="r-scr-form" id="scr-form">
      <label for="scr-text" class="r-scr-hint">Тема, автор, книжка чи просто думка</label>
      ${photo ? `<span class="r-scr-shot"><img src="${photo.url}" alt="Фото до запису"><button type="button" data-act="scr-unphoto" aria-label="Прибрати фото">×</button></span>` : ""}
      <textarea id="scr-text" rows="2" placeholder="Що хочете дослідити?" enterkeyhint="done">${esc(draft)}</textarea>
      <div class="r-scr-row">
        <button type="button" class="pp-tool${window.Dictation?.field() === "scr-text" ? " on" : ""}" data-act="scr-mic" title="Надиктувати" aria-label="Надиктувати">${MIC}</button>
        <button type="button" class="pp-tool" data-act="scr-photo" title="Фото" aria-label="Додати фото">${CAM}</button>
        <span class="r-scr-sp"></span>
        <button type="submit" class="r-pill"${sending ? " disabled" : ""}>${sending ? "Записую…" : "Записати"}</button>
      </div></form>`;
  }

  // A book's row: cover, title, author, what the reader made in it; `extra` under it.
  const brow = (b, subline, extra = "", attrs = `data-scr-book="${esc(b.path)}"`) => `<button type="button" class="nx-brow" ${attrs}>${window.Shell.rcover(b)}
      <span class="nx-bx"><b>${esc(b.title)}</b><span class="nx-bm">${esc(author(b))}</span>${subline ? `<span class="nx-bs">${subline}</span>` : ""}${extra}</span></button>`;
  const quote = (n) => (n?.quote ? `<span class="nx-q">${n.own ? `<span class="nx-own">${esc(n.quote)}</span>` : `<span>${esc(n.quote)}</span>`}${n.comment ? `<em>${esc(n.comment)}</em>` : ""}</span>` : "");

  function listHtml() {
    let html = `<section class="r-scr nx"><h1 class="r-jh">Нотатки</h1>${formHtml()}<div class="nx-main"${q.trim() ? " hidden" : ""}>`;
    if (!items) return `${html}<p class="r-empty">${failed ? "Без мережі нотаток не показати." : `${SPIN}Завантажуємо…`}</p></div></section>`;
    const ts = topics();
    const ls = loose();
    const books = Object.entries(byBook).filter(([p]) => libBook(p)).sort((x, y) => (y[1].at || 0) - (x[1].at || 0));
    if (!ts.length && !ls.length && !books.length) html += `<p class="r-empty r-scr-none">Тут будуть теми, які ви розбираєте, ваші думки й нотатки з книжок.</p>`;
    if (ts.length) html += head(`Теми · ${ts.length}`) + ts.map(row).join("");
    if (ls.length) {
      html += head(`Думки без теми · ${ls.length}`) + ls.map((it) => `<button type="button" class="nx-th" data-scr-open="${it.id}"><p>${esc(it.text || "Фото")}</p><span class="nx-when">${when(it.at)}</span>
        ${it.status === "fail" ? `<span class="nx-ai">Не вдалося розібрати.</span>` : it.ai?.guesses?.length ? `<span class="nx-ai">Може, це: ${it.ai.guesses.map(esc).join("; ")}</span>` : ""}</button>`).join("");
    }
    if (books.length) {
      const shownBooks = allBooks ? books : books.slice(0, 4);
      html += head(`З книжок · ${books.length}`, books.length > 4 ? `<button type="button" class="r-link" data-act="scr-allbooks">${allBooks ? "Згорнути" : "Усі"}</button>` : "");
      html += shownBooks.map(([p]) => brow(libBook(p), esc(counts(p)))).join("");
    }
    // The search under everything (Max 2026-11-25: «поки вниз»), its results right under it.
    return `${html}</div><label class="nx-search nx-search-foot">${LENS}<input id="scr-q" type="search" placeholder="Пошук у нотатках" value="${esc(q)}" autocomplete="off"></label>
      <div id="scr-found">${foundHtml()}</div></section>`;
  }

  // The search: topics here (title, words, what Opus said, thoughts), notes and explanations on the server.
  function foundHtml() {
    const s = norm(q);
    if (s.length < 2) return "";
    const ws = s.split(" ");
    const hay = (it) => norm([title(it), it.text, it.ai?.about, ...(it.thoughts || []).map((t) => t.text), ...(it.ask || []), ...(it.ai?.books || []).map((b) => `${bookTitle(b)} ${bookAuthor(b)}`)].join(" "));
    const ts = (items || []).filter((it) => ws.every((w) => hay(it).includes(w)));
    const hits = found.q === s ? found.hits.filter((h) => libBook(h.book)) : [];
    let html = ts.length ? head(`Теми · ${ts.length}`) + ts.map(row).join("") : "";
    const KINDS = { note: "Нотатки", chat: "Пояснення", paperChat: "Пояснення" };
    for (const label of ["Нотатки", "Пояснення"]) {
      const rows = hits.filter((h) => KINDS[h.kind] === label);
      if (!rows.length) continue;
      html += head(`${label} · ${rows.length}`) + rows.map((h) => `<button type="button" class="nx-hit" data-scr-hit="${hits.indexOf(h)}"><span class="nx-bm">${esc(libBook(h.book).title)}${h.where ? ` · ${esc(h.where)}` : ""}</span>
        <span class="nx-q">${h.field === "text" || h.field === "sel" ? `<span>${esc(h.text)}</span>` : esc(h.text)}</span></button>`).join("");
    }
    if (!html) html = `<p class="r-empty">${found.q === s ? "Нічого не знайшли." : `${SPIN}Шукаємо…`}</p>`;
    return html;
  }
  let searchTimer = 0;
  function search() {
    clearTimeout(searchTimer);
    const s = norm(q);
    const paint = () => {
      const box = $("#scr-found");
      if (box) box.innerHTML = foundHtml();
      const main = $(".nx-main");
      if (main) main.hidden = !!q.trim();
    };
    paint();
    if (s.length < 2 || found.q === s) return;
    searchTimer = setTimeout(async () => {
      let hits = [];
      try {
        hits = (await window.reader.searchMine(q.trim())) || [];
      } catch {}
      if (norm(q) !== s) return;
      found = { q: s, hits };
      paint();
    }, 250);
  }

  function aiBookHtml(b, i, it, button) {
    const lang = b.title_uk ? "є українською" : LANG[b.lang] || "";
    const meta = [bookAuthor(b), lang, b.nonfiction ? "нонфікшн" : ""].filter(Boolean).join(" · ");
    return `<div class="r-scr-book">
      <button type="button" class="r-scr-bc" data-act="scr-card" data-scr-ai="${i}" aria-label="${esc(bookTitle(b))}">${aiCover(b)}</button>
      <span class="r-scr-bw"><button type="button" class="r-scr-bx" data-act="scr-card" data-scr-ai="${i}"><b>${esc(bookTitle(b))}</b><span class="r-scr-bm">${esc(meta)}</span>${b.why ? `<span class="r-scr-why">${esc(b.why)}</span>` : ""}</button>
      ${button ? `<span class="nx-acts3"><button type="button" class="r-pill-line r-scr-add" data-act="scr-add" data-scr-ai="${i}">Додати в тему</button><button type="button" class="r-link nx-no" data-act="scr-no" data-scr-ai="${i}">Не цікаво</button></span>` : `<button type="button" class="r-link nx-drop" data-act="scr-drop" data-scr-ai="${i}">Прибрати з теми</button>`}</span></div>`;
  }

  // A topic's book from the reader's shelf on the site (server/scratch.js `ai.shelf`): read, wanted, reading; a tap
  // opens its card.
  const SHELF = { read: "прочитано", reading: "читаю", want: "хочу прочитати", abandoned: "кинули", "": "на полиці" };
  const SHELF_STATE = { read: "read", abandoned: "read", reading: "reading" };
  const shelfBookHtml = (s, j) => `<div class="r-scr-book">
      <button type="button" class="r-scr-bc" data-act="scr-shelfcard" data-scr-sh="${j}" aria-label="${esc(s.t)}">${window.Shell.rcover({ title: s.t, authors: [s.a] }, s.cover || null)}</button>
      <span class="r-scr-bw"><button type="button" class="r-scr-bx" data-act="scr-shelfcard" data-scr-sh="${j}"><b>${esc(s.t)}</b><span class="r-scr-bm">${esc([s.a, SHELF[s.s] ?? SHELF[""]].filter(Boolean).join(" · "))}</span></button></span></div>`;

  function pickHtml() {
    const s = norm(pickQ);
    if (picking === "book") {
      const it = byId(open);
      const have = new Set(ownIn(it).map((b) => b.path));
      const list = lib().filter((b) => !have.has(b.path) && (!s || norm(`${b.title} ${author(b)}`).includes(s))).slice(0, 40);
      return list.map((b) => `<button type="button" class="r-prow nx-pick" data-act="scr-link" data-scr-path="${esc(b.path)}">${window.Shell.rcover(b)}<span class="r-prow-t">${esc(b.title)}</span><span class="r-prow-p">${esc(author(b))}</span></button>`).join("") || `<p class="r-empty">Немає такої книжки.</p>`;
    }
    const inIt = new Set(topicsOf(book).map((x) => x.id));
    const list = topics().filter((x) => !inIt.has(x.id) && (!s || norm(title(x)).includes(s)));
    return list.map((x) => `<button type="button" class="r-scr-item nx-pick" data-act="scr-into" data-scr-topic="${x.id}"><span class="r-scr-x"><b>${esc(title(x))}</b></span></button>`).join("") || `<p class="r-empty">${topics().length ? "Немає такої теми." : "Тем ще немає: запишіть першу в «Нотатках»."}</p>`;
  }
  const picker = (label) => `<div class="nx-picker"><label class="nx-search">${LENS}<input id="scr-pick" type="search" placeholder="${label}" value="${esc(pickQ)}" autocomplete="off"></label>
    <div id="scr-picks">${pickHtml()}</div><button type="button" class="r-link" data-act="scr-unpick">Закрити</button></div>`;

  function oneHtml(it) {
    const at = new Date(it.at);
    const time = at.toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" });
    const said = [it.text ? `«${esc(it.text)}»` : "", `${when(it.at)}${when(it.at) ? ", " : ""}${time}`, it.voice ? "голосом" : ""].filter(Boolean).join(" · ");
    let html = `<section class="r-scr r-scr-one nx"><button type="button" class="r-scr-back" data-act="scr-back">‹ Нотатки</button>
      <p class="r-scr-said">${said}</p>
      ${it.photo ? `<img class="r-scr-photo" src="/api/scratch/${it.id}/photo" alt="Фото до запису">` : ""}`;
    const a = it.ai;
    const busy = it.status === "wait";
    if (a && a.kind !== "unclear") {
      html += `<span class="r-scr-kind">${KIND[a.kind] || ""}</span><h1 class="r-scr-t">${esc(a.title)}</h1>
        ${a.about ? `<p class="r-scr-about${more ? "" : " nx-fold"}${a.about.length < 400 ? " short" : ""}">${esc(a.about)}</p>${a.about.length > 150 ? `<button type="button" class="r-link nx-more${a.about.length < 400 ? " short" : ""}" data-act="scr-more">${more ? "Згорнути" : "Більше"}</button>` : ""}` : ""}`;
    } else if (a?.kind === "unclear") {
      html += `<p class="r-scr-state">Не зрозуміли, що це.${a.guesses?.length ? " Може, це:" : " Допишіть думку нижче."}</p>
        ${a.guesses?.length ? `<div class="r-scr-guess">${a.guesses.map((g, i) => `<button type="button" data-act="scr-guess" data-scr-guess="${i}">${esc(g)}</button>`).join("")}</div>` : ""}`;
    }
    if (busy && suggesting !== it.id) html += `<p class="r-scr-state">${SPIN}${a ? "Думаємо над новою думкою…" : "Розбираємо: шукаємо, що це і що почитати…"}</p>`;
    else if (it.status === "limit") html += `<p class="r-scr-state">На сьогодні розборів досить. Розберемо завтра.</p>`;
    else if (it.status === "fail") html += `<p class="r-scr-state">Не вдалося розібрати. <button type="button" class="r-link" data-act="scr-again">Ще раз</button></p>`;

    // The reader's thoughts: «Уточнення» from before, then the thoughts with Opus's answers.
    const ths = [...(it.ask || []).map((t) => ({ text: t })), ...(it.thoughts || [])];
    html += head(`Мої думки${ths.length ? ` · ${ths.length}` : ""}`);
    html += ths.map((t) => `<div class="nx-th"><p>${esc(t.text)}</p><span class="nx-when">${when(t.at)}${t.voice ? " · голосом" : ""}${t.id ? `<button type="button" class="r-link nx-x" data-act="scr-unthink" data-scr-tid="${t.id}">Видалити</button>` : ""}</span>${t.reply ? `<span class="nx-ai">${esc(t.reply)}</span>` : ""}</div>`).join("");
    html += `<form class="r-scr-form nx-think" id="scr-think-form"><textarea id="scr-think" rows="1" placeholder="Додати думку: що хочеться з'ясувати, куди копати" enterkeyhint="send">${esc(thought)}</textarea>
      <div class="r-scr-row"><button type="button" class="pp-tool${window.Dictation?.field() === "scr-think" ? " on" : ""}" data-act="scr-thinkmic" title="Надиктувати" aria-label="Надиктувати">${MIC}</button><span class="r-scr-sp"></span>
      <button type="submit" class="r-pill"${busy ? " disabled" : ""}>Записати</button></div></form>`;

    // The topic's books, the reader's own and Opus's added by hand, like a to-do list (Max 2026-11-25): the newest
    // added on top, read ones at the bottom; Opus's own picks after the added ones, reading before not started.
    const { own, picked, rest, older, shelfs } = topicBooks(it);
    const n = own.length + picked.length + shelfs.length;
    html += head(`Книжки по темі${n ? ` · ${n}` : ""}`, `<button type="button" class="r-link" data-act="scr-pickbook">${picking === "book" ? "" : "Додати свою"}</button>`);
    if (picking === "book") html += picker("Знайти серед моїх книжок");
    const ORDER = ["reading", "new", "read"];
    const rows = [
      ...own.map((b) => ({ s: state(b), at: it.added?.[b.path] || 0, html: () => brow(b, esc([STATE[state(b)], counts(b.path)].filter(Boolean).join(" · ")), quote(byBook[b.path]), `data-scr-book="${esc(b.path)}" data-scr-from="${it.id}"`) })),
      ...picked.map(([b, i]) => ({ s: "new", at: typeof b.wanted === "number" ? b.wanted : 0, html: () => aiBookHtml(b, i, it, false) })),
      ...shelfs.map(([s, j]) => ({ s: SHELF_STATE[s.s] || "new", at: 0, html: () => shelfBookHtml(s, j) })),
    ];
    rows.sort((x, y) => (x.s === "read") - (y.s === "read") || y.at - x.at || ORDER.indexOf(x.s) - ORDER.indexOf(y.s));
    html += rows.map((r) => r.html()).join("");
    if (!n && picking !== "book") html += `<p class="r-empty nx-none">Книжок тут ще немає.</p>`;
    if (rest.length) html += head(`Можуть підійти · ${rest.length}`) + rest.map(([b, i]) => aiBookHtml(b, i, it, true)).join("");
    // «Порадити ще» (Max 2026-11-25): new books past those suggested before, when the list is worked through.
    if (a && a.kind !== "unclear") {
      if (!rest.length) html += head("Можуть підійти");
      html += busy && suggesting === it.id ? `<p class="r-scr-state">${SPIN}Шукаємо ще книжки…</p>` : `<div class="nx-moreb"><button type="button" class="r-pill-line"${busy ? " disabled" : ""} data-act="scr-suggest">Порадити ще</button></div>`;
    }
    // What was suggested before «Порадити ще» and neither added nor declined: folded, for later.
    if (older.length) {
      html += head(`Раніше радили · ${older.length}`, `<button type="button" class="r-link" data-act="scr-older">${showOlder ? "Сховати" : "Показати"}</button>`);
      if (showOlder) html += older.map(([b, i]) => aiBookHtml(b, i, it, true)).join("");
    }
    html += `<div class="r-scr-foot"><button type="button" class="r-link" data-act="scr-delete">Видалити тему</button></div>`;
    return `${html}</section>`;
  }

  // One book's notes and explanations, as the book's own «Нотатки» lists them, by chapter, newest first.
  function bookHtml() {
    const b = libBook(book);
    const back = from && byId(from) ? `‹ ${esc(title(byId(from)))}` : "‹ Нотатки";
    if (!b) return `<section class="r-scr r-scr-one nx"><button type="button" class="r-scr-back" data-act="scr-back">‹ Нотатки</button><p class="r-empty">Цієї книжки вже немає серед ваших.</p></section>`;
    const ts = topicsOf(book);
    let html = `<section class="r-scr r-scr-one nx"><button type="button" class="r-scr-back" data-act="scr-back">${back}</button>
      <div class="nx-bookhead">${window.Shell.rcover(b)}<span><b>${esc(b.title)}</b><span class="nx-bm">${esc([author(b), STATE[state(b)]].filter(Boolean).join(" · "))}</span>
      <span class="nx-topic">${ts.length > 1 ? "Теми" : "Тема"}: ${ts.map((x) => `<span class="nx-tchip"><button type="button" class="r-link" data-scr-open="${x.id}">${esc(title(x))}</button><button type="button" class="nx-tx" data-act="scr-unlink" data-scr-topic="${x.id}" aria-label="Прибрати з теми">×</button></span>`).join("")}${picking === "topic" ? "" : `<button type="button" class="r-link nx-tadd" data-act="scr-picktopic">${ts.length ? "+ ще" : "+ додати"}</button>`}</span></span></div>`;
    if (picking === "topic") html += picker("Знайти тему");
    const d = bookData?.path === book ? bookData : null;
    if (!d) return `${html}<p class="r-empty">${SPIN}Завантажуємо…</p></section>`;
    if (d.failed) return `${html}<p class="r-empty">Без мережі нотаток не показати.</p></section>`;
    const notes = [...d.notes].sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0));
    const chats = [...d.chats].sort((x, y) => (y.at || 0) - (x.at || 0));
    if (tab === "chats" && !chats.length) tab = "notes";
    const t = (k, label, n) => `<button type="button" data-act="scr-tab" data-scr-tab="${k}"${tab === k ? ' class="on"' : ""}>${label} <span>${n}</span></button>`;
    html += `<div class="mn-tabs nx-tabs">${t("notes", "Нотатки", notes.length)}${chats.length ? t("chats", "Пояснення", chats.length) : ""}</div>`;
    const list = tab === "chats" ? chats : notes;
    if (!list.length) return `${html}<p class="r-empty">Нотаток ще немає. Виділіть текст у книжці й натисніть «Зберегти».</p></section>`;
    let group = null;
    list.forEach((x, i) => {
      if (x.chapter !== group) (group = x.chapter), (html += `<h3 class="nx-ch">${esc(x.chapter || "Без розділу")}</h3>`);
      const own = tab === "notes" && (String(x.cfi).startsWith("mine:") || (b.paper && !x.quote));
      const body = tab === "notes"
        ? `<div class="nx-q">${own ? `<span class="nx-own">${esc(x.text)}</span>` : `<span>${esc(x.text)}</span>`}${x.comment ? `<em>${esc(x.comment)}</em>` : ""}</div>`
        : `<div class="nx-q">${x.sel ? `<span>${esc(x.sel.length > 300 ? `${x.sel.slice(0, 298)}…` : x.sel)}</span>` : ""}${x.q && x.q !== x.sel ? `<em><b>${esc(x.q)}</b></em>` : ""}${x.a ? `<em>${esc(x.a.length > 280 ? `${x.a.slice(0, 278)}…` : x.a)}</em>` : ""}</div>`;
      html += `<div class="nx-note">${body}<div class="nx-acts2"><span>${when(x.createdAt || x.at)}</span><button type="button" class="r-link" data-act="scr-go" data-scr-i="${i}">Перейти</button></div></div>`;
    });
    return `${html}</section>`;
  }

  function html() {
    watch();
    if (book) return bookHtml();
    const it = open && byId(open);
    if (open && !it && items) open = null;
    return it ? oneHtml(it) : listHtml();
  }

  // The page opens: the list again from the server.
  function enter() {
    open = null;
    book = null;
    picking = "";
    load();
  }
  function top() {
    const h = $("#home");
    if (h) h.scrollTop = 0;
  }
  // Android's back and the header's: a book goes back to its topic or the list, a topic to the list.
  function back() {
    if (picking) return (picking = ""), redraw(), true;
    if (book) {
      book = null;
      open = from && byId(from) ? from : null;
      from = null;
      redraw();
      top();
      return true;
    }
    if (!open) return false;
    open = null;
    thought = "";
    more = false;
    showOlder = false;
    redraw();
    top();
    return true;
  }
  function showTopic(id) {
    book = null;
    from = null;
    open = id;
    thought = "";
    more = false;
    picking = "";
    redraw();
    top();
  }
  async function showBook(p, fromTopic = null) {
    book = p;
    from = fromTopic;
    tab = "notes";
    picking = "";
    redraw();
    top();
    if (bookData?.path === p) return;
    bookData = null;
    try {
      const d = await window.reader.bookNotes(p);
      bookData = { path: p, notes: d.notes || [], chats: d.chats || [] };
    } catch {
      bookData = { path: p, failed: true, notes: [], chats: [] };
    }
    if (book === p) redraw();
  }

  function put(it) {
    if (!it) return;
    const i = (items || []).findIndex((x) => x.id === it.id);
    if (i < 0) items = [it, ...(items || [])];
    else items[i] = it;
  }
  const oops = (err, what) => showNotice(err instanceof TypeError ? `Немає з'єднання: ${what} можна лише онлайн.` : err.message || "Не вийшло.", false);
  // The reader's books for Opus to pick the topic's own from.
  const libFor = () => lib().slice(0, 300).map((b) => ({ p: b.path, t: b.title, a: author(b) }));

  async function send() {
    const text = ($("#scr-text")?.value ?? draft).trim();
    if ((!text && !photo) || sending) return;
    window.Dictation?.stop();
    document.activeElement?.blur();
    sending = true;
    redraw();
    try {
      let b64 = "";
      if (photo) {
        const buf = new Uint8Array(await photo.blob.arrayBuffer());
        let s = "";
        for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        b64 = btoa(s);
      }
      const { item } = await window.reader.scratchAdd({ text, photo: b64, voice, lib: libFor() });
      put(item);
      window.ReadingTime?.count("scr-write");
      draft = "";
      voice = false;
      if (photo) URL.revokeObjectURL(photo.url);
      photo = null;
    } catch (err) {
      oops(err, "записати");
    }
    sending = false;
    redraw();
    watch();
  }

  async function think() {
    const it = open && byId(open);
    const text = ($("#scr-think")?.value ?? thought).trim();
    if (!it || !text || it.status === "wait") return;
    window.Dictation?.stop();
    document.activeElement?.blur();
    try {
      put((await window.reader.scratchThink(it.id, { text, voice: thoughtVoice, lib: libFor() })).item);
      window.ReadingTime?.count("scr-think");
      thought = "";
      thoughtVoice = false;
    } catch (err) {
      oops(err, "записати думку");
    }
    redraw();
    watch();
  }

  async function addPhoto() {
    const file = await window.Paper.pickPhoto();
    if (!file) return;
    const blob = await window.Paper.shrink(file, 1200);
    if (photo) URL.revokeObjectURL(photo.url);
    photo = { blob, url: URL.createObjectURL(blob) };
    // Drawn now even when the field has the finger (typed while the photo was shrunk): the caret is put back.
    const f = $("#scr-text");
    draft = f?.value ?? draft;
    const at = document.activeElement === f ? f.selectionStart : null;
    redraw();
    if (at != null) $("#scr-text")?.focus(), $("#scr-text")?.setSelectionRange(at, at);
  }

  // «Перейти»: the book opens at the note or the explanation (home.js `go`, as the panel's search does).
  function go(i) {
    const b = libBook(book);
    const d = bookData;
    if (!b || !d) return;
    const list = tab === "chats" ? [...d.chats].sort((x, y) => (y.at || 0) - (x.at || 0)) : [...d.notes].sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0));
    const x = list[i];
    if (!x) return;
    window.Shell.go({ kind: tab === "chats" ? (b.paper ? "paperChat" : "chat") : "note", book: b.path, id: x.id, cfi: x.cfi, posKey: x.posKey });
  }

  async function act(name, el) {
    if (name === "scr-mic") return (voice = true), window.Dictation.toggle("scr-text", '[data-act="scr-mic"]');
    if (name === "scr-thinkmic") return (thoughtVoice = true), window.Dictation.toggle("scr-think", '[data-act="scr-thinkmic"]');
    if (name === "scr-photo") return addPhoto();
    if (name === "scr-unphoto") return photo && URL.revokeObjectURL(photo.url), (photo = null), (draft = $("#scr-text")?.value ?? draft), redraw();
    if (name === "scr-allbooks") return (allBooks = !allBooks), redraw();
    if (name === "scr-back") return back();
    if (name === "scr-more") return (more = !more), redraw();
    if (name === "scr-older") return (showOlder = !showOlder), redraw();
    if (name === "scr-tab") return (tab = el.dataset.scrTab), redraw();
    if (name === "scr-go") return go(Number(el.dataset.scrI));
    if (name === "scr-unpick") return (picking = ""), redraw();
    if (name === "scr-pickbook") return (picking = picking === "book" ? "" : "book"), (pickQ = ""), redraw(), $("#scr-pick")?.focus();
    if (name === "scr-picktopic") return (picking = picking === "topic" ? "" : "topic"), (pickQ = ""), redraw(), $("#scr-pick")?.focus();
    try {
      if (name === "scr-into") {
        put((await window.reader.scratchPatch(el.dataset.scrTopic, { book, on: true })).item);
        picking = "";
        return redraw();
      }
      if (name === "scr-unlink") {
        put((await window.reader.scratchPatch(el.dataset.scrTopic, { book, on: false })).item);
        return redraw();
      }
    } catch (err) {
      return oops(err, "це зробити");
    }
    const it = open && byId(open);
    if (!it) return;
    const i = Number(el.dataset.scrAi);
    const b = it.ai?.books?.[i];
    const sh = it.ai?.shelf?.[Number(el.dataset.scrSh)];
    if (name === "scr-shelfcard" && sh) return topicCard({ title: sh.t, author: sh.a, cover: sh.cover || "", href: sh.href || "", year: sh.year }, `<p class="nx-cwhy">${esc(SHELF[sh.s] ?? SHELF[""])} · на полиці Chytai</p>`, "");
    if (name === "scr-card" && b) {
      const acts = b.wanted
        ? `<button type="button" class="r-link nx-drop" data-nx-act="scr-drop" data-scr-ai="${i}">Прибрати з теми</button>`
        : `<span class="nx-acts3"><button type="button" class="r-pill" data-nx-act="scr-add" data-scr-ai="${i}">Додати в тему</button><button type="button" class="r-link nx-no" data-nx-act="scr-no" data-scr-ai="${i}">Не цікаво</button></span>`;
      return topicCard({ title: bookTitle(b), author: bookAuthor(b), cover: b.cover || "", href: b.href || "", year: b.year }, b.why ? `<p class="nx-cwhy">${esc(b.why)}</p>` : "", acts);
    }
    try {
      if (name === "scr-link") {
        put((await window.reader.scratchPatch(it.id, { book: el.dataset.scrPath, on: true })).item);
        picking = "";
        return redraw();
      }
      if (name === "scr-no" && b) {
        el.disabled = true;
        put((await window.reader.scratchPatch(it.id, { no: i })).item);
        return redraw();
      }
      if ((name === "scr-add" || name === "scr-drop") && b) {
        el.disabled = true;
        put((await window.reader.scratchPatch(it.id, { wanted: i, on: name === "scr-add" })).item);
        return redraw();
      }
      if (name === "scr-guess") return put((await window.reader.scratchThink(it.id, { text: `Мається на увазі: ${it.ai?.guesses?.[Number(el.dataset.scrGuess)] || ""}`, lib: libFor() })).item), redraw(), watch();
      if (name === "scr-suggest") return (suggesting = it.id), put((await window.reader.scratchAsk(it.id, { more: true, lib: libFor() })).item), redraw(), watch();
      if (name === "scr-again") return put((await window.reader.scratchAsk(it.id, { again: true, lib: libFor() })).item), redraw(), watch();
      if (name === "scr-unthink") return put((await window.reader.scratchUnthink(it.id, el.dataset.scrTid)).item), redraw();
      if (name === "scr-delete") {
        if (sure !== it.id) return (sure = it.id), (el.textContent = "Точно видалити тему й думки?");
        await window.reader.scratchDelete(it.id);
        items = items.filter((x) => x.id !== it.id);
        return back();
      }
    } catch (err) {
      if (name === "scr-add" || name === "scr-drop" || name === "scr-no") el.disabled = false;
      oops(err, "це зробити");
    }
  }

  const shell = $("#shell");
  // Before home.js: the header's «назад» on a topic or a book goes back here, not home.
  // A topic's book card (Max 2026-11-25, «Картка теми»): why it is here, «Про книжку» / «Чому варто читати» (paper.js),
  // the topic's own buttons and the book's page here; no «Додати в мої книжки» (reading has its own pages).
  function topicCard(b, top, acts) {
    const page = b.href ? `<p class="pf-page"><a href="${esc(b.href)}" target="_blank" rel="noopener">Сторінка книжки на Chytai ↗</a></p>` : "";
    window.Paper.card(b, { top, noAdd: true, foot: `${acts ? `<div class="nx-cacts">${acts}</div>` : ""}${page}` });
  }
  document.addEventListener("click", (e) => {
    const el = e.target.closest("#paper-found [data-nx-act]");
    if (!el) return;
    $("#paper-found").close();
    window.ReadingTime?.count(`act-${el.dataset.nxAct}-card`);
    act(el.dataset.nxAct, el);
  });
  shell.addEventListener("click", (e) => {
    if (shown() && (open || book) && e.target.closest(".r-head-s .r-back")) e.stopPropagation(), back();
  }, true);
  shell.addEventListener("click", (e) => {
    if (!shown()) return;
    const o = e.target.closest("[data-scr-open]");
    if (o) return showTopic(o.dataset.scrOpen);
    const bk = e.target.closest("[data-scr-book]");
    if (bk) return showBook(bk.dataset.scrBook, bk.dataset.scrFrom || null);
    const h = e.target.closest("[data-scr-hit]");
    if (h) {
      const hit = found.hits.filter((x) => libBook(x.book))[Number(h.dataset.scrHit)];
      return hit && window.Shell.go(hit);
    }
    const el = e.target.closest("[data-act^='scr-']");
    if (el) act(el.dataset.act, el);
  });
  shell.addEventListener("input", (e) => {
    if (e.target.id === "scr-text") draft = e.target.value;
    if (e.target.id === "scr-think") thought = e.target.value;
    if (e.target.id === "scr-q") (q = e.target.value), search();
    if (e.target.id === "scr-pick") {
      pickQ = e.target.value;
      const box = $("#scr-picks");
      if (box) box.innerHTML = pickHtml();
    }
  });
  shell.addEventListener("submit", (e) => {
    if (e.target.id === "scr-form") return e.preventDefault(), send();
    if (e.target.id === "scr-think-form") return e.preventDefault(), think();
  });
  // Enter in a field writes the entry (or the thought) on a computer; a phone's Enter is a new line.
  shell.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey || !matchMedia("(hover: hover)").matches) return;
    if (e.target.id === "scr-text") e.preventDefault(), send();
    if (e.target.id === "scr-think") e.preventDefault(), think();
  });

  window.Scratch = { html, enter, back, load, typing };
})();

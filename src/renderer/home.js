// Home screen (design v2 from Claude Design, 2026-11-02): «Мої книжки» and «Додати книжку», with a panel on the
// left. It covers the reader while it is open; a book opening puts it away, «←» in the book brings it back.
// The old tabs (Пошук, Клуб, Бібліотека, Нотатки, Хочу прочитати) were taken out on 2026-11-18.
(() => {
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ESC[c]);
  const DAY = 864e5;

  let lib = null; // the library list (library-view.js)

  // ---------- Showing and hiding ----------

  const isOpen = () => !$("#shell").classList.contains("hidden");

  function show() {
    $("#shell").classList.remove("hidden");
    // Keys go to the home screen now, not to the page of the book left focused underneath.
    if (document.activeElement?.tagName === "IFRAME") document.activeElement.blur();
    document.body.classList.add("library-open");
    $("#home").scrollTop = 0;
    load();
  }

  function hide() {
    $("#shell").classList.add("hidden");
    document.body.classList.remove("library-open");
  }

  // ---------- Data ----------

  let loadingAll = null;
  let waitTimer = null;
  function load() {
    render();
    // A server that was asleep (Fly stops it when nobody reads) takes a few seconds to wake.
    clearTimeout(waitTimer);
    if (!lib) waitTimer = setTimeout(() => !lib && $("#home-wait").classList.remove("hidden"), 2500);
    loadingAll ??= Promise.all([
      // The books are drawn once they are here, if the rest is still on its way: on a weak network it may not
      // answer for a long time (Max, 2026-11-11).
      window.Library.data(true).then((d) => ((lib = d), setTimeout(() => loadingAll && render(), document.body.classList.contains("offline") ? 0 : 1000))),
      loadTrashCount(),
    ])
      .catch((err) => {
        if (!lib) $("#home-body").innerHTML = `<div class="lib-empty">${esc(err.message)}</div>`;
      })
      .finally(() => {
        loadingAll = null;
        clearTimeout(waitTimer);
        render();
      });
    return loadingAll;
  }

  // ---------- Helpers ----------

  const norm = (s) => String(s || "").toLowerCase().replace(/[«»"'’ʼ.,:;!?()—–-]/g, " ").replace(/\s+/g, " ").trim();
  const author = (b) => b.authors.slice(0, 2).join(", ") + (b.authors.length > 2 ? "…" : "");

  function when(ms) {
    const days = Math.floor((new Date().setHours(24, 0, 0, 0) - ms) / DAY);
    if (days <= 0) return "сьогодні";
    if (days === 1) return "вчора";
    return new Date(ms).toLocaleDateString("uk-UA", { day: "numeric", month: "long" });
  }

  // 1 нотатка, 2 нотатки, 5 нотаток.
  function plural(n, one, few, many) {
    const t = n % 100;
    const u = n % 10;
    return t > 10 && t < 20 ? many : u === 1 ? one : u >= 2 && u <= 4 ? few : many;
  }

  // ---------- Головна ----------

  const render = () => renderHome();

  // ---------- Мої книжки: design «3a» from Claude Design (Max, 2026-11-01) ----------
  // One page: «Читаю зараз» (that book is in the list too), your books with filters and a «+» tile, what others read now, the free shelf.
  // A query in the search field replaces it with results from your books and the free shelf.
  let homeFilter = "all"; // all («Читаю») | new | done | paper
  // Мої книжки as covers or as a list (Max 2026-11-04: a label on the cover hides part of the title).
  let homeView = (() => { try { return localStorage.getItem("chytai-home-view") === "list" ? "list" : "grid"; } catch { return "grid"; } })();
  const viewIcon = { grid: `<svg viewBox="0 0 18 18" aria-hidden="true"><rect x="2" y="2" width="5.5" height="6" rx="1"/><rect x="10.5" y="2" width="5.5" height="6" rx="1"/><rect x="2" y="10" width="5.5" height="6" rx="1"/><rect x="10.5" y="10" width="5.5" height="6" rx="1"/></svg>`, list: `<svg viewBox="0 0 18 18" aria-hidden="true"><rect x="2" y="2.5" width="3.5" height="4.5" rx=".8"/><rect x="2" y="11" width="3.5" height="4.5" rx=".8"/><path d="M8 4.75h8M8 13.25h8"/></svg>` };
  const viewSwitch = () => `<span class="r-view">${["grid", "list"].map((v) => `<button type="button" class="${v === homeView ? "on" : ""}" data-view="${v}" title="${v === "grid" ? "Обкладинки" : "Список"}" aria-label="${v === "grid" ? "Обкладинки" : "Список"}">${viewIcon[v]}</button>`).join("")}</span>`;
  // On a computer the list has columns, sorted by a click on their heading (Max 2026-11-04).
  let homeSort = (() => { try { return localStorage.getItem("chytai-home-sort") || "opened"; } catch { return "opened"; } })();
  const fmt = (b) => (b.paper ? "Паперова" : (/\.([a-z0-9]+)$/i.exec(b.path)?.[1] || "").toUpperCase());
  const sorters = {
    opened: (x, y) => lastTouched(y) - lastTouched(x),
    title: (x, y) => x.title.localeCompare(y.title, "uk"),
    format: (x, y) => fmt(x).localeCompare(fmt(y)) || lastTouched(y) - lastTouched(x),
  };
  const listHead = () => `<div class="r-lhead">${[["title", "Назва"], ["opened", "Відкривали"], ["format", "Формат"]].map(([k, label]) => `<button type="button" class="${k === homeSort ? "on" : ""}" data-sort="${k}">${label}</button>`).join("")}</div>`;
  const rowCols = (b) => `<span class="r-lc r-lc-o">${b.openedAt ? when(b.openedAt) : "—"}</span><span class="r-lc r-lc-f">${esc(fmt(b))}</span>`;
  const rowStatus = (b) => `<span class="r-st${b.finished ? " done" : ""}">${b.finished ? "Прочитана" : b.paper ? "Паперова" : b.pct > 0 ? `${b.pct}%` : ""}</span>`;
  let freeTab = "new"; // new | kids | classics | all
  let homeHtml = "";
  const kept = new Map(); // page -> { html, f }: the page left, as it was drawn
  let drawn = { page: "", html: "" }; // what #home-body shows now
  const lastTouched = (b) => Math.max(b.openedAt || 0, b.addedAt || 0);
  const matches = (b, q) => norm(`${b.title} ${b.authors.join(" ")}`).includes(q);
  const hue = (t) => [...String(t || "")].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0) % 360;
  // A paper book has no percentage (v2: no «Я на сторінці»): opened and not finished is being read.
  const isReading = (b) => !b.finished && (b.paper ? !!b.openedAt : b.pct != null && b.pct >= 1 && b.pct < 99);
  const isNewBook = (b) => !b.finished && !b.started && !(b.pct > 0);
  // Progress sits on the cover itself: a thin bar while reading, a small mark when finished. A line of text
  // under each cover took height and said little (Max).
  // Design v2: a 3px strip at the cover's foot, full for a book read to the end.
  // Finished (Max 2026-11-04: the full strip was too quiet): a «Прочитана» label on the cover, like «Паперова».
  const doneMark = () => `<span class="r-done-tag">Прочитана</span>`;
  const mark = (b) => b.finished ? doneMark() : (b.pct > 0 ? `<span class="r-bar" title="${b.finished ? "Прочитано" : `${b.pct}%`}"><span style="width:${b.finished ? 100 : Math.max(b.pct, 3)}%"></span></span>` : "");
  const statusText = (b) => (b.finished ? "прочитано" : b.pct > 0 ? `${b.pct}%` : "не почато");
  // A cover: the picture when there is one, the site's typographic stand-in under it otherwise.
  const rcover = (b, url = window.reader.coverUrl?.(b)) => `<span class="r-cover" style="--h:${hue(b.title)}" lang="${esc(b.language || "uk")}">
      <span class="r-cover-t">${esc(b.title)}</span><span class="r-cover-a">${esc((b.authors || [b.author])[0] || "")}</span>
      ${url ? `<img src="${esc(url)}" alt="" loading="lazy" draggable="false" onerror="this.remove()" />` : ""}</span>`;
  const more = (b) => (settings.guest ? "" : `<span class="r-more" role="button" tabindex="0" data-menu="${esc(b.path)}" title="Ще" aria-label="Ще"><i></i><i></i><i></i></span>`);
  const card = (b, foot, menu = true, cls = "") => `<button class="r-card${cls}${b.unavailable ? " unavailable" : ""}" data-open="${esc(b.path)}">${rcover(b)}${b.paper && !b.finished ? `<span class="pp-ctag">Паперова</span>` : ""}${menu ? more(b) : ""}
      <span class="r-t">${esc(b.title)}</span><span class="r-a">${esc(author(b))}</span>${foot}</button>`;
  const head = (title, aside = "", plain = false) => `<div class="r-sec-head${plain ? " plain" : ""}">${title ? `<h2>${title}</h2>` : ""}${aside}</div>`;
  const tabs = (list, active, attr) => `<div class="r-tabs">${list.map(([k, label, n]) => `<button class="${k === active ? "on" : ""}" ${attr}="${k}">${label}${n != null ? ` <i>${n}</i>` : ""}</button>`).join("")}</div>`;

  function myBooks() {
    return lib.books.filter((b) => !(b.aside && (b.free || b.protected || b.paper))).sort((x, y) => lastTouched(y) - lastTouched(x));
  }
  // The book you are reading now: the one opened last, if it is between 1% and 99%.
  function nowBook(books) {
    const last = books.find((b) => b.path === lib.lastBook);
    const paperNow = books.filter((b) => b.paper && b.openedAt && isReading(b)).sort((x, y) => y.openedAt - x.openedAt)[0];
    if (last && isReading(last) && !(paperNow && paperNow.openedAt > (last.openedAt || 0))) return last;
    return books.filter((b) => b.openedAt && isReading(b)).sort((x, y) => y.openedAt - x.openedAt)[0] || null;
  }

  // ---------- Design v2 (Claude Design turns 7 and 8, Max 2026-11-02): a panel and two pages ----------
  // The panel: search in your books, Мої книжки / Додати книжку / Нещодавно видалені, the books opened lately,
  // feedback and your settings. Always open on a computer; on a phone the header's button (or, in the app, a
  // swipe from the left edge) slides the page aside to show it. Safari keeps that edge for «back».
  let page = "home"; // home | add | journey | want | shelves | scratch | admin | how | paper
  let backTo = "home"; // where «назад» goes: «Як це працює» opened from «Додати книжку» goes back there (Max 2026-11-22, №36)
  let paperPath = null; // the paper book on «paper» (paper.js)
  let addQuery = "";
  let freeAll = false;
  let shopOpen = null; // "yakaboo" | "bookua": the store whose «як додати» is open
  const found = new Map(); // query -> { books } | { error } | "…" while asked
  const more6 = new Set(); // groups opened with «Ще N →»
  let panelHtml = "";
  const phone = () => matchMedia("(max-width: 760px)").matches;

  function setPage(next, { push = true } = {}) {
    if ((next === "add" || next === "journey" || next === "want" || next === "scratch" || next === "shelves") && settings.guest) return;
    if (next === "admin" && !settings.owner) return;
    if (next === "journey") loadJourney();
    if (next === "scratch") window.Scratch.enter();
    if (next === "want") window.Want.enter();
    if (next === "shelves") window.Shelves.enter();
    if (next === "admin") loadAdmin();
    const was = page;
    page = next;
    $("#shell").dataset.page = page;
    panel(false);
    if (was !== page) {
      backTo = page === "how" && was === "add" ? "add" : "home";
      // A browser's «back» (and Esc) on «Додати книжку» comes back to your books. Not in the iPhone app: its web
      // view turns a swipe from the screen's edge into back/forward, and a swipe closing the panel near the right
      // edge went «forward» to this entry, so the panel jumped back open (Max, 2026-11-02).
      if (push && page !== "home" && history.state?.rp !== page && !document.documentElement.classList.contains("in-app")) history[history.state?.rp && backTo === "home" ? "replaceState" : "pushState"]({ rp: page }, "");
      $("#home").scrollTop = 0;
      homeHtml = "";
    }
    if (!isOpen()) show();
    else renderHome();
  }
  addEventListener("popstate", () => page !== "home" && history.state?.rp !== page && setPage(history.state?.rp || "home", { push: false }));
  function backHome() {
    if (history.state?.rp === page) history.back();
    else setPage(backTo);
  }

  // In an e-book (phone app) a swipe from the left edge opens the panel too, as on a paper book (Max 2026-11-05):
  // your books show behind it, as on a paper book. Putting the panel away leaves you on your books: going back to
  // the book there made a tap on another cover behind the panel reopen the same book (Max 2026-11-05).
  // With the tabs (variant А, Max 2026-11-28) that swipe and Android's back bring «Мої книжки» with the tabs; the panel is
  // only search on a phone.
  function panelFromBook() {
    if (!phone() || isOpen() || settings.guest) return;
    if (page !== "home") setPage("home", { push: false });
    show("home");
  }
  function panel(open = !$("#shell").classList.contains("panel-open")) {
    if (open && !phone()) open = false;
    $("#shell").classList.toggle("panel-open", open);
    if (!open && document.activeElement?.id === "r-pq" && phone()) document.activeElement.blur();
  }

  function renderPanel() {
    const books = myBooks();
    const q = norm($("#r-pq").value);
    $("#r-panel").classList.toggle("searching", !!q);
    let html = "";
    if (q) {
      const hits = books.filter((b) => matches(b, q)).slice(0, 30);
      const more = deepHtml(q, books);
      html = hits.length || more ? (more && hits.length ? `<h3 class="r-phead">Книжки</h3>` : "") + hits.map(prow).join("") + more
        : deep.q === q || deep.offline || q.length < 2 || !window.reader.searchMine ? `<p class="r-pnone">Нічого не знайшлося.</p>` : "";
    }
    // «Нещодавно відкриті» is gone (variant А, Max 2026-11-28): the same books as «Читаю зараз».
    const all = `${html}\u0000${books.length}|${trashCount}|${page}|${settings.user}`;
    if (all === panelHtml) return;
    panelHtml = all;
    $("#r-pfound").innerHTML = html;
    $("#r-pfound").classList.toggle("hidden", !q);
    $("#r-n-books").textContent = books.length || "";
    $("#r-pnav-trash").hidden = !trashCount;
    $("#r-n-trash").textContent = trashCount || "";
    for (const b of document.querySelectorAll(".r-pnav [data-page], #r-tabs [data-page]")) b.classList.toggle("on", b.dataset.page === page);
    const letter = (settings.user || "Ч").trim()[0].toUpperCase();
    $("#r-avatar").textContent = letter;
    for (const a of document.querySelectorAll(".r-hava")) a.textContent = letter;
    $("#r-me-name").textContent = settings.user || "";
    $("#ms-name").textContent = settings.user || "";
    $("#me-trash").hidden = !trashCount;
    $("#ms-trash").textContent = trashCount ? `${trashCount} ${trashCount === 1 ? "книжка" : trashCount < 5 ? "книжки" : "книжок"}` : "";
  }
  // Past the titles (Max, 2026-11-03): the query is also looked for in your notes, their thoughts and your talks
  // with Claude (GET /api/search, server/search.js). A hit shows its book, a piece of text and opens at its place.
  let deep = { q: "", hits: [], offline: false };
  let deepTimer = 0;
  let pqCounted = false;
  function askDeep() {
    clearTimeout(deepTimer);
    const q = norm($("#r-pq").value);
    if (!q || q.length < 2 || !window.reader.searchMine) return;
    deepTimer = setTimeout(async () => {
      if (!pqCounted) pqCounted = true, window.ReadingTime?.count("psearch"); // once a time the field is used
      try {
        const hits = await window.reader.searchMine($("#r-pq").value.trim());
        if (norm($("#r-pq").value) !== q) return;
        deep = { q, hits: hits || [], offline: !hits };
      } catch {
        deep = { q, hits: [], offline: true };
      }
      renderPanel();
    }, 250);
  }
  const KINDS = { note: "Нотатки", chat: "Пояснення", paperChat: "Пояснення" };
  function markWords(text, q) {
    const ws = [...new Set(q.split(" ").filter((w) => w.length >= 2))];
    let out = esc(text);
    for (const w of ws.sort((x, y) => y.length - x.length)) out = out.replace(new RegExp(esc(w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), (m) => `\u0001${m}\u0002`);
    return out.replace(/\u0001/g, "<mark>").replace(/\u0002/g, "</mark>");
  }
  function deepHtml(q, books) {
    if (deep.q !== q || !deep.hits.length) return "";
    const byPath = new Map(books.map((b) => [b.path, b]));
    let html = "";
    for (const label of [...new Set(Object.values(KINDS))]) {
      const rows = deep.hits.filter((h) => KINDS[h.kind] === label && byPath.has(h.book));
      if (!rows.length) continue;
      html += `<h3 class="r-phead">${label}</h3>` + rows.map((h) => {
        const b = byPath.get(h.book);
        const i = deep.hits.indexOf(h);
        const said = h.kind !== "note" && (h.field === "a" || h.field === "q") && h.quote ? `<span class="r-phit-q">${esc(h.quote)}</span>` : "";
        return `<button type="button" class="r-phit" data-hit="${i}"><span class="r-phit-b">${esc(b.title)}${h.where ? ` · ${esc(h.where)}` : ""}</span>${said}<span class="r-phit-t${h.field === "text" || h.field === "sel" ? " quote" : ""}">${markWords(h.text, q)}</span></button>`;
      }).join("");
    }
    return html;
  }
  function openHit(i) {
    go(deep.hits[i]);
  }
  // A note or a talk opens at its place in its book (the panel's search; «Нотатки», scratch.js).
  function go(h) {
    if (!h) return;
    panel(false);
    if (h.kind === "paperChat") {
      openBook(h.book);
      // The question comes unfolded once the book's talks are there.
      let tries = 0;
      const unfold = () => {
        const el = document.querySelector(`.pp-chat[data-chat="${CSS.escape(h.id)}"]`);
        if (!el) return ++tries < 30 && setTimeout(unfold, 100);
        if (!el.classList.contains("open")) el.querySelector(".pp-chat-q")?.click();
        setTimeout(() => document.querySelector(`.pp-chat[data-chat="${CSS.escape(h.id)}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" }), 50);
      };
      return unfold();
    }
    if (h.kind === "chat" && typeof window.openChatInBook === "function") return window.openChatInBook(h.book, h.id);
    if (h.kind === "note" && lib.books.find((b) => b.path === h.book)?.paper) return openBook(h.book);
    if (h.cfi) return openNoteInBook(h.book, { id: h.id, cfi: h.cfi, posKey: h.posKey });
    openBook(h.book);
  }

  const prow = (b) => `<button type="button" class="r-prow${b.unavailable ? " unavailable" : ""}" data-open="${esc(b.path)}">${rcover(b)}<span class="r-prow-t">${esc(b.title)}</span><span class="r-prow-p">${b.finished ? "✓" : b.paper ? (b.page ? `стор. ${b.page}` : "") : b.pct != null ? `${b.pct}%` : ""}</span></button>`;

  function renderHome() {
    if (!lib) return; // the skeleton stays until the library arrives
    $("#shell").dataset.page = page;
    $(".r-add-btn").hidden = !!settings.guest;
    renderPanel();
    // Typing the page or a note on a paper book's page: the library arriving again must not redraw it under the finger.
    if (page === "paper" && document.activeElement?.closest?.(".pp") && homeHtml) return;
    if (page === "scratch" && window.Scratch.typing() && homeHtml) return;
    const pb = page === "paper" && lib.books.find((b) => b.path === paperPath);
    if (page === "paper" && !pb) page = "home";
    const html = pb ? window.Paper.pageHtml(pb) : page === "add" ? addPageHtml() : page === "journey" ? journeyHtml() : page === "scratch" ? window.Scratch.html() : page === "want" ? window.Want.html() : page === "shelves" ? window.Shelves.html() : page === "admin" ? adminHtml() : page === "how" ? howHtml() : homePageHtml();
    // The library comes twice (the saved copy, then the server's) and again when the app comes back to the
    // front: drawing the same covers anew made them flicker, so an unchanged screen is left alone.
    if (html === homeHtml) return;
    homeHtml = html;
    // Going to «Додати книжку» and back drew every cover anew: each one showed its typographic stand-in for a
    // moment before the picture came (Max 2026-11-05, «подьоргування»). The page left is kept as it was and put
    // back when it comes back unchanged.
    const body = $("#home-body");
    if (drawn.html && drawn.page !== "paper" && body.firstChild) {
      const f = document.createDocumentFragment();
      f.append(...body.childNodes);
      kept.set(drawn.page, { html: drawn.html, f });
    }
    const k = kept.get(page);
    // replaceChildren, not append: coming back from a paper book its page is still in the body (Max 2026-11-06).
    if (k && k.html === html) body.replaceChildren(k.f);
    else body.innerHTML = html;
    kept.delete(page);
    drawn = { page, html };
  }

  // An empty shelf (Max 2026-11-18, «Level up your reading», variant 1A of the canvas; texts
  // Max's variant B of 2026-11-19): what the reader is for, the button for one's own book, a paper one, and four
  // classics whose «Словничок» is ready.
  const START_PICKS = ["kulish-chorna-rada.epub", "kotliarevsky-eneida.epub", "kotsiubynskyi-tini-zabutykh-predkiv.epub", "kobylianska-zemlia.epub"];
  function startHtml() {
    const free = lib.free || [];
    const glossed = new Set(settings.glossaries || []);
    const picks = [...START_PICKS.map((n) => free.find((b) => b.path === n)), ...free.filter((b) => glossed.has(b.path) && /класика/i.test(b.group || ""))]
      .filter((b, i, a) => b && glossed.has(b.path) && a.indexOf(b) === i)
      .slice(0, 4);
    return `<section class="r-start">
      <h1 class="r-start-t">Вітаємо в Chytai!</h1>
      <p class="r-start-p">Читайте книжки разом з нашим <span class="r-nowrap">AI-помічником</span>. Він пояснює складні або застарілі слова, дає зручний переклад та пояснення в контексті.</p>
      <button class="r-pill r-start-add" data-act="add"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V5M7 10l5-5 5 5M5 20h14"/></svg>Додати книжку</button>
      <p class="r-start-f">Формати EPUB, PDF, MOBI</p>
      <button class="r-pill-line r-start-paper" data-act="cover-photo"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>Додати паперову книжку</button>
      <button class="r-link r-start-how" data-page="how">Як це працює</button></section>
      ${picks.length ? `<section class="r-start-free">${head("Або почніть з класики", "", false)}
        <div class="r-grid r-start-grid">${picks.map((b) => card(b, "", false)).join("")}</div>
        <button class="r-link r-start-all" data-act="free-shelf">Уся вільна полиця →</button></section>` : ""}`;
  }

  // app.chytai.org.ua/?new shows the empty shelf's start over one's own books (Max 2026-11-18: to look at it without a
  // new account); nothing else changes, and the next load without it is the usual home.
  const PREVIEW_START = new URLSearchParams(location.search).has("new");
  function homePageHtml() {
    const books = myBooks();
    if (!settings.guest && (!books.length || PREVIEW_START)) return startHtml();
    if (!settings.guest) setTimeout(() => fetchAboutAhead(books), 3000);
    const cur = nowBook(books);
    let html = "";
    if (cur?.paper) {
      const meta = [esc(author(cur)), cur.page ? `стор. ${cur.page}` : ""].filter(Boolean).join(" · ");
      html += `<section class="r-now">${head("Читаю зараз", "", true)}
        <div class="r-now-row"><button class="r-now-cover" data-open="${esc(cur.path)}">${rcover(cur)}</button>
          <div class="r-now-text"><span class="pp-tag">Паперова</span><h3 class="r-now-t">${esc(cur.title)}</h3>
            <p class="r-now-meta">${meta}</p>
            <button class="r-pill r-wide" data-open="${esc(cur.path)}">Продовжити читання</button></div></div>
        <button class="r-pill r-narrow" data-open="${esc(cur.path)}">Продовжити читання</button></section>`;
    } else if (cur) {
      const where = [cur.chapter || (cur.parts ? `розділ ${cur.part} з ${cur.parts}` : "")].filter(Boolean).map(esc).join("");
      html += `<section class="r-now">${head("Читаю зараз", "", true)}
        <div class="r-now-row"><button class="r-now-cover" data-open="${esc(cur.path)}">${rcover(cur)}</button>
          <div class="r-now-text"><h3 class="r-now-t">${esc(cur.title)}</h3>
            <div class="r-progress"><span style="width:${cur.pct}%"></span></div>
            <p class="r-now-meta"><b>${cur.pct}%</b>${where ? ` · ${where}` : ""}</p>
            <button class="r-pill r-wide" data-open="${esc(cur.path)}">Продовжити читання</button></div></div>
        <button class="r-pill r-narrow" data-open="${esc(cur.path)}">Продовжити читання</button></section>`;
    }
    // The book on top is also the first in «Мої книжки» (Max 2026-11-22, bot report №23): its «⋯» is there, as on every
    // other book, and «Читаю» counts it. The cover on top only opens the book (no long press).
    const rest = books;
    // «Читаю» (the first tab, once «Усі») is every book not finished; «Прочитані» has those (Max, 2026-11-17).
    const groups = { all: rest.filter((b) => !b.finished), reading: rest.filter(isReading), new: rest.filter(isNewBook), done: rest.filter((b) => b.finished), paper: rest.filter((b) => b.paper) };
    // Every book is drawn once and a filter only hides cards: drawing the grid anew on each click reloaded
    // all the covers, which flickered on a slow connection (Max).
    const gcls = (b) => ["reading", "new", "done", "paper"].filter((k) => groups[k].includes(b)).map((k) => ` g-${k}`).join("");
    const empty = (k) => (groups[k].length ? "" : `<p class="r-empty g-${k}">Тут поки порожньо.</p>`);
    const plus = settings.guest || books.length ? "" : `<button class="r-card r-plus" data-page="add"><span class="r-plus-box"><b>+</b><span>Додати книжку</span><small>EPUB, PDF, MOBI</small></span></button>`;
    html += `<section class="r-mine">${head(`Мої книжки · ${books.length}`, books.length ? tabs([["all", "Читаю", groups.all.length], ["new", "Не початі", groups.new.length], ["done", "Прочитані", groups.done.length], ...(groups.paper.length ? [["paper", "Паперові", groups.paper.length]] : [])], homeFilter, "data-filter") + viewSwitch() : "", !cur)}
      <div class="r-filtered" data-show="${homeFilter}"><div class="r-grid${homeView === "list" ? " r-list" : ""}">${homeView === "list" && rest.length ? listHead() : ""}${(homeView === "list" ? [...rest].sort(sorters[homeSort] || sorters.opened) : rest).map((b) => card(b, homeView === "list" ? rowCols(b) + rowStatus(b) : mark(b), true, gcls(b))).join("")}${plus}</div>
      ${rest.length ? empty("all") : ""}${empty("new")}${empty("done")}${empty("paper")}</div></section>`;
    return html;
  }

  // «Статистика» (Max 2026-11-19: «всі книжки що я читав, скільки робив пояснення… почнемо з простого»): a few numbers,
  // the months (what was finished, how much asked), and every book with its explanations as a bar. Minutes of reading
  // (Max 2026-11-19 by the bot: in place of the «Словничок» words, and beside the explanations), no streaks or goals. GET /api/journey has the counts; titles and covers are the
  // library's. Asked anew each time the page opens.
  let journey = null; // the last answer, or "…" while asked
  function loadJourney() {
    if (journey === "…") return;
    const was = journey;
    journey = was || "…";
    window.reader.journey?.().then((j) => {
      journey = j || (was && was !== "…" ? was : null);
      if (page === "journey") (homeHtml = ""), renderHome();
    });
  }
  // «Адмінка» (Max 2026-11-20): the owner's stats of the whole reader, drawn by admin-view.js from GET /api/admin.
  // Asked anew each time the page opens; app.chytai.org.ua/admin (and /?admin) opens it.
  let admin = null; // the last answer, or "…" while asked
  function loadAdmin() {
    if (admin === "…") return;
    const was = admin;
    admin = was || "…";
    window.reader.admin?.().then((s) => {
      admin = s || (was && was !== "…" ? was : null);
      if (page === "admin") (homeHtml = ""), renderHome();
    });
  }
  function adminHtml() {
    if (!admin || admin === "…") return `<section class="r-jour">${admin === "…" ? `<p class="r-empty"><span class="spinner"></span>Збираємо…</p>` : `<p class="r-empty">Читалка не віддала числа. Спробуйте ще раз.</p>`}</section>`;
    return window.AdminView.html(admin);
  }
  async function adminOff(el) {
    el.disabled = true;
    const r = await window.reader.adminOff?.(el.dataset.id, !!el.dataset.off);
    const u = r?.ok && admin?.users?.find((x) => x.id === el.dataset.id);
    if (u) u.off = r.off;
    homeHtml = "";
    renderHome();
  }
  const MONTHS = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень", "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];
  const num = (n) => Number(n || 0).toLocaleString("uk-UA");
  // «Як це працює» (Max 2026-11-19, variant C of the canvas): paper books in the reader weren't obvious, so one screen
  // shows how: a page photographed and circled, the answer, and what else works. Opened from the empty shelf.
  function howHtml() {
    const row = (icon, b, rest) => `<li><span class="r-how-i"><svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg></span><span><b>${b}</b> ${rest}</span></li>`;
    return `<section class="r-how">
      <h1 class="r-jh">Як це працює</h1>
      <h2 class="r-how-t">Читаєте на папері?</h2>
      <p class="r-start-p">Сфотографуйте сторінку й обведіть, що незрозуміло.</p>
      <img class="r-how-img" src="how-paper.jpg" width="780" height="258" alt="Фото сторінки, абзац обведено червоним" />
      <div class="r-how-ans"><span>Пояснення</span>Це повінь після підриву Каховської ГЕС у червні 2023-го. Рятувальники поїхали, коли вода спала, а місцеві ще тижнями розбирали завали.</div>
      <ul class="r-how-list">
        ${row('<path d="M6 3h9l4 4v14H6z"/><path d="M10 13h5M10 17h3"/>', "Сторінку", "бачимо з фото, тож без спойлерів.")}
        ${row('<path d="M7 7h4v4c0 3-2 5-4 6M15 7h4v4c0 3-2 5-4 6"/>', "Цитату", "з фото збережемо в нотатки.")}
        ${row('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6M12 17h.01"/>', "Питайте", "про книжку текстом чи голосом.")}
        ${row('<path d="M6 4h12v16l-6-4-6 4z"/>', "Усе лишається", "при книжці у вашому акаунті.")}
      </ul>
      <button class="r-pill r-how-add" data-act="cover-photo"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>Додати паперову книжку</button>
    </section>`;
  }

  function journeyHtml() {
    if (!journey || journey === "…") return `<section class="r-jour">${journey === "…" ? `<p class="r-empty"><span class="spinner"></span>Збираємо…</p>` : `<p class="r-empty">Без мережі статистики не показати.</p>`}</section>`;
    const j = journey;
    const all = [...lib.books, ...(lib.free || [])];
    const byPath = new Map(all.map((b) => [b.path, b]));
    const stat = (name) => j.books[name] || { explains: 0, translations: 0, notes: 0, sec: 0, finishedAt: 0 };
    const mins = (sec) => (sec >= 60 ? `${num(Math.round(sec / 60))} хв` : "");
    const asked = (s) => s.explains + s.translations;
    const done = lib.books.filter((b) => b.finished);
    const notes = Object.values(j.books).reduce((n, s) => n + s.notes, 0);
    // Every book read since the start: the months' books that are still in the library (Max 2026-11-19: «25 книг з 14 жовтня»).
    const read = new Set(j.months.flatMap((m) => [...m.finished, ...(m.read || [])]).filter((p) => byPath.has(p)));
    const tile = (n, label) => `<div class="r-jt"><b>${num(n)}</b><span>${label}</span></div>`;
    const since = j.since ? new Date(j.since).toLocaleDateString("uk-UA", { day: "numeric", month: "long", year: new Date(j.since).getFullYear() === new Date().getFullYear() ? undefined : "numeric" }) : "";
    let html = `<section class="r-jour"><h1 class="r-jh">Статистика</h1>
      ${since ? `<p class="r-jsince">${read.size ? `${num(read.size)} ${plural(read.size, "книга", "книги", "книг")}` : "У Читалці"} з ${esc(since)}</p>` : ""}
      <div class="r-jtiles">${tile(done.length, "прочитано")}${tile(j.explains, plural(j.explains, "пояснення", "пояснення", "пояснень"))}${tile(notes, plural(notes, "нотатка", "нотатки", "нотаток"))}${tile(j.minutes || 0, `${plural(j.minutes || 0, "хвилина", "хвилини", "хвилин")} читання`)}</div></section>`;
    // By month: a line of counts and the covers of what was finished.
    const months = j.months.filter((m) => m.explains || m.notes || (m.read || m.finished).some((p) => byPath.has(p)));
    if (months.length) {
      html += `<section class="r-jmonths">${head("По місяцях", "", false)}${months.map((m) => {
        const [y, mm] = m.month.split("-").map(Number);
        // Every book read that month, not only those finished; the last opened first (Max 2026-11-20).
        const done = new Set(m.finished);
        const fin = [...new Set([...m.finished, ...(m.read || [])])].map((p) => byPath.get(p)).filter(Boolean).sort((x, y) => lastTouched(y) - lastTouched(x));
        const finished = fin.filter((b) => done.has(b.path)).length;
        const bits = [fin.length ? `${fin.length} ${plural(fin.length, "книга", "книги", "книг")}` : "", finished ? `${finished} прочитано` : "", mins(m.sec), m.explains ? `${num(m.explains)} ${plural(m.explains, "пояснення", "пояснення", "пояснень")}` : "", m.notes ? `${num(m.notes)} ${plural(m.notes, "нотатка", "нотатки", "нотаток")}` : ""].filter(Boolean);
        return `<div class="r-jm"><h3>${MONTHS[mm - 1]}${y !== new Date().getFullYear() ? ` ${y}` : ""}</h3><p>${bits.join(" · ")}</p>
          ${fin.length ? `<div class="r-jm-covers">${fin.map((b) => `<button class="r-jm-c" data-open="${esc(b.path)}" title="${esc(b.title)}">${rcover(b)}</button>`).join("")}</div>` : ""}</div>`;
      }).join("")}</section>`;
    }
    // Every book read or asked about, the most asked first; the bar is its explanations against the most asked one.
    const rows = all.filter((b, i, a) => a.findIndex((x) => x.path === b.path) === i && (b.finished || asked(stat(b.path)) || stat(b.path).notes || (b.paper ? b.openedAt : b.pct >= 1)))
      .sort((x, y) => asked(stat(y.path)) - asked(stat(x.path)) || stat(y.path).notes - stat(x.path).notes || (stat(y.path).finishedAt || lastTouched(y)) - (stat(x.path).finishedAt || lastTouched(x)));
    const top = Math.max(1, ...rows.map((b) => asked(stat(b.path))));
    if (rows.length) {
      html += `<section class="r-jbooks">${head(`Книжки · ${rows.length}`, "", false)}${rows.map((b) => {
        const s = stat(b.path);
        const where = b.finished ? `прочитано${s.finishedAt ? ` ${when(s.finishedAt)}` : ""}` : b.paper ? (b.page ? `стор. ${b.page}` : "паперова") : b.pct > 0 ? `${b.pct}%` : "";
        const counts = [mins(s.sec), s.explains ? `${num(s.explains)} ${plural(s.explains, "пояснення", "пояснення", "пояснень")}` : "", s.translations ? `${num(s.translations)} ${plural(s.translations, "переклад", "переклади", "перекладів")}` : "", s.notes ? `${num(s.notes)} ${plural(s.notes, "нотатка", "нотатки", "нотаток")}` : ""].filter(Boolean).join(" · ");
        return `<button class="r-jb" data-open="${esc(b.path)}">${rcover(b)}<span class="r-jb-t"><b>${esc(b.title)}</b><span class="r-jb-a">${esc([author(b), where].filter(Boolean).join(" · "))}</span>
          ${asked(s) ? `<span class="r-jb-bar"><i style="width:${Math.max(2, Math.round((100 * asked(s)) / top))}%"></i></span>` : ""}${counts ? `<span class="r-jb-n">${counts}</span>` : ""}</span></button>`;
      }).join("")}</section>`;
    }
    return html;
  }

  // «Додати книжку»: a file of your own, the free shelf, and what the search finds there and in the catalog.
  function addPageHtml() {
    const q = norm(addQuery);
    return q ? addFoundHtml(q) : addStartHtml();
  }

  const freeOf = () => (lib.free || []).concat(lib.books.filter((b) => b.free));
  function addStartHtml() {
    const free = lib.free || [];
    const newest = [...free].sort((x, y) => y.order - x.order);
    // «Вільна полиця» is one row in «Де ще шукаємо»; it opens the whole shelf under the list (Max 2026-11-17:
    // the app is about one's own books, the cover strip took a screen).
    let freeHtml = "";
    if (free.length && freeAll) {
      const fcls = (b) => (newest.indexOf(b) < 16 ? " g-new" : "") + (b.group === "Для дітей" ? " g-kids" : "") + (/класика/i.test(b.group) ? " g-classics" : "");
      freeHtml = `<section class="r-free" id="r-free">${head(`Вільна полиця · ${free.length} <span class="r-sub">Можна читати безкоштовно</span>`, tabs([["new", "Нові"], ["kids", "Для дітей"], ["classics", "Класика"], ["all", "Усі"]], freeTab, "data-free-tab"))}
        <p class="r-sub-phone">Можна читати безкоштовно</p>
        <div class="r-filtered" data-show="${freeTab}"><div class="r-grid r-free-grid">${newest.map((b) => card(b, "", false, fcls(b))).join("")}</div></div></section>`;
    }
    const freeRow = free.length ? `<button class="r-where-row" data-act="free-all" aria-expanded="${freeAll}"><span>Вільна полиця · ${free.length}</span><small>${freeAll ? "згорнути" : "читати безкоштовно"}</small></button>` : "";
    // The empty shelf's two buttons (Max 2026-11-22, variant C of the canvas, bot idea №25): what the helper does in one
    // line, a file, a paper book and «Як це працює»; then the stores. A file dropped anywhere on the page is added.
    return `<div class="r-add-c">
      <section class="r-start r-add-two">
        <p class="r-start-p">Додайте книжку з файлу й читайте її тут.</p>
        <button class="r-pill r-start-add" data-act="add"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V5M7 10l5-5 5 5M5 20h14"/></svg>Вибрати файл</button>
        <p class="r-start-f">EPUB, PDF, MOBI<span class="r-dt"> · або перетягніть файл сюди</span></p>
        <button class="r-pill-line r-start-paper" data-act="cover-photo"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>Додати паперову книжку</button>
        <button class="r-link r-start-how" data-page="how">Як це працює</button></section>
      <section class="r-where">${head("Де ще шукаємо", "", true)}
        ${shopRow("yakaboo", "Yakaboo", yakabooHtml)}
        ${shopRow("bookua", "Book.ua", bookuaHtml)}
        ${freeRow}</section>
      ${freeHtml}
    </div>`;
  }

  // A store's row in «Де ще шукаємо»: its name, and «як додати» opens the steps under it.
  function shopRow(key, name, steps) {
    const open = shopOpen === key;
    return `<button class="r-where-row r-yak-row" data-act="${key}" aria-expanded="${open}"><span>${name}</span><small>${open ? "згорнути" : "як додати"}</small></button>${open ? steps() : ""}`;
  }

  // Books bought on Yakaboo (Max 2026-11-08): no API, but «Мої книги» there gives each e-book as a file.
  // Books the publisher keeps to Yakaboo's own app have no buttons and can't be brought here.
  function yakabooHtml() {
    return `<ol class="r-yak">
      <li>Відкрийте <a href="https://www.yakaboo.ua/ua/my-account/library" target="_blank" rel="noopener">«Мої книги» на Yakaboo ↗</a></li>
      <li>Наведіть на книжку і натисніть <b>epub</b>.<span class="r-yak-card" aria-hidden="true"><span class="r-yak-t">Тигролови</span><span class="r-yak-a">Іван Багряний</span><span class="r-yak-f"><b>epub</b><i>fb2</i><i>mobi</i><i>pdf</i></span></span></li>
      <li><button class="r-link" data-act="add">Додайте файл сюди</button>. Можна кілька одразу.</li></ol>
      <p class="r-drop-note">Книжки «лише в застосунку Yakaboo» скачати не можна.</p>`;
  }

  // Books bought on Book.ua (Max 2026-11-16): «Моя електронна бібліотека» gives each one as a file without DRM
  // («Файл» → EPUB → «Завантажити»); a few illustrated ones are PDF only, the reader takes those too.
  function bookuaHtml() {
    return `<ol class="r-yak">
      <li>Відкрийте <a href="https://book.ua/cabinet/library" target="_blank" rel="noopener">«Моя електронна бібліотека» на Book.ua ↗</a></li>
      <li>Під книжкою натисніть <b>Файл</b>, виберіть <b>EPUB</b> і «Завантажити».<span class="r-yak-card" aria-hidden="true"><span class="r-yak-t">Тигролови</span><span class="r-yak-a">Іван Багряний</span><span class="r-yak-f"><b>Файл</b><i>Kindle</i></span></span></li>
      <li><button class="r-link" data-act="add">Додайте файл сюди</button>. Можна кілька одразу.</li></ol>`;
  }

  function addFoundHtml(q) {
    const mine = new Set(lib.books.map((b) => b.path));
    const free = freeOf().filter((b, i, a) => a.findIndex((x) => x.path === b.path) === i && matches(b, q));
    const cat = found.get(q);
    const group = (key, title, rows, extra = "") => {
      const open = more6.has(key);
      const shown = open ? rows : rows.slice(0, 3);
      return `<section class="r-fgroup">${head(title, "", false)}<div class="r-frows">${shown.join("")}</div>
        ${rows.length > shown.length ? `<button class="r-more-link" data-more="${key}">Ще ${rows.length - shown.length} →</button>` : ""}${extra}</section>`;
    };
    const freeRows = free.map((b) => `<div class="r-frow">${`<button class="r-frow-c" data-open="${esc(b.path)}">${rcover(b)}</button>`}
      <span class="r-frow-x"><span class="r-frow-t">${esc(b.title)}</span><span class="r-frow-a">${esc(author(b))}</span></span>
      ${mine.has(b.path) ? `<button class="r-frow-go done" data-open="${esc(b.path)}">У моїх</button>` : `<button class="r-frow-go" data-take="${esc(b.path)}">Додати</button>`}</div>`);
    let html = "";
    if (free.length) html += group("free", `Вільна полиця · ${free.length}`, freeRows);
    if (cat === "…" || cat == null) html += `<section class="r-fgroup">${head("Каталог Chytai", "", false)}<p class="r-empty">Шукаю…</p></section>`;
    else if (cat.error) html += `<section class="r-fgroup">${head("Каталог Chytai", "", false)}<p class="r-empty">${navigator.onLine ? "Каталог зараз не відповідає." : "Немає з'єднання."}</p></section>`;
    else if (cat.books.length) {
      const paperOf = new Map(lib.books.filter((b) => b.paper && !b.aside && b.href).map((b) => [b.href, b.path]));
      const rows = cat.books.map((b, i) => `<div class="r-frow r-frow-cat"><a class="r-frow-c" href="${esc(b.href)}" target="_blank" rel="noopener">${rcover({ title: b.title, authors: [b.author] }, b.cover || null)}</a>
        <a class="r-frow-x" href="${esc(b.href)}" target="_blank" rel="noopener"><span class="r-frow-t">${esc(b.title)}</span><span class="r-frow-a">${esc([b.author, b.year].filter(Boolean).join(" · "))}</span></a>
        <span class="r-frow-two">${paperOf.has(b.href) ? `<button class="r-frow-go done" data-open="${esc(paperOf.get(b.href))}">Паперова в моїх</button>` : `<button class="r-frow-go" data-paper-add="${i}">Читаю паперову</button>`}
          <a class="r-frow-go plain" href="${esc(b.href)}" target="_blank" rel="noopener">Де взяти ↗</a></span></div>`);
      html += group("cat", `Каталог Chytai · ${cat.books.length}`, rows, `<p class="r-fnote">Купили електронну? <button class="r-link" data-act="add">Додайте файл</button>, і вона буде тут.</p>`);
    }
    if (!free.length && cat && cat !== "…" && !cat.error && !cat.books.length)
      html += `<p class="r-empty">Нічого не знайшлося. <a class="r-link" href="https://chytai.org.ua/search?q=${encodeURIComponent(addQuery.trim())}" target="_blank" rel="noopener">Шукати на chytai.org.ua ↗</a></p>`;
    html += `<p class="r-fnote r-fpaper">Читаєте на папері, а книжки нема? <button class="r-link" data-act="cover-photo">Сфотографуйте обкладинку</button></p>`;
    return `<div class="r-found">${html}</div>`;
  }

  let addTimer = 0;
  $("#r-aq").addEventListener("input", () => {
    addQuery = $("#r-aq").value;
    more6.clear();
    clearTimeout(addTimer);
    addTimer = setTimeout(() => {
      const q = norm(addQuery);
      renderHome();
      if (q.length < 2 || found.has(q) || !window.reader.catalogFind) return q.length < 2 && q && (found.set(q, { books: [] }), renderHome());
      found.set(q, "…");
      window.reader.catalogFind(addQuery.trim())
        .then((d) => found.set(q, { books: d.books || [] }))
        .catch(() => found.delete(q) || found.set(q, { error: true }))
        .finally(() => {
          if (found.get(q)?.error) setTimeout(() => found.get(q)?.error && found.delete(q), 30000);
          if (page === "add" && norm(addQuery) === q) renderHome();
        });
    }, 200);
  });
  $("#r-aq").addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    if ($("#r-aq").value) ($("#r-aq").value = ""), $("#r-aq").dispatchEvent(new Event("input"));
    else backHome();
  });
  $("#r-pq").addEventListener("input", () => (renderPanel(), askDeep()));
  $("#r-pq").addEventListener("focus", () => (pqCounted = false));
  $("#r-pq-clear").onclick = () => (($("#r-pq").value = ""), renderPanel(), askDeep(), $("#r-pq").focus());
  $("#r-pq").addEventListener("keydown", (e) => {
    if (e.key === "Escape") e.preventDefault(), ($("#r-pq").value = ""), renderPanel(), $("#r-pq").blur(), panel(false);
    if (e.key === "Enter") $("#r-pfound [data-open]")?.click();
  });
  // «Додати» on a free-shelf book: it joins your books and the button says so.
  async function takeBook(path, btn) {
    btn.disabled = true;
    try {
      await window.reader.libraryTake(path);
    } catch (err) {
      btn.disabled = false;
      return showNotice(err instanceof TypeError ? "Немає з'єднання: додати книжку можна лише онлайн." : err.message, false);
    }
    const b = (lib.free || []).find((x) => x.path === path);
    if (b && !lib.books.some((x) => x.path === path)) lib.books.push({ ...b, addedAt: Date.now(), aside: false });
    homeHtml = "";
    renderHome();
    window.Library.data(true).then((d) => ((lib = d), renderHome())).catch(() => {});
  }

  $("#home").addEventListener("click", (e) => {
    const m = e.target.closest("[data-more]");
    if (m) return more6.add(m.dataset.more), renderHome();
    const so = e.target.closest("[data-sort]");
    if (so) {
      homeSort = so.dataset.sort;
      try { localStorage.setItem("chytai-home-sort", homeSort); } catch {}
      return renderHome();
    }
    const v = e.target.closest("[data-view]");
    if (v) {
      homeView = v.dataset.view;
      try { localStorage.setItem("chytai-home-view", homeView); } catch {}
      return renderHome();
    }
    const f = e.target.closest("[data-filter]");
    const t = e.target.closest("[data-free-tab]");
    if (!f && !t) return;
    if (f) homeFilter = f.dataset.filter;
    else freeTab = t.dataset.freeTab;
    // Only the cards' visibility changes; the page's HTML is remembered as if drawn anew, so the next
    // render with the same books leaves the covers alone.
    const tab = f || t;
    for (const b of tab.parentElement.children) b.classList.toggle("on", b === tab);
    tab.closest("section").querySelector(".r-filtered").dataset.show = f ? homeFilter : freeTab;
    homeHtml = page === "add" ? addPageHtml() : page === "journey" ? journeyHtml() : page === "scratch" ? window.Scratch.html() : page === "want" ? window.Want.html() : page === "shelves" ? window.Shelves.html() : page === "admin" ? adminHtml() : page === "how" ? howHtml() : homePageHtml();
    drawn.html = homeHtml;
  });

  // The phone's panel: a tap on the page beside it closes it; in the app a swipe from the left edge opens it
  // and one to the left closes it.
  $("#shell-main").addEventListener("click", (e) => {
    if (!$("#shell").classList.contains("panel-open")) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    panel(false);
  }, true);
  // The page follows the finger (Max 2026-11-02: a swipe only bounced the page down and then the panel jumped
  // open): a sideways drag moves it, and on release it settles open or closed.
  // 318 px, narrower on a narrow screen (Android's bigger system font zooms the page, bug №24): a strip of the page stays.
  const panelW = () => Math.min(318, innerWidth - 56);
  let drag = null;
  // Going between «Мої книжки» and «Додати книжку» on a phone (Max 2026-11-05: the page jerked): the other page
  // is laid beside this one and both move together, under the finger or on a tap of «+» / «‹», so the new page
  // is already there when the old one leaves. It is the page as it was left (kept), or drawn fresh the first time.
  function underPage(target) {
    const k = kept.get(target);
    const html = k?.html || (target === "add" ? addPageHtml() : homePageHtml());
    const under = document.createElement("div");
    under.id = "shell-under";
    under.dataset.page = target;
    under.setAttribute("aria-hidden", "true");
    under.inert = true;
    // Only «Мої книжки» / «Додати книжку» is copied, not every other view with its pictures (memory on iPhone).
    const views = $("#shell-views").cloneNode(false);
    views.append($("#home").cloneNode(true));
    const body = views.querySelector("#home-body");
    body.textContent = "";
    for (const el of views.querySelectorAll("[id]")) if (el !== body && el.id !== "home") el.removeAttribute("id");
    if (k?.html === html) body.append(k.f);
    else body.innerHTML = html;
    kept.delete(target);
    under.append(views);
    $("#shell-main").after(under);
    $("#shell").classList.add("page-drag");
    return { under, body, html, target };
  }
  function movePages(pos, kind) {
    const w = innerWidth;
    $("#shell-main").style.transform = pos ? `translateX(${pos}px)` : "";
    $("#shell-under").style.transform = `translateX(${kind === "add" ? w + pos : pos - w}px)`;
  }
  function settlePages(kind, pos, go, u) {
    const main = $("#shell-main");
    const under = u.under;
    const w = innerWidth;
    const end = go ? (kind === "add" ? -w : w) : 0;
    const left = Math.abs(end - pos) / w;
    const ms = Math.round(140 + 160 * left);
    for (const el of [main, under]) el.style.transition = `transform ${ms}ms cubic-bezier(.2, .8, .2, 1)`;
    void main.offsetWidth;
    movePages(end, kind);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      // The page beside goes back to being kept; on «go» it is put in place at once, the same nodes.
      const f = document.createDocumentFragment();
      f.append(...u.body.childNodes);
      kept.set(u.target, { html: u.html, f });
      if (go) {
        const back = u.target === "home" && history.state?.rp === page;
        setPage(u.target, { push: u.target !== "home" });
        if (back) history.back();
      }
      for (const el of [main, under]) el.style.transition = "";
      main.style.transform = "";
      under.remove();
      // The page takes its place now, while page-drag still holds the transition off: else the style flush that comes
      // with the class's removal animates it from beside the screen back in (Max 2026-11-18, Android: «стрибає»).
      void main.offsetWidth;
      requestAnimationFrame(() => $("#shell").classList.remove("page-drag"));
    };
    main.addEventListener("transitionend", (e) => e.target === main && finish(), { once: false });
    setTimeout(finish, ms + 80);
  }
  function slidePage(target) {
    if (!phone() || matchMedia("(prefers-reduced-motion: reduce)").matches || $("#shell").classList.contains("panel-open")) return false;
    const u = underPage(target);
    const kind = target === "add" ? "add" : "back";
    movePages(0, kind);
    settlePages(kind, 0, true, u);
    return true;
  }

  // In the app a swipe from the right edge opens «Додати книжку», and on it one from the left edge comes back
  // (Max 2026-11-03).
  const EDGE = 24;
  $("#shell").addEventListener("touchstart", (e) => {
    const x = e.touches[0].clientX;
    const open = $("#shell").classList.contains("panel-open");
    const app = document.documentElement.classList.contains("in-app");
    const ok = phone() && isOpen() && !document.querySelector("dialog[open]");
    // The panel is search on a phone now (variant А): no swipe opens or drags it.
    const kind = !ok || open ? null
      : app && page === "add" && x < EDGE ? "back"
      : app && page === "home" && !settings.guest && x > innerWidth - EDGE ? "add"
      : null;
    drag = kind ? { kind, x, y: e.touches[0].clientY, open, dir: null, pos: open ? panelW() : 0, t: Date.now() } : null;
  }, { passive: true });
  $("#shell").addEventListener("touchmove", (e) => {
    if (!drag) return;
    const dx = e.touches[0].clientX - drag.x;
    const dy = e.touches[0].clientY - drag.y;
    if (!drag.dir) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      drag.dir = Math.abs(dx) > Math.abs(dy) ? "h" : "v";
      if (drag.dir === "v") return (drag = null);
      $("#shell").classList.add(drag.kind === "panel" ? "panel-drag" : "page-drag");
    }
    e.preventDefault();
    if (drag.kind !== "panel") {
      drag.pos = drag.kind === "add" ? Math.min(0, dx) : Math.max(0, dx);
      if (!drag.under) drag.under = underPage(drag.kind === "add" ? "add" : "home");
      movePages(drag.pos, drag.kind);
      return;
    }
    drag.pos = Math.max(0, Math.min(panelW(), (drag.open ? panelW() : 0) + dx));
    $("#shell-main").style.transform = `translateX(${drag.pos}px)`;
  }, { passive: false });
  // A cancelled touch goes back to where it was: on Android the system's back gesture from either edge starts as our
  // swipe and is then taken away (touchcancel), and going on with it opened «Додати книжку» before back closed it
  // again (bug report №25, 2026-11-21).
  const endDrag = (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.dir !== "h") return;
    const cancel = e?.type === "touchcancel";
    const fast = Date.now() - d.t < 250;
    if (d.kind !== "panel") {
      const go = !cancel && Math.abs(d.pos) > (fast ? 30 : innerWidth / 3);
      if (d.under) settlePages(d.kind, d.pos, go, d.under);
      else $("#shell").classList.remove("page-drag"), ($("#shell-main").style.transform = "");
      return;
    }
    const open = cancel ? d.open : fast ? (d.open ? d.pos > panelW() - 40 : d.pos > 40) : d.pos > panelW() / 2;
    $("#shell").classList.remove("panel-drag");
    $("#shell-main").style.transform = "";
    panel(open);
  };
  $("#shell").addEventListener("touchend", endDrag, { passive: true });
  $("#shell").addEventListener("touchcancel", endDrag, { passive: true });

  // A file dropped anywhere on the page is added to your books; while one is dragged over, the page says so.
  let dragDepth = 0;
  const dragging = (e) => !settings.guest && e.dataTransfer?.types?.includes("Files");
  $("#shell").addEventListener("dragenter", (e) => dragging(e) && (dragDepth++, $("#shell").classList.add("r-drag")));
  $("#shell").addEventListener("dragleave", (e) => dragging(e) && --dragDepth <= 0 && ((dragDepth = 0), $("#shell").classList.remove("r-drag")));
  $("#shell").addEventListener("dragover", (e) => dragging(e) && e.preventDefault());
  $("#shell").addEventListener("drop", async (e) => {
    dragDepth = 0;
    $("#shell").classList.remove("r-drag");
    if (settings.guest || !e.dataTransfer?.files?.length) return;
    e.preventDefault();
    const files = [...e.dataTransfer.files];
    // One book opens; a batch stays here, with its progress in the notice (Max, 2026-11-10).
    if (files.length === 1 && BOOK_EXT.test(files[0].name)) return window.reader.openPath(window.reader.pathForFile(files[0]));
    if (await window.reader.uploadFiles?.(files)) (homeHtml = ""), window.Library.data(true).then((d) => ((lib = d), render()));
  });

  // ---------- Clicks ----------

  function openBook(path) {
    const b = lib?.books.find((x) => x.path === path) || lib?.free?.find((x) => x.path === path);
    if (b) b.seen = true;
    // Back from the book is your books, not the page it was found on.
    if (page === "add") {
      page = "home";
      homeHtml = "";
      if (history.state?.rp === "add") history.replaceState(null, "");
      setTimeout(renderHome, 400);
    }
    if (b?.paper) return openPaper(path);
    // The book already on screen just comes back; any other one opens.
    if (current?.path === path) return hide();
    if (b?.unavailable) return window.ReadingTime?.offlineOpen("missing"), showNotice("Немає з'єднання, а ця книжка ще не збережена на пристрої.", false);
    window.reader.openPath(path);
  }

  $("#shell").addEventListener("click", (e) => {
    const el = e.target.closest("[data-menu], [data-hit], [data-open], [data-act], [data-page], [data-take], [data-paper-add]");
    // #shell itself carries data-page (the page shown): a tap on anything else, the search field in the phone's
    // panel too, came here as «Мої книжки» and closed the panel, so search did nothing on a phone (Max, 2026-11-03).
    if (!el || el.id === "shell") return;
    tap(el);
  });
  // The phone's two sheets (variant А): «+» = «Додати книжку», the avatar = «Я». A row closes its sheet and does what
  // the same row does on the page.
  for (const id of ["add-sheet", "me-sheet"]) {
    $(`#${id}`).addEventListener("click", (e) => {
      const el = e.target.closest("[data-act], [data-page]");
      if (!el) return;
      $(`#${id}`).close();
      tap(el);
    });
  }
  // From the sheet: «Додати книжку» as a page, at its search (once the sheet is gone: closing gives the focus back to
  // the «+») or at the stores.
  function addAt(sel) {
    setPage("add");
    if (sel === "#r-aq") return $("#add-sheet").addEventListener("close", () => setTimeout(() => $(sel).focus(), 0), { once: true });
    setTimeout(() => $(sel)?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }
  function tap(el) {
    if (el.dataset.menu) return bookMenu(el.dataset.menu, el);
    if (el.dataset.take) return takeBook(el.dataset.take, el);
    if (el.dataset.paperAdd != null) return paperFromCatalog(Number(el.dataset.paperAdd));
    if (el.dataset.page) {
      const to = el.dataset.page;
      // A tab: its page from the top; the page already on screen goes back to its first level and up.
      if (el.closest("#r-tabs")) {
        if (to === page) $("#home").scrollTo({ top: 0, behavior: "smooth" });
        return to === "home" ? (page === "home" ? renderHome() : backHome()) : setPage(to);
      }
      if (el.closest(".r-head") && to !== page && (to === "add" || (to === "home" && page === "add")) && !(to === "add" && settings.guest) && slidePage(to)) return;
      if (to === "home" && page === "how" && el.closest(".r-pnav")) return setPage("home"); // the panel's «Мої книжки» = one's books
      return to === "home" && page !== "home" ? backHome() : setPage(to);
    }
    if (el.dataset.hit != null) return openHit(Number(el.dataset.hit));
    if (el.dataset.open != null) return panel(false), openBook(el.dataset.open);
    if (el.dataset.act === "add") return window.Library.add();
    if (el.dataset.act === "trash") return panel(false), openTrash();
    if (el.dataset.act === "panel") return panel();
    if (el.dataset.act === "psearch") return panel(true), $("#r-pq").focus();
    if (el.dataset.act === "add-sheet") return $("#add-sheet").showModal();
    if (el.dataset.act === "me") return settings.guest ? openSettings() : (renderPanel(), $("#me-sheet").showModal());
    if (el.dataset.act === "add-find") return addAt("#r-aq");
    if (el.dataset.act === "add-shops") return addAt(".r-yak-row");
    if (el.dataset.act === "settings") return panel(false), openSettings();
    if (el.dataset.act === "admin-off") return adminOff(el);
    if (el.dataset.act === "cover-photo") return window.Paper.coverPhoto();
    if (el.dataset.act === "free-shelf") {
      freeAll = true;
      setPage("add");
      return setTimeout(() => $("#r-free")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    }
    if (el.dataset.act === "free-all") {
      freeAll = !freeAll;
      renderHome();
      if (freeAll) $("#r-free")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (el.dataset.act === "yakaboo" || el.dataset.act === "bookua") return (shopOpen = shopOpen === el.dataset.act ? null : el.dataset.act), renderHome();
  }
  // The header's search, «+» and avatar on every page with tabs (the home header has the original).
  for (const h of document.querySelectorAll(".r-head-w, .r-head-s, .r-head-p")) h.append($(".r-head-home .r-hact").cloneNode(true));

  // A paper book opens as a page of Мої книжки (paper.js).
  function openPaper(path) {
    const b = lib?.books.find((x) => x.path === path);
    if (!b) return;
    if (b.aside) Object.assign(b, { aside: false });
    b.openedAt = Date.now();
    paperPath = path;
    window.reader.paperUpdate(path, {}).catch(() => {});
    if (page === "paper") page = "home"; // another paper book: draw anew
    setPage("paper");
    // Straight to the question on a computer; a phone's keyboard would cover the page at once.
    if (!matchMedia("(pointer: coarse)").matches) setTimeout(() => $("#pp-q")?.focus(), 50);
  }
  // «Читаю паперову» on a catalog book.
  function paperFromCatalog(i) {
    const b = found.get(norm(addQuery))?.books?.[i];
    if (b) window.Paper.add({ title: b.title, author: b.author, cover: b.cover || "", href: b.href });
  }

  // The book stops counting as one you read (for you only; notes and the place in it stay) until you open it again.
  async function setAside(path) {
    try {
      await window.reader.librarySetAside(path);
    } catch (err) {
      return showNotice(err instanceof TypeError ? "Немає з'єднання: прибрати з читання можна лише онлайн." : err.message, false);
    }
    const b = lib?.books.find((x) => x.path === path);
    if (b) Object.assign(b, { aside: true, started: false, pct: null, chapter: "", openedAt: 0 });
    if (lib?.lastBook === path) lib.lastBook = null;
    if (page === "paper" && paperPath === path) backHome();
    render();
  }

  // ---------- A book's menu: lend it, fix its title, put it away, delete it ----------

  let menuBook = null;
  // On a phone a sheet from the bottom; with a mouse a small menu by the ⋯ or where the right click was.
  // A phone (or a tablet) or a computer, for «на телефоні» and «Зберегти на телефон».
  const deviceWords = () => (matchMedia("(pointer: coarse)").matches ? ["на телефоні", "на телефон"] : ["на комп'ютері", "на комп'ютер"]);
  async function keepBook(b) {
    const [onIt, toIt] = deviceWords();
    showNotice("Зберігаю…", true);
    try {
      await window.reader.libraryKeep(b.path);
      b.onDevice = true;
      showNotice(`Збережено ${toIt}.`, false);
    } catch (err) {
      showNotice(err instanceof TypeError ? "Немає з'єднання: зберегти можна лише онлайн." : err.code === "full" ? `${onIt[0].toUpperCase()}${onIt.slice(1)} вже забагато книжок.` : `Не вдалося зберегти: ${err.message}`, false);
    }
  }
  // «Словничок» in the book's menu, after «Про книжку» (Max 2026-11-18: «готуємо, готово, скільки слів і пояснень»):
  // how much of the book its list covers, its words and the book's people and places. Asked each time the menu opens.
  // A book with none gets «Підготувати словничок» (Max: the reader asks for it, it isn't made by itself).
  async function glossLine(b) {
    const el = $("#bm-gloss");
    el.hidden = true;
    el.innerHTML = "";
    el.classList.remove("go");
    if (!/\.epub$/i.test(b.path || "") || b.protected || !window.reader.glossaryStatus) return;
    let p;
    try {
      p = await window.reader.glossaryStatus(b.path);
    } catch {
      return;
    }
    if (menuBook !== b || !p || (p.none && !p.possible)) return;
    if (p.none || (p.error && !p.words && !p.building)) {
      el.innerHTML = `<button type="button" class="bm-gloss-go" data-act="gloss-start">Підготувати словничок<small>Пояснимо складні слова, терміни й алюзії, поки читаєте</small></button>`;
      el.classList.add("go");
      el.hidden = false;
      el.firstChild.onclick = async () => {
        el.firstChild.disabled = true;
        const r = await window.reader.glossaryStart(b.path, b.pct || 0);
        if (menuBook !== b) return;
        if (!r || r.error || r.capped || r.none || r.off) {
          el.innerHTML = `<span class="bm-gloss-t">${r?.capped ? "Сьогодні вже забагато, спробуйте завтра." : "Не вдалося. Спробуйте ще раз згодом."}</span>`;
          el.classList.remove("go");
          return;
        }
        glossLine(b);
      };
      return;
    }
    const pct = Math.round((p.covered || 0) * 100);
    const done = !p.lazy && pct >= 100;
    const count = [p.words ? `${p.words} ${plural(p.words, "слово", "слова", "слів")}` : "", p.names ? `${p.names} ${plural(p.names, "ім'я", "імені", "імен")}` : ""].filter(Boolean).join(" і ");
    // By parts as the book is read: «готово 30% книжки» grows while one reads on.
    const state = p.building && !count ? "готуємо…" : done ? "готово" : p.building ? `готуємо · ${pct}% книжки` : `готово ${pct}% книжки`;
    el.innerHTML = `<span class="bm-gloss-t"><b>Словничок</b> · ${esc(state)}</span>${count ? `<small>Пояснено ${esc(count)}</small>` : ""}${done ? "" : `<span class="bm-gloss-bar"><i style="width:${Math.max(pct, p.building ? 3 : 0)}%"></i></span>`}`;
    el.hidden = false;
  }
  function bookMenu(path, at = null) {
    const b = lib?.books.find((x) => x.path === path);
    if (!b || settings.guest) return;
    menuBook = b;
    for (const x of document.querySelectorAll("#book-menu .bm-list button")) x.hidden = false;
    const own = !b.free && !b.protected && !b.paper;
    const d = $("#book-menu");
    $("#bm-title").textContent = b.title;
    // «На телефоні» / «Зберегти на телефон» (Max, 2026-11-10, for everyone): which books open without a network.
    const keepable = !!window.reader.libraryKeep && !b.paper && !b.protected && /^(epub|pdf)$/.test(b.ext || "");
    const [onIt, toIt] = deviceWords();
    $("#bm-author").textContent = [author(b), statusText(b), keepable && b.onDevice ? onIt : ""].filter(Boolean).join(" · ");
    $("#bm-cover").innerHTML = rcover(b);
    const pop = !!at && matchMedia("(min-width: 761px)").matches;
    d.classList.toggle("pop", pop);
    if (pop) {
      const r = at instanceof Element ? at.getBoundingClientRect() : { left: at.x, right: at.x, bottom: at.y, top: at.y };
      d.style.left = `${Math.max(12, Math.min(innerWidth - 232, r.left))}px`;
      d.style.top = `${Math.min(innerHeight - 240, r.bottom + 6)}px`;
    } else d.style.left = d.style.top = "";
    $("#bm-edit").hidden = !(own && window.reader.libraryUpdateBook);
    // «Знайти обкладинку» only for a book without one (Max 2026-11-22, bug report №30): shown once its picture fails.
    const findOk = own && !!window.reader.coverPick;
    const img = $("#bm-cover img");
    const findRow = () => ($("#bm-cover-find").hidden = !findOk || !!(img?.isConnected && img.naturalWidth));
    $("#bm-cover-find").hidden = !findOk || !!img;
    if (img && findOk) img.complete ? findRow() : (img.addEventListener("load", findRow), img.addEventListener("error", findRow));
    // A PDF added before uploads became EPUB (2026-11-01): it opens slowly, so it can become one now.
    $("#bm-epub").hidden = !(own && /\.pdf$/i.test(b.path) && window.reader.libraryPdfToEpub);
    // Your own file is deleted; a book from the free shelf or a publisher just leaves the home screen.
    $("#bm-aside").hidden = own;
    $("#bm-delete").hidden = !(own && window.reader.libraryDeleteBook);
    $("#bm-keep").hidden = !keepable || b.onDevice || b.unavailable;
    glossLine(b);
    $("#bm-keep").textContent = `Зберегти ${toIt}`;
    $("#bm-finished").hidden = !window.reader.libraryFinished;
    $("#bm-finished").textContent = b.finished ? "Позначити непрочитаною" : "Позначити прочитаною";
    d.returnValue = "";
    d.showModal();
  }
  // «Знайти обкладинку» (Max 2026-11-22, variant A of the canvas): covers for the book's title and author from our
  // catalog, book.ua, Open Library and Google Books (server /api/cover/find); a tap keeps one at once, «Свій файл або
  // фото» takes a picture, «Як у файлі» goes back to the file's own. The field searches other words.
  let coverBook = null;
  let coverList = [];
  let coverPicked = -1;
  function coverGrid(b) {
    const tiles = coverList.map((c, i) => `<button type="button" class="cf-tile${i === coverPicked ? " on" : ""}" data-cf="${i}"><img src="${esc(c.thumb)}" alt="" loading="lazy" onerror="this.closest('.cf-tile').remove()"><small>${i === coverPicked ? "✓ Поставлено" : esc(c.from)}</small></button>`);
    tiles.push(`<button type="button" class="cf-tile" data-cf="file"><span class="cf-box">Свій файл або фото</span><small>&nbsp;</small></button>`);
    if (b.coverAt) tiles.push(`<button type="button" class="cf-tile" data-cf="reset"><span class="cf-box">Як у файлі книжки</span><small>&nbsp;</small></button>`);
    $("#cf-grid").innerHTML = `${coverList.length ? "" : `<p class="cf-note">Обкладинок не знайшли. Спробуйте інші слова або візьміть свій файл.</p>`}<div class="cf-tiles">${tiles.join("")}</div>`;
  }
  async function showCovers(b, q = "") {
    coverBook = b;
    coverPicked = -1;
    const d = $("#cover-dialog");
    $("#cf-sub").textContent = [b.title, author(b)].filter(Boolean).join(" · ");
    if (!q) $("#cf-q").value = "";
    $("#cf-grid").innerHTML = `<p class="cf-note"><span class="spinner"></span>Шукаю обкладинки…</p>`;
    if (!d.open) d.showModal();
    let list = [];
    try {
      list = (await window.reader.coverFind(q || b.title, q ? "" : author(b))).covers || [];
    } catch (err) {
      if (coverBook !== b) return;
      $("#cf-grid").innerHTML = `<p class="cf-note">${err instanceof TypeError ? "Немає з'єднання." : "Не вдалося пошукати."} Можна взяти свій файл.</p>`;
    }
    if (coverBook !== b) return;
    coverList = list;
    coverGrid(b);
  }
  // The covers on the home screen and the reader's own copies of the list take the new one.
  const coverSet = (b, at) => {
    b.coverAt = at;
    homeHtml = "";
    render();
  };
  $("#cf-grid").addEventListener("click", async (e) => {
    const t = e.target.closest("[data-cf]");
    const b = coverBook;
    if (!t || !b || t.classList.contains("busy")) return;
    const what = t.dataset.cf;
    if (what === "file") return $("#cf-file").click();
    t.classList.add("busy");
    window.ReadingTime?.count?.(what === "reset" ? "cover-reset" : "cover-pick");
    try {
      if (what === "reset") coverSet(b, (await window.reader.librarySetCover(b.path, null)).coverAt);
      else {
        coverSet(b, (await window.reader.coverPick(b.path, coverList[+what].full)).coverAt);
        coverPicked = +what;
      }
      if (coverBook === b) coverGrid(b);
    } catch (err) {
      t.classList.remove("busy");
      showNotice(err instanceof TypeError ? "Немає з'єднання: обкладинку можна змінити лише онлайн." : err.message || "Не вдалося поставити обкладинку.", false);
    }
  });
  $("#cf-file").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    const b = coverBook;
    e.target.value = "";
    if (!file || !b) return;
    try {
      const blob = await window.Library.smallCover(file);
      coverSet(b, (await window.reader.librarySetCover(b.path, blob)).coverAt);
      window.ReadingTime?.count?.("cover-file");
      $("#cover-dialog").close();
    } catch (err) {
      showNotice(err instanceof TypeError ? "Немає з'єднання: обкладинку можна змінити лише онлайн." : "Цей файл не схожий на зображення.", false);
    }
  });
  $("#cf-q").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const q = $("#cf-q").value.trim();
    if (coverBook && q.length >= 2) showCovers(coverBook, q);
  });
  $("#cover-dialog").addEventListener("close", () => {
    coverBook = null;
    coverList = [];
  });

  // «Про книжку»: for an EPUB the guide (below) in place of the site's description (Max 2026-11-20: no site text, no
  // link to the site); the description shows only for a book with no guide (a PDF) or when the guide can't be made.
  async function showAbout(b) {
    const d = $("#about-dialog");
    $("#ab-cover").innerHTML = rcover(b);
    $("#ab-title").textContent = b.title;
    $("#ab-author").textContent = author(b);
    const body = $("#ab-body");
    body.hidden = guided(b);
    const link = $("#ab-link");
    const fill = (a) => {
      if (!a) {
        body.innerHTML = `<p class="muted">${navigator.onLine ? "Завантажую…" : "Немає з'єднання, а опис цієї книжки ще не збережено."}</p>`;
        link.hidden = true;
        return;
      }
      // The book's page on the site (back by Max's wish, 2026-11-22), under the guide too.
      link.hidden = false;
      link.href = a.found ? a.href : a.add;
      link.textContent = siteLinkText(a);
      $("#ab-author").textContent = [author(b), a.year].filter(Boolean).join(" · ");
      body.innerHTML = a.found
        ? a.blurb ? a.blurb.split(/\n\n+/).map((p) => `<p>${esc(p)}</p>`).join("") : `<p class="muted">Опису поки немає.</p>`
        : `<p class="muted">Цієї книжки ще немає в каталозі Chytai.</p>`;
    };
    $("#ab-before").innerHTML = guided(b) ? abSec("Про книжку", abWait(navigator.onLine ? "Завантажую…" : "Немає з'єднання.")) : "";
    const opened = (aboutSeq = (aboutSeq || 0) + 1);
    fill(await window.reader.bookAbout?.(b, true));
    if (!d.open) d.showModal();
    d.scrollTop = 0;
    showGuide(b, d, opened);
    const fresh = await window.reader.bookAbout?.(b);
    if (opened !== aboutSeq) return;
    if (fresh && d.open) fill(fresh);
    else if (!fresh && d.open && body.textContent === "Завантажую…") body.innerHTML = `<p class="muted">Не вдалося завантажити опис.</p>`;
  }
  // EPUBs from their text, paper books from their title and author (Max 2026-11-20).
  const guided = (b) => !!window.reader.bookGuide && (b.paper || /\.epub$/i.test(b.path || ""));
  // The guide (Max 2026-11-18, server/bookguide.js): what the book is and why it is worth reading, in place of the
  // site's description. Made the first time someone asks (a few seconds), then kept for every reader
  // of the same file. The recap of a started book («де ви зупинилися, що було досі, хто тут хто») went on 2026-11-19 (Max: it only
  // retold what he read the day before); «Перед главою» shows in the book itself (renderer.js `intro`).
  let aboutSeq = 0;
  async function showGuide(b, d, opened) {
    if (!guided(b)) return;
    const draw = (g) => {
      if (opened !== aboutSeq || !d.open || !g) return;
      const html = beforeHtml(g);
      // Nothing to show (no text, over the day's cap, a failed call): the site's description after all.
      $("#ab-body").hidden = !!g.before?.about || !!g.before?.why || !!g.building;
      $("#ab-before").innerHTML = html;
    };
    draw((await window.reader.bookGuide(b, true)) || { building: { what: "before" } });
    for (let i = 0; i < 60; i++) {
      const g = await window.reader.bookGuide(b);
      draw(g || { none: true });
      if (!g?.building || opened !== aboutSeq || !d.open) return;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  const siteLinkText = (a) => (a.found ? "Сторінка книжки на Chytai ↗" : "Додати на Chytai ↗");
  const siteLink = (a) => (a && !a.failed && (a.href || a.add) ? `<a class="ab-site" href="${esc(a.found ? a.href : a.add)}" target="_blank" rel="noopener">${siteLinkText(a)}</a>` : "");
  const abSec = (title, body) => `<section class="ab-sec"><h3>${title}</h3>${body}</section>`;
  const abWait = (text) => `<p class="ab-wait">${text}</p>`;
  // Max 2026-11-20: «Про книжку» and «Чому варто читати»; no «Як читати» (condescending), no level or pages. A guide made before
  // (`why`, `how`) shows its `why` until the new one comes.
  // `inline`: under the panel's own «Про книжку» row, so the first part goes without its heading.
  function beforeHtml(g, inline = false) {
    const f = g.before;
    let html = "";
    const about = f?.about || f?.why;
    if (about) {
      html += inline ? `<p>${esc(about)}</p>` : abSec("Про книжку", `<p>${esc(about)}</p>`);
      if (f.worth) html += abSec("Чому варто читати", `<p>${esc(f.worth)}</p>`);
    } else if (g.building?.what === "before") html += inline ? abWait("Готуємо кілька слів про книжку…") : abSec("Про книжку", abWait("Готуємо кілька слів про книжку…"));
    return html;
  }
  // «Про книжку» as a block at the end of a book's panel that unfolds in place, like the questions and
  // notes above it (Max 2026-11-05: no separate dialog). Same block for paper and e-books.
  const aboutKept = new Map(); // path → the summary, once loaded
  const guideKept = new Map(); // path → the guide (paper books), once loaded
  function aboutBlock(b, open) {
    const a = b && aboutKept.get(b.path);
    const g = b && guideKept.get(b.path);
    let body = "";
    if (open) {
      // The book's guide, as in the dialog (Max 2026-11-20); the site's description when there is none.
      if (g?.before?.about || g?.before?.why || g?.building) body = beforeHtml(g, true);
      else if (a?.failed) body = `<p class="muted">Не вдалося завантажити опис.</p>`;
      else if (!a) body = `<p class="muted">${navigator.onLine ? "Завантажую…" : "Немає з'єднання, а опис цієї книжки ще не збережено."}</p>`;
      else body = (([author(b), a.year].filter(Boolean).join(" · ")) ? `<p class="ab-meta">${esc([author(b), a.year].filter(Boolean).join(" · "))}</p>` : "") + (a.found
        ? a.blurb ? a.blurb.split(/\n\n+/).map((p) => `<p>${esc(p)}</p>`).join("") : `<p class="muted">Опису поки немає.</p>`
        : `<p class="muted">Цієї книжки ще немає в каталозі Chytai.</p>`);
      body += siteLink(a);
    }
    return `<section class="ab-block${open ? " open" : ""}"><button type="button" class="pp-row" data-about-toggle><span>Про книжку</span><span class="ab-chev">›</span></button>${open ? `<div class="ab-inline">${body}</div>` : ""}</section>`;
  }
  // Loads the summary (the kept copy first, then a fresh one) and calls done after each that arrives; a paper book's
  // guide too, asked again while it is being made.
  async function loadAbout(b, done) {
    if (!b || !window.reader.bookAbout) return;
    if (guided(b)) loadGuide(b, done);
    const kept = aboutKept.get(b.path) || (await window.reader.bookAbout(b, true));
    if (kept) aboutKept.set(b.path, kept), done();
    const fresh = await window.reader.bookAbout(b);
    if (fresh) aboutKept.set(b.path, fresh);
    else if (!kept) aboutKept.set(b.path, { found: false, failed: true });
    done();
  }
  async function loadGuide(b, done) {
    const kept = guideKept.get(b.path) || (await window.reader.bookGuide(b, true));
    if (kept) guideKept.set(b.path, kept), done();
    for (let i = 0; i < 60; i++) {
      const g = await window.reader.bookGuide(b);
      if (g) guideKept.set(b.path, g.before || g.building ? g : kept || g), done();
      if (!g?.building) return;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  // The books being read get their summaries ahead, so «Про книжку» works offline for them.
  let aboutAhead = false;
  function fetchAboutAhead(books) {
    if (aboutAhead || !window.reader.bookAbout || !navigator.onLine) return;
    aboutAhead = true;
    const list = books.filter((b) => b.pct > 0 && !b.finished).slice(0, 12);
    (async () => {
      for (const b of list) if (!(await window.reader.bookAbout(b, true))) await window.reader.bookAbout(b);
    })();
  }
  $("#book-menu").addEventListener("close", async () => {
    const b = menuBook;
    menuBook = null;
    const act = $("#book-menu").returnValue;
    if (!b) return;
    if (act === "about") return showAbout(b);
    if (act === "keep") return keepBook(b);
    if (act === "edit") return window.Library.editBook(b.path);
    if (act === "cover") return showCovers(b);
    if (act === "aside") return setAside(b.path);
    if (act === "epub") return pdfToEpub(b);
    if (act === "finished") {
      b.finished = !b.finished;
      homeHtml = "";
      render();
      // Marked read: the screen «Прочитано» with the site's stars and a few words (renderer.js showDone), when the
      // site's catalog has the book; nothing reaches the site before «Опублікувати» there.
      let res;
      try {
        res = await window.reader.libraryFinished(b.path, b.finished);
      } catch {
        b.finished = !b.finished;
        homeHtml = "";
        render();
        return showNotice("Немає з'єднання: позначити книжку можна лише онлайн.", false);
      }
      if (b.finished) res.json().then((r) => r?.site && window.showDone?.(b.path, r.site)).catch(() => {});
      return;
    }
    if (act !== "delete") return;
    try {
      await window.reader.libraryDeleteBook(b.path);
    } catch (err) {
      return showNotice(err instanceof TypeError ? "Немає з'єднання: видалити книжку можна лише онлайн." : `Не вдалося видалити: ${err.message}`, false);
    }
    if (current?.path === b.path) closeBook?.();
    lib.books = lib.books.filter((x) => x.path !== b.path);
    if (lib.lastBook === b.path) lib.lastBook = null;
    trashCount++;
    homeHtml = "";
    render();
    // No question before deleting (Max, 2026-11-01); the notice gives a way back instead.
    showNotice(`«${b.title}» видалено`, false);
    const undo = document.createElement("button");
    undo.className = "link notice-link";
    undo.textContent = "Скасувати";
    undo.onclick = () => restoreBook(b.path).then(() => $("#notice").classList.add("hidden"));
    $("#notice .notice-text").append(" ", undo);
  });

  async function pdfToEpub(b) {
    showNotice(`Перетворюю «${b.title}» на EPUB…`, true);
    try {
      if (current?.path === b.path) closeBook?.();
      await window.reader.libraryPdfToEpub(b.path, (n, total) => showNotice(`Перетворюю «${b.title}» на EPUB… ${n} / ${total}`, true));
    } catch (err) {
      const text = err.message === "NO_TEXT" ? "Це скан без тексту, тож він лишається PDF." : err instanceof TypeError ? "Немає з'єднання: перетворити книжку можна лише онлайн." : `Не вдалося перетворити: ${err.message}`;
      return showNotice(text, false);
    }
    showNotice(`«${b.title}» тепер EPUB. PDF у «Кошику».`, false);
    trashCount++;
    homeHtml = "";
    refresh();
  }

  // ---------- Нещодавно видалені ----------

  let trashCount = 0;
  async function loadTrashCount() {
    if (!window.reader.libraryTrash || settings.guest) return;
    try {
      const n = (await window.reader.libraryTrash()).books.length;
      if (n !== trashCount) (trashCount = n), (homeHtml = ""), render();
    } catch {
      /* offline: the link waits */
    }
  }
  async function restoreBook(path) {
    try {
      await window.reader.libraryRestoreBook(path);
    } catch (err) {
      return showNotice(err instanceof TypeError ? "Немає з'єднання: повернути книжку можна лише онлайн." : `Не вдалося повернути: ${err.message}`, false);
    }
    trashCount = Math.max(0, trashCount - 1);
    lib = await window.Library.data(true);
    homeHtml = "";
    render();
    toast("Книжку повернуто");
  }
  async function openTrash() {
    const box = $("#trash-list");
    box.innerHTML = `<li class="m">Завантажую…</li>`;
    $("#trash-dialog").showModal();
    let books = [];
    try {
      books = (await window.reader.libraryTrash()).books;
    } catch (err) {
      box.innerHTML = `<li class="m">${esc(err.message)}</li>`;
      return;
    }
    trashCount = books.length;
    const left = (until) => Math.max(1, Math.ceil((until - Date.now()) / DAY));
    box.innerHTML = books.length
      ? books.map((b) => `<li>${rcover(b)}<span class="row-text"><span class="t">${esc(b.title)}</span><span class="m">${esc(b.authors[0] || "")}${b.authors[0] ? " · " : ""}ще ${left(b.until)} ${plural(left(b.until), "день", "дні", "днів")}</span>
          <span class="tr-acts"><button type="button" class="tr-restore" data-restore="${esc(b.path)}">Відновити</button><button type="button" class="r-forget" data-forget="${esc(b.path)}">Видалити назавжди</button></span></span></li>`).join("")
      : `<li class="m">Порожньо.</li>`;
  }
  $("#trash-list").addEventListener("click", async (e) => {
    const el = e.target.closest("[data-restore], [data-forget]");
    if (!el) return;
    el.disabled = true;
    try {
      if (el.dataset.restore) await restoreBook(el.dataset.restore);
      else await window.reader.libraryForgetBook(el.dataset.forget);
    } catch (err) {
      el.disabled = false;
      return showNotice(err.message, false);
    }
    el.closest("li").remove();
    trashCount = [...$("#trash-list").children].filter((li) => !li.classList.contains("m")).length;
    homeHtml = "";
    render();
    if (!$("#trash-list li")) $("#trash-list").innerHTML = `<li class="m">Порожньо.</li>`;
  });

  // A long press on a cover opens its menu; with a mouse, a right click does.
  let tilePress = null;
  let tilePressed = false;
  $("#shell").addEventListener("touchstart", (e) => {
    const t = e.target.closest(".tile, .home-hero, .r-card[data-open], .r-row");
    if (!t || settings.guest) return;
    tilePressed = false;
    tilePress = setTimeout(() => {
      tilePressed = true;
      navigator.vibrate?.(10);
      bookMenu(t.dataset.open);
    }, 500);
  }, { passive: true });
  for (const type of ["touchend", "touchmove", "touchcancel"]) $("#shell").addEventListener(type, () => clearTimeout(tilePress), { passive: true });
  $("#shell").addEventListener("click", (e) => {
    if (!tilePressed || !e.target.closest(".tile, .home-hero, .r-card[data-open], .r-row")) return;
    tilePressed = false;
    e.stopImmediatePropagation();
  }, true);
  $("#shell").addEventListener("contextmenu", (e) => {
    const t = e.target.closest(".tile, .home-hero, .r-card[data-open], .r-row");
    if (!t || settings.guest || !lib?.books.some((b) => b.path === t.dataset.open)) return;
    e.preventDefault();
    bookMenu(t.dataset.open, { x: e.clientX, y: e.clientY });
  });

  $("#btn-library").onclick = () => (isOpen() && current ? hide() : show("home"));

  // Single keys on a keyboard: Esc back to the book, / to search, T for the contents, − + for the
  // font, ? for the list. Never while typing or with a dialog open; guests have no home screen.
  // Matched by the physical key, so they work the same with the Ukrainian layout on.
  function key(e) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return; // desk-read.js took it
    if (e.target?.closest?.("input, textarea, select, [contenteditable]")) return;
    if (document.querySelector("dialog[open]")) return;
    const reading = !isOpen() && current;
    let act = null;
    const code = e.code;
    if (e.key === "Escape" && isOpen() && $("#shell").classList.contains("panel-open")) act = () => panel(false);
    else if (e.key === "Escape" && isOpen() && page === "shelves" && window.Shelves.back()) act = () => {};
    else if (e.key === "Escape" && isOpen() && page !== "home") act = backHome;
    else if (e.key === "Escape" && current && isOpen()) act = hide;
    else if (code === "Slash" && !e.shiftKey) {
      act = reading
        ? () => window.BookSearch?.open()
        : () => {
            panel(true);
            $("#r-pq").focus();
            $("#r-pq").select();
          };
    } else if (code === "Slash" && e.shiftKey) act = () => $("#keys").showModal();
    else if (reading && code === "KeyT" && !$("#btn-toc").disabled) act = () => $("#btn-toc").click();
    else if (reading && (code === "Minus" || code === "NumpadSubtract")) act = () => $("#btn-font-down").click();
    else if (reading && (code === "Equal" || code === "NumpadAdd")) act = () => $("#btn-font-up").click();
    if (!act) return;
    e.preventDefault();
    act();
  }
  document.addEventListener("keydown", key);
  $("#btn-keys").onclick = () => {
    $("#settings").close();
    $("#keys").showModal();
  };
  window.reader.onShowLibrary(() => $("#btn-library").click()); // ⌘L: Мої книжки, as «←» in the book
  window.reader.onBookOpen(() => hide());
  // A note saved or removed in the book shows up here next time.
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && isOpen() && load());
  // The server answered late, after the home screen was drawn from the device's copy (web-bridge.js inTime).
  window.addEventListener("chytai:fresh", () => isOpen() && load());

  // The library list changed (a rescan, an edit, a deletion): draw again from it.
  async function refresh() {
    if (!isOpen()) return;
    lib = await window.Library.data(false);
    render();
  }

  // Android's back (the app, app/App.js), which a swipe from the screen's edge also is (bug report №20, 2026-11-20:
  // the swipe that opens the panel left the app): close what is open, and from a book do what that swipe does here.
  // false = nothing to close, the app goes to the background.
  window.__chytaiBack = () => {
    const dlg = document.querySelector("dialog[open]");
    if (dlg) return dlg.close(), true;
    if (!$("#done").classList.contains("hidden")) return $("#done").classList.add("hidden"), true;
    if (window.PhoneRead?.sheetOpen()) return window.PhoneRead.closeSheet(), true;
    if (isOpen() && $("#shell").classList.contains("panel-open")) return panel(false), true;
    if (isOpen() && page === "scratch" && window.Scratch.back()) return true;
    if (isOpen() && page === "shelves" && window.Shelves.back()) return true;
    if (isOpen() && page !== "home") return backHome(), true;
    if (!isOpen() && current && !settings.guest) return panelFromBook(), true;
    return false;
  };

  window.Shell = {
    show, hide, panelFromBook, refresh, key, when, setAside, rcover, showAbout, openPaper, aboutBlock, loadAbout,
    open: (path) => (panel(false), openBook(path)),
    book: (path) => lib?.books.find((b) => b.path === path) || null,
    books: () => lib?.books || [],
    rerender: () => ((homeHtml = ""), renderHome()),
    setPage: (p) => setPage(p),
    go,
    reload: async () => ((lib = await window.Library.data(true)), (homeHtml = "")),
  };

  // «Адмінка» from the settings (owner only, body.not-owner hides the button there).
  $("#btn-admin").onclick = () => ($("#settings").close(), setPage("admin"));

  // The family starts here; a guest has one book, which the bridge opens straight away. /?admin opens «Адмінка».
  settingsReady
    .then(() => {
      if (settings.guest) return hide();
      if (settings.owner && new URLSearchParams(location.search).has("admin")) history.replaceState(history.state, "", "/"), setPage("admin", { push: false });
      show("home");
    })
    .catch(() => show("home"));
})();

// Home screen (designed in Claude Design, 2026-10-15): what you are reading, your shelf, your notes, the
// books the family added lately and your wish list, with a tab bar for Головна / Бібліотека / Нотатки
// (on a wider screen a sidebar instead, from the desktop mock-up). It covers the reader while it is open;
// a book opening puts it away, the toolbar's «Головна» brings it back.
(() => {
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ESC[c]);
  const DAY = 864e5;
  const ARRIVALS_DAYS = 30;
  const TABS = { home: "#home", discover: "#discover", club: "#club", library: "#library", notes: "#all-notes", wish: "#wish" };

  let tab = "home";
  let lib = null; // the library list (library-view.js)
  let notes = null; // { "<book path>": [note, …] }
  let wish = null; // [{ id, title, author }]

  // ---------- Showing and hiding ----------

  const isOpen = () => !$("#shell").classList.contains("hidden");

  function show(next = tab) {
    if (next === "library") next = "home"; // the old «Бібліотека» page is gone; Мої книжки has it all (Max, 2026-11-02)
    if (next !== "library") beforeSearch = null;
    tab = next;
    $("#shell").classList.remove("hidden");
    // Keys go to the home screen now, not to the page of the book left focused underneath.
    if (document.activeElement?.tagName === "IFRAME") document.activeElement.blur();
    document.body.classList.add("library-open");
    for (const [name, sel] of Object.entries(TABS)) $(sel).classList.toggle("hidden", name !== tab);
    for (const b of document.querySelectorAll("#tabbar button")) b.classList.toggle("active", b.dataset.tab === tab);
    $(TABS[tab]).scrollTop = 0;
    if (tab === "library") window.Library.shown();
    else load();
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
      window.Library.data(true).then((d) => (lib = d)),
      loadTrashCount(),
      Promise.resolve(window.reader.notesAll?.()).then((n) => (notes = n || {})).catch(() => {}),
      Promise.resolve(window.reader.wishList?.()).then((w) => (wish = w || [])).catch(() => {}),
      loadClub(),
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
  const titleMatch = (a, b) => {
    const x = norm(a);
    const y = norm(b);
    return x.length > 2 && y.length > 2 && (x === y || x.includes(y) || y.includes(x));
  };
  const bookFor = (w) => lib?.books.find((b) => titleMatch(b.title, w.title));
  const wishedFor = (b) => (wish || []).some((w) => titleMatch(b.title, w.title));
  const author = (b) => b.authors.slice(0, 2).join(", ") + (b.authors.length > 2 ? "…" : "");
  const reading = (b) => b.pct != null && b.pct < 99;

  function isNew(b) {
    return !b.seen && !!b.addedBy && b.addedBy !== settings.user && Date.now() - (b.addedAt || 0) < ARRIVALS_DAYS * DAY;
  }

  function arrivals() {
    if (!lib) return [];
    return lib.books
      // Only books someone added since uploads are recorded: who brought the older ones is unknown.
      .filter((b) => b.addedBy && b.addedBy !== settings.user && Date.now() - (b.addedAt || 0) < ARRIVALS_DAYS * DAY)
      .sort((x, y) => y.addedAt - x.addedAt)
      .slice(0, 5);
  }

  // «Позначити переглянутими»: the dots and badges of new arrivals go away.
  function markSeen() {
    const paths = arrivals().filter((b) => !b.seen).map((b) => b.path);
    paths.forEach((p) => (lib.books.find((b) => b.path === p).seen = true));
    window.reader.librarySeen?.(paths);
    render();
  }

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

  // A cover: the book's own picture when it has one, a quiet typographic one underneath otherwise.
  function cover(b, size) {
    let h = 0;
    for (const c of b.title) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const url = window.reader.coverUrl?.(b);
    return `<span class="cover ${size}" style="--hue:${h % 360}">
      <span class="cover-t">${esc(b.title)}</span><span class="cover-a">${esc(b.authors[0] || "")}</span>
      ${url ? `<img src="${esc(url)}" alt="" loading="lazy" onerror="this.remove()" />` : ""}
    </span>`;
  }

  // «Прибрати з читання» (web, family): on hover, or after a long press on a phone.
  const canAside = () => typeof window.reader.librarySetAside === "function" && !settings.guest;
  const asideButton = (b) => (canAside() ? `<span class="aside-x" role="button" data-aside="${esc(b.path)}" title="Прибрати з читання" aria-label="Прибрати з читання">×</span>` : "");

  const bar = (pct, cls = "") => `<span class="progress ${cls}"><span style="width:${Math.max(0, Math.min(100, pct || 0))}%"></span></span>`;

  // ---------- Головна ----------

  function render() {
    renderBadge();
    if (tab === "home") renderHome();
    else if (tab === "discover") renderDiscover();
    else if (tab === "club") renderClub();
    else if (tab === "notes") renderNotes();
    else if (tab === "wish") renderWish();
  }

  function renderBadge() {
    if ($("#club-dot")) clubDot();

    // Sidebar «Читаю» (wide screens): the books in progress, the one read last first.
    const inProgress = (lib?.books || [])
      .filter((b) => b.openedAt && (b.pct == null ? b.started : reading(b)))
      .sort((x, y) => y.openedAt - x.openedAt)
      .slice(0, 6);
    $("#side-reading").innerHTML = inProgress.map((b) => `<button class="side-book" data-open="${esc(b.path)}">
        <span class="t ellipsis">${esc(b.title)}</span>
        ${b.pct != null ? `<span class="side-progress">${bar(b.pct, "thin")}<span class="m">${b.pct}%</span></span>` : ""}
        ${asideButton(b)}
      </button>`).join("");
    $(".side-head").classList.toggle("hidden", !inProgress.length);
  }

  // ---------- Мої книжки: design «3a» from Claude Design (Max, 2026-11-01) ----------
  // One page: «Читаю зараз», your books with filters and a «+» tile, what others read now, the free shelf.
  // A query in the search field replaces it with results from your books and the free shelf.
  let homeFilter = "all"; // all | reading | new | done
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
  const head = (title, aside = "", plain = false) => `<div class="r-sec-head${plain ? " plain" : ""}"><h2>${title}</h2>${aside}</div>`;
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
  let page = "home"; // home | add | paper | week
  let paperPath = null; // the paper book on «paper» (paper.js)
  let addQuery = "";
  let freeAll = false;
  let yakOpen = false;
  const found = new Map(); // query -> { books } | { error } | "…" while asked
  const more6 = new Set(); // groups opened with «Ще N →»
  let panelHtml = "";
  const phone = () => matchMedia("(max-width: 760px)").matches;

  function setPage(next, { push = true } = {}) {
    if ((next === "add" && settings.guest) || (next === "articles" && !settings.owner)) return;
    const was = page;
    page = next;
    $("#shell").dataset.page = page;
    panel(false);
    if (was !== page) {
      // A browser's «back» (and Esc) on «Додати книжку» comes back to your books. Not in the iPhone app: its web
      // view turns a swipe from the screen's edge into back/forward, and a swipe closing the panel near the right
      // edge went «forward» to this entry, so the panel jumped back open (Max, 2026-11-02).
      if (push && page !== "home" && history.state?.rp !== page && !document.documentElement.classList.contains("in-app")) history[history.state?.rp ? "replaceState" : "pushState"]({ rp: page }, "");
      $("#home").scrollTop = 0;
      homeHtml = "";
      if (page === "articles") loadArticles();
    }
    if (tab !== "home") show("home");
    else renderHome();
  }
  addEventListener("popstate", () => page !== "home" && history.state?.rp !== page && setPage("home", { push: false }));
  function backHome() {
    if (history.state?.rp === page) history.back();
    else setPage("home");
  }

  // In an e-book (phone app) a swipe from the left edge opens the panel too, as on a paper book (Max 2026-11-05):
  // your books show behind it, as on a paper book. Putting the panel away leaves you on your books: going back to
  // the book there made a tap on another cover behind the panel reopen the same book (Max 2026-11-05).
  function panelFromBook() {
    if (!phone() || isOpen() || settings.guest) return;
    if (page !== "home") setPage("home", { push: false });
    show("home");
    panel(true);
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
    const recent = books.filter((b) => b.openedAt).sort((x, y) => y.openedAt - x.openedAt).slice(0, 4);
    const wk = weekPanelHtml();
    const all = `${html}\u0000${recent.map(prow).join("")}\u0000${wk}\u0000${books.length}|${trashCount}|${page}|${settings.user}`;
    if (all === panelHtml) return;
    panelHtml = all;
    $("#r-pfound").innerHTML = html;
    $("#r-pfound").classList.toggle("hidden", !q);
    $("#r-recent").innerHTML = recent.map(prow).join("");
    $(".r-precent").classList.toggle("hidden", !recent.length);
    // An older page (an app's saved copy) may have no such block: it must not stop the rest from drawing.
    const pw = $("#r-pweek");
    if (pw) pw.innerHTML = wk, pw.classList.toggle("hidden", !wk), pw.classList.toggle("on", page === "week");
    $("#r-n-books").textContent = books.length || "";
    $("#r-pnav-trash").hidden = !trashCount;
    // Max's experiment for now (2026-11-08), like «Статті» in the site's menu: his account only.
    $(".r-pnav-arts").hidden = !settings.owner || !window.reader.articlesList;
    $("#r-n-trash").textContent = trashCount || "";
    for (const b of document.querySelectorAll(".r-pnav [data-page]")) b.classList.toggle("on", b.dataset.page === page);
    $("#r-avatar").textContent = (settings.user || "Ч").trim()[0].toUpperCase();
    $("#r-me-name").textContent = settings.user || "";
  }
  // Past the titles (Max, 2026-11-03): the query is also looked for in your notes, their thoughts and your talks
  // with Claude (GET /api/search, server/search.js). A hit shows its book, a piece of text and opens at its place.
  let deep = { q: "", hits: [], offline: false };
  let deepTimer = 0;
  function askDeep() {
    clearTimeout(deepTimer);
    const q = norm($("#r-pq").value);
    if (!q || q.length < 2 || !window.reader.searchMine) return;
    deepTimer = setTimeout(async () => {
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
    const h = deep.hits[i];
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

  // «Цей тиждень» (Max 2026-11-06): a small block in the panel with your minutes this week, and a page behind it
  // with the days and the books. Only counts: no streaks, no nudges, nobody else sees it. Hidden in a week
  // with no reading. Asked again at most once a minute, when your books are drawn (coming back from a book too).
  let week = null;
  let weekAt = 0;
  function loadWeek() {
    if (settings.guest || !window.reader.readingWeek || Date.now() - weekAt < 60000) return;
    weekAt = Date.now();
    window.reader.readingWeek().then((w) => {
      if (!w || JSON.stringify(w) === JSON.stringify(week)) return;
      week = w;
      panelHtml = "";
      renderPanel();
      if (page === "week") renderHome();
    }).catch(() => {});
  }
  const DAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];
  function dur(sec) {
    const m = Math.round(sec / 60);
    if (m < 60) return `${m} хв`;
    return m % 60 ? `${Math.floor(m / 60)} год ${m % 60} хв` : `${Math.floor(m / 60)} год`;
  }
  const weekSum = (w) => (w?.days || []).reduce((a, s) => a + s, 0);
  function weekBars(w) {
    const top = Math.max(...w.days, 1);
    return `<span class="r-wbars">${w.days.map((s, i) => `<span class="r-wday${i > w.today ? " later" : ""}${i === w.today ? " now" : ""}"><span class="r-wcol"><span style="height:${s >= 30 ? Math.max(8, Math.round((s / top) * 100)) : 0}%"></span></span><small>${DAYS[i]}</small></span>`).join("")}</span>`;
  }
  function weekPanelHtml() {
    const sum = weekSum(week);
    if (sum < 60) return "";
    return `<h3>Цей тиждень</h3><span class="r-pweek-row"><b>${dur(sum)}</b>${weekBars(week)}</span>`;
  }
  function weekPageHtml() {
    const sum = weekSum(week);
    const prev = week?.weeks?.[1]?.sec || 0;
    const byPath = new Map((lib?.books || []).map((b) => [b.path, b]));
    const books = (week?.books || []).filter((b) => b.sec >= 30).map((b) => {
      const mine = byPath.get(b.name);
      // An article (articles.js) is counted as «article:<slug>»: its title from the list, else the slug in words.
      const art = b.name.startsWith("article:") && b.name.slice(8);
      const title = mine?.title || b.title || (art ? [...(arts?.later || []), ...(arts?.all || [])].find((a) => a.slug === art)?.title || art.replace(/-/g, " ") : b.name.replace(/\.[a-z0-9]+$/i, ""));
      return `<li>${mine ? `<button data-open="${esc(b.name)}">${esc(title)}</button>` : `<span>${esc(title)}</span>`}<i>${dur(b.sec)}</i></li>`;
    }).join("");
    return `<section class="r-week">${head("Цей тиждень", "", true)}
      ${sum < 60 ? `<p class="r-empty">Цього тижня ще не читали.</p>` : `<div class="r-week-top"><div><div class="r-week-num">${dur(sum)}</div>${prev >= 60 ? `<p class="r-week-prev">Минулого тижня ${dur(prev)}</p>` : ""}</div>${weekBars(week)}</div>
      ${books ? `<ul class="r-week-books">${books}</ul>` : ""}`}</section>`;
  }

  // ---------- «Статті» (Max, 2026-11-08): the site's articles, read here like a book (articles.js) ----------
  // Your «Прочитати пізніше» first, then the newest on the site; a link adds one. The list comes each time the page
  // opens (a few dozen titles), nothing is kept on the device.
  let arts = null; // { later, all } | { error }
  let artsBusy = false;
  function loadArticles() {
    if (artsBusy || !window.reader.articlesList) return;
    artsBusy = true;
    window.reader.articlesList()
      .then((d) => (arts = d))
      .catch((err) => (arts = { error: err instanceof TypeError ? "Немає з'єднання: статті відкриваються лише онлайн." : err.message }))
      .finally(() => ((artsBusy = false), page === "articles" && renderHome()));
  }
  function artRow(a) {
    const pct = a.read && a.read.blocks ? Math.round(((a.read.block + 1) / a.read.blocks) * 100) : 0;
    const meta = [a.author, a.source, `${a.minutes} хв`].filter(Boolean).map(esc).join(" · ");
    return `<li><button type="button" class="r-art" data-article="${esc(a.slug)}"><b>${esc(a.title)}</b><small>${meta}${pct >= 95 ? " · прочитано" : pct > 3 ? ` · ${pct}%` : ""}</small></button>
      <button type="button" class="r-art-later${a.later ? " on" : ""}" data-later="${esc(a.slug)}" title="${a.later ? "Прибрати з «Прочитати пізніше»" : "Прочитати пізніше"}" aria-label="Прочитати пізніше"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 3.5h11v17l-5.5-3.8-5.5 3.8z"/></svg></button></li>`;
  }
  function articlesPageHtml() {
    const form = `<form class="r-art-add"><input type="url" name="url" placeholder="Посилання на статтю" autocomplete="off" enterkeyhint="go" required /><button type="submit" class="pill">Додати</button></form>`;
    if (!arts) return `<section class="r-arts"><h1 class="r-arts-h">Статті</h1>${form}<p class="r-empty"><span class="spinner"></span></p></section>`;
    if (arts.error) return `<section class="r-arts"><h1 class="r-arts-h">Статті</h1>${form}<p class="r-empty">${esc(arts.error)}</p></section>`;
    const later = new Set(arts.later.map((a) => a.slug));
    const rest = arts.all.filter((a) => !later.has(a.slug));
    return `<section class="r-arts"><h1 class="r-arts-h">Статті</h1>${form}
      ${arts.later.length ? `${head("Прочитати пізніше", "", true)}<ul class="r-art-list">${arts.later.map(artRow).join("")}</ul>` : ""}
      ${rest.length ? `${head(arts.later.length ? "Ще на сайті" : "Нові", "", true)}<ul class="r-art-list">${rest.map(artRow).join("")}</ul>` : ""}
      <a class="r-art-site" href="https://chytai.org.ua/articles" target="_blank" rel="noopener">Статті на сайті ↗</a></section>`;
  }
  async function addArticle(form) {
    const input = form.querySelector("input");
    const url = input.value.trim();
    if (!url) return;
    const btn = form.querySelector("button");
    btn.disabled = true;
    btn.textContent = "Додаю…";
    try {
      const { slug } = await window.reader.articleAdd(url);
      input.value = "";
      arts = null;
      loadArticles();
      window.reader.openPath(`article:${slug}`);
    } catch (err) {
      showNotice(err instanceof TypeError ? "Немає з'єднання." : err.message, false);
    } finally {
      btn.disabled = false;
      btn.textContent = "Додати";
    }
  }
  async function toggleLater(slug, el) {
    const on = !el.classList.contains("on");
    el.classList.toggle("on", on);
    try {
      await window.reader.articleLater(slug, on);
      loadArticles();
    } catch (err) {
      el.classList.toggle("on", !on);
      showNotice(err.message, false);
    }
  }

  function renderHome() {
    if (!lib) return; // the skeleton stays until the library arrives
    $("#shell").dataset.page = page;
    $(".r-add-btn").hidden = !!settings.guest;
    renderPanel();
    // Typing the page or a note on a paper book's page: the library arriving again must not redraw it under the finger.
    if (page === "paper" && document.activeElement?.closest?.(".pp") && homeHtml) return;
    const pb = page === "paper" && lib.books.find((b) => b.path === paperPath);
    if (page === "paper" && !pb) page = "home";
    loadWeek();
    if (page === "articles" && !arts) loadArticles();
    const ha = $(".r-head-add h1");
    if (ha) ha.textContent = page === "articles" ? "Статті" : "Додати книжку";
    const html = pb ? window.Paper.pageHtml(pb) : page === "add" ? addPageHtml() : page === "week" ? weekPageHtml() : page === "articles" ? articlesPageHtml() : homePageHtml();
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

  function homePageHtml() {
    const books = myBooks();
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
    const rest = books.filter((b) => b !== cur);
    const groups = { all: rest, reading: rest.filter(isReading), new: rest.filter(isNewBook), done: rest.filter((b) => b.finished), paper: rest.filter((b) => b.paper) };
    // Every book is drawn once and a filter only hides cards: drawing the grid anew on each click reloaded
    // all the covers, which flickered on a slow connection (Max).
    const gcls = (b) => ["reading", "new", "done", "paper"].filter((k) => groups[k].includes(b)).map((k) => ` g-${k}`).join("");
    const empty = (k) => (groups[k].length ? "" : `<p class="r-empty g-${k}">Тут поки порожньо.</p>`);
    const plus = settings.guest || books.length ? "" : `<button class="r-card r-plus" data-page="add"><span class="r-plus-box"><b>+</b><span>Додати книжку</span><small>EPUB, PDF, MOBI</small></span></button>`;
    html += `<section class="r-mine">${head(`Мої книжки · ${books.length}`, books.length ? tabs([["all", "Усі", groups.all.length], ["reading", "Читаю", groups.reading.length], ["new", "Не почато", groups.new.length], ["done", "Прочитані", groups.done.length], ...(groups.paper.length ? [["paper", "Паперові", groups.paper.length]] : [])], homeFilter, "data-filter") + viewSwitch() : "", !cur)}
      <div class="r-filtered" data-show="${homeFilter}"><div class="r-grid${homeView === "list" ? " r-list" : ""}">${homeView === "list" && rest.length ? listHead() : ""}${(homeView === "list" ? [...rest].sort(sorters[homeSort] || sorters.opened) : rest).map((b) => card(b, homeView === "list" ? rowCols(b) + rowStatus(b) : mark(b), true, gcls(b))).join("")}${plus}</div>
      ${empty("reading")}${empty("new")}${empty("done")}${empty("paper")}</div></section>`;
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
    let freeHtml = "";
    if (free.length) {
      const fcls = (b) => (newest.indexOf(b) < 16 ? " g-new" : "") + (b.group === "Для дітей" ? " g-kids" : "") + (/класика/i.test(b.group) ? " g-classics" : "");
      freeHtml = `<section class="r-free">${head(`Вільна полиця · ${free.length} <span class="r-sub">Можна читати безкоштовно</span>`, freeAll ? tabs([["new", "Нові"], ["kids", "Для дітей"], ["classics", "Класика"], ["all", "Усі"]], freeTab, "data-free-tab") : `<button class="r-aside-link" data-act="free-all">Усі →</button>`)}
        <p class="r-sub-phone">Можна читати безкоштовно</p>
        ${freeAll
          ? `<div class="r-filtered" data-show="${freeTab}"><div class="r-grid r-free-grid">${newest.map((b) => card(b, "", false, fcls(b))).join("")}</div></div>`
          : `<div class="r-strip">${newest.slice(0, 18).map((b) => card(b, "", false)).join("")}</div>`}</section>`;
    }
    return `<div class="r-add-grid">
      <section class="r-file">${head(`Файл з <span class="r-ph">телефона</span><span class="r-dt">комп'ютера</span>`, "", true)}
        <div class="r-drop"><p class="r-drop-t r-dt">Перетягніть файл сюди</p>
          <button class="r-pill-line r-pick" data-act="add"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V5M7 10l5-5 5 5M5 20h14"/></svg><span class="r-dt">або вибрати файл</span><span class="r-ph">Вибрати файл</span></button>
          <div class="r-chips"><span>EPUB</span><span>PDF</span><span>MOBI</span></div>
          <p class="r-drop-note">MOBI і PDF з текстом перетворюються на EPUB, щоб працювали пояснення й нотатки. Скани лишаються PDF.</p></div></section>
      <section class="r-paper">${head("Паперова книжка", "", true)}
        <p class="r-drop-note">Читаєте на папері? Додайте книжку пошуком вище або за фото обкладинки. Пояснення й нотатки до неї будуть тут, і ШІ знатиме, на якій ви сторінці.</p>
        <button class="r-pill-line r-pick" data-act="cover-photo"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg><span>Сфотографувати обкладинку</span></button></section>
      ${freeHtml}
      <section class="r-where">${head("Де ще шукаємо", "", true)}
        <a class="r-where-row" href="https://chytai.org.ua" target="_blank" rel="noopener"><span>Каталог Chytai</span><small>де купити ↗</small></a>
        <div class="r-where-row soon"><span>Project Gutenberg</span><small>незабаром</small></div>
        <button class="r-where-row r-yak-row" data-act="yakaboo" aria-expanded="${yakOpen}"><span>Куплені на Yakaboo</span><small>${yakOpen ? "згорнути" : "як додати"}</small></button>
        ${yakOpen ? yakabooHtml() : ""}
        <div class="r-where-row soon"><span>Інші книгарні</span><small>незабаром</small></div></section>
    </div>`;
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
    homeHtml = page === "add" ? addPageHtml() : homePageHtml();
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
  const PANEL_W = 318;
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
    const kind = !ok ? null
      : open ? "panel"
      : app && page === "add" && x < EDGE ? "back"
      : app && x < EDGE ? "panel"
      : app && page === "home" && !settings.guest && x > innerWidth - EDGE ? "add"
      : null;
    drag = kind ? { kind, x, y: e.touches[0].clientY, open, dir: null, pos: open ? PANEL_W : 0, t: Date.now() } : null;
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
    drag.pos = Math.max(0, Math.min(PANEL_W, (drag.open ? PANEL_W : 0) + dx));
    $("#shell-main").style.transform = `translateX(${drag.pos}px)`;
  }, { passive: false });
  const endDrag = () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.dir !== "h") return;
    const fast = Date.now() - d.t < 250;
    if (d.kind !== "panel") {
      const go = Math.abs(d.pos) > (fast ? 30 : innerWidth / 3);
      if (d.under) settlePages(d.kind, d.pos, go, d.under);
      else $("#shell").classList.remove("page-drag"), ($("#shell-main").style.transform = "");
      return;
    }
    const open = fast ? (d.open ? d.pos > PANEL_W - 40 : d.pos > 40) : d.pos > PANEL_W / 2;
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
    if (await window.reader.uploadFiles?.([...e.dataTransfer.files])) (homeHtml = ""), window.Library.data(true).then((d) => ((lib = d), render()));
  });

  // ---------- Пошук ----------

  let discQuery = "";
  let discHtml = "";
  // ---------- Клуб: what others read now, and the Club's talks (Max, 2026-11-01) ----------

  let club = null; // the site's /api/club-feed
  let clubAt = 0;
  let clubHtml = "";
  let clubFailed = false;
  const CLUB_SEEN = "chytai.clubSeen";
  const clubSeen = () => {
    try {
      return localStorage.getItem(CLUB_SEEN) || "";
    } catch {
      return "";
    }
  };
  const newestTalk = () => (club?.talks || []).reduce((m, t) => (t.active > m ? t.active : m), "");
  function loadClub() {
    if (settings.guest || !window.reader.clubFeed || Date.now() - clubAt < 60 * 1000) return Promise.resolve(false);
    clubAt = Date.now();
    return window.reader.clubFeed().then((d) => ((club = d), true)).catch(() => ((clubFailed = true), true));
  }
  // A dot on the tab when something was said in the Club since the tab was last open.
  function clubDot() {
    const newest = newestTalk();
    if (tab === "club" && newest) {
      try {
        localStorage.setItem(CLUB_SEEN, newest);
      } catch {
        /* private mode */
      }
    }
    const seen = clubSeen();
    $("#club-dot").classList.toggle("hidden", !newest || tab === "club" || (!!seen && newest <= seen));
  }
  const ago = (iso) => (iso ? when(new Date(iso).getTime()) : "");
  function renderClub() {
    clubDot();
    let html;
    if (!club) html = `<p class="m">${!clubFailed ? "Завантажую…" : "Не вдалося завантажити Клуб. Перевірте з'єднання."}</p>`;
    else {
      const seen = clubSeen();
      const reading = club.reading || [];
      html = reading.length
        ? `<section class="home-sec"><div class="sec-head"><span>Зараз читають</span></div>
          <div class="shelf">${reading.map((b) => `<a class="shelf-book" href="${esc(b.href)}" target="_blank" rel="noopener">
            <span class="cover mid" style="--hue:${[...b.title].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0) % 360}"><span class="cover-t">${esc(b.title)}</span><span class="cover-a">${esc(b.author)}</span>${b.cover ? `<img src="${esc(b.cover)}" alt="" loading="lazy" onerror="this.remove()" />` : ""}</span>
            <span class="t">${esc(b.title)}</span><span class="m ellipsis">${esc(b.reader.name)}</span></a>`).join("")}</div></section>`
        : "";
      html += `<section class="home-sec"><div class="sec-head"><span>Обговорення</span><a class="site-link" href="${esc(club.newTopic)}" target="_blank" rel="noopener">Нова тема ↗</a></div>
        <div class="club-talks">${(club.talks || []).map((t) => `<a class="club-talk${seen && t.active > seen ? " fresh" : ""}" href="${esc(t.href)}" target="_blank" rel="noopener">
            <span class="row-text"><span class="t">${t.official ? "📌 " : ""}${esc(t.title)}</span>
            <span class="m">${[t.by, t.replies ? `${t.replies} ${plural(t.replies, "відповідь", "відповіді", "відповідей")}` : "", ago(t.active), t.spoiler ? "спойлери" : ""].filter(Boolean).map(esc).join(" · ")}</span></span>
          </a>`).join("") || `<p class="m">Тем ще немає.</p>`}</div>
        <a class="site-link" href="${esc(club.club)}" target="_blank" rel="noopener">Увесь Клуб на сайті ↗</a></section>`;
    }
    if (html !== clubHtml) $("#club-body").innerHTML = clubHtml = html;
    if (tab === "club") loadClub().then((fresh) => fresh && tab === "club" && renderClub());
  }

  function renderDiscover() {
    const box = $("#disc-body");
    if (!lib) return (box.innerHTML = `<p class="home-wait"><span class="spinner"></span>Завантажую…</p>`);
    const free = lib.free || [];
    const q = norm(discQuery);
    if (q) {
      const mine = lib.books.filter((b) => matches(b, q));
      const freeHits = free.filter((b) => matches(b, q) && !lib.books.some((x) => x.path === b.path));
      box.innerHTML = (mine.length ? `<section class="home-sec"><div class="sec-head"><span>У моїх книжках</span></div><div class="tiles">${mine.map(tile).join("")}</div></section>` : "") +
        (freeHits.length ? `<section class="home-sec"><div class="sec-head"><span>На вільній полиці</span></div><div class="tiles">${freeHits.map(tile).join("")}</div></section>` : "") +
        (!mine.length && !freeHits.length ? `<p class="m disc-none">Нічого не знайшлося.</p>` : "") +
        `<p class="m disc-site">Шукати на <a href="https://chytai.org.ua/search?q=${encodeURIComponent(discQuery)}" target="_blank" rel="noopener">chytai.org.ua</a></p>`;
      return;
    }
    let html = "";
    if (!settings.guest) html += `<button class="add-card" data-act="add">
        <span class="add-plus">+</span>
        <span class="row-text"><span class="t">Додати свої книжки</span><span class="m">EPUB, PDF або MOBI з ${matchMedia("(pointer: coarse)").matches ? "телефона" : "комп'ютера"}</span></span>
      </button>`;
    const fresh = arrivals();
    if (fresh.length) html += `<section class="home-sec"><div class="sec-head"><span>Нові надходження</span></div>
      <div class="shelf">${fresh.map((b) => `<button class="shelf-book" data-open="${esc(b.path)}">${cover(b, "mid")}<span class="t">${esc(b.title)}</span><span class="m ellipsis">${esc(b.authors[0] || "")}</span></button>`).join("")}</div></section>`;
    const groups = new Map();
    for (const b of free) {
      if (!groups.has(b.group)) groups.set(b.group, []);
      groups.get(b.group).push(b);
    }
    if (free.length) html += `<section class="home-sec"><div class="sec-head"><span>Вільна полиця · ${free.length}</span>${settings.guest ? "" : `<a class="site-link" href="https://chytai.org.ua/publishers/chytai-free" target="_blank" rel="noopener">На сайті ↗</a>`}</div>
      <p class="m disc-hint">Книжки, які можна читати безкоштовно.</p>
      ${[...groups].map(([group, list]) => `${group ? `<div class="free-group m">${esc(group)}</div>` : ""}
        <div class="shelf">${list.map((b) => `<button class="shelf-book" data-open="${esc(b.path)}">${cover(b, "mid")}<span class="t">${esc(b.title)}</span><span class="m ellipsis">${esc(b.authors[0] || "")}</span></button>`).join("")}</div>`).join("")}
    </section>`;
    html += `<p class="m disc-site">Більше книжок і де їх узяти: <a href="https://chytai.org.ua" target="_blank" rel="noopener">chytai.org.ua</a></p>`;
    if (html === discHtml) return;
    discHtml = html;
    box.innerHTML = html;
  }
  $("#disc-search").addEventListener("input", (e) => {
    discQuery = e.target.value;
    renderDiscover();
  });

  function renderHomeOld() {
    if (!lib) return; // the skeleton stays until the library arrives
    const books = lib.books;
    const byPath = new Map(books.map((b) => [b.path, b]));
    let html = "";
    const parts = {};


    // Продовжити: the book read last, then up to two others still in progress.
    const cur = byPath.get(lib.lastBook);
    const others = books
      .filter((b) => b !== cur && b.openedAt && (b.pct == null ? b.started : reading(b)))
      .sort((x, y) => y.openedAt - x.openedAt)
      .slice(0, 2);
    if (cur) {
      parts.cont = `<section class="home-sec sec-cont"><div class="sec-head"><span>Продовжити</span></div>
        <button class="hero" data-open="${esc(cur.path)}">
          ${asideButton(cur)}
          ${cover(cur, "big")}
          <span class="hero-text">
            <span class="kicker">читаю зараз</span>
            <span class="t">${esc(cur.title)}</span>
            <span class="m">${esc(author(cur))}</span>
            <span class="hero-foot">
              ${cur.chapter ? `<span class="m ellipsis">${esc(cur.chapter)}</span>` : ""}
              ${cur.pct != null ? bar(cur.pct) : ""}
              <span class="hero-row"><span class="m">${cur.pct != null ? `${cur.pct}%` : ""}</span><span class="pill">Читати</span></span>
            </span>
          </span>
        </button>
        ${others.map((b) => `<button class="row-book" data-open="${esc(b.path)}">
            <span class="row-text"><span class="t">${esc(b.title)}</span><span class="m">${esc(author(b))}</span></span>
            ${b.pct != null ? `${bar(b.pct, "small")}<span class="m pct">${b.pct}%</span>` : ""}
            ${asideButton(b)}
          </button>`).join("")}
      </section>`;
    }

    // Моя полиця: everything, the books opened lately first, then the newest.
    if (books.length) {
      const shelf = [...books].sort((x, y) => (y.openedAt || 0) - (x.openedAt || 0) || (y.addedAt || 0) - (x.addedAt || 0)).slice(0, 24);
      parts.shelf = `<section class="home-sec sec-shelf"><div class="sec-head"><span>Моя полиця · ${books.length}</span><button class="link" data-tab="library">Уся бібліотека</button></div>
        <div class="shelf">${shelf.map((b) => `<button class="shelf-book" data-open="${esc(b.path)}">
            ${cover(b, "mid")}<span class="t">${esc(b.title)}</span><span class="m ellipsis">${esc(b.authors[0] || "")}</span>
          </button>`).join("")}</div>
      </section>`;
    }

    // Вільна полиця: the public-domain books every account sees, by group (free/shelf.json on the server).
    const free = lib.free || [];
    if (free.length) {
      const groups = new Map();
      for (const b of free) {
        if (!groups.has(b.group)) groups.set(b.group, []);
        groups.get(b.group).push(b);
      }
      parts.free = `<section class="home-sec sec-shelf sec-free"><div class="sec-head"><span>Вільна полиця · ${free.length}</span></div>
        ${[...groups].map(([group, list]) => `${group ? `<div class="free-group m">${esc(group)}</div>` : ""}
          <div class="shelf">${list.map((b) => `<button class="shelf-book" data-open="${esc(b.path)}">
            ${cover(b, "mid")}<span class="t">${esc(b.title)}</span><span class="m ellipsis">${esc(b.authors[0] || "")}</span>
          </button>`).join("")}</div>`).join("")}
      </section>`;
    }

    // Нотатки: how many, and in which books.
    const noteBooks = Object.entries(notes || {}).filter(([, list]) => list.length).sort((a, b) => b[1].length - a[1].length);
    const noteCount = noteBooks.reduce((n, [, list]) => n + list.length, 0);
    if (noteCount) {
      const noteTitle = (p) => byPath.get(p.replace(/#reflow$/, ""))?.title || p.replace(/\.[^.]+$/, "");
      const latest = noteBooks.flatMap(([, list]) => list).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
      // A phone shows chips per book; a wide screen a list per book and the latest passage.
      parts.notes = `<section class="home-sec sec-notes">
        <div class="sec-head wide-only"><span>Нотатки</span><button class="link" data-tab="notes">Усі нотатки</button></div>
        <button class="notes-card" data-tab="notes">
          <span class="sec-head plain narrow-only"><span>Нотатки</span><span class="link">Усі нотатки ›</span></span>
          <span class="notes-count"><b>${noteCount}</b><span class="m">${plural(noteCount, "нотатка", "нотатки", "нотаток")} у ${noteBooks.length} ${noteBooks.length === 1 ? "книжці" : "книжках"}</span></span>
          <span class="chips narrow-only">${noteBooks.slice(0, 4).map(([p, list]) => `<span class="chip">${esc(noteTitle(p))} <span class="m">${list.length}</span></span>`).join("")}</span>
          <span class="note-books wide-only">${noteBooks.slice(0, 5).map(([p, list]) => `<span class="note-book"><span class="t">${esc(noteTitle(p))}</span><span class="m">${list.length}</span></span>`).join("")}</span>
          ${latest ? `<span class="note-quote latest wide-only">${esc(latest.text.length > 220 ? `${latest.text.slice(0, 220)}…` : latest.text)}</span>` : ""}
        </button></section>`;
    }

    // Нові надходження: what others added in the last month; a dot until you open it.
    const fresh = arrivals();
    if (fresh.length) {
      const unseen = fresh.some((b) => !b.seen);
      parts.arr = `<section class="home-sec sec-arr"><div class="sec-head"><span>Нові надходження</span>${unseen ? `<button class="link" data-act="seen">Позначити переглянутими</button>` : ""}</div>
        ${fresh.map((b) => `<button class="arrival" data-open="${esc(b.path)}">
            ${cover(b, "small")}
            <span class="row-text"><span class="t">${esc(b.title)}</span><span class="m">${esc(author(b))}</span>
              <span class="m">${esc(`${b.addedBy} · ${when(b.addedAt)}`)}${wishedFor(b) ? `<span class="accent"> · було в бажаному</span>` : ""}</span></span>
            <span class="dot${b.seen ? " off" : ""}"></span>
          </button>`).join("")}
      </section>`;
    }

    // Хочу прочитати: the top of the list, with «Уже є» once someone added the book.
    // On a wide screen the whole list is here, with its own field to add to it.
    // Only for those who already keep one: the list is from the family library, and the site has its own
    // «Хочу прочитати» (reader usability review, 2026-10-28).
    if (window.reader.wishList && !settings.guest && wish?.length) {
      const list = wish || [];
      parts.wish = `<section class="home-sec sec-wish"><div class="sec-head"><span>Хочу прочитати${list.length ? ` · ${list.length}` : ""}</span><button class="link narrow-only" data-tab="wish">${list.length ? "Увесь список" : "Додати"}</button></div>
        <div class="narrow-only">${list.length ? list.slice(0, 3).map((w) => {
          const b = bookFor(w);
          return `<div class="wish-row"><span class="row-text"><span class="t">${esc(w.title)}</span><span class="m">${esc(w.author)}</span></span>
            ${b ? `<button class="pill small" data-open="${esc(b.path)}">Уже є</button>` : ""}</div>`;
        }).join("") : `<p class="m">Запишіть книжку, яку хочете прочитати: коли вона з'явиться в бібліотеці, ви побачите це тут.</p>`}</div>
        <div class="wide-only">
          <form class="wish-form"><input placeholder="Назва та автор" autocomplete="off" /><button type="submit" class="pill">Додати</button></form>
          ${wishRows(list)}
        </div>
      </section>`;
    }

    // Rows for a wide screen (Продовжити | Нотатки, the shelf, Нові надходження | Хочу прочитати); on a phone the
    // rows dissolve and the sections stack in the order of the mock-up (style.css).
    const row = (cls, ...xs) => (xs.some(Boolean) ? `<div class="home-row ${cls}">${xs.filter(Boolean).join("")}</div>` : "");
    // No books of your own yet: most people have no EPUB at hand, so the free shelf comes first and adding
    // your own files is one line under it.
    if (!books.length) {
      const add = settings.guest ? "" : `<p class="home-own m">Свої книжки в EPUB чи PDF теж можна читати тут. <button class="link" data-act="add">Додати книжки…</button></p>`;
      html += parts.free ? add + parts.free : `<div class="home-empty"><p>Бібліотека поки порожня.</p>${add}</div>`;
    } else html += row("top", parts.cont, parts.notes) + (parts.shelf || "") + row("bottom", parts.arr, parts.wish) + (parts.free || "");
    $("#home-body").innerHTML = html;
  }

  // ---------- Нотатки ----------

  function renderNotes() {
    const box = $("#all-notes-body");
    if (!notes) return (box.innerHTML = `<div class="lib-empty">Завантажую нотатки…</div>`);
    const byPath = new Map((lib?.books || []).map((b) => [b.path, b]));
    const all = Object.entries(notes)
      .flatMap(([p, list]) => list.map((n) => ({ ...n, book: p.replace(/#reflow$/, "") })))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    if (!all.length) return (box.innerHTML = `<div class="lib-empty">Нотаток ще немає. Виділіть уривок у книжці й натисніть «В нотатки».</div>`);
    const books = new Set(all.map((n) => n.book)).size;
    box.innerHTML = `<p class="view-hint">${all.length} ${plural(all.length, "нотатка", "нотатки", "нотаток")} у ${books} ${books === 1 ? "книжці" : "книжках"}</p>` +
      all.map((n, i) => {
        const title = byPath.get(n.book)?.title || n.book.replace(/\.[^.]+$/, "");
        const text = n.text.length > 500 ? `${n.text.slice(0, 500)}…` : n.text;
        return `<div class="note-card">
          <div class="note-quote">${esc(text)}</div>
          ${n.comment ? `<div class="note-comment-text">${esc(n.comment)}</div>` : ""}
          <div class="note-foot"><span class="ellipsis">${esc([title, n.chapter].filter(Boolean).join(" · "))}</span><button class="link" data-note="${i}">Перейти</button></div>
        </div>`;
      }).join("");
    box.notes = all;
  }

  // ---------- Хочу прочитати ----------

  function wishRows(list) {
    return list.map((w) => {
      const b = bookFor(w);
      return `<div class="wish-row line"><span class="row-text"><span class="t">${esc(w.title)}</span>
          <span class="m">${esc([w.author, b && `уже в бібліотеці${b.addedBy ? `, додав ${b.addedBy}` : ""}`].filter(Boolean).join(" · "))}</span></span>
        ${b ? `<button class="pill small" data-open="${esc(b.path)}">Читати</button>` : ""}
        <button class="icon-btn" data-unwish="${esc(w.id)}" title="Прибрати">✕</button></div>`;
    }).join("");
  }

  function renderWish() {
    const list = wish || [];
    $("#wish-body").innerHTML = list.length ? wishRows(list) : `<div class="lib-empty">Список порожній.</div>`;
  }

  // Both the «Хочу прочитати» view and the wide home screen have a field for it.
  $("#shell").addEventListener("submit", async (e) => {
    if (e.target.matches(".r-art-add")) return e.preventDefault(), addArticle(e.target);
    if (!e.target.matches(".wish-form")) return;
    e.preventDefault();
    const input = e.target.querySelector("input");
    const value = input.value.trim();
    if (!value) return;
    const [title, ...rest] = value.split(/\s+[—–-]\s+|,\s*/);
    try {
      wish = await window.reader.wishAdd({ title, author: rest.join(", ") });
      input.value = "";
      toast("Додано до бажаного");
      render();
    } catch (err) {
      showNotice(err instanceof TypeError ? "Немає з'єднання: список бажаного змінюється лише онлайн." : `Не вдалося додати: ${err.message}`, false);
    }
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
    if (b?.unavailable) return showNotice("Немає з'єднання, а ця книжка ще не збережена на пристрої.", false);
    window.reader.openPath(path);
  }

  $("#shell").addEventListener("click", async (e) => {
    const el = e.target.closest("[data-menu], [data-aside], [data-hit], [data-open], [data-tab], [data-act], [data-note], [data-unwish], [data-page], [data-take], [data-paper-add], [data-article], [data-later]");
    // #shell itself carries data-page (the page shown): a tap on anything else, the search field in the phone's
    // panel too, came here as «Мої книжки» and closed the panel, so search did nothing on a phone (Max, 2026-11-03).
    if (!el || el.id === "shell") return;
    if (el.dataset.article) return panel(false), window.reader.openPath(`article:${el.dataset.article}`);
    if (el.dataset.later) return toggleLater(el.dataset.later, el);
    if (el.dataset.menu) return bookMenu(el.dataset.menu, el);
    if (el.dataset.aside) return setAside(el.dataset.aside);
    if (el.dataset.take) return takeBook(el.dataset.take, el);
    if (el.dataset.paperAdd != null) return paperFromCatalog(Number(el.dataset.paperAdd));
    if (el.dataset.page) {
      const to = el.dataset.page;
      if (el.closest(".r-head") && to !== page && (to === "add" || (to === "home" && page === "add")) && !(to === "add" && settings.guest) && slidePage(to)) return;
      return to === "home" && page !== "home" ? backHome() : setPage(to);
    }
    if (el.dataset.hit != null) return openHit(Number(el.dataset.hit));
    if (el.dataset.open != null) return panel(false), openBook(el.dataset.open);
    if (el.dataset.tab) {
      // The «Мої книжки» tab always shows all your books: a filter typed earlier goes (Max, 2026-11-01).
      return show(el.dataset.tab);
    }
    if (el.dataset.note != null) {
      const note = $("#all-notes-body").notes?.[Number(el.dataset.note)];
      if (note) openNoteInBook(note.book, note);
      return;
    }
    if (el.dataset.unwish) {
      try {
        wish = await window.reader.wishRemove(el.dataset.unwish);
        render();
      } catch (err) {
        showNotice(err instanceof TypeError ? "Немає з'єднання: список бажаного змінюється лише онлайн." : err.message, false);
      }
      return;
    }
    if (el.dataset.act === "add") return $("#lib-add").click();
    if (el.dataset.act === "trash") return panel(false), openTrash();
    if (el.dataset.act === "panel") return panel();
    if (el.dataset.act === "settings") return panel(false), openSettings();
    if (el.dataset.act === "cover-photo") return window.Paper.coverPhoto();
    if (el.dataset.act === "free-all") return (freeAll = true), renderHome();
    if (el.dataset.act === "yakaboo") return (yakOpen = !yakOpen), renderHome();
    if (el.dataset.act === "seen") markSeen();
  });

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
    window.Library.render?.();
  }

  // ---------- A book's menu: lend it, fix its title, put it away, delete it ----------

  let menuBook = null;
  // On a phone a sheet from the bottom; with a mouse a small menu by the ⋯ or where the right click was.
  function bookMenu(path, at = null) {
    const b = lib?.books.find((x) => x.path === path);
    if (!b || settings.guest) return;
    menuBook = b;
    const own = !b.free && !b.protected && !b.paper;
    const d = $("#book-menu");
    $("#bm-title").textContent = b.title;
    $("#bm-author").textContent = [author(b), statusText(b)].filter(Boolean).join(" · ");
    $("#bm-cover").innerHTML = rcover(b);
    const pop = !!at && matchMedia("(min-width: 761px)").matches;
    d.classList.toggle("pop", pop);
    if (pop) {
      const r = at instanceof Element ? at.getBoundingClientRect() : { left: at.x, right: at.x, bottom: at.y, top: at.y };
      d.style.left = `${Math.max(12, Math.min(innerWidth - 232, r.left))}px`;
      d.style.top = `${Math.min(innerHeight - 240, r.bottom + 6)}px`;
    } else d.style.left = d.style.top = "";
    // «Дати почитати» is hidden for now (Max, 2026-11-01).
    $("#bm-edit").hidden = !(own && window.reader.libraryUpdateBook);
    // A PDF added before uploads became EPUB (2026-11-01): it opens slowly, so it can become one now.
    $("#bm-epub").hidden = !(own && /\.pdf$/i.test(b.path) && window.reader.libraryPdfToEpub);
    // Your own file is deleted; a book from the free shelf or a publisher just leaves the home screen.
    $("#bm-aside").hidden = own;
    $("#bm-delete").hidden = !(own && window.reader.libraryDeleteBook);
    $("#bm-finished").hidden = !window.reader.libraryFinished;
    $("#bm-finished").textContent = b.finished ? "Позначити непрочитаною" : "Позначити прочитаною";
    d.returnValue = "";
    d.showModal();
  }
  // «Про книжку»: the device's copy at once, then the network's when it answers.
  async function showAbout(b) {
    const d = $("#about-dialog");
    $("#ab-cover").innerHTML = rcover(b);
    $("#ab-title").textContent = b.title;
    $("#ab-author").textContent = author(b);
    const link = $("#ab-link");
    const fill = (a) => {
      if (!a) {
        $("#ab-body").innerHTML = `<p class="muted">${navigator.onLine ? "Завантажую…" : "Немає з'єднання, а опис цієї книжки ще не збережено."}</p>`;
        link.hidden = true;
        return;
      }
      $("#ab-author").textContent = [author(b), a.year].filter(Boolean).join(" · ");
      $("#ab-body").innerHTML = a.found
        ? a.blurb ? a.blurb.split(/\n\n+/).map((p) => `<p>${esc(p)}</p>`).join("") : `<p class="muted">Опису поки немає.</p>`
        : `<p class="muted">Цієї книжки ще немає в каталозі Chytai.</p>`;
      link.hidden = false;
      link.href = a.found ? a.href : a.add;
      link.textContent = a.found ? "Сторінка книжки на Chytai ↗" : "Додати на Chytai ↗";
    };
    fill(await window.reader.bookAbout?.(b, true));
    d.showModal();
    const fresh = await window.reader.bookAbout?.(b);
    if (fresh && d.open) fill(fresh);
    else if (!fresh && d.open && $("#ab-body").textContent === "Завантажую…") $("#ab-body").innerHTML = `<p class="muted">Не вдалося завантажити опис.</p>`;
  }
  // «Про книжку» as a block at the end of a book's panel that unfolds in place, like the questions and
  // notes above it (Max 2026-11-05: no separate dialog). Same block for paper and e-books.
  const aboutKept = new Map(); // path → the summary, once loaded
  function aboutBlock(b, open) {
    const a = b && aboutKept.get(b.path);
    let body = "";
    if (open) {
      if (a?.failed) body = `<p class="muted">Не вдалося завантажити опис.</p>`;
      else if (!a) body = `<p class="muted">${navigator.onLine ? "Завантажую…" : "Немає з'єднання, а опис цієї книжки ще не збережено."}</p>`;
      else {
        const meta = [author(b), a.year].filter(Boolean).join(" · ");
        body = `${meta ? `<p class="ab-meta">${esc(meta)}</p>` : ""}${a.found
          ? a.blurb ? a.blurb.split(/\n\n+/).map((p) => `<p>${esc(p)}</p>`).join("") : `<p class="muted">Опису поки немає.</p>`
          : `<p class="muted">Цієї книжки ще немає в каталозі Chytai.</p>`}
          <a class="ab-site" href="${esc(a.found ? a.href : a.add)}" target="_blank" rel="noopener">${a.found ? "Сторінка книжки на Chytai ↗" : "Додати на Chytai ↗"}</a>`;
      }
    }
    return `<section class="ab-block${open ? " open" : ""}"><button type="button" class="pp-row" data-about-toggle><span>Про книжку</span><span class="ab-chev">›</span></button>${open ? `<div class="ab-inline">${body}</div>` : ""}</section>`;
  }
  // Loads the summary (the kept copy first, then a fresh one) and calls done after each that arrives.
  async function loadAbout(b, done) {
    if (!b || !window.reader.bookAbout) return;
    const kept = aboutKept.get(b.path) || (await window.reader.bookAbout(b, true));
    if (kept) aboutKept.set(b.path, kept), done();
    const fresh = await window.reader.bookAbout(b);
    if (fresh) aboutKept.set(b.path, fresh);
    else if (!kept) aboutKept.set(b.path, { found: false, failed: true });
    done();
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
    if (act === "share") return window.Library.shareBook(b.path);
    if (act === "edit") return window.Library.editBook(b.path);
    if (act === "aside") return setAside(b.path);
    if (act === "epub") return pdfToEpub(b);
    if (act === "finished") {
      b.finished = !b.finished;
      homeHtml = "";
      render();
      return window.reader.libraryFinished(b.path, b.finished).catch(() => {
        b.finished = !b.finished;
        homeHtml = "";
        render();
        showNotice("Немає з'єднання: позначити книжку можна лише онлайн.", false);
      });
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
    window.Library.render?.();
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
    showNotice(`«${b.title}» тепер EPUB. PDF у «Нещодавно видалених».`, false);
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
    const t = e.target.closest(".tile, .home-hero, .r-card[data-open], .r-now-cover, .r-row");
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
    if (!tilePressed || !e.target.closest(".tile, .home-hero, .r-card[data-open], .r-now-cover, .r-row")) return;
    tilePressed = false;
    e.stopImmediatePropagation();
  }, true);
  $("#shell").addEventListener("contextmenu", (e) => {
    const t = e.target.closest(".tile, .home-hero, .r-card[data-open], .r-now-cover, .r-row");
    if (!t || settings.guest || !lib?.books.some((b) => b.path === t.dataset.open)) return;
    e.preventDefault();
    bookMenu(t.dataset.open, { x: e.clientX, y: e.clientY });
  });

  // A long press on a phone shows the ×; the tap that ends the press does not open the book.
  let pressTimer = null;
  let pressed = false;
  $("#shell").addEventListener("touchstart", (e) => {
    const row = e.target.closest(".hero, .row-book, .side-book");
    if (!row || !canAside()) return;
    pressed = false;
    pressTimer = setTimeout(() => {
      pressed = true;
      document.querySelectorAll("#shell .show-aside").forEach((r) => r.classList.remove("show-aside"));
      row.classList.add("show-aside");
    }, 500);
  }, { passive: true });
  for (const type of ["touchend", "touchmove", "touchcancel"]) $("#shell").addEventListener(type, () => clearTimeout(pressTimer), { passive: true });
  $("#shell").addEventListener("contextmenu", (e) => e.target.closest(".hero, .row-book, .side-book") && e.preventDefault());
  $("#shell").addEventListener("click", (e) => {
    if (!pressed) return;
    pressed = false;
    if (!e.target.closest("[data-aside]")) e.stopImmediatePropagation();
  }, true);

  // The gear moved into the avatar menu (design «3a»).
  $("#side-settings").onclick = () => openSettings();
  $("#top-add").onclick = () => $("#lib-add").click();
  // The search on top of a wide screen searches the library, so typing there opens it.
  // Search opens the library; Esc in the field clears it and goes back to where the search started.
  let beforeSearch = null;
  function searchLibrary() {
    if (tab === "library") return;
    beforeSearch = tab;
    show("library");
  }
  $("#top-search").addEventListener("focus", searchLibrary);
  $("#top-search").addEventListener("input", () => {
    $("#lib-search").value = $("#top-search").value;
    searchLibrary();
    $("#lib-search").dispatchEvent(new Event("input"));
  });
  $("#btn-library").onclick = () => (isOpen() && current ? hide() : show("home"));

  // Single keys on a keyboard: Esc back to the book, 1 2 3 for the tabs, / to search, T for the contents, − + for the
  // font, ? for the list. Never while typing or with a dialog open; guests have no home screen.
  // Matched by the physical key, so they work the same with the Ukrainian layout on.
  const TAB_KEYS = {}; // one page since design «3a» (Max, 2026-11-01)
  function key(e) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return; // desk-read.js took it
    if (e.target?.closest?.("input, textarea, select, [contenteditable]")) return;
    if (document.querySelector("dialog[open]")) return;
    const guest = document.body.classList.contains("guest");
    const reading = !isOpen() && current;
    let act = null;
    const code = e.code;
    if (e.key === "Escape" && isOpen() && $("#shell").classList.contains("panel-open")) act = () => panel(false);
    else if (e.key === "Escape" && isOpen() && page !== "home") act = backHome;
    else if (e.key === "Escape" && current && isOpen()) act = hide;
    else if (TAB_KEYS[code] && !e.shiftKey && !guest) act = () => show(TAB_KEYS[code]);
    else if (code === "Slash" && !e.shiftKey) {
      act = reading
        ? () => window.BookSearch?.open()
        : () => {
            if (tab !== "home") show("home");
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
  for (const field of [$("#top-search"), $("#lib-search")]) {
    field.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      $("#top-search").value = $("#lib-search").value = "";
      $("#lib-search").dispatchEvent(new Event("input"));
      field.blur();
      if (beforeSearch) show(beforeSearch);
    });
  }
  $("#btn-keys").onclick = () => {
    $("#settings").close();
    $("#keys").showModal();
  };
  window.reader.onShowLibrary(() => $("#btn-library").click()); // ⌘L: Мої книжки, as «←» in the book
  window.reader.onBookOpen(() => hide());
  // A note saved or removed in the book shows up here next time.
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && isOpen() && tab !== "library" && load());

  // The library list changed (a rescan, an edit, a deletion): draw again from it.
  async function refresh() {
    if (!isOpen()) return;
    lib = await window.Library.data(false);
    render();
  }

  window.Shell = {
    show, hide, panelFromBook, isNew, arrivals, markSeen, refresh, key, cover, when, setAside, rcover, showAbout, openPaper, aboutBlock, loadAbout,
    book: (path) => lib?.books.find((b) => b.path === path) || null,
    rerender: () => ((homeHtml = ""), renderHome()),
    reload: async () => ((lib = await window.Library.data(true)), (homeHtml = "")),
  };

  // The family starts here; a guest has one book, which the bridge opens straight away.
  settingsReady
    .then(() => (settings.guest ? hide() : show("home")))
    .catch(() => show("home"));
})();

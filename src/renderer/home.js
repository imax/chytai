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
  let homeQuery = "";
  let homeFilter = "all"; // all | reading | new | done
  let freeTab = "new"; // new | kids | classics | all
  let homeHtml = "";
  const lastTouched = (b) => Math.max(b.openedAt || 0, b.addedAt || 0);
  const matches = (b, q) => norm(`${b.title} ${b.authors.join(" ")}`).includes(q);
  const hue = (t) => [...String(t || "")].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0) % 360;
  const isReading = (b) => !b.finished && b.pct != null && b.pct >= 1 && b.pct < 99;
  const isNewBook = (b) => !b.finished && !b.started && !(b.pct > 0);
  // Progress sits on the cover itself: a thin bar while reading, a small mark when finished. A line of text
  // under each cover took height and said little (Max).
  const mark = (b) => (b.finished ? `<span class="r-done" title="Прочитано">✓</span>` : b.pct > 0 ? `<span class="r-bar" title="${b.pct}%"><span style="width:${Math.max(b.pct, 3)}%"></span></span>` : "");
  const statusText = (b) => (b.finished ? "прочитано" : b.pct > 0 ? `${b.pct}%` : "не почато");
  // A cover: the picture when there is one, the site's typographic stand-in under it otherwise.
  const rcover = (b, url = window.reader.coverUrl?.(b)) => `<span class="r-cover" style="--h:${hue(b.title)}" lang="${esc(b.language || "uk")}">
      <span class="r-cover-t">${esc(b.title)}</span><span class="r-cover-a">${esc((b.authors || [b.author])[0] || "")}</span>
      ${url ? `<img src="${esc(url)}" alt="" loading="lazy" onerror="this.remove()" />` : ""}</span>`;
  const more = (b) => (settings.guest ? "" : `<span class="r-more" role="button" tabindex="0" data-menu="${esc(b.path)}" title="Ще" aria-label="Ще"><i></i><i></i><i></i></span>`);
  const card = (b, foot, menu = true, cls = "") => `<button class="r-card${cls}" data-open="${esc(b.path)}">${rcover(b)}${menu ? more(b) : ""}
      <span class="r-t">${esc(b.title)}</span><span class="r-a">${esc(author(b))}</span>${foot}</button>`;
  const head = (title, aside = "", plain = false) => `<div class="r-sec-head${plain ? " plain" : ""}"><h2>${title}</h2>${aside}</div>`;
  const tabs = (list, active, attr) => `<div class="r-tabs">${list.map(([k, label, n]) => `<button class="${k === active ? "on" : ""}" ${attr}="${k}">${label}${n != null ? ` <i>${n}</i>` : ""}</button>`).join("")}</div>`;

  function myBooks() {
    return lib.books.filter((b) => !(b.aside && (b.free || b.protected))).sort((x, y) => lastTouched(y) - lastTouched(x));
  }
  // The book you are reading now: the one opened last, if it is between 1% and 99%.
  function nowBook(books) {
    const last = books.find((b) => b.path === lib.lastBook);
    if (last && isReading(last)) return last;
    return books.filter((b) => b.openedAt && isReading(b)).sort((x, y) => y.openedAt - x.openedAt)[0] || null;
  }

  function renderHome() {
    if (!lib) return; // the skeleton stays until the library arrives
    $("#r-avatar").textContent = (settings.user || "Ч").trim()[0].toUpperCase();
    $(".r-add-btn").hidden = !!settings.guest;
    const html = homeQuery.trim() ? searchHtml(norm(homeQuery)) : homePageHtml();
    // The library comes twice (the saved copy, then the server's) and again when the app comes back to the
    // front: drawing the same covers anew made them flicker, so an unchanged screen is left alone.
    if (html === homeHtml) return;
    homeHtml = html;
    $("#home-body").innerHTML = html;
  }

  function homePageHtml() {
    const books = myBooks();
    if (!settings.guest) setTimeout(() => fetchAboutAhead(books), 3000);
    const cur = nowBook(books);
    let html = "";
    if (cur) {
      const where = [cur.chapter || (cur.parts ? `розділ ${cur.part} з ${cur.parts}` : "")].filter(Boolean).map(esc).join("");
      html += `<section class="r-now">${head("Читаю зараз", "", true)}
        <div class="r-now-row"><button class="r-now-cover" data-open="${esc(cur.path)}">${rcover(cur)}</button>
          <div class="r-now-text"><h3 class="r-now-t">${esc(cur.title)}</h3><p class="r-now-a">${esc(author(cur))}</p>
            <div class="r-progress"><span style="width:${cur.pct}%"></span></div>
            <p class="r-now-meta"><b>${cur.pct}%</b>${where ? ` · ${where}` : ""}</p>
            <button class="r-pill r-wide" data-open="${esc(cur.path)}">Продовжити читання</button></div></div>
        <button class="r-pill r-narrow" data-open="${esc(cur.path)}">Продовжити читання</button></section>`;
    }
    const rest = books.filter((b) => b !== cur);
    const groups = { all: rest, reading: rest.filter(isReading), new: rest.filter(isNewBook), done: rest.filter((b) => b.finished) };
    // Every book is drawn once and a filter only hides cards: drawing the grid anew on each click reloaded
    // all the covers, which flickered on a slow connection (Max).
    const gcls = (b) => ["reading", "new", "done"].filter((k) => groups[k].includes(b)).map((k) => ` g-${k}`).join("");
    const empty = (k) => (groups[k].length ? "" : `<p class="r-empty g-${k}">Тут поки порожньо.</p>`);
    const plus = settings.guest || books.length ? "" : `<button class="r-card r-plus" data-act="add"><span class="r-plus-box"><b>+</b><span>Додати книжку</span><small>EPUB, PDF, MOBI</small></span></button>`;
    html += `<section>${head(`Мої книжки · ${books.length}`, books.length ? tabs([["all", "Усі", groups.all.length], ["reading", "Читаю", groups.reading.length], ["new", "Не почато", groups.new.length], ["done", "Прочитані", groups.done.length]], homeFilter, "data-filter") : "")}
      <div class="r-filtered" data-show="${homeFilter}"><div class="r-grid">${rest.map((b) => card(b, mark(b), true, gcls(b))).join("")}${plus}</div>
      ${empty("reading")}${empty("new")}${empty("done")}</div>
      ${trashCount ? `<p class="r-trash"><button class="r-link" data-act="trash">Нещодавно видалені · ${trashCount} →</button></p>` : ""}</section>`;
    const reading = (club?.reading || []).slice(0, 8);
    if (reading.length)
      html += `<section>${head("Зараз читають", `<a class="r-aside-link" href="${esc(club.club)}" target="_blank" rel="noopener">Обговорення на Chytai ↗</a>`)}
        <div class="r-grid r-others">${reading.map((b) => `<a class="r-card" href="${esc(b.href)}" target="_blank" rel="noopener">${rcover({ title: b.title, authors: [b.author] }, b.cover)}
          <span class="r-t">${esc(b.title)}</span><span class="r-a">${esc(b.reader.name)}</span></a>`).join("")}</div></section>`;
    const free = lib.free || [];
    if (free.length && !settings.guest) {
      const newest = new Set([...free].sort((x, y) => y.order - x.order).slice(0, 16));
      const fcls = (b) => (newest.has(b) ? " g-new" : "") + (b.group === "Для дітей" ? " g-kids" : "") + (/класика/i.test(b.group) ? " g-classics" : "");
      html += `<section>${head(`Вільна полиця · ${free.length} <span class="r-sub">Можна читати безкоштовно</span>`, tabs([["new", "Нові"], ["kids", "Для дітей"], ["classics", "Класика"], ["all", "Усі"]], freeTab, "data-free-tab"))}
        <div class="r-filtered" data-show="${freeTab}"><div class="r-grid">${[...newest, ...free.filter((b) => !newest.has(b))].map((b) => card(b, "", false, fcls(b))).join("")}</div></div></section>`;
    }
    return html;
  }

  function searchHtml(q) {
    const mine = myBooks().filter((b) => matches(b, q));
    const own = new Set(mine.map((b) => b.path));
    const free = (lib.free || []).filter((b) => !own.has(b.path) && matches(b, q));
    const action = (b) => (b.finished || b.pct >= 99 ? "Перечитати" : b.pct > 0 ? "Продовжити" : "Почати");
    let html = "";
    if (mine.length)
      html += `<section>${head(`У моїх книжках · ${mine.length}`, "", true)}<div class="r-rows">${mine.map((b) => `<button class="r-row" data-open="${esc(b.path)}">${rcover(b)}
        <span class="r-row-t">${esc(b.title)}</span><span class="r-row-a">${esc(author(b))}</span><span class="r-row-go">${action(b)}</span></button>`).join("")}</div></section>`;
    if (free.length)
      html += `<section>${head(`На вільній полиці · ${free.length}`)}<div class="r-grid">${free.map((b) => card(b, `<span class="r-add">+ До моїх книжок</span>`, false)).join("")}</div></section>`;
    if (!mine.length && !free.length) html += `<p class="r-empty">Нічого не знайшлося.</p>`;
    html += `<p class="r-foot">Немає потрібної? ${settings.guest ? "" : `<button class="r-link" data-act="add">Завантажте свій файл</button>: EPUB, PDF або MOBI. `}<a class="r-link" href="https://chytai.org.ua/search?q=${encodeURIComponent(homeQuery.trim())}" target="_blank" rel="noopener">Шукати на chytai.org.ua ↗</a></p>`;
    return html;
  }

  // The search field: in the header on a computer, at the top of the page on a phone; both hold the same text.
  let searchTimer = 0;
  for (const field of document.querySelectorAll(".r-q"))
    field.addEventListener("input", () => {
      homeQuery = field.value;
      for (const f of document.querySelectorAll(".r-q")) if (f !== field) f.value = field.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(renderHome, 150);
    });
  function clearSearch() {
    homeQuery = "";
    for (const f of document.querySelectorAll(".r-q")) f.value = "";
    homeHtml = "";
  }
  $("#home").addEventListener("click", (e) => {
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
    homeHtml = homeQuery.trim() ? homeHtml : homePageHtml();
  });

  // The avatar's menu: a popover under it on a computer, a sheet from the bottom on a phone.
  const menuBox = $("#r-menu");
  function toggleMenu(open = menuBox.classList.contains("hidden")) {
    menuBox.classList.toggle("hidden", !open);
    $("#r-avatar").classList.toggle("open", open);
    if (open) {
      $("#r-me-name").textContent = settings.user || "";
      $("#r-me-user").textContent = settings.username ? `@${settings.username}` : "";
      $("#r-me-page").href = settings.username ? `https://chytai.org.ua/@${settings.username}` : "https://chytai.org.ua";
      $("#r-me-page").hidden = !settings.username;
      menuBox.querySelector("[data-r=settings]").hidden = !!settings.guest;
    }
  }
  $("#r-avatar").onclick = (e) => (e.stopPropagation(), toggleMenu());
  menuBox.addEventListener("click", (e) => {
    const r = e.target.closest("[data-r]")?.dataset.r;
    toggleMenu(false);
    if (r === "settings") openSettings();
    if (r === "logout") window.reader.logout?.();
  });
  document.addEventListener("click", (e) => !menuBox.classList.contains("hidden") && !e.target.closest("#r-menu") && toggleMenu(false));
  document.addEventListener("keydown", (e) => e.key === "Escape" && !menuBox.classList.contains("hidden") && toggleMenu(false));

  // A file dropped anywhere on the page is added to your books.
  $("#shell").addEventListener("dragover", (e) => !settings.guest && e.dataTransfer?.types?.includes("Files") && e.preventDefault());
  $("#shell").addEventListener("drop", async (e) => {
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
    // The book already on screen just comes back; any other one opens.
    if (current?.path === path) return hide();
    if (b?.unavailable) return showNotice("Немає з'єднання, а ця книжка ще не збережена на пристрої.", false);
    window.reader.openPath(path);
  }

  $("#shell").addEventListener("click", async (e) => {
    const el = e.target.closest("[data-menu], [data-aside], [data-open], [data-tab], [data-act], [data-note], [data-unwish]");
    if (!el) return;
    if (el.dataset.menu) return bookMenu(el.dataset.menu, el);
    if (el.dataset.aside) return setAside(el.dataset.aside);
    if (el.dataset.open != null) return openBook(el.dataset.open);
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
    if (el.dataset.act === "trash") return openTrash();
    if (el.dataset.act === "seen") markSeen();
  });

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
    const own = !b.free && !b.protected;
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
      ? books.map((b) => `<li>${rcover(b, null)}<span class="row-text"><span class="t">${esc(b.title)}</span><span class="m">${esc(b.authors[0] || "")}${b.authors[0] ? " · " : ""}ще ${left(b.until)} ${plural(left(b.until), "день", "дні", "днів")}</span></span>
          <button type="button" class="r-pill-line" data-restore="${esc(b.path)}">Відновити</button>
          <button type="button" class="r-forget" data-forget="${esc(b.path)}">Видалити назавжди</button></li>`).join("")
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
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    if (e.target?.closest?.("input, textarea, select, [contenteditable]")) return;
    if (document.querySelector("dialog[open]")) return;
    const guest = document.body.classList.contains("guest");
    const reading = !isOpen() && current;
    let act = null;
    const code = e.code;
    if (e.key === "Escape" && current && isOpen()) act = hide;
    else if (TAB_KEYS[code] && !e.shiftKey && !guest) act = () => show(TAB_KEYS[code]);
    else if (code === "Slash" && !e.shiftKey) {
      act = reading
        ? () => window.BookSearch?.open()
        : () => {
            const field = getComputedStyle($("#shell-top")).display !== "none" ? $("#top-search") : $("#lib-search");
            searchLibrary();
            field.focus();
            field.select();
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
  window.reader.onShowLibrary(() => (isOpen() && current ? hide() : show("library")));
  window.reader.onBookOpen(() => hide());
  // A note saved or removed in the book shows up here next time.
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && isOpen() && tab !== "library" && load());

  // The library list changed (a rescan, an edit, a deletion): draw again from it.
  async function refresh() {
    if (!isOpen()) return;
    lib = await window.Library.data(false);
    render();
  }

  window.Shell = { show, hide, isNew, arrivals, markSeen, refresh, key, cover, when, setAside };

  // The family starts here; a guest has one book, which the bridge opens straight away.
  settingsReady
    .then(() => (settings.guest ? hide() : show("home")))
    .catch(() => show("home"));
})();

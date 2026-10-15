// Home screen (designed in Claude Design, 2026-10-15): what you are reading, your shelf, your notes, the
// books the family added lately and your wish list, with a tab bar for Головна / Бібліотека / Нотатки.
// It covers the reader while it is open; a book opening puts it away, the toolbar's «Головна» brings it back.
(() => {
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ESC[c]);
  const DAY = 864e5;
  const ARRIVALS_DAYS = 30;
  const TABS = { home: "#home", library: "#library", notes: "#all-notes", wish: "#wish" };

  let tab = "home";
  let lib = null; // the library list (library-view.js)
  let notes = null; // { "<book path>": [note, …] }
  let wish = null; // [{ id, title, author }]

  // ---------- Showing and hiding ----------

  const isOpen = () => !$("#shell").classList.contains("hidden");

  function show(next = tab) {
    tab = next;
    $("#shell").classList.remove("hidden");
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
      Promise.resolve(window.reader.notesAll?.()).then((n) => (notes = n || {})).catch(() => {}),
      Promise.resolve(window.reader.wishList?.()).then((w) => (wish = w || [])).catch(() => {}),
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

  const bar = (pct, cls = "") => `<span class="progress ${cls}"><span style="width:${Math.max(0, Math.min(100, pct || 0))}%"></span></span>`;

  // ---------- Головна ----------

  function render() {
    renderBadge();
    if (tab === "home") renderHome();
    else if (tab === "notes") renderNotes();
    else if (tab === "wish") renderWish();
  }

  function renderBadge() {
    const n = lib ? lib.books.filter(isNew).length : 0;
    $("#tab-badge").textContent = n;
    $("#tab-badge").classList.toggle("hidden", !n);
  }

  function renderHome() {
    if (!lib) return; // the skeleton stays until the library arrives
    const books = lib.books;
    const byPath = new Map(books.map((b) => [b.path, b]));
    let html = "";

    if (!books.length) {
      html += `<div class="home-empty">
        <p>Бібліотека поки порожня.</p>
        ${settings.guest ? "" : `<button class="pill" data-act="add">Додати книжки…</button>`}
      </div>`;
    }

    // Продовжити: the book read last, then up to two others still in progress.
    const cur = byPath.get(lib.lastBook);
    const others = books
      .filter((b) => b !== cur && b.openedAt && (b.pct == null ? b.started : reading(b)))
      .sort((x, y) => y.openedAt - x.openedAt)
      .slice(0, 2);
    if (cur) {
      html += `<section class="home-sec"><div class="sec-head"><span>Продовжити</span></div>
        <button class="hero" data-open="${esc(cur.path)}">
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
          </button>`).join("")}
      </section>`;
    }

    // Моя полиця: everything, the books opened lately first, then the newest.
    if (books.length) {
      const shelf = [...books].sort((x, y) => (y.openedAt || 0) - (x.openedAt || 0) || (y.addedAt || 0) - (x.addedAt || 0)).slice(0, 24);
      html += `<section class="home-sec"><div class="sec-head"><span>Моя полиця · ${books.length}</span><button class="link" data-tab="library">Уся бібліотека</button></div>
        <div class="shelf">${shelf.map((b) => `<button class="shelf-book" data-open="${esc(b.path)}">
            ${cover(b, "mid")}<span class="t">${esc(b.title)}</span><span class="m ellipsis">${esc(b.authors[0] || "")}</span>
          </button>`).join("")}</div>
      </section>`;
    }

    // Нотатки: how many, and in which books.
    const noteBooks = Object.entries(notes || {}).filter(([, list]) => list.length).sort((a, b) => b[1].length - a[1].length);
    const noteCount = noteBooks.reduce((n, [, list]) => n + list.length, 0);
    if (noteCount) {
      html += `<section class="home-sec"><button class="notes-card" data-tab="notes">
          <span class="sec-head plain"><span>Нотатки</span><span class="link">Усі нотатки ›</span></span>
          <span class="notes-count"><b>${noteCount}</b><span class="m">${plural(noteCount, "нотатка", "нотатки", "нотаток")} у ${noteBooks.length} ${noteBooks.length === 1 ? "книжці" : "книжках"}</span></span>
          <span class="chips">${noteBooks.slice(0, 4).map(([p, list]) => `<span class="chip">${esc(byPath.get(p.replace(/#reflow$/, ""))?.title || p.replace(/\.[^.]+$/, ""))} <span class="m">${list.length}</span></span>`).join("")}</span>
        </button></section>`;
    }

    // Нові надходження: what others added in the last month; a dot until you open it.
    const fresh = arrivals();
    if (fresh.length) {
      const unseen = fresh.some((b) => !b.seen);
      html += `<section class="home-sec"><div class="sec-head"><span>Нові надходження</span>${unseen ? `<button class="link" data-act="seen">Позначити переглянутими</button>` : ""}</div>
        ${fresh.map((b) => `<button class="arrival" data-open="${esc(b.path)}">
            ${cover(b, "small")}
            <span class="row-text"><span class="t">${esc(b.title)}</span><span class="m">${esc(author(b))}</span>
              <span class="m">${esc(`${b.addedBy} · ${when(b.addedAt)}`)}${wishedFor(b) ? `<span class="accent"> · було в бажаному</span>` : ""}</span></span>
            <span class="dot${b.seen ? " off" : ""}"></span>
          </button>`).join("")}
      </section>`;
    }

    // Хочу прочитати: the top of the list, with «Уже є» once someone added the book.
    if (window.reader.wishList && !settings.guest) {
      const list = wish || [];
      html += `<section class="home-sec"><div class="sec-head"><span>Хочу прочитати${list.length ? ` · ${list.length}` : ""}</span><button class="link" data-tab="wish">${list.length ? "Увесь список" : "Додати"}</button></div>
        ${list.length ? list.slice(0, 3).map((w) => {
          const b = bookFor(w);
          return `<div class="wish-row"><span class="row-text"><span class="t">${esc(w.title)}</span><span class="m">${esc(w.author)}</span></span>
            ${b ? `<button class="pill small" data-open="${esc(b.path)}">Уже є</button>` : ""}</div>`;
        }).join("") : `<p class="m">Запишіть книжку, яку хочете прочитати: коли хтось із родини її додасть, вона з'явиться тут.</p>`}
      </section>`;
    }

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
    if (!all.length) return (box.innerHTML = `<div class="lib-empty">Нотаток ще немає. Виділіть уривок у книжці й натисніть «Зберегти».</div>`);
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

  function renderWish() {
    const box = $("#wish-body");
    const list = wish || [];
    box.innerHTML = list.length
      ? list.map((w) => {
          const b = bookFor(w);
          return `<div class="wish-row line"><span class="row-text"><span class="t">${esc(w.title)}</span>
              <span class="m">${esc([w.author, b && `уже в бібліотеці${b.addedBy ? `, додав ${b.addedBy}` : ""}`].filter(Boolean).join(" · "))}</span></span>
            ${b ? `<button class="pill small" data-open="${esc(b.path)}">Читати</button>` : ""}
            <button class="icon-btn" data-unwish="${esc(w.id)}" title="Прибрати">✕</button></div>`;
        }).join("")
      : `<div class="lib-empty">Список порожній.</div>`;
  }

  $("#wish-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const value = $("#wish-input").value.trim();
    if (!value) return;
    const [title, ...rest] = value.split(/\s+[—–-]\s+|,\s*/);
    try {
      wish = await window.reader.wishAdd({ title, author: rest.join(", ") });
      $("#wish-input").value = "";
      toast("Додано до бажаного");
      render();
    } catch (err) {
      showNotice(err instanceof TypeError ? "Немає з'єднання: список бажаного змінюється лише онлайн." : `Не вдалося додати: ${err.message}`, false);
    }
  });

  // ---------- Clicks ----------

  function openBook(path) {
    const b = lib?.books.find((x) => x.path === path);
    if (b) b.seen = true;
    // The book already on screen just comes back; any other one opens.
    if (current?.path === path) return hide();
    if (b?.unavailable) return showNotice("Немає з'єднання, а ця книжка ще не збережена на пристрої.", false);
    window.reader.openPath(path);
  }

  $("#shell").addEventListener("click", async (e) => {
    const el = e.target.closest("[data-open], [data-tab], [data-act], [data-note], [data-unwish]");
    if (!el) return;
    if (el.dataset.open != null) return openBook(el.dataset.open);
    if (el.dataset.tab) return show(el.dataset.tab);
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
    if (el.dataset.act === "seen") {
      const paths = arrivals().filter((b) => !b.seen).map((b) => b.path);
      paths.forEach((p) => (lib.books.find((b) => b.path === p).seen = true));
      window.reader.librarySeen?.(paths);
      render();
    }
  });

  $("#home-settings").onclick = () => openSettings();
  $("#btn-library").onclick = () => (isOpen() && current ? hide() : show("home"));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && current && isOpen() && !document.querySelector("dialog[open]")) hide();
  });
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

  window.Shell = { show, hide, isNew, refresh };

  // The family starts here; a guest has one book, which the bridge opens straight away.
  settingsReady
    .then(() => (settings.guest ? hide() : show("home")))
    .catch(() => show("home"));
})();

// Library tab of the home screen (home.js): a catalogue of the books in the library folders, by author's surname.
// On a wide screen authors stand in columns, Cyrillic ones first and then Latin, under new arrivals; on a phone
// it is a list with a letter index. Both filter by reading status, search by title or author; the wide one also
// by language. It also loads the library list
// the home screen is drawn from (window.Library).
(() => {
  const LANGS = { uk: "українська", ru: "російська", en: "англійська", be: "білоруська", pl: "польська", de: "німецька", fr: "французька", es: "іспанська", it: "італійська", la: "латина", el: "грецька", ar: "арабська", he: "іврит", ja: "японська", zh: "китайська" };
  const MONTHS_IN = ["січні", "лютому", "березні", "квітні", "травні", "червні", "липні", "серпні", "вересні", "жовтні", "листопаді", "грудні"];
  const FILTERS = [["all", "Усі"], ["reading", "Читаю"], ["unread", "Не почато"], ["done", "Прочитано"], ["new", "Нові"]];
  const PHONE_FILTERS = ["all", "reading", "new"];
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ESC[c]);
  let data = null; // { folders, books, lastBook }
  let loading = null;
  // Web, family only: a pencil on a book (on hover, or after a long press on a phone) fixes its title and author.
  const canEdit = () => typeof window.reader.libraryUpdateBook === "function" && !settings.guest;
  const PENCIL = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.17 6.81a2.83 2.83 0 0 0-4-4L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/></svg>`;
  const SHARE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m8 7 4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>`;
  const ASIDE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;
  // What the reader picked last time on this device: filter and language.
  const view = { f: "all", lang: "" };
  try {
    Object.assign(view, JSON.parse(localStorage.getItem("libraryView") || "{}"));
  } catch {}
  const remember = () => {
    try {
      localStorage.setItem("libraryView", JSON.stringify(view));
    } catch {}
  };

  // Sort authors by surname (last word); Cyrillic first, then Latin, collections and unknown last.
  function authorKey(name) {
    if (!name || name === "Збірник") return "2";
    const last = name.split(" ").pop().toLowerCase();
    return (/[Ѐ-ӿ]/.test(last) ? "0" : "1") + last;
  }
  const mainAuthor = (b) => (b.authors.length > 3 ? "Збірник" : b.authors[0] || "");
  const status = (b) => (b.pct >= 99 ? "done" : b.started || b.path === data.lastBook || b.pct > 0 ? "reading" : "unread");
  const isNew = (b) => !!window.Shell?.isNew(b);
  const matches = (b, f) => f === "all" || (f === "new" ? isNew(b) : status(b) === f);
  const byTitle = (x, y) => x.title.localeCompare(y.title, "uk");
  const byAuthor = (x, y) => authorKey(mainAuthor(x)).localeCompare(authorKey(mainAuthor(y)), "uk") || byTitle(x, y);

  // The list from the server (or the device, offline); force asks again even when one is at hand.
  async function fetchData(force) {
    if (data && !force) return data;
    loading ??= window.reader.libraryList().finally(() => (loading = null));
    data = await loading;
    return data;
  }

  async function load(force) {
    if (!data) $("#lib-body").innerHTML = `<div class="lib-empty">Скануємо папки з книжками…</div>`;
    try {
      await fetchData(force);
    } catch (err) {
      if (!data) return ($("#lib-body").innerHTML = `<div class="lib-empty">${esc(err.message)}</div>`);
    }
    render();
    window.Shell?.refresh();
  }

  function addedLabel(b) {
    const who = !b.addedBy || b.addedBy === settings.user ? "" : b.addedBy; // your own library: always you
    if (!b.addedAt) return who;
    const days = Math.floor((new Date().setHours(24, 0, 0, 0) - b.addedAt) / 864e5);
    const date = new Date(b.addedAt);
    const when =
      days < 31 ? window.Shell.when(b.addedAt)
      : date.getFullYear() === new Date().getFullYear() ? `у ${MONTHS_IN[date.getMonth()]}`
      : date.toLocaleDateString("uk-UA", { month: "long", year: "numeric" });
    return who ? `${who}, ${when}` : when;
  }

  // The short mark at the end of a row.
  function tag(b) {
    if (isNew(b)) return `<span class="lib-tag accent strong">нова</span>`;
    const st = status(b);
    if (st === "done") return `<span class="lib-tag">✓</span>`;
    if (st === "reading") return `<span class="lib-tag accent">${b.pct ? `${Math.round(b.pct)}%` : "читаю"}</span>`;
    return "";
  }

  // Phone: what a row's swipe shows. Own books are shared by a link for one person; a free-shelf book's own link works for anyone.
  function swipeActions(b) {
    if (!canEdit()) return "";
    const acts = [
      `<button data-share="${esc(b.path)}">${SHARE}Поділитися</button>`,
      b.free ? "" : `<button data-edit="${esc(b.path)}">${PENCIL}Назва</button>`,
      status(b) === "reading" ? `<button data-aside="${esc(b.path)}">${ASIDE}Прибрати</button>` : "",
    ].join("");
    return `<div class="lib-acts" aria-hidden="true">${acts}</div>`;
  }
  const shareButton = (b) => (canEdit() && !b.free ? `<span class="lib-edit" role="button" data-share="${esc(b.path)}" title="Дати почитати">${SHARE.replace("<svg ", '<svg width="15" height="15" ')}</span>` : "");

  const editButton = (b) => (canEdit() && !b.free ? `<span class="lib-edit" role="button" data-edit="${esc(b.path)}" title="Назва й автор${b.edited ? " (виправлено вручну)" : ""}">${PENCIL}</span>` : "");


  function render() {
    $("#lib-folders").innerHTML = data.folders.length
      ? data.folders.map((f) => `<span title="${esc(f)}">📁 ${esc(f.replace(/^\/Users\/[^/]+/, "~").replace("~/Library/Mobile Documents/com~apple~CloudDocs", "iCloud Drive"))}<button class="link" data-remove="${esc(f)}">прибрати</button></span>`).join("")
      : "";
    if (!data.books.length) {
      const hint = document.body.classList.contains("web") ? "Бібліотека порожня. Натисніть «Додати книжки…», щоб завантажити EPUB чи PDF." : "Додайте папку з книжками, і вони з'являться тут.";
      $("#lib-stats").textContent = "";
      $("#lib-chips").innerHTML = $("#lib-langs").innerHTML = "";
      $("#lib-body").innerHTML = `<div class="lib-empty">${data.folders.length ? "У цих папках книжок не знайшлося." : hint}</div>`;
      return;
    }

    // Languages offered are the ones in the library; a remembered one that is gone falls back to all.
    const langs = [...new Set(data.books.map((b) => b.lang).filter(Boolean))].sort((a, b) => (a === "uk" ? -1 : b === "uk" ? 1 : a.localeCompare(b)));
    if (view.lang && !langs.includes(view.lang)) view.lang = "";
    const q = $("#lib-search").value.trim().toLowerCase();
    const found = data.books.filter((b) => (!view.lang || b.lang === view.lang) && (!q || `${b.title} ${b.authors.join(" ")}`.toLowerCase().includes(q)));
    const books = found.filter((b) => matches(b, view.f));

    $("#lib-stats").textContent = `${books.length} з ${data.books.length} · авторів: ${new Set(books.map(mainAuthor).filter((a) => a && a !== "Збірник")).size}`;
    $("#lib-chips").innerHTML = FILTERS.map(
      ([id, label]) =>
        `<button class="lib-chip${view.f === id ? " on" : ""}${PHONE_FILTERS.includes(id) ? "" : " wide-only"}" data-f="${id}">${label}<span class="n">${found.filter((b) => matches(b, id)).length}</span></button>`,
    ).join("");
    $("#lib-langs").innerHTML =
      langs.length > 1
        ? [["", "Усі мови"], ...langs.map((l) => [l, (LANGS[l] || l).replace(/^./, (c) => c.toUpperCase())])]
            .map(([id, label]) => `<button class="${view.lang === id ? "on" : ""}" data-lang="${esc(id)}">${esc(label)}</button>`)
            .join("")
        : "";

    $("#lib-abc").innerHTML = "";
    if (!books.length) return ($("#lib-body").innerHTML = `<div class="lib-empty">Нічого не знайшлося. Спробуйте інший фільтр або запит.</div>`);
    // Phone: by the first letter of the author's surname, with an index to jump between letters.
    const groups = new Map();
    for (const b of [...books].sort(byAuthor)) {
      const a = mainAuthor(b);
      const letter = a === "Збірник" ? "…" : (a.split(" ").pop()[0] || "#").toUpperCase();
      if (!groups.has(letter)) groups.set(letter, []);
      groups.get(letter).push(b);
    }
    let list = `<div class="lib-list narrow-only">`;
    for (const [letter, list2] of groups) {
      list += `<section class="lib-letter" data-letter="${esc(letter)}"><div class="lib-letter-head">${esc(letter)}</div>`;
      for (const b of list2) {
        const body = `${window.Shell.cover(b, "small")}
          <span class="lib-li-text"><span class="t ellipsis">${esc(b.title)}</span><span class="m ellipsis">${esc([mainAuthor(b), b.year].filter(Boolean).join(" · "))}</span>
          </span>${tag(b)}`;
        list += `<div class="lib-swipe">${swipeActions(b)}<button class="lib-li${b.unavailable ? " unavailable" : ""}" data-path="${esc(b.path)}">${body}</button></div>`;
      }
      list += `</section>`;
    }
    list += `</div>`;
    const index = groups.size > 4 ? `<nav class="lib-index narrow-only">${[...groups.keys()].map((l) => `<button data-jump="${esc(l)}">${esc(l)}</button>`).join("")}</nav>` : "";
    $("#lib-body").innerHTML = catalogue(books, q) + list + index;
  }

  // Wide: new arrivals on top, then authors in columns, Cyrillic before Latin, each letter once.
  function catalogue(books, q) {
    const fresh = q || view.f !== "all" ? [] : window.Shell.arrivals();
    const unseen = fresh.filter((b) => !b.seen).length;
    const arrivals = fresh.length
      ? `<section class="lib-arr"><div class="lib-arr-head"><span>Нові надходження</span>${unseen ? `<span class="lib-count">${unseen}</span><button class="link" data-act="seen">Позначити переглянутими</button>` : ""}</div>
          <div class="lib-arr-grid">${fresh.map((b) => `<button class="lib-book" data-path="${esc(b.path)}">${window.Shell.cover(b, "small")}
            <span class="lib-li-text"><span class="t ellipsis">${esc(b.title)}</span><span class="m ellipsis">${esc([mainAuthor(b), b.addedBy, window.Shell.when(b.addedAt)].filter(Boolean).join(" · "))}</span></span>
            <span class="dot${b.seen ? " off" : ""}"></span></button>`).join("")}</div></section>`
      : "";

    const authors = new Map();
    for (const b of [...books].sort(byAuthor)) {
      const a = mainAuthor(b);
      if (!authors.has(a)) authors.set(a, []);
      authors.get(a).push(b);
    }
    const blocks = { 0: "", 1: "", 2: "" };
    const letters = { 0: [], 1: [] };
    for (const [a, list] of authors) {
      const k = authorKey(a)[0];
      const letter = k === "2" ? "" : a.split(" ").pop()[0].toUpperCase();
      const first = letter && !letters[k].includes(letter);
      if (first) letters[k].push(letter);
      blocks[k] += `<section class="lib-author"${first ? ` data-letter="${esc(letter)}"` : ""}>
        <div class="lib-author-head">${first ? `<b>${esc(letter)}</b>` : ""}<span class="ellipsis">${esc(a || "Автор невідомий")}</span></div>
        ${list.map((b) => {
          const body = `${window.Shell.cover(b, "small")}
            <span class="lib-li-text"><span class="t ellipsis">${esc(b.title)}</span><span class="m ellipsis">${esc([b.year, addedLabel(b)].filter(Boolean).join(" · "))}${b.ext !== "epub" ? ` · ${esc(b.ext.toUpperCase())}` : ""}${b.cloud ? " · ☁︎" : ""}</span>
            </span>${tag(b)}${shareButton(b)}${editButton(b)}`;
          return `<button class="lib-book${b.unavailable ? " unavailable" : ""}" data-path="${esc(b.path)}" title="${b.unavailable ? "Немає з'єднання, а ця книжка ще не збережена на пристрої" : ""}">${body}</button>`;
        }).join("")}</section>`;
    }
    const jump = (l) => `<button data-jump="${esc(l)}">${esc(l)}</button>`;
    $("#lib-abc").innerHTML = letters[0].map(jump).join("") + (letters[0].length && letters[1].length ? `<i></i>` : "") + letters[1].map(jump).join("");
    const latin = blocks[1] ? `${blocks[0] ? `<div class="lib-sep"><b>A–Z</b><i></i><span>автори латиницею</span></div>` : ""}<div class="lib-cols">${blocks[1]}</div>` : "";
    const other = blocks[2] ? `${blocks[0] || blocks[1] ? `<div class="lib-sep"><i></i></div>` : ""}<div class="lib-cols">${blocks[2]}</div>` : "";
    return `<div class="lib-cat wide-only">${arrivals}${blocks[0] ? `<div class="lib-cols">${blocks[0]}</div>` : ""}${latin}${other}</div>`;
  }

  window.Library = {
    data: fetchData,
    render: () => data && render(),
    // The tab was opened: draw what is known at once, then ask the server for the latest.
    shown: () => {
      if (data) render();
      load(true);
    },
  };

  $("#lib-body").addEventListener("click", (e) => {
    const act = e.target.closest("[data-edit], [data-share], [data-aside]");
    if (act) {
      closeSwipe();
      if (act.dataset.edit) return editBook(act.dataset.edit);
      if (act.dataset.share) return shareBook(act.dataset.share);
      return window.Shell.setAside(act.dataset.aside);
    }
    if (swiped) return closeSwipe(); // a tap on an open row closes it
    if (e.target.closest("[data-act=seen]")) {
      window.Shell.markSeen();
      return render();
    }
    const jump = e.target.closest("[data-jump]");
    if (jump) return jumpTo(jump.dataset.jump);
    const el = e.target.closest("button.lib-book, button.lib-li");
    if (!el) return;
    const book = data.books.find((b) => b.path === el.dataset.path);
    if (book?.cloud) showNotice(`Завантажую «${book.title}» з iCloud…`, true);
    window.reader.openPath(el.dataset.path);
  });

  // The letter index: the phone's runs down the list, the wide one sits by the filters.
  function jumpTo(letter) {
    const section = [...document.querySelectorAll("#lib-body [data-letter]")].find((s) => s.dataset.letter === letter && s.offsetParent);
    section?.scrollIntoView({ block: "start", behavior: "smooth" });
  }
  $("#lib-abc").addEventListener("click", (e) => {
    const jump = e.target.closest("[data-jump]");
    if (jump) jumpTo(jump.dataset.jump);
  });

  // ---------- Fixing a title or author (web, family) ----------

  // A row slides left under the finger to show its actions; one row open at a time, any tap closes it.
  let swiped = null;
  function closeSwipe() {
    swiped?.querySelector(".lib-li").style.removeProperty("transform");
    swiped = null;
  }
  let drag = null;
  $("#lib-body").addEventListener("touchstart", (e) => {
    const row = e.target.closest(".lib-swipe");
    if (!row?.querySelector(".lib-acts") || e.target.closest(".lib-acts")) return (drag = null);
    if (swiped && swiped !== row) closeSwipe();
    const t = e.touches[0];
    drag = { row, x: t.clientX, y: t.clientY, base: row === swiped ? -row.querySelector(".lib-acts").offsetWidth : 0, dx: 0, on: false };
  }, { passive: true });
  $("#lib-body").addEventListener("touchmove", (e) => {
    if (!drag) return;
    const t = e.touches[0];
    const dx = t.clientX - drag.x;
    if (!drag.on) {
      if (Math.abs(t.clientY - drag.y) > 10) return (drag = null); // scrolling the list
      if (Math.abs(dx) < 10) return;
      drag.on = true;
      drag.row.classList.add("dragging");
    }
    const w = drag.row.querySelector(".lib-acts").offsetWidth;
    drag.dx = Math.max(-w, Math.min(0, drag.base + dx));
    drag.row.querySelector(".lib-li").style.transform = `translateX(${drag.dx}px)`;
  }, { passive: true });
  $("#lib-body").addEventListener("touchend", () => {
    if (!drag?.on) return (drag = null);
    const { row, dx } = drag;
    drag = null;
    row.classList.remove("dragging");
    const w = row.querySelector(".lib-acts").offsetWidth;
    if (dx < -w / 3) {
      swiped = row;
      row.querySelector(".lib-li").style.transform = `translateX(${-w}px)`;
    } else if (swiped === row) closeSwipe();
    else row.querySelector(".lib-li").style.removeProperty("transform");
    // The touch that ends a swipe must not also open the book.
    const stop = (ev) => (ev.stopImmediatePropagation(), ev.preventDefault());
    $("#lib-body").addEventListener("click", stop, { capture: true, once: true });
    setTimeout(() => $("#lib-body").removeEventListener("click", stop, { capture: true }), 400);
  });

  let editing = null;
  function editBook(name) {
    editing = data.books.find((b) => b.path === name);
    if (!editing) return;
    $("#edit-title").value = editing.title;
    $("#edit-authors").value = editing.authors.join(", ");
    $("#edit-file").textContent = `Файл: ${name}`;
    $("#book-edit").returnValue = "";
    $("#book-edit").showModal();
  }

  // Own book: the dialog with its links. A free-shelf book: its public link, through the phone's own share sheet.
  function shareBook(name) {
    const b = data.books.find((x) => x.path === name);
    if (!b) return;
    if (b.free) {
      const url = `${location.origin}/free/${encodeURIComponent(name)}`;
      if (navigator.share) return navigator.share({ title: b.title, url }).catch(() => {});
      return navigator.clipboard?.writeText(url).then(() => showNotice("Посилання скопійовано.", false), () => {});
    }
    editing = b;
    $("#share-book").textContent = b.authors.length ? `«${b.title}», ${b.authors[0]}` : `«${b.title}»`;
    $("#share-for").value = "";
    $("#share-list").innerHTML = "";
    loadShares(name);
    $("#share-dialog").showModal();
  }
  $("#share-dialog").addEventListener("close", () => (editing = null));

  // ---------- «Дати почитати»: a link to one book for one person (web) ----------

  const shareDate = (ts) => new Date(ts).toLocaleDateString("uk-UA", { day: "numeric", month: "long" });
  function renderShares(list) {
    $("#share-list").innerHTML = list
      .map((s) => `<li><span class="who">${esc(s.for)}</span><span class="state">${s.opened ? "відкрито" : "ще не відкривали"} · до ${esc(shareDate(s.expires))}</span>
        <button type="button" class="link" data-copy="${esc(s.url)}">Скопіювати</button><button type="button" class="link" data-unshare="${esc(s.token)}">Вимкнути</button>
        <input type="text" readonly value="${esc(s.url)}"></li>`)
      .join("");
  }
  async function loadShares(name) {
    if (!window.reader.shares || !document.body.classList.contains("web") || document.body.classList.contains("guest")) return;
    try {
      const { shares } = await window.reader.shares(name);
      if (editing?.path === name) renderShares(shares);
    } catch {
      /* offline: no links to show */
    }
  }
  $("#share-make").onclick = async () => {
    const book = editing;
    const who = $("#share-for").value.trim();
    if (!book) return;
    if (!who) return $("#share-for").focus();
    try {
      const res = await window.reader.shareBook(book.path, who);
      if (res.error) return showNotice(res.error, false);
      $("#share-for").value = "";
      await loadShares(book.path);
      // A phone sends it straight from its share sheet (Telegram, Viber…); elsewhere it goes to the clipboard.
      if (navigator.share && matchMedia("(pointer: coarse)").matches) return navigator.share({ title: book.title, text: `${who}, даю тобі почитати «${book.title}»`, url: res.share.url }).catch(() => {});
      navigator.clipboard?.writeText(res.share.url).then(() => showNotice(`Посилання для «${who}» скопійовано.`, false), () => {});
    } catch (err) {
      showNotice(`Не вдалося створити посилання: ${err.message}`, false);
    }
  };
  $("#share-for").addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), $("#share-make").click()));
  $("#share-list").addEventListener("click", async (e) => {
    const copy = e.target.closest("[data-copy]")?.dataset.copy;
    const token = e.target.closest("[data-unshare]")?.dataset.unshare;
    if (copy) {
      navigator.clipboard?.writeText(copy).then(() => showNotice("Посилання скопійовано.", false), () => e.target.closest("li").querySelector("input").select());
    } else if (token && editing) {
      try {
        await window.reader.unshare(token);
        loadShares(editing.path);
      } catch (err) {
        showNotice(`Не вдалося вимкнути: ${err.message}`, false);
      }
    }
  });

  $("#book-edit").addEventListener("close", async () => {
    const dialog = $("#book-edit");
    const book = editing;
    editing = null;
    if (!book || !["save", "reset"].includes(dialog.returnValue)) return;
    const patch = dialog.returnValue === "reset" ? { title: "", authors: "" } : { title: $("#edit-title").value, authors: $("#edit-authors").value };
    try {
      await window.reader.libraryUpdateBook(book.path, patch);
    } catch (err) {
      return showNotice(`Не вдалося зберегти: ${err.message}`, false);
    }
    // The server keeps only the correction; "as in the file" needs a rescan to show the file's own metadata.
    if (dialog.returnValue === "reset") return load(true);
    const authors = patch.authors.split(/[,;]/).map((a) => a.trim()).filter(Boolean);
    Object.assign(book, { title: patch.title.trim() || book.title, authors: authors.length ? authors : book.authors, edited: true });
    if (current?.path === book.path) {
      current.title = book.title;
      current.author = book.authors[0] || "";
      $("#book-title").textContent = current.author ? `${current.title} · ${current.author}` : current.title;
      $("#running-head").textContent = current.title;
    }
    render();
    window.Shell?.refresh();
  });
  $("#edit-reset").onclick = () => {
    $("#book-edit").returnValue = "reset";
    $("#book-edit").close("reset");
  };
  $("#lib-folders").addEventListener("click", async (e) => {
    const folder = e.target.dataset?.remove;
    if (!folder) return;
    await window.reader.libraryRemoveFolder(folder);
    load(true);
  });
  $("#lib-search").addEventListener("input", () => data && render());
  $("#lib-chips").addEventListener("click", (e) => {
    const f = e.target.closest("[data-f]")?.dataset.f;
    if (!f || !data) return;
    view.f = f;
    remember();
    render();
  });
  $("#lib-langs").addEventListener("click", (e) => {
    const el = e.target.closest("[data-lang]");
    if (!el || !data) return;
    view.lang = el.dataset.lang;
    remember();
    render();
  });
  $("#lib-refresh").onclick = () => load(true);
  $("#lib-add").onclick = async () => (await window.reader.libraryAddFolder()) && load(true);
  window.reader.onBookOpen((payload) => {
    if (!data) return;
    data.lastBook = payload.path;
    const book = data.books.find((b) => b.path === payload.path);
    if (book) Object.assign(book, { started: true, cloud: false, seen: true, openedAt: Date.now() });
    render();
  });
})();

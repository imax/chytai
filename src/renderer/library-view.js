// Library tab of the home screen (home.js): a catalogue of the books in the library folders. On a wide screen
// a table sorted by any column; on a phone a list by author's surname with a letter index. Both filter by
// reading status, search by title or author; the wide one also by language. It also loads the library list
// the home screen is drawn from (window.Library).
(() => {
  const LANGS = { uk: "українська", ru: "російська", en: "англійська", be: "білоруська", pl: "польська", de: "німецька", fr: "французька", es: "іспанська", it: "італійська", la: "латина", el: "грецька", ar: "арабська", he: "іврит", ja: "японська", zh: "китайська" };
  // "Українські" for the language switch.
  const LANG_PLURAL = { uk: "Українські", ru: "Російські", en: "Англійські", be: "Білоруські", pl: "Польські", de: "Німецькі", fr: "Французькі", es: "Іспанські", it: "Італійські" };
  const MONTHS_IN = ["січні", "лютому", "березні", "квітні", "травні", "червні", "липні", "серпні", "вересні", "жовтні", "листопаді", "грудні"];
  const FILTERS = [["all", "Усі"], ["reading", "Читаю"], ["unread", "Не почато"], ["done", "Прочитано"], ["new", "Нові"]];
  const PHONE_FILTERS = ["all", "reading", "new"];
  const COLUMNS = [["title", "Назва"], ["author", "Автор"], ["pct", "Прогрес"], ["year", "Рік"], ["added", "Додано"], ["size", "МБ"]];
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ESC[c]);
  let data = null; // { folders, books, lastBook }
  let loading = null;
  let manage = false; // web only: the family fixes titles and deletes books right in the library
  const canManage = () => typeof window.reader.libraryDelete === "function";
  // What the reader picked last time on this device: filter, language and sort column.
  const view = { f: "all", lang: "", k: "author", dir: 1 };
  try {
    Object.assign(view, JSON.parse(localStorage.getItem("libraryView") || "{}"));
  } catch {}
  const remember = () => {
    try {
      localStorage.setItem("libraryView", JSON.stringify(view));
    } catch {}
  };

  // Sort authors by surname (last word); Cyrillic first, then Latin, unknown last.
  function authorKey(name) {
    if (!name) return "2";
    const last = name.split(" ").pop().toLowerCase();
    return (/[Ѐ-ӿ]/.test(last) ? "0" : "1") + last;
  }
  const mainAuthor = (b) => (b.authors.length > 3 ? "Збірник" : b.authors[0] || "");
  const status = (b) => (b.pct >= 99 ? "done" : b.started || b.path === data.lastBook || b.pct > 0 ? "reading" : "unread");
  const isNew = (b) => !!window.Shell?.isNew(b);
  const matches = (b, f) => f === "all" || (f === "new" ? isNew(b) : status(b) === f);
  const byTitle = (x, y) => x.title.localeCompare(y.title, "uk");
  const byAuthor = (x, y) => authorKey(mainAuthor(x)).localeCompare(authorKey(mainAuthor(y)), "uk") || byTitle(x, y);
  const SORTS = {
    title: byTitle,
    author: byAuthor,
    pct: (x, y) => (x.pct || (status(x) === "reading" ? 0.5 : 0)) - (y.pct || (status(y) === "reading" ? 0.5 : 0)),
    year: (x, y) => (x.year || 0) - (y.year || 0),
    added: (x, y) => (x.addedAt || 0) - (y.addedAt || 0),
    size: (x, y) => x.size - y.size,
  };

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
    const who = !b.addedBy ? "" : b.addedBy === settings.user ? "ви" : b.addedBy;
    if (!b.addedAt) return who;
    const days = Math.floor((new Date().setHours(24, 0, 0, 0) - b.addedAt) / 864e5);
    const date = new Date(b.addedAt);
    const when =
      days < 31 ? window.Shell.when(b.addedAt)
      : date.getFullYear() === new Date().getFullYear() ? `у ${MONTHS_IN[date.getMonth()]}`
      : date.toLocaleDateString("uk-UA", { month: "long", year: "numeric" });
    return who ? `${who}, ${when}` : when;
  }

  function progressCell(b) {
    const st = status(b);
    if (st === "done") return `<span class="m">✓ прочитано</span>`;
    if (st === "unread") return `<span class="m">—</span>`;
    if (!b.pct) return `<span class="m">розпочата</span>`;
    return `<span class="progress"><span style="width:${Math.min(100, b.pct)}%"></span></span><span class="m">${Math.round(b.pct)}%</span>`;
  }

  // The short mark at the end of a phone row.
  function tag(b) {
    if (isNew(b)) return `<span class="lib-tag accent strong">нова</span>`;
    const st = status(b);
    if (st === "done") return `<span class="lib-tag">✓</span>`;
    if (st === "reading") return `<span class="lib-tag accent">${b.pct ? `${Math.round(b.pct)}%` : "читаю"}</span>`;
    return "";
  }

  function manageBlock(b) {
    return `<span class="lib-file m">${esc(b.path)}${b.edited ? ` <span class="badge" title="Назву або автора виправлено вручну">виправлено</span>` : ""}</span>
      <span class="lib-actions"><button data-edit="${esc(b.path)}">Назва й автор…</button><button data-delete="${esc(b.path)}" class="danger">Видалити</button></span>`;
  }

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
        ? [["", "Усі мови"], ...langs.map((l) => [l, LANG_PLURAL[l] || LANGS[l] || l])]
            .map(([id, label]) => `<button class="${view.lang === id ? "on" : ""}" data-lang="${esc(id)}">${esc(label)}</button>`)
            .join("")
        : "";

    if (!books.length) return ($("#lib-body").innerHTML = `<div class="lib-empty">Нічого не знайшлося. Спробуйте інший фільтр або запит.</div>`);

    // Wide: a table sorted by the chosen column.
    const sorted = [...books].sort((x, y) => SORTS[view.k](x, y) * view.dir || byAuthor(x, y));
    const head = COLUMNS.map(([k, label]) => `<button class="${view.k === k ? "on" : ""}" data-sort="${k}">${label} ${view.k === k ? (view.dir > 0 ? "↑" : "↓") : ""}</button>`).join("");
    const rows = sorted
      .map((b) => {
        const author = b.authors.length > 3 ? `${b.authors.slice(0, 2).join(", ")}…` : b.authors.join(", ");
        const cells = `<span class="lib-title">${window.Shell.cover(b, "small")}<span class="t ellipsis">${esc(b.title)}</span>${isNew(b) ? `<span class="new-badge">нова</span>` : ""}${b.ext !== "epub" ? `<span class="m">${esc(b.ext.toUpperCase())}</span>` : ""}${b.cloud ? `<span class="m" title="В iCloud, ще не завантажена">☁︎</span>` : ""}</span>
          <span class="ellipsis">${esc(author)}</span>
          <span class="lib-prog">${progressCell(b)}</span>
          <span class="m">${esc(b.year || "")}</span>
          <span class="m ellipsis">${esc(addedLabel(b))}</span>
          <span class="m num">${(b.size / 1e6).toFixed(1)}</span>`;
        return manage
          ? `<div class="lib-row manage" data-path="${esc(b.path)}">${cells}<span class="lib-manage-row">${manageBlock(b)}</span></div>`
          : `<button class="lib-row${b.unavailable ? " unavailable" : ""}" data-path="${esc(b.path)}" title="${b.unavailable ? "Немає з'єднання, а ця книжка ще не збережена на пристрої" : ""}">${cells}</button>`;
      })
      .join("");
    const table = `<div class="lib-table wide-only"><div class="lib-row lib-th">${head}</div>${rows}</div>`;

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
          ${manage ? manageBlock(b) : ""}</span>${manage ? "" : tag(b)}`;
        list += manage
          ? `<div class="lib-li manage">${body}</div>`
          : `<button class="lib-li${b.unavailable ? " unavailable" : ""}" data-path="${esc(b.path)}">${body}</button>`;
      }
      list += `</section>`;
    }
    list += `</div>`;
    const index = groups.size > 4 ? `<nav class="lib-index narrow-only">${[...groups.keys()].map((l) => `<button data-jump="${esc(l)}">${esc(l)}</button>`).join("")}</nav>` : "";
    $("#lib-body").innerHTML = table + list + index;
  }

  window.Library = {
    data: fetchData,
    // The tab was opened: draw what is known at once, then ask the server for the latest.
    shown: () => {
      if (data) render();
      load(true);
    },
  };

  $("#lib-body").addEventListener("click", (e) => {
    const action = e.target.closest("[data-edit], [data-delete]");
    if (action) return action.dataset.edit != null ? editBook(action.dataset.edit) : deleteBook(action.dataset.delete);
    const sort = e.target.closest("[data-sort]");
    if (sort) {
      const k = sort.dataset.sort;
      // Again on the same column turns the order around; a new column starts with the most useful end.
      if (view.k === k) view.dir = -view.dir;
      else Object.assign(view, { k, dir: ["pct", "added"].includes(k) ? -1 : 1 });
      remember();
      return render();
    }
    const jump = e.target.closest("[data-jump]");
    if (jump) {
      const section = [...document.querySelectorAll("#lib-body .lib-letter")].find((s) => s.dataset.letter === jump.dataset.jump);
      return section?.scrollIntoView({ block: "start" });
    }
    const el = e.target.closest("button.lib-row, button.lib-li");
    if (!el) return;
    const book = data.books.find((b) => b.path === el.dataset.path);
    if (book?.cloud) showNotice(`Завантажую «${book.title}» з iCloud…`, true);
    window.reader.openPath(el.dataset.path);
  });

  // ---------- Managing the shared library (web, family) ----------

  function setManage(on) {
    manage = on && canManage();
    $("#lib-manage").textContent = manage ? "Готово" : "Керувати";
    $("#lib-manage").classList.toggle("on", manage);
    if (data) render();
  }

  const label = (b) => `«${b.title}»${b.authors[0] ? ` (${b.authors[0]})` : ""}`;

  async function deleteBook(name) {
    const book = data.books.find((b) => b.path === name);
    if (!book) return;
    const readers = book.path === data.lastBook || book.started ? "\nЗакладки й позиції читання в ній теж зникнуть." : "";
    if (!confirm(`Видалити ${label(book)} з бібліотеки для всіх?${readers}`)) return;
    try {
      await window.reader.libraryDelete(name);
    } catch (err) {
      return showNotice(`Не вдалося видалити книжку: ${err.message}`, false);
    }
    data.books = data.books.filter((b) => b.path !== name);
    if (data.lastBook === name) data.lastBook = null;
    window.Shell?.refresh();
    if (current?.path === name) {
      // The book being read is gone: close it and stay in the library.
      closeBook();
      current = null;
      $("#book-title").textContent = "Chytai";
      $("#running-head").textContent = "";
      document.title = "Chytai";
    }
    showNotice(`Видалено ${label(book)}.`, false);
    render();
  }

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
  $("#lib-manage").onclick = () => setManage(!manage);
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

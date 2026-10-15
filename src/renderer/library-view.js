// Library tab of the home screen (home.js): books from the library folders, grouped by author, with search
// and a language filter. It also loads the library list the home screen is drawn from (window.Library).
(() => {
  const LANGS = { uk: "українська", ru: "російська", en: "англійська" };
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ESC[c]);
  let data = null; // { folders, books, lastBook }
  let loading = null;
  let manage = false; // web only: the family fixes titles and deletes books right in the library
  const canManage = () => typeof window.reader.libraryDelete === "function";

  // Sort authors by surname (last word); Cyrillic first, then Latin, unknown last.
  function authorKey(name) {
    if (!name) return "2";
    const last = name.split(" ").pop().toLowerCase();
    return (/[Ѐ-ӿ]/.test(last) ? "0" : "1") + last;
  }

  // The list from the server (or the device, offline); force asks again even when one is at hand.
  async function fetchData(force) {
    if (data && !force) return data;
    loading ??= window.reader.libraryList().finally(() => (loading = null));
    data = await loading;
    const lang = $("#lib-lang").value;
    const langs = [...new Set(data.books.map((b) => b.lang).filter(Boolean))].sort();
    $("#lib-lang").innerHTML = `<option value="">Усі мови</option>` + langs.map((l) => `<option value="${esc(l)}">${esc(LANGS[l] || l)}</option>`).join("");
    $("#lib-lang").value = lang;
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

  function render() {
    $("#lib-folders").innerHTML = data.folders.length
      ? data.folders.map((f) => `<span title="${esc(f)}">📁 ${esc(f.replace(/^\/Users\/[^/]+/, "~").replace("~/Library/Mobile Documents/com~apple~CloudDocs", "iCloud Drive"))}<button class="link" data-remove="${esc(f)}">прибрати</button></span>`).join("")
      : "";
    const q = $("#lib-search").value.trim().toLowerCase();
    const lang = $("#lib-lang").value;
    const books = data.books.filter(
      (b) => (!lang || b.lang === lang) && (!q || `${b.title} ${b.authors.join(" ")}`.toLowerCase().includes(q)),
    );
    if (!data.books.length) {
      const hint = document.body.classList.contains("web") ? "Бібліотека порожня. Натисніть «Додати книжки…», щоб завантажити EPUB чи PDF." : "Додайте папку з книжками, і вони з'являться тут.";
      $("#lib-body").innerHTML = `<div class="lib-empty">${data.folders.length ? "У цих папках книжок не знайшлося." : hint}</div>`;
      return;
    }
    const groups = new Map();
    for (const b of books) {
      const author = b.authors.length > 3 ? "Збірники" : b.authors[0] || "";
      if (!groups.has(author)) groups.set(author, []);
      groups.get(author).push(b);
    }
    const authors = [...groups.keys()].sort((a, b) => authorKey(a).localeCompare(authorKey(b), "uk"));
    const authorCount = authors.filter((a) => a && a !== "Збірники").length;
    // The books being read are on the home screen; here everything is by author.
    let html = `<div class="lib-stats">${books.length} з ${data.books.length} книжок · авторів: ${authorCount}</div><div class="lib-groups">`;
    for (const a of authors) {
      const list = groups.get(a).sort((x, y) => x.title.localeCompare(y.title, "uk"));
      html += `<section class="lib-group"><div class="lib-author">${esc(a || "Автор невідомий")}</div>`;
      for (const b of list) {
        const coauthors = b.authors.length > 1 ? b.authors.slice(a === "Збірники" ? 0 : 1, 4).join(", ") + (b.authors.length > 4 ? "…" : "") : "";
        const meta = [
          b.lang && (LANGS[b.lang] || b.lang),
          b.year,
          b.ext !== "epub" && b.ext.toUpperCase(),
          `${(b.size / 1e6).toFixed(1)} МБ`,
          b.cloud && "☁︎ в iCloud",
          b.onDevice && "на пристрої",
        ].filter(Boolean);
        const badge = b.path === data.lastBook ? "читаю зараз" : b.pct >= 99 ? "прочитано" : b.started ? "розпочата" : window.Shell?.isNew(b) ? "нова" : "";
        const body = `<span class="t">${esc(b.title)}</span>
          ${coauthors ? `<span class="m">${esc(coauthors)}</span>` : ""}
          <span class="m">${meta.map(esc).join(" · ")}${badge ? ` <span class="badge">${badge}</span>` : ""}</span>`;
        html += manage
          ? `<div class="lib-book manage" data-path="${esc(b.path)}">${body}
          <span class="m"><span class="file">${esc(b.path)}</span>${b.edited ? ` <span class="badge" title="Назву або автора виправлено вручну">виправлено</span>` : ""}</span>
          <span class="lib-actions"><button data-edit="${esc(b.path)}">Назва й автор…</button><button data-delete="${esc(b.path)}" class="danger">Видалити</button></span>
        </div>`
          : `<button class="lib-book${b.unavailable ? " unavailable" : ""}" data-path="${esc(b.path)}" title="${b.unavailable ? "Немає з'єднання, а ця книжка ще не збережена на пристрої" : esc(b.path)}">${body}</button>`;
      }
      html += `</section>`;
    }
    $("#lib-body").innerHTML = books.length ? html + `</div>` : `<div class="lib-empty">Нічого не знайшлося.</div>`;
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
    const el = e.target.closest("button.lib-book");
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
  $("#lib-lang").addEventListener("change", () => data && render());
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

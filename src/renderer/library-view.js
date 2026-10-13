// Library screen: books from the library folders, grouped by author, with search and a language filter.
(() => {
  const LANGS = { uk: "українська", ru: "російська", en: "англійська" };
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ESC[c]);
  let data = null; // { folders, books, lastBook }
  let loading = null;

  // Sort authors by surname (last word); Cyrillic first, then Latin, unknown last.
  function authorKey(name) {
    if (!name) return "2";
    const last = name.split(" ").pop().toLowerCase();
    return (/[Ѐ-ӿ]/.test(last) ? "0" : "1") + last;
  }

  async function load(force) {
    if (data && !force) return render();
    $("#lib-body").innerHTML = `<div class="lib-empty">Скануємо папки з книжками…</div>`;
    loading ??= window.reader.libraryList().finally(() => (loading = null));
    data = await loading;
    const langs = [...new Set(data.books.map((b) => b.lang).filter(Boolean))].sort();
    $("#lib-lang").innerHTML = `<option value="">Усі мови</option>` + langs.map((l) => `<option value="${esc(l)}">${esc(LANGS[l] || l)}</option>`).join("");
    render();
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
      $("#lib-body").innerHTML = `<div class="lib-empty">${data.folders.length ? "У цих папках книжок не знайшлося." : "Додайте папку з книжками, і вони з'являться тут."}</div>`;
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
    let html = `<div class="lib-stats">${books.length} з ${data.books.length} книжок · авторів: ${authorCount}</div>`;
    // Like Kindle: the books opened most recently come first, then everything by author.
    const openedAt = (b) => (b.path === data.lastBook ? Infinity : b.openedAt || 0);
    const recent = books.filter((b) => b.openedAt || b.started || b.path === data.lastBook)
      .sort((x, y) => openedAt(y) - openedAt(x)).slice(0, 12);
    let groupsOpen = false;
    const sections = [
      ...(recent.length ? [["Нещодавні", recent, true]] : []),
      ...authors.map((a) => [a || "Автор невідомий", groups.get(a).sort((x, y) => x.title.localeCompare(y.title, "uk")), false, a]),
    ];
    for (const [heading, list, isRecent, a] of sections) {
      if (!isRecent && !groupsOpen) (html += `<div class="lib-groups">`), (groupsOpen = true); // recent spans the full width
      html += `<section class="lib-group${isRecent ? " lib-recent" : ""}"><div class="lib-author">${esc(heading)}</div>`;
      for (const b of list) {
        const coauthors = isRecent
          ? b.authors.slice(0, 3).join(", ") + (b.authors.length > 3 ? "…" : "")
          : b.authors.length > 1 ? b.authors.slice(a === "Збірники" ? 0 : 1, 4).join(", ") + (b.authors.length > 4 ? "…" : "") : "";
        const meta = [
          b.lang && (LANGS[b.lang] || b.lang),
          b.year,
          b.ext !== "epub" && b.ext.toUpperCase(),
          `${(b.size / 1e6).toFixed(1)} МБ`,
          b.cloud && "☁︎ в iCloud",
        ].filter(Boolean);
        const badge = b.path === data.lastBook ? "читаю зараз" : b.started ? "розпочата" : "";
        html += `<button class="lib-book" data-path="${esc(b.path)}" title="${esc(b.path)}">
          <span class="t">${esc(b.title)}</span>
          ${coauthors ? `<span class="m">${esc(coauthors)}</span>` : ""}
          <span class="m">${meta.map(esc).join(" · ")}${badge ? ` <span class="badge">${badge}</span>` : ""}</span>
        </button>`;
      }
      html += `</section>`;
    }
    $("#lib-body").innerHTML = books.length ? html + `</div>` : `<div class="lib-empty">Нічого не знайшлося.</div>`;
  }

  function show(visible) {
    $("#library").classList.toggle("hidden", !visible);
    document.body.classList.toggle("library-open", visible);
    $("#lib-close").classList.toggle("hidden", !current);
    if (visible) {
      load(false);
      $("#lib-search").focus();
    }
  }

  $("#lib-body").addEventListener("click", (e) => {
    const el = e.target.closest(".lib-book");
    if (!el) return;
    const book = data.books.find((b) => b.path === el.dataset.path);
    if (book?.cloud) showNotice(`Завантажую «${book.title}» з iCloud…`, true);
    window.reader.openPath(el.dataset.path);
  });
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
  $("#lib-close").onclick = () => show(false);
  $("#btn-library").onclick = () => show($("#library").classList.contains("hidden"));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && current && !$("#library").classList.contains("hidden")) show(false);
  });
  window.reader.onShowLibrary(() => show(true));
  window.reader.onBookOpen((payload) => {
    show(false);
    if (!data) return;
    data.lastBook = payload.path;
    const book = data.books.find((b) => b.path === payload.path);
    if (book) Object.assign(book, { started: true, cloud: false, openedAt: Date.now() });
    render();
  });

  // With no book to reopen, start on the library instead of the empty screen.
  settingsReady.then(() => {
    if (!settings.lastBook) show(true);
  });
})();

// The library list the home screen is drawn from (window.Library), adding books, and the dialog «Назва, автор,
// обкладинка». The old «Бібліотека» tab (authors in columns, filters, folders) was taken out on 2026-11-18.
(() => {
  let data = null; // { books, free, lastBook, … }
  let loading = null;

  // The list from the server (or the device, offline); force asks again even when one is at hand.
  async function fetchData(force) {
    if (data && !force) return data;
    loading ??= window.reader.libraryList().finally(() => (loading = null));
    data = await loading;
    return data;
  }

  // «Додати книжку»: files picked on the web are uploaded; the Mac app adds a folder.
  async function add() {
    if (!(await window.reader.libraryAddFolder())) return;
    await fetchData(true).catch(() => {});
    window.Shell?.refresh();
  }

  window.Library = { data: fetchData, editBook, add, smallCover: (f) => smallCover(f) };

  let editing = null;
  // The cover picked in the dialog, made small here (900 px, JPEG): it goes to the server on «Зберегти».
  let newCover = null;
  function showEditCover() {
    if (!editing || !window.Shell?.rcover) return;
    const url = newCover ? URL.createObjectURL(newCover) : undefined;
    $("#edit-cover").innerHTML = newCover ? window.Shell.rcover(editing, url) : window.Shell.rcover(editing);
  }
  function smallCover(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const k = Math.min(1, 900 / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement("canvas");
        c.width = Math.round(img.naturalWidth * k);
        c.height = Math.round(img.naturalHeight * k);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        c.toBlob((b) => (b ? resolve(b) : reject(new Error("bad image"))), "image/jpeg", 0.85);
      };
      img.onerror = () => (URL.revokeObjectURL(url), reject(new Error("bad image")));
      img.src = url;
    });
  }
  $("#edit-cover-pick").onclick = () => $("#edit-cover-file").click();
  $("#edit-cover-file").onchange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      newCover = await smallCover(file);
      showEditCover();
    } catch {
      showNotice("Цей файл не схожий на зображення.", false);
    }
  };
  function editBook(name) {
    editing = data.books.find((b) => b.path === name);
    if (!editing) return;
    $("#edit-title").value = editing.title;
    $("#edit-authors").value = editing.authors.join(", ");
    $("#edit-file").textContent = `Файл: ${name}`;
    newCover = null;
    $("#edit-cover-row").hidden = !window.reader.librarySetCover;
    showEditCover();
    $("#book-edit").returnValue = "";
    $("#book-edit").showModal();
  }

  $("#book-edit").addEventListener("close", async () => {
    const dialog = $("#book-edit");
    const book = editing;
    editing = null;
    const cover = newCover;
    newCover = null;
    if (!book || !["save", "reset"].includes(dialog.returnValue)) return;
    const patch = dialog.returnValue === "reset" ? { title: "", authors: "" } : { title: $("#edit-title").value, authors: $("#edit-authors").value };
    try {
      await window.reader.libraryUpdateBook(book.path, patch);
      if (dialog.returnValue === "reset" ? book.coverAt : cover) book.coverAt = (await window.reader.librarySetCover(book.path, dialog.returnValue === "reset" ? null : cover)).coverAt;
    } catch (err) {
      return showNotice(`Не вдалося зберегти: ${err.message}`, false);
    }
    // The server keeps only the correction; "as in the file" needs a rescan to show the file's own metadata.
    if (dialog.returnValue === "reset") return fetchData(true).then(() => window.Shell?.refresh());
    const authors = patch.authors.split(/[,;]/).map((a) => a.trim()).filter(Boolean);
    Object.assign(book, { title: patch.title.trim() || book.title, authors: authors.length ? authors : book.authors, edited: true });
    if (current?.path === book.path) {
      current.title = book.title;
      current.author = book.authors[0] || "";
      $("#book-title").textContent = current.author ? `${current.title} · ${current.author}` : current.title;
      $("#running-head").textContent = current.title;
    }
    window.Shell?.refresh();
  });
  $("#edit-reset").onclick = () => {
    $("#book-edit").returnValue = "reset";
    $("#book-edit").close("reset");
  };
  window.reader.onBookOpen((payload) => {
    if (!data) return;
    data.lastBook = payload.path;
    const book = data.books.find((b) => b.path === payload.path);
    if (book) Object.assign(book, { started: true, cloud: false, seen: true, openedAt: Date.now() });
  });
})();

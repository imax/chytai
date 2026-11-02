// Paper books (Max, 2026-11-02): a book read on paper sits among your books without a file. Its page here has
// where you are («Я на сторінці»), «Запитати» about the book, «Фото сторінки» (the page's text, to select and
// explain like in a book on screen) and notes. The AI knows the book and the page and doesn't spoil what's after.
// home.js draws the page into Мої книжки (page "paper"); this file does the page, the questions and the photos.
/* global md */
(() => {
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ESC[c]);
  const $ = (s) => document.querySelector(s);
  const offline = (err, what) => (err instanceof TypeError ? `Немає з'єднання: ${what} можна лише онлайн.` : err.message);

  let book = null; // the paper book on screen
  let notes = []; // its notes
  let scan = null; // { text, page } from the last page photo, or "…" while it is read
  let adding = false; // the «+ Нотатка» form is open

  const where = (b, p = b.page) => [p ? `стор. ${p}` : "", b.chapter].filter(Boolean).join(" · ");

  // ---------- Photos ----------

  // The camera on a phone, a file chooser on a computer.
  function pickPhoto() {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.setAttribute("capture", "environment");
      input.onchange = () => resolve(input.files[0] || null);
      input.click();
    });
  }
  // A phone's photo is several megabytes; 1600 pixels on the long side is plenty to read a page.
  async function shrink(file, max = 1600) {
    try {
      const img = await createImageBitmap(file, { imageOrientation: "from-image" });
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      return await new Promise((r) => c.toBlob(r, "image/jpeg", 0.85));
    } catch {
      return file;
    }
  }

  // ---------- Adding a paper book ----------

  async function add(info) {
    try {
      const { path } = await window.reader.paperAdd(info);
      await window.Shell.reload();
      window.Shell.openPaper(path);
    } catch (err) {
      showNotice(offline(err, "додати книжку"), false);
    }
  }

  // «Сфотографувати обкладинку»: the photo gives a title and author, the catalog the book; «Це вона?».
  async function coverPhoto() {
    const file = await pickPhoto();
    if (!file) return;
    const d = $("#paper-found");
    $("#pf-body").innerHTML = `<p class="pf-wait"><span class="spinner"></span>Читаю обкладинку…</p>`;
    d.showModal();
    let seen;
    try {
      seen = await window.reader.paperScan("cover", await shrink(file, 1200));
    } catch (err) {
      $("#pf-body").innerHTML = `<p class="pf-wait">${esc(offline(err, "розпізнати фото"))}</p>`;
      return;
    }
    if (!seen.title) {
      $("#pf-body").innerHTML = `<p class="pf-wait">Не вдалося прочитати назву. Спробуйте ще раз ближче або знайдіть книжку пошуком.</p>`;
      return;
    }
    $("#pf-body").innerHTML = `<p class="pf-wait"><span class="spinner"></span>Шукаю «${esc(seen.title)}»…</p>`;
    let books = [];
    try {
      books = (await window.reader.catalogFind(`${seen.title} ${seen.author}`.trim())).books || [];
      if (!books.length && seen.author) books = (await window.reader.catalogFind(seen.title)).books || [];
    } catch {}
    if (!d.open) return;
    const top = books.slice(0, 3);
    d.found = { seen, top };
    $("#pf-body").innerHTML = `<h2 class="pf-h">${top.length ? "Це вона?" : "У каталозі не знайшлося"}</h2>
      ${top.map((b, i) => `<div class="pf-row">${window.Shell.rcover({ title: b.title, authors: [b.author] }, b.cover || null)}
        <span class="pf-x"><span class="pf-t">${esc(b.title)}</span><span class="pf-a">${esc([b.author, b.year].filter(Boolean).join(" · "))}</span></span>
        <button type="button" class="r-pill" data-pf="${i}">Додати</button></div>`).join("")}
      <button type="button" class="r-link pf-asis" data-pf="seen">${top.length ? "Немає в списку: додати" : "Додати"} «${esc(seen.title)}»${seen.author ? `, ${esc(seen.author)}` : ""}</button>`;
  }
  $("#paper-found").addEventListener("click", (e) => {
    const d = $("#paper-found");
    if (e.target === d) return d.close();
    const el = e.target.closest("[data-pf]");
    if (!el || !d.found) return;
    const { seen, top } = d.found;
    const b = el.dataset.pf === "seen" ? null : top[Number(el.dataset.pf)];
    d.close();
    add(b ? { title: b.title, author: b.author, cover: b.cover || "", href: b.href } : { title: seen.title, author: seen.author });
  });

  // ---------- The page ----------

  async function open(b) {
    if (book?.path !== b.path) {
      scan = null;
      adding = false;
      notes = [];
      loadNotes(b);
    }
    book = b;
  }
  async function loadNotes(b) {
    try {
      const list = await window.reader.notesList(b.path);
      if (book?.path !== b.path) return;
      notes = list || [];
      window.Shell.rerender();
    } catch {}
  }

  function pageHtml(b) {
    open(b);
    const pct = b.pages && b.page ? Math.min(100, Math.round((b.page / b.pages) * 100)) : 0;
    const sorted = [...notes].sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0));
    let scanHtml = "";
    if (scan === "…") scanHtml = `<section class="pp-scan"><p class="pf-wait"><span class="spinner"></span>Розпізнаю сторінку…</p></section>`;
    else if (scan) {
      scanHtml = `<section class="pp-scan">
        <div class="pp-scan-head"><h2>${scan.page ? `Стор. ${scan.page}` : "Сторінка"}</h2><span>з фото</span><button type="button" class="pp-x" data-pp="scan-close" aria-label="Закрити">×</button></div>
        <div class="pp-scan-text" id="pp-scan-text">${scan.text.split(/\n{2,}/).map((p) => `<p>${esc(p)}</p>`).join("")}</div>
        <p class="pp-scan-hint">Виділіть, що незрозуміло.</p>
        <div class="pp-scan-acts"><button type="button" class="r-pill" data-pp="explain">Пояснити</button><button type="button" class="r-pill-line" data-pp="quote">В нотатки</button></div></section>`;
    }
    return `<div class="pp">
      <div class="pp-bar"><button class="r-back" type="button" data-page="home" aria-label="Назад"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5-7 7 7 7"/></svg></button>
        <span class="r-more pp-more" role="button" tabindex="0" data-menu="${esc(b.path)}" title="Ще" aria-label="Ще"><i></i><i></i><i></i></span></div>
      <div class="pp-top"><div class="pp-cover">${window.Shell.rcover(b)}</div>
        <div class="pp-ti"><span class="pp-tag">Паперова</span><h1>${esc(b.title)}</h1><p>${esc(b.authors.join(", "))}</p></div></div>
      <section class="pp-where">
        <div class="pp-where-row"><div><h2 class="pp-lbl">Я на сторінці</h2>
          <div class="pp-step"><button type="button" data-pp="minus" aria-label="Мінус сторінка">−</button>
            <input id="pp-page" type="number" inputmode="numeric" min="0" max="20000" value="${b.page || ""}" placeholder="0" aria-label="Сторінка" />
            <button type="button" data-pp="plus" aria-label="Плюс сторінка">+</button>
            <label class="pp-of">з <input id="pp-pages" type="number" inputmode="numeric" min="0" max="20000" value="${b.pages || ""}" placeholder="?" aria-label="Усього сторінок" /></label></div></div>
          <label class="pp-ch"><span>Розділ</span><input id="pp-chapter" type="text" maxlength="200" value="${esc(b.chapter)}" placeholder="не обов'язково" /></label></div>
        <div class="r-progress"><span style="width:${pct}%"></span></div></section>
      <div class="pp-acts"><button type="button" class="r-pill" data-pp="ask">Запитати</button>
        <button type="button" class="r-pill-line" data-pp="photo"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>Фото сторінки</button></div>
      ${scanHtml}
      <section class="pp-notes"><div class="r-sec-head"><h2>Нотатки${notes.length ? ` · ${notes.length}` : ""}</h2><button type="button" class="pp-addnote" data-pp="note">+ Нотатка</button></div>
        ${adding ? `<form class="pp-noteform" data-pp-form><textarea id="pp-note" rows="3" placeholder="Думка, цитата або що перечитати"></textarea>
          <div><button type="submit" class="r-pill">Зберегти</button><button type="button" class="r-link" data-pp="note-cancel">Скасувати</button></div></form>` : ""}
        ${sorted.length ? sorted.map((n) => `<div class="pp-note${n.quote ? " q" : ""}"><div class="pp-note-t">${esc(n.text)}</div>
          ${n.comment ? `<div class="pp-note-c">${md(n.comment)}</div>` : ""}
          <div class="pp-note-m">${esc(n.chapter || "")}<button type="button" class="r-link" data-pp-del="${esc(n.id)}">Видалити</button></div></div>`).join("")
          : adding ? "" : `<p class="r-empty">Тут будуть ваші думки, цитати й збережені пояснення.</p>`}</section>
      <button type="button" class="pp-row" data-pp="about"><span>Про книжку</span><span>›</span></button>
    </div>`;
  }

  // Where you are: saved a moment after the last change.
  let saveTimer = 0;
  function save(patch) {
    Object.assign(book, patch);
    if (book.pages && book.page) book.pct = Math.min(100, Math.round((book.page / book.pages) * 100));
    book.started = !!book.page;
    book.openedAt = Date.now();
    const bar = $(".pp .r-progress span");
    if (bar) bar.style.width = `${book.pct || 0}%`;
    clearTimeout(saveTimer);
    const b = book;
    saveTimer = setTimeout(() => window.reader.paperUpdate(b.path, { page: b.page || 0, pages: b.pages || 0, chapter: b.chapter || "" }).catch(() => {}), 600);
  }
  const num = (v) => Math.max(0, Math.min(20000, parseInt(v, 10) || 0));

  document.addEventListener("input", (e) => {
    if (!book || !e.target.closest(".pp")) return;
    if (e.target.id === "pp-page") save({ page: num(e.target.value) });
    if (e.target.id === "pp-pages") save({ pages: num(e.target.value) });
    if (e.target.id === "pp-chapter") save({ chapter: e.target.value.trim() });
  });
  document.addEventListener("submit", async (e) => {
    if (!e.target.matches("[data-pp-form]")) return;
    e.preventDefault();
    const text = $("#pp-note").value.trim();
    if (!text) return;
    await addNote({ text });
    adding = false;
    window.Shell.rerender();
  });

  async function addNote({ text, comment = "", quote = false, page = book.page }) {
    const b = book;
    try {
      const n = await window.reader.notesAdd(b.path, { cfi: quote ? `paper:${page || 0}:${[...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36)}` : `paper:${Date.now().toString(36)}`, text, chapter: where(b, page) || "", quote });
      if (comment) {
        n.comment = comment.slice(0, 4000);
        await window.reader.notesUpdate(b.path, n.id, { comment: n.comment });
      }
      if (quote) n.quote = true;
      if (book === b) notes = [...notes.filter((x) => x.id !== n.id), n];
      return n;
    } catch (err) {
      showNotice(offline(err, "зберегти нотатку"), false);
    }
  }

  async function pagePhoto() {
    const file = await pickPhoto();
    if (!file) return;
    const b = book;
    scan = "…";
    window.Shell.rerender();
    try {
      const r = await window.reader.paperScan("page", await shrink(file));
      if (book !== b) return;
      scan = r.text ? r : null;
      if (!r.text) showNotice("На фото не знайшлося тексту.", false);
      // The page printed on the photo moves «Я на сторінці» forward (never back: it may be an earlier page).
      if (r.page && r.page > (b.page || 0) && (!b.pages || r.page <= b.pages)) save({ page: r.page });
    } catch (err) {
      scan = null;
      showNotice(offline(err, "розпізнати фото"), false);
    }
    window.Shell.rerender();
    setTimeout(() => $(".pp-scan")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }

  // The selection in the page's text, with a little of what is around it for context.
  function selected() {
    const sel = getSelection();
    const box = $("#pp-scan-text");
    if (!sel || sel.isCollapsed || !box || !box.contains(sel.anchorNode)) return null;
    const text = sel.toString().trim();
    if (!text) return null;
    const all = box.innerText;
    const at = all.indexOf(text);
    return { selection: text, before: at > 0 ? all.slice(Math.max(0, at - 1500), at) : "", after: at >= 0 ? all.slice(at + text.length, at + text.length + 800) : "" };
  }

  document.addEventListener("click", async (e) => {
    if (!book || !e.target.closest(".pp")) return;
    const del = e.target.closest("[data-pp-del]");
    if (del) {
      const id = del.dataset.ppDel;
      notes = notes.filter((n) => n.id !== id);
      window.Shell.rerender();
      return window.reader.notesDelete(book.path, id).catch(() => {});
    }
    const act = e.target.closest("[data-pp]")?.dataset.pp;
    if (!act) return;
    if (act === "minus" || act === "plus") {
      const page = Math.max(0, (book.page || 0) + (act === "plus" ? 1 : -1));
      $("#pp-page").value = page || "";
      return save({ page });
    }
    if (act === "ask") return ask({});
    if (act === "photo") return pagePhoto();
    if (act === "scan-close") return (scan = null), window.Shell.rerender();
    if (act === "about") return window.Shell.showAbout(book);
    if (act === "note") return (adding = true), window.Shell.rerender(), setTimeout(() => $("#pp-note")?.focus(), 30);
    if (act === "note-cancel") return (adding = false), window.Shell.rerender();
    if (act === "explain" || act === "quote") {
      const s = selected();
      if (!s) return showNotice("Спершу виділіть шматок тексту.", false);
      const page = scan?.page || book.page;
      if (act === "explain") return ask({ ...s, page });
      await addNote({ text: s.selection, quote: true, page });
      getSelection().removeAllRanges();
      window.Shell.rerender();
      showNotice("Збережено в нотатки", false);
    }
  });

  // ---------- Запитати / Пояснити: one card, like the reader's, with the book and the page as its context ----------

  let conv = null;
  function ask({ selection = "", before = "", after = "", page = book.page }) {
    const b = book;
    conv = { id: `paper-${Date.now()}`, book: b, page, selection, messages: null, text: "", busy: false, reqId: null, lastQ: "" };
    const d = $("#paper-ask");
    $("#pa-title").textContent = selection ? "Пояснення" : "Запитання";
    $("#pa-where").textContent = [b.title.split(/[.:]\s/)[0], where(b, page)].filter(Boolean).join(" · ");
    $("#pa-thread").innerHTML = selection ? `<blockquote class="pa-quote">«${esc(selection)}»</blockquote>` : "";
    $("#pa-save").hidden = true;
    $("#pa-q").value = "";
    $("#pa-q").placeholder = selection ? "Уточнити питання…" : "Що хочете спитати про книжку?";
    conv.context = { paper: true, bookTitle: b.title, author: b.authors.join(", "), page: page || 0, pages: b.pages || 0, chapter: b.chapter || "", selection, before, after };
    d.showModal();
    if (selection) turn(null);
    else setTimeout(() => $("#pa-q").focus(), 50);
  }

  function turn(question) {
    const c = conv;
    c.lastQ = question || c.lastQ;
    if (question) $("#pa-thread").insertAdjacentHTML("beforeend", `<div class="pa-question"><span>Ваше питання</span>${esc(question)}</div>`);
    const el = document.createElement("div");
    el.className = "answer streaming";
    el.innerHTML = `<span class="dots"><i></i><i></i><i></i></span>`;
    $("#pa-thread").appendChild(el);
    c.el = el;
    c.text = "";
    c.busy = true;
    $("#pa-q").disabled = true;
    const request = c.messages ? { messages: [...c.messages, { role: "user", content: question }] } : { context: { ...c.context, question: question || undefined } };
    c.reqId = `${c.id}-${Date.now()}`;
    window.reader.explain(c.reqId, request);
  }

  window.reader.onAiEvent((reqId, ev) => {
    const c = conv;
    if (!c || c.reqId !== reqId) return;
    if (ev.type === "text") {
      c.text += ev.text;
      c.el.innerHTML = md(c.text);
      return;
    }
    c.busy = false;
    c.el.classList.remove("streaming");
    $("#pa-q").disabled = false;
    if (ev.type === "done") {
      c.messages = ev.messages;
      c.answer = c.text;
      $("#pa-save").hidden = false;
      $("#pa-q").placeholder = "Уточнити питання…";
      if (!c.text) c.el.innerHTML = "<em>Порожня відповідь.</em>";
    } else if (ev.type === "aborted") {
      if (!c.text) c.el.innerHTML = "<em>Зупинено.</em>";
    } else if (ev.type === "error") {
      c.el.innerHTML = `<div class="error">${esc(ev.message)}</div>`;
    }
  });

  $("#pa-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = $("#pa-q").value.trim();
    if (!q || !conv || conv.busy) return;
    $("#pa-q").value = "";
    turn(q);
  });
  $("#pa-close").onclick = () => $("#paper-ask").close();
  $("#paper-ask").addEventListener("click", (e) => e.target === $("#paper-ask") && $("#paper-ask").close());
  $("#paper-ask").addEventListener("close", () => {
    if (conv?.busy) window.reader.abort(conv.reqId);
    conv = null;
  });
  // «В нотатки»: the passage (or the question) with the last answer as its comment.
  $("#pa-save").onclick = async () => {
    const c = conv;
    if (!c?.answer) return;
    $("#pa-save").hidden = true;
    const n = await addNote({ text: c.selection || c.lastQ || "Питання", comment: c.answer, quote: !!c.selection, page: c.page });
    if (n) showNotice("Збережено в нотатки", false), window.Shell.rerender();
    else $("#pa-save").hidden = false;
  };

  window.Paper = { pageHtml, add, coverPhoto, current: () => book };
})();

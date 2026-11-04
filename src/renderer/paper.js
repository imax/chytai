// Paper books (Max, 2026-11-02): a book read on paper sits among your books without a file. Its page here is,
// from the top (v2, Max: «мінімальний фрікшн, щоб запитати щось нове»): a field for a question about the book with
// a photo or a screenshot of the page, the questions asked so far with their answers (kept), and notes. The page
// you are on comes from the photos (or from what you write); the AI doesn't spoil what's after it.
// home.js draws the page into Мої книжки (page "paper"); this file does the page, the questions and the photos.
/* global md */
(() => {
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ESC[c]);
  const $ = (s) => document.querySelector(s);
  const offline = (err, what) => (err instanceof TypeError ? `Немає з'єднання: ${what} можна лише онлайн.` : err.message);

  let book = null; // the paper book on screen
  let notes = []; // its notes
  let chats = []; // its questions with answers: { id, turns: [{ q, a }], messages, sel, page, at }
  let scan = null; // { text, page, thumb } from the photo attached to the next question, or { busy, thumb }
  let showText = false; // the attached photo's text is open to select from
  let adding = false; // the «+ Нотатка» form is open
  let editing = null; // the note being edited
  let photo = null; // { data, small, marked, thumb, page }: the photo attached to the question field, sent with «Пояснити»/«Запитати»
  let noteDraft = ""; // its text, kept across redraws (an answer streaming in redraws the page)
  let notePage = 0; // the page the text from a photo came from
  let noteBusy = false; // the text of a photo for the note is being read
  let openChat = null; // the question unfolded in the list
  let allChats = false; // «Запитання» shows only the last few until «Показати всі» (Max 2026-11-03: long to scroll to notes)
  const CHATS_SHOWN = 3;
  let idea = ""; // the question the AI suggests asking next, shown as the field's placeholder (v3)
  let ideasKey = "";

  const where = (b, p = b.page) => [p ? `стор. ${p}` : "", b.chapter].filter(Boolean).join(" · ");

  // ---------- Photos ----------

  // A phone offers the camera, the photo library (screenshots) or files; a computer a file chooser. `camera`
  // goes straight to the camera (the cover).
  // An iPhone app built before 2026-11-02 has no camera permission, and iOS closes it on the camera.
  const OLD_APP = /ChytaiApp/.test(navigator.userAgent) && !/ChytaiApp\/camera/.test(navigator.userAgent);
  function pickPhoto(camera = false) {
    if (OLD_APP) {
      showNotice("Фото в цій версії аппки поки не працює. Відкрийте app.chytai.org.ua у Safari або дочекайтеся оновлення.", false);
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      if (camera) input.setAttribute("capture", "environment");
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
    const file = await pickPhoto(true);
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

  function open(b) {
    if (book?.path !== b.path) {
      scan = photo = null;
      showText = adding = false;
      editing = null;
      openChat = null;
      allChats = false;
      notes = [];
      chats = [];
      idea = "";
      ideasKey = "";
      load(b);
    }
    book = b;
  }
  async function load(b) {
    const [n, c] = await Promise.all([window.reader.notesList(b.path).catch(() => null), window.reader.paperChats(b.path).catch(() => null)]);
    if (book?.path !== b.path) return;
    if (n) notes = n;
    if (c) chats = c;
    window.Shell.rerender();
    loadIdeas(b);
  }
  // Suggested questions: from the book and the page, or following on from the last question asked.
  async function loadIdeas(b) {
    const last = [...chats].sort((x, y) => (y.at || 0) - (x.at || 0))[0];
    const key = `${b.path}|${b.page || 0}|${last?.id || ""}|${last?.turns.length || 0}`;
    if (key === ideasKey) return;
    ideasKey = key;
    try {
      const q = await window.reader.paperSuggest(b.path);
      if (book?.path !== b.path || ideasKey !== key || !q) return;
      idea = q;
      const f = $("#pp-q");
      if (f) f.placeholder = idea;
    } catch {}
  }
  const PLACEHOLDER = "Що хочете спитати про книжку?";

  const svgMic = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>`;
  const svgCam = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>`;
  function pageHtml(b) {
    open(b);
    const draft = $("#pp-q")?.value || "";
    let att = "";
    if (photo) {
      att = `<div class="pp-att"><img src="${photo.thumb}" alt="" /><span class="pp-att-t"><b>${photo.marked ? "Обведене на фото" : "Фото сторінки"}</b>${photo.page ? ` · стор. ${photo.page}` : ""}</span>
        <button type="button" class="pp-x" data-pp="unphoto" aria-label="Прибрати фото">×</button></div>`;
    } else if (scan) {
      att = `<div class="pp-att">${scan.thumb ? `<img src="${scan.thumb}" alt="" />` : ""}
        <span class="pp-att-t">${scan.busy ? `<span class="spinner"></span>Розпізнаю текст…` : `${scan.page ? `Стор. ${scan.page}` : "Сторінка"} з фото · <button type="button" class="r-link" data-pp="text">${showText ? "Сховати текст" : "Показати текст"}</button>`}</span>
        <button type="button" class="pp-x" data-pp="unattach" aria-label="Прибрати фото">×</button></div>`;
      if (showText && scan.text)
        att += `<div class="pp-scan"><div class="pp-scan-text" id="pp-scan-text">${scan.text.split(/\n{2,}/).map((p) => `<p>${esc(p)}</p>`).join("")}</div>
          <p class="pp-scan-hint">Виділіть, що незрозуміло.</p>
          <div class="pp-scan-acts"><button type="button" class="r-pill" data-pp="explain">Пояснити</button><button type="button" class="r-pill-line" data-pp="quote">В нотатки</button></div></div>`;
    }
    const sortedNotes = [...notes].sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0));
    const allSorted = [...chats].sort((x, y) => (y.at || 0) - (x.at || 0));
    const sortedChats = allChats ? allSorted : allSorted.filter((c, i) => i < CHATS_SHOWN || c.id === openChat || lives.has(c.id));
    const moreChats = allSorted.length > CHATS_SHOWN
      ? `<button type="button" class="pp-allq" data-pp="allq">${allChats ? "Згорнути" : `Показати всі ${allSorted.length}`}</button>` : "";
    return `<div class="pp">
      <div class="pp-bar"><button class="r-back" type="button" data-page="home" aria-label="Назад"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5-7 7 7 7"/></svg></button>
        <button type="button" class="pp-mini" data-pp="about"><span class="pp-mini-c">${window.Shell.rcover(b)}</span><span class="pp-mini-x"><b>${esc(b.title)}</b><small>${esc([b.authors.join(", "), b.page ? `стор. ${b.page}` : ""].filter(Boolean).join(" · "))}</small></span></button>
        <span class="r-more pp-more" role="button" tabindex="0" data-menu="${esc(b.path)}" title="Ще" aria-label="Ще"><i></i><i></i><i></i></span></div>
      <form class="pp-ask" data-pp-ask>
        <textarea id="pp-q" rows="4" placeholder="${esc(idea || PLACEHOLDER)}" enterkeyhint="send">${esc(draft)}</textarea>
        ${att}
        <div class="pp-ask-row"><button type="button" class="pp-tool" data-pp="img" title="Фото чи скріншот" aria-label="Фото чи скріншот">${svgCam}</button>
          <button type="button" class="pp-tool${window.Dictation.field() === "pp-q" ? " on" : ""}" data-pp="mic" title="Надиктувати" aria-label="Надиктувати">${svgMic}</button>
          <span class="pp-ask-sp"></span>
          <button type="button" class="r-pill" data-pp="ask">${photo && !draft.trim() ? "Пояснити" : "Запитати"}</button></div>
      </form>
      ${sortedChats.length ? `<section class="pp-chats"><div class="r-sec-head"><h2>Запитання · ${chats.length}</h2></div>
        ${sortedChats.map((c) => {
          const last = c.turns[c.turns.length - 1] || {};
          const live = lives.get(c.id) || null;
          const on = openChat === c.id || !!live;
          const fq = (q) => `<div class="pp-chat-fq">${esc(q)}</div>`;
          const pending = live && (live.busy || live.error)
            ? `${live.q && (c.turns.length || c.sel) ? fq(live.q) : ""}<div class="pp-chat-a answer pp-live">${live.error ? `<div class="error">${esc(live.error)} <button type="button" class="r-link pp-retry" data-pp-retry="${esc(c.id)}">Спробувати ще раз</button></div>` : live.text ? md(live.text) : `<span class="dots"><i></i><i></i><i></i></span>`}</div>`
            : "";
          return `<div class="pp-chat${on ? " open" : ""}" data-chat="${esc(c.id)}">
            <div class="pp-chat-q">${c.img ? `<img class="pp-chat-img" src="${c.img}" alt="" />` : ""}${esc(c.sel ? (c.img ? c.sel : `«${c.sel}»`) : c.turns[0]?.q || live?.q || "")}</div>
            ${on ? c.turns.map((t, i) => `${(i || c.sel) && t.q ? fq(t.q) : ""}<div class="pp-chat-a answer">${md(t.a)}</div>`).join("") + pending
              : `<div class="pp-chat-a short">${esc(String(last.a || "").replace(/[*_#>`]/g, "").slice(0, 400))}</div>`}
            <div class="pp-note-m">${esc([c.page ? `стор. ${c.page}` : "", when(c.at)].filter(Boolean).join(" · "))}${on && c.turns.length ? `<button type="button" class="r-link pp-more-q" data-pp-savechat="${esc(c.id)}">В нотатки</button><button type="button" class="r-link" data-pp-delchat="${esc(c.id)}">Видалити</button>` : ""}</div>
            ${on && c.turns.length && !live?.busy ? `<form class="pp-fq" data-pp-fq="${esc(c.id)}"><input class="pp-fq-in" type="text" autocomplete="off" enterkeyhint="send" placeholder="Уточнити…" /><button type="submit" aria-label="Надіслати"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg></button></form>` : ""}</div>`;
        }).join("")}${moreChats}</section>` : ""}
      <section class="pp-notes"><div class="r-sec-head"><h2>Нотатки${notes.length ? ` · ${notes.length}` : ""}</h2><button type="button" class="pp-addnote" data-pp="note">+ Нотатка</button></div>
        ${adding ? `<form class="pp-ask pp-noteform" data-pp-form><textarea id="pp-note" rows="3" placeholder="Думка, цитата або що перечитати">${esc(noteDraft)}</textarea>
          ${noteBusy ? `<div class="pp-note-busy"><span class="spinner"></span>Розпізнаю текст…</div>` : ""}
          <div class="pp-ask-row"><button type="button" class="pp-tool" data-pp="img-note" title="Текст з фото чи скріншота" aria-label="Текст з фото чи скріншота">${svgCam}</button>
            <button type="button" class="pp-tool${window.Dictation.field() === "pp-note" ? " on" : ""}" data-pp="mic-note" title="Надиктувати" aria-label="Надиктувати">${svgMic}</button><span class="pp-ask-sp"></span><button type="submit" class="r-pill">Зберегти</button></div></form>` : ""}
        ${sortedNotes.length ? sortedNotes.map((n) => editing === n.id
          ? `<form class="pp-ask pp-noteform" data-pp-edit="${esc(n.id)}"><textarea id="pp-note-edit" rows="3">${esc(n.text)}</textarea>
            <div class="pp-ask-row"><label class="pp-page-in">стор. <input id="pp-note-page" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="5" value="${esc((n.chapter || "").match(/\d+/)?.[0] || "")}" /></label><span class="pp-ask-sp"></span><button type="button" class="r-link" data-pp="cancel-edit">Скасувати</button><button type="submit" class="r-pill">Зберегти</button></div></form>`
          : `<div class="pp-note${n.quote ? " q" : ""}"><div class="pp-note-t">${esc(n.text)}</div>
          ${n.comment ? `<div class="pp-note-c">${md(n.comment)}</div>` : ""}
          <div class="pp-note-m">${esc(n.chapter || "")}<button type="button" class="r-link" data-pp-edit-note="${esc(n.id)}">Редагувати</button><button type="button" class="r-link" data-pp-del="${esc(n.id)}">Видалити</button></div></div>`).join("")
          : adding ? "" : `<p class="r-empty">Тут будуть ваші думки й цитати.</p>`}</section>
      <button type="button" class="pp-row" data-pp="about"><span>Про книжку</span><span>›</span></button>
    </div>`;
  }
  const when = (t) => (t ? new Date(t).toLocaleDateString("uk-UA", { day: "numeric", month: "long" }) : "");

  // The page you are on, as far as the reader knows: the last photo's page number.
  function seenPage(page) {
    if (!page || page <= (book.page || 0)) return;
    book.page = page;
    book.openedAt = Date.now();
    const b = book;
    window.reader.paperUpdate(b.path, { page }).catch(() => {});
  }

  document.addEventListener("submit", async (e) => {
    if (e.target.matches("[data-pp-ask]")) {
      e.preventDefault();
      return askFromField();
    }
    if (e.target.matches("[data-pp-fq]")) {
      e.preventDefault();
      const q = e.target.querySelector("input").value.trim();
      const c = chats.find((x) => x.id === e.target.dataset.ppFq);
      if (!q || !c || lives.get(c.id)?.busy) return;
      if (!lives.has(c.id)) lives.set(c.id, { chat: c, book, text: "", busy: false, reqId: null });
      return turn(lives.get(c.id), q);
    }
    if (e.target.matches("[data-pp-edit]")) {
      e.preventDefault();
      const id = e.target.dataset.ppEdit;
      const text = $("#pp-note-edit").value.trim();
      const page = Number($("#pp-note-page")?.value.replace(/\D/g, "") || 0);
      const note = notes.find((n) => n.id === id);
      editing = null;
      const chapter = page > 0 ? `стор. ${page}` : "";
      if (!text || !note || (text === note.text && chapter === (note.chapter || ""))) return window.Shell.rerender();
      note.text = text;
      note.chapter = chapter;
      window.Shell.rerender();
      return window.reader.notesUpdate(book.path, id, { text, page, chapter }).catch((err) => showNotice(`Не вдалося зберегти: ${err.message}`, false));
    }
    if (!e.target.matches("[data-pp-form]")) return;
    e.preventDefault();
    window.Dictation.stop();
    const text = $("#pp-note").value.trim();
    if (!text) return;
    await addNote({ text, page: notePage || book.page });
    adding = false;
    noteDraft = "";
    notePage = 0;
    window.Shell.rerender();
  });
  document.addEventListener("input", (e) => e.target.id === "pp-note" && (noteDraft = e.target.value));
  // With a photo in the field: «Пояснити» while the field is empty, «Запитати» once there is a question.
  document.addEventListener("input", (e) => {
    if (e.target.id !== "pp-q" || !photo) return;
    const btn = $('[data-pp="ask"]');
    if (btn) btn.textContent = e.target.value.trim() ? "Запитати" : "Пояснити";
  });
  // Enter sends the question on a computer; on a phone Enter is a new line and «Запитати» sends.
  document.addEventListener("keydown", (e) => {
    if (e.target.id !== "pp-q" || e.key !== "Enter" || e.shiftKey || matchMedia("(pointer: coarse)").matches) return;
    e.preventDefault();
    askFromField();
  });

  function askFromField() {
    window.Dictation.stop();
    const q = $("#pp-q").value.trim();
    if (scan?.busy) return showNotice("Зачекайте, текст з фото ще розпізнається.", false);
    if (photo) {
      const p = photo;
      photo = null;
      $("#pp-q").value = "";
      ask({ image: p.data, img: p.small, marked: p.marked, question: q, page: p.page || book.page });
      return URL.revokeObjectURL(p.thumb);
    }
    // An empty field asks the suggested question from the placeholder.
    if (!q && !scan?.text && !idea) return $("#pp-q").focus();
    const page = scan?.page || book.page || 0;
    ask({ question: q || (scan?.text ? "" : idea) || "Поясни, що відбувається на цій сторінці.", pageText: scan?.text || "", page });
    $("#pp-q").value = "";
    scan = null;
    showText = false;
  }

  async function addNote({ text, comment = "", quote = false, page = book.page }) {
    const b = book;
    try {
      const n = await window.reader.notesAdd(b.path, { cfi: quote ? `paper:${page || 0}:${[...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36)}` : `paper:${Date.now().toString(36)}`, text, chapter: page ? `стор. ${page}` : "", quote });
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

  // «Фото чи скріншот»: the page's text goes with the next question; it can also be opened to select from.
  // A photo and the reader's marks on it: { small, thumb, marked } (marked as mark() gives it), or null.
  async function shoot(words) {
    // On a phone our own camera (Max: iOS's «Use Photo / Retake» and then the marks were two screens for one
    // thing): shoot, and the marks come right after on the same screen, with «Перезняти» there.
    const cam = CAM_OK && matchMedia("(pointer: coarse)").matches;
    let file, small, thumb, marked;
    for (;;) {
      file = cam ? await camera() : await pickPhoto();
      if (!file) return null;
      small = await shrink(file);
      thumb = URL.createObjectURL(small);
      marked = await mark(thumb, cam, words);
      if (marked !== "retake") break;
      URL.revokeObjectURL(thumb);
    }
    if (marked === null) return URL.revokeObjectURL(thumb), null;
    return { small, thumb, marked };
  }

  async function attach() {
    // First the marks: whatever is circled or underlined gets explained at once.
    const shot = await shoot();
    if (!shot) return;
    const { small, thumb, marked } = shot;
    const b = book;
    if (marked) {
      // Into the field, like a file in a chat (Max): a question or a comment can go with it, or none.
      if (photo) URL.revokeObjectURL(photo.thumb);
      photo = { data: marked.data, small: marked.small, marked: marked.marked, thumb };
      redraw();
      $("#pp-q")?.focus({ preventScroll: true });
      // The page number still comes from the photo, quietly.
      // Only the number: quick, and the question asked after it knows the page.
      const ph = photo;
      window.reader.paperScan("pagenum", small).then((r) => {
        if (!r.page || book !== b) return;
        ph.page = r.page;
        seenPage(r.page);
        if (photo === ph) redraw();
      }).catch(() => {});
      return;
    }
    scan = { busy: true, thumb };
    window.Shell.rerender();
    try {
      const r = await window.reader.paperScan("page", small);
      if (book !== b || scan?.thumb !== thumb) return;
      if (!r.text) {
        scan = null;
        showNotice("На фото не знайшлося тексту.", false);
      } else {
        scan = { ...r, thumb };
        seenPage(r.page);
      }
    } catch (err) {
      if (scan?.thumb === thumb) scan = null;
      showNotice(offline(err, "розпізнати фото"), false);
    }
    window.Shell.rerender();
  }

  // The note's text from a photo (Max, 2026-11-04): what is circled, or the whole page, goes into the «+ Нотатка» form.
  async function noteFromPhoto() {
    window.Dictation.stop();
    const shot = await shoot({ hint: "Обведіть, що зберегти", go: ["Взяти весь текст", "Взяти обведене"] });
    if (!shot) return;
    URL.revokeObjectURL(shot.thumb);
    const b = book;
    noteBusy = true;
    redraw();
    try {
      const marked = shot.marked?.marked;
      const pic = marked ? await (await fetch(`data:image/jpeg;base64,${shot.marked.data}`)).blob() : shot.small;
      const r = await window.reader.paperScan(marked ? "marked" : "page", pic);
      if (book !== b) return;
      seenPage(r.page);
      if (!r.text) showNotice(marked ? "Не вдалося прочитати обведене." : "На фото не знайшлося тексту.", false);
      else {
        noteDraft = (noteDraft.trim() ? `${noteDraft.trim()}\n\n` : "") + r.text;
        if (r.page) notePage = r.page;
      }
    } catch (err) {
      showNotice(offline(err, "розпізнати фото"), false);
    }
    noteBusy = false;
    if (book !== b) return;
    adding = true;
    redraw();
  }

  // ---------- Marking the photo (v3, Max: «обвести кружечком… і щоб він зразу пояснював обведене») ----------

  // The camera, on the same full-screen sheet as the marks. Resolves to the picture (a Blob or, from «Галерея»,
  // a File), or null. Where the camera can't be had, the system's photo picker instead.
  const CAM_OK = !!navigator.mediaDevices?.getUserMedia && !OLD_APP;
  let stream = null;
  function stopCam() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    $("#pm-video").srcObject = null;
  }
  function camera() {
    return new Promise((resolve) => {
      const d = $("#paper-mark");
      const v = $("#pm-video");
      let over = false;
      const done = (f, close) => {
        if (over) return;
        over = true;
        stopCam();
        d.onclose = null;
        if (close && d.open) d.close();
        resolve(f);
      };
      d.dataset.mode = "cam";
      $("#pm-shot").hidden = false;
      $("#pm-hint").textContent = "Сфотографуйте сторінку";
      $("#pm-cancel").textContent = "Скасувати";
      $("#pm-cancel").onclick = () => done(null, true);
      d.onclose = () => done(null);
      $("#pm-lib").onclick = async () => {
        const f = await pickPhoto();
        if (f) done(f);
      };
      $("#pm-shot").onclick = () => {
        if (!v.videoWidth) return;
        const c = document.createElement("canvas");
        c.width = v.videoWidth;
        c.height = v.videoHeight;
        c.getContext("2d").drawImage(v, 0, 0);
        c.toBlob((blob) => blob && done(blob), "image/jpeg", 0.9);
      };
      if (!d.open) d.showModal();
      navigator.mediaDevices
        .getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false })
        .then((s) => {
          if (over) return s.getTracks().forEach((t) => t.stop());
          stream = s;
          v.srcObject = s;
          v.play().catch(() => {});
        })
        .catch(() => {
          // No camera here, or no permission: «Галерея» (the system's picker) still works.
          $("#pm-hint").textContent = "Камера недоступна";
          $("#pm-shot").hidden = true;
        });
    });
  }

  // Resolves to { data, small } with the marks drawn in, false for «Без позначок», null for «Скасувати»,
  // "retake" for «Перезняти» (after our camera; the sheet stays open for it).
  function mark(url, retake = false, words = { hint: "Обведіть, що пояснити", go: ["Готово", "Готово"] }) {
    return new Promise((resolve) => {
      const d = $("#paper-mark");
      d.dataset.mode = "mark";
      $("#pm-hint").textContent = words.hint;
      $("#pm-cancel").textContent = retake ? "Перезняти" : "Скасувати";
      const img = $("#pm-img");
      const cv = $("#pm-canvas");
      const strokes = [];
      let cur = null;
      const fit = () => {
        const r = img.getBoundingClientRect();
        cv.width = Math.round(r.width * devicePixelRatio);
        cv.height = Math.round(r.height * devicePixelRatio);
        cv.style.width = `${r.width}px`;
        cv.style.height = `${r.height}px`;
        draw();
      };
      const draw = (ctx = cv.getContext("2d"), w = cv.width, h = cv.height, onPhoto = false) => {
        if (!onPhoto) ctx.clearRect(0, 0, w, h);
        ctx.strokeStyle = "rgba(214, 40, 30, .85)";
        ctx.lineWidth = Math.max(3, w / 160);
        ctx.lineCap = ctx.lineJoin = "round";
        for (const s of strokes) {
          ctx.beginPath();
          s.forEach(([x, y], i) => (i ? ctx.lineTo(x * w, y * h) : ctx.moveTo(x * w, y * h)));
          ctx.stroke();
        }
        // One button: the photo, with or without marks, goes into the question field.
        $("#pm-go").textContent = words.go[strokes.length ? 1 : 0];
        $("#pm-clear").hidden = !strokes.length;
      };
      const at = (e) => {
        const r = cv.getBoundingClientRect();
        return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
      };
      cv.onpointerdown = (e) => {
        e.preventDefault();
        cv.setPointerCapture(e.pointerId);
        cur = [at(e)];
        strokes.push(cur);
        draw();
      };
      cv.onpointermove = (e) => cur && (cur.push(at(e)), draw());
      cv.onpointerup = cv.onpointercancel = () => (cur = null);
      $("#pm-clear").onclick = () => ((strokes.length = 0), draw());
      const done = (v) => {
        removeEventListener("resize", fit);
        d.onclose = null;
        d.close();
        resolve(v);
      };
      $("#pm-cancel").onclick = () => {
        if (!retake) return done(null);
        removeEventListener("resize", fit);
        d.onclose = null;
        resolve("retake");
      };
      d.onclose = () => resolve(null);
      $("#pm-go").onclick = async () => {
        // The photo with the marks on it, as the model sees it, and a small copy for the list.
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0);
        draw(ctx, c.width, c.height, true);
        const data = c.toDataURL("image/jpeg", 0.85).split(",")[1];
        const k = 240 / Math.max(c.width, c.height);
        const t = document.createElement("canvas");
        t.width = Math.round(c.width * k);
        t.height = Math.round(c.height * k);
        t.getContext("2d").drawImage(c, 0, 0, t.width, t.height);
        done({ data, small: t.toDataURL("image/jpeg", 0.7), marked: strokes.length > 0 });
      };
      img.onload = () => fit();
      img.src = url;
      addEventListener("resize", fit);
      $("#pm-clear").hidden = true;
      $("#pm-go").textContent = words.go[0];
      if (!d.open) d.showModal();
      if (img.complete && img.naturalWidth) fit();
    });
  }

  // ---------- Dictation (v3): dictation.js, tidied with the paper book's title ----------

  // Into the question field, or into the «+ Нотатка» form (a voice note, Max: «додати голосову заметку»).
  function mic(id = "pp-q") {
    const name = book?.path;
    window.Dictation.toggle(id, `[data-pp="${id === "pp-q" ? "mic" : "mic-note"}"]`, (said) => (name && book?.path === name ? window.reader.paperTidy(name, said) : said));
  }

  // The selection in the photo's text, with a little of what is around it for context.
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
    const edit = e.target.closest("[data-pp-edit-note]");
    if (edit) {
      editing = edit.dataset.ppEditNote;
      window.Shell.rerender();
      const f = $("#pp-note-edit");
      f?.focus();
      f?.setSelectionRange(f.value.length, f.value.length);
      return;
    }
    const delChat = e.target.closest("[data-pp-delchat]");
    if (delChat) {
      const id = delChat.dataset.ppDelchat;
      chats = chats.filter((c) => c.id !== id);
      if (lives.get(id)?.busy) window.reader.abort(lives.get(id).reqId);
      lives.delete(id);
      if (openChat === id) openChat = null;
      window.Shell.rerender();
      return window.reader.paperChatDelete(book.path, id).catch(() => {});
    }
    const save = e.target.closest("[data-pp-savechat]");
    if (save) {
      const c = chats.find((x) => x.id === save.dataset.ppSavechat);
      const last = c?.turns[c.turns.length - 1];
      if (!last) return;
      const n = await addNote({ text: c.sel && !c.img ? c.sel : c.turns[0]?.q || c.sel || "Питання", comment: last.a, quote: !!c.sel && !c.img, page: c.page });
      if (n) redraw(), showNotice("Збережено в нотатки", false);
      return;
    }
    const retry = e.target.closest("[data-pp-retry]");
    if (retry) {
      const l = lives.get(retry.dataset.ppRetry);
      return l && !l.busy && turn(l, l.q || null);
    }
    const chat = e.target.closest("[data-chat]");
    if (chat && !e.target.closest("a, button") && !getSelection().toString() && (!chat.classList.contains("open") || e.target.closest(".pp-chat-q"))) {
      openChat = openChat === chat.dataset.chat ? null : chat.dataset.chat;
      // Folding an answered question lets it go from the live ones; one still being answered stays open.
      for (const [id, l] of lives) if (!l.busy && id !== openChat) lives.delete(id);
      return window.Shell.rerender();
    }
    const act = e.target.closest("[data-pp]")?.dataset.pp;
    if (!act) return;
    if (act === "ask") return askFromField();
    if (act === "img") return attach();
    if (act === "mic") return mic();
    if (act === "mic-note") return mic("pp-note");
    if (act === "img-note") return noteFromPhoto();
    if (act === "unphoto") return photo && URL.revokeObjectURL(photo.thumb), (photo = null), redraw();
    if (act === "unattach") return (scan = null), (showText = false), window.Shell.rerender();
    if (act === "text") return (showText = !showText), window.Shell.rerender();
    if (act === "about") return window.Shell.showAbout(book);
    if (act === "cancel-edit") {
      editing = null;
      return window.Shell.rerender();
    }
    if (act === "allq") {
      allChats = !allChats;
      return window.Shell.rerender();
    }
    if (act === "note") {
      if (adding) return window.Dictation.stop(), (adding = false), (noteDraft = ""), (notePage = 0), window.Shell.rerender();
      return (adding = true), window.Shell.rerender(), setTimeout(() => $("#pp-note")?.focus(), 30);
    }
    if (act === "note-cancel") return window.Dictation.stop(), (adding = false), window.Shell.rerender();
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

  // ---------- Запитати / Пояснити: the answer right on the page (v3, Max: no card, there's no text it'd cover) ----------
  // The question goes to the top of «Запитання», open, and the answer streams into it; every one is kept.

  // Redraws the page and puts the cursor back where it was (a phone would otherwise drop the keyboard).
  function redraw() {
    const a = document.activeElement;
    // The question field keeps its text by itself (pageHtml); the follow-up fields by their chat.
    const drafts = new Map([...document.querySelectorAll(".pp-fq")].map((f) => [f.dataset.ppFq, f.querySelector("input").value]));
    const sel = a?.id === "pp-q" ? "#pp-q" : a?.classList?.contains("pp-fq-in") ? `[data-pp-fq="${a.closest(".pp-fq").dataset.ppFq}"] input` : null;
    const [s0, s1] = sel ? [a.selectionStart, a.selectionEnd] : [];
    window.Shell.rerender();
    for (const f of document.querySelectorAll(".pp-fq")) if (drafts.get(f.dataset.ppFq)) f.querySelector("input").value = drafts.get(f.dataset.ppFq);
    const el = sel && document.querySelector(sel);
    if (el) {
      el.focus({ preventScroll: true });
      try {
        el.setSelectionRange(s0, s1);
      } catch {}
    }
  }

  // Questions being answered, or just answered and still unfolded, by chat id: { chat, book, q, text, busy,
  // error, reqId, context }. Several can be answered at once (Max: a new question used to drop the one before).
  const lives = new Map();
  function ask({ selection = "", before = "", after = "", question = "", pageText = "", page = book.page, image = "", img = "", marked = true }) {
    const b = book;
    chats = chats.filter((c) => c.turns.length || lives.get(c.id)?.busy); // a question that failed is let go
    for (const [id, l] of lives) if (!l.busy) lives.delete(id);
    const sel = selection || (image ? (marked ? "Обведене на фото" : question ? "" : "Сторінка з фото") : "");
    const chat = { id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, turns: [], messages: null, sel, img, page: page || 0, at: Date.now() };
    chats = [...chats, chat];
    openChat = chat.id;
    const conv = { chat, book: b, text: "", busy: false, reqId: null };
    lives.set(chat.id, conv);
    conv.context = { paper: true, bookTitle: b.title, author: b.authors.join(", "), page: page || 0, chapter: b.chapter || "", selection, before, after, pageText, ...(image ? { image, marked } : {}) };
    turn(conv, question || null);
    $(".pp-chats")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function turn(c, question) {
    c.q = question || "";
    c.text = "";
    c.error = null;
    c.busy = true;
    const request = c.chat.messages ? { messages: [...c.chat.messages, { role: "user", content: question }] } : { context: { ...c.context, question: question || undefined } };
    c.reqId = `${c.chat.id}-${Date.now()}`;
    redraw();
    window.reader.explain(c.reqId, request);
  }

  window.reader.onAiEvent((reqId, ev) => {
    const c = [...lives.values()].find((l) => l.reqId === reqId);
    if (!c) return;
    if (ev.type === "text") {
      c.text += ev.text;
      const el = book === c.book && document.querySelector(`[data-chat="${c.chat.id}"] .pp-live`);
      if (el) el.innerHTML = md(c.text);
      return;
    }
    c.busy = false;
    if (ev.type === "done") {
      if (!c.text) c.error = "Порожня відповідь.";
      else {
        // Kept at once: the question, the answer, and the talk so far for «Уточнити».
        const ch = c.chat;
        ch.messages = ev.messages;
        ch.turns = [...ch.turns, { q: c.q, a: c.text }];
        // ch.at stays the time it was asked: the list doesn't reshuffle while answers come in.
        window.reader.paperChatSave(c.book.path, ch).then(() => c.book === book && loadIdeas(book)).catch(() => {});
      }
    } else if (ev.type === "aborted") {
      if (!c.text) c.error = "Зупинено.";
    } else if (ev.type === "error") {
      c.error = ev.message || "Не вдалося отримати відповідь.";
    }
    if (book === c.book) redraw();
  });

  // «Читаю зараз» on the site: while the page is open and in use, a ping a minute; the server counts the minutes.
  let busyAt = 0;
  for (const ev of ["pointerdown", "keydown", "scroll", "input"]) addEventListener(ev, () => (busyAt = Date.now()), { passive: true, capture: true });
  setInterval(() => {
    if (book && $(".pp") && document.visibilityState === "visible" && Date.now() - busyAt < 5 * 60 * 1000) window.reader.paperSeen(book.path);
  }, 60 * 1000);

  window.Paper = { pageHtml, add, coverPhoto, current: () => book };
})();

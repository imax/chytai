/* global $, ePub, book, rendition, pdfView, current, settings, notes, conversations, PHONE, BASE_SCALE,
   chapterTitle, toggleChrome, showPanel, addNote, openConvCard, startExplanation, noteContext, goToNote, noteReachable,
   notesStore, unmarkNote, redrawNote, renderNotes, showNotice, fitComment, scrolled, reopenBook, applyTheme, resizeView,
   applyTypography, setFont, bookFontSize, closeSheets, rememberReturn */
// The reading screen, turn 9 (phone) and turn 10 (computer) from Claude Design (2026-11-02).
// Phone: two bars around the text (tap in the middle shows them), one sheet look for the explanation, notes,
// contents and «Вигляд», the selection bar at the bottom, search over the whole screen.
// Computer: the same bars, contents and notes; the sheet becomes a panel on the right, the contents a panel on
// the left, «Вигляд» a small window under «Аа». What only a computer does (the mouse, keys, the panels' places)
// is in desk-read.js.
(function () {
  const on = () => PHONE.matches;
  const body = document.body;
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const plural = (n, one, few, many) => (n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many);

  // ---------- Pages ----------
  // A page is a ~1600-character chunk of the locations index, as on the contents (the same on every screen).
  function pageOf(cfi) {
    const n = book?.locationsReady && book.locations.length();
    if (!n || !cfi || current?.preview) return null;
    try {
      return { page: book.locations.locationFromCfi(cfi) + 1, total: n, pct: Math.round(book.locations.percentageFromCfi(cfi) * 100) };
    } catch {
      return null;
    }
  }

  let dragging = false;
  function progress(location) {
    const cfi = location.start.cfi;
    $("#m-chapter").textContent = chapterTitle(location.start.href, cfi);
    const p = pageOf(cfi);
    $("#m-pages").textContent = p ? `стор. ${p.page} з ${p.total} · ${p.pct}%` : "";
    if (p && !dragging) setSlider(p.pct / 100);
    // Until the page index is built the place is unknown: no slider at 0 % in the middle of a book.
    $("#m-bottom").classList.toggle("no-pos", !p);
    if (p) introBars();
    // Pages mode: the caption says the page rather than the percentage (9k).
    if (on() && p && !scrolled()) queueMicrotask(() => ($("#progress-label").textContent = `стор. ${p.page} з ${p.total}`));
    // After renderer.js has filled the caption for this page.
    if (!on()) queueMicrotask(() => (tocFollow(), window.DeskRead?.relocated(location, p)));
  }
  function pdfPage(page, total) {
    $("#m-bottom").classList.remove("no-pos");
    $("#m-pages").textContent = `стор. ${page} з ${total}`;
    if (!dragging) setSlider((page - 1) / Math.max(1, total - 1));
  }
  function setSlider(f) {
    $("#m-range").value = Math.round(f * 1000);
    $("#m-fill").style.width = `${f * 100}%`;
  }

  // Chapter starts as ticks on the slider, from the contents' page numbers.
  function ticks() {
    const n = book?.locations?.length?.();
    const box = $("#m-ticks");
    box.innerHTML = "";
    if (!n) return;
    for (const span of document.querySelectorAll("#toc-list a .toc-page")) {
      if (parseInt(span.parentElement.style.paddingLeft) > 12) continue; // top-level entries only
      const f = (Number(span.textContent) - 1) / n;
      if (f > 0.005 && f < 0.995) box.insertAdjacentHTML("beforeend", `<i style="left:${(f * 100).toFixed(2)}%"></i>`);
    }
  }

  const range = $("#m-range");
  range.addEventListener("input", () => {
    dragging = true;
    const f = range.value / 1000;
    $("#m-fill").style.width = `${f * 100}%`;
    const bubble = $("#m-bubble");
    if (pdfView) {
      bubble.textContent = `стор. ${Math.round(f * (pdfView.viewer.pagesCount - 1)) + 1}`;
    } else if (book?.locationsReady) {
      // A long chapter needs more than its name: the page and the percentage too (Max, 2026-11-02).
      const n = book.locations.length();
      const cfi = book.locations.cfiFromPercentage(f);
      const section = book.spine.get(new ePub.CFI(cfi).spinePos);
      const name = section && chapterTitle(section.href);
      bubble.innerHTML = `${name ? `<b>${esc(name)}</b>` : ""}<span>стор. ${Math.round(f * (n - 1)) + 1} · ${Math.round(f * 100)}%</span>`;
    } else return;
    bubble.classList.remove("hidden");
    const W = range.offsetWidth;
    const w = bubble.offsetWidth;
    bubble.style.left = `${Math.min(W - w / 2, Math.max(w / 2, f * W))}px`;
  });
  range.addEventListener("change", () => {
    const f = range.value / 1000;
    $("#m-bubble").classList.add("hidden");
    dragging = false;
    if (pdfView) pdfView.viewer.currentPageNumber = Math.round(f * (pdfView.viewer.pagesCount - 1)) + 1;
    else if (rendition && book?.locationsReady) {
      // A jump with the slider is easy to make by accident: «← Назад» returns, as after a footnote.
      // Several jumps in a row keep the way back to where the reader was before the first one.
      if ($("#btn-back").classList.contains("hidden")) rememberReturn();
      rendition.display(book.locations.cfiFromPercentage(f)).then(() => toggleChrome(true));
    }
  });

  // ---------- Bars ----------
  function bookOpened() {
    $("#m-title").textContent = current?.title || "";
    $("#m-author").textContent = current?.author || "";
    $("#m-ticks").innerHTML = "";
    $("#m-pages").textContent = "";
    setSlider(0);
    $("#m-bottom").classList.add("no-pos");
    closeSheet();
    body.classList.toggle("m-paged", !scrolled());
  }
  // The very first book read on this device shows the bars for a moment, so the reader knows they exist;
  // only once the place in the book is known (Max, 2026-11-02: the slider showed 0 % for a second).
  function introBars() {
    try {
      if (!on() || localStorage.getItem("barsShown")) return;
      localStorage.setItem("barsShown", "1");
    } catch {
      return;
    }
    toggleChrome(true);
    setTimeout(() => body.classList.contains("chrome-shown") && !sheetOpen() && toggleChrome(false), 2500);
  }
  function chrome(show) {
    if (show) $("#m-findbar").classList.add("hidden");
    else if (findActive) $("#m-findbar").classList.remove("hidden");
  }
  $("#m-back").onclick = () => $("#btn-library").click();
  $("#m-search").onclick = () => {
    toggleChrome(false);
    window.BookSearch?.open();
  };
  // A tap on the caption at the bottom shows the bars too (open question 5).
  $("#status").addEventListener("click", () => on() && toggleChrome(true));
  for (const b of document.querySelectorAll(".m-nav button")) {
    b.onclick = () => {
      toggleChrome(false);
      if (b.dataset.m === "notes") return showPanel(true, "notes");
      if (b.dataset.m === "ask") return openAsk();
      openSheet(b.dataset.m);
    };
  }
  function notesCount() {
    $("#m-ncount").textContent = notes.length || "";
    $("#m-dncount").textContent = notes.length || "";
  }

  // ---------- The sheet: contents and «Вигляд» ----------
  const sheet = $("#msheet");
  let sheetKind = null;
  const sheetOpen = () => !!sheetKind;
  function openSheet(kind) {
    if (!on()) return kind === "look" ? window.DeskRead?.look(true) : openToc();
    if (!body.classList.contains("panel-hidden")) showPanel(false);
    sheetKind = kind;
    sheet.dataset.kind = kind;
    if (kind === "toc") {
      $("#ms-title").textContent = "Зміст";
      $("#ms-sub").textContent = [current?.title, current?.author].filter(Boolean).join(" · ");
      sheet.style.setProperty("--ms-top", "52px");
      renderToc();
    } else {
      $("#ms-title").textContent = "Вигляд";
      $("#ms-sub").textContent = "";
      sheet.style.setProperty("--ms-top", "44%");
      renderLook();
    }
    sheet.classList.remove("hidden");
    if (kind === "toc") requestAnimationFrame(() => $("#ms-body .cur")?.scrollIntoView({ block: "center" }));
  }
  function closeSheet() {
    const was = sheetKind;
    sheetKind = null;
    sheet.classList.add("hidden");
    if (was && !on()) window.DeskRead?.tocShown(false);
  }
  // Computer: the contents stay open on the left while the reader goes from chapter to chapter (10g).
  function openToc() {
    sheetKind = "toc";
    sheet.dataset.kind = "toc";
    $("#ms-title").textContent = "Зміст";
    $("#ms-sub").textContent = [current?.title, current?.author].filter(Boolean).join(" · ");
    renderToc();
    sheet.classList.remove("hidden");
    window.DeskRead?.tocShown(true);
    requestAnimationFrame(() => $("#ms-body .cur")?.scrollIntoView({ block: "center" }));
  }
  $("#ms-close").onclick = closeSheet;

  // Pull a sheet down by its head to put it away (both sheets: this one and the explanations panel).
  function dragToClose(head, el, close) {
    let d = null;
    head.addEventListener("pointerdown", (e) => {
      if (!on() || e.target.closest("button") || el.id === "panel") return;
      d = { y: e.clientY, id: e.pointerId, t: e.timeStamp };
      head.setPointerCapture(e.pointerId);
      el.classList.add("dragging");
    });
    head.addEventListener("pointermove", (e) => {
      if (!d || e.pointerId !== d.id) return;
      el.style.transform = `translateY(${Math.max(0, e.clientY - d.y)}px)`;
    });
    const end = (e) => {
      if (!d) return;
      const dy = e.clientY - d.y;
      const fast = dy / Math.max(1, e.timeStamp - d.t) > 0.6;
      d = null;
      el.classList.remove("dragging");
      el.style.transform = "";
      if (e.type === "pointerup" && (dy > 90 || (fast && dy > 20))) close();
    };
    head.addEventListener("pointerup", end);
    head.addEventListener("pointercancel", end);
  }
  dragToClose($("#msheet .ms-head"), sheet, closeSheet);

  function renderToc() {
    const here = $("#chapter-label").textContent.trim() || $("#m-chapter").textContent.trim();
    const links = [...document.querySelectorAll("#toc-list a")];
    let cur = links.findIndex((a) => a.firstChild?.textContent.trim() === here);
    const pct = (() => {
      const loc = rendition?.currentLocation?.();
      return loc?.start ? pageOf(loc.start.cfi)?.pct : null;
    })();
    $("#ms-body").innerHTML = links.length
      ? `<ol class="mt">${links
          .map((a, i) => {
            const depth = Math.max(0, Math.round((parseInt(a.style.paddingLeft) - 12) / 14));
            const page = a.querySelector(".toc-page")?.textContent || "";
            return `<li class="mt-row${i === cur ? " cur" : ""}" data-i="${i}" style="padding-left:${depth * 16}px"><span class="mt-t">${esc(a.firstChild?.textContent.trim())}${i === cur ? `<small>ви тут${pct != null ? ` · ${pct}%` : ""}</small>` : ""}</span><span class="mt-p">${esc(page)}</span></li>`;
          })
          .join("")}</ol>`
      : `<p class="m-empty">У цієї книжки немає змісту.</p>`;
    for (const li of $("#ms-body").querySelectorAll(".mt-row")) {
      li.onclick = () => {
        if (on()) closeSheet();
        links[li.dataset.i].click();
      };
    }
  }
  // The open contents follow the reader: «ви тут» moves with the page.
  function tocFollow() {
    if (sheetKind !== "toc" || on()) return;
    const box = $("#ms-body");
    const top = box.scrollTop;
    renderToc();
    box.scrollTop = top;
  }

  // «Вигляд»: every change applies to the text at once, no «Зберегти» (turn 9).
  const MARGIN_ICONS = {
    narrow: '<path d="M4 6h16M4 10h16M4 14h16M4 18h16"/>',
    normal: '<path d="M4 4v16M20 4v16M8 7h8M8 11h8M8 15h8"/>',
    wide: '<path d="M4 4v16M20 4v16M10 8h4M10 12h4M10 16h4"/>',
  };
  // The column on a computer (10i): three lines, short to long.
  const COLUMN_ICONS = { narrow: '<path d="M8 7h8M8 12h8M8 17h8"/>', normal: '<path d="M5 7h14M5 12h14M5 17h14"/>', wide: '<path d="M2 7h20M2 12h20M2 17h20"/>' };
  function lookBox() {
    return on() ? $("#ms-body") : $("#ml-body");
  }
  function renderLook() {
    const desk = !on();
    const theme = settings.theme || "auto";
    const font = settings.font || "literata";
    const margins = settings.margins || "normal";
    const px = Math.round((16 * BASE_SCALE * bookFontSize()) / 100);
    const seg = (key, items, value) =>
      `<div class="m-seg" data-key="${key}">${items.map(([v, label, style]) => `<button type="button" data-v="${v}"${v === value ? ' class="on"' : ""}${style ? ` style="${style}"` : ""}>${label}</button>`).join("")}</div>`;
    lookBox().innerHTML = `
      <div class="ml">
        <div class="m-seg m-size"><button type="button" data-size="-10" aria-label="Менший шрифт">А</button><span>${px}</span><button type="button" data-size="10" aria-label="Більший шрифт">А</button></div>
        <div class="m-themes">${[
          ["auto", "Як у системі"],
          ["light", "Світла"],
          ["sepia", "Сепія"],
          ["dark", "Темна"],
        ]
          .map(([v, l]) => `<button type="button" data-theme="${v}"${v === theme ? ' class="on"' : ""}><i>Аа</i><span>${l}</span></button>`)
          .join("")}</div>
        <div class="m-grp">Шрифт</div>
        ${seg("font", [["literata", "Literata", "font-family:'Literata Variable',Literata,Georgia,serif"], ["georgia", "Georgia", "font-family:Georgia,serif"], ["publisher", "Видавця"]], font)}
        <div class="m-two">${
          desk
            ? `<div><div class="m-grp">Колонка</div>${seg("column", Object.entries(COLUMN_ICONS).map(([v, d]) => [v, `<svg viewBox="0 0 24 24" aria-label="${{ narrow: "Вузька", normal: "Звичайна", wide: "Широка" }[v]}">${d}</svg>`]), settings.column || "normal")}</div>
          <div><div class="m-grp">Гортання</div>${seg("mode", [["scroll", "Прокрутка"], ["pages", "Розворот"]], settings.deskScroll ? "scroll" : "pages")}</div>`
            : `<div><div class="m-grp">Поля</div>${seg("margins", Object.entries(MARGIN_ICONS).map(([v, d]) => [v, `<svg viewBox="0 0 24 24" aria-label="${{ narrow: "Вузькі", normal: "Звичайні", wide: "Широкі" }[v]}">${d}</svg>`]), margins)}</div>
          <div><div class="m-grp">Гортання</div>${seg("mode", [["scroll", "Прокрутка"], ["pages", "Сторінки"]], settings.pageTaps ? "pages" : "scroll")}</div>`
        }
        </div>
      </div>`;
    const box = lookBox();
    for (const b of box.querySelectorAll("[data-size]")) b.onclick = async () => (await setFont(Number(b.dataset.size)), renderLook());
    for (const b of box.querySelectorAll(".m-themes button")) b.onclick = () => applyLook({ theme: b.dataset.theme });
    for (const b of box.querySelectorAll(".m-seg[data-key] button")) {
      b.onclick = () => {
        const key = b.parentElement.dataset.key;
        applyLook(key === "mode" ? (desk ? { deskScroll: b.dataset.v === "scroll" } : { pageTaps: b.dataset.v === "pages" }) : { [key]: b.dataset.v });
      };
    }
  }
  async function applyLook(patch) {
    const fontChanged = patch.font && patch.font !== settings.font;
    const marginsChanged = patch.margins && patch.margins !== (settings.margins || "normal");
    const columnChanged = patch.column && patch.column !== (settings.column || "normal");
    const wasScrolled = scrolled();
    settings = await window.reader.setSettings(patch);
    if (wasScrolled !== scrolled()) {
      if (on()) closeSheet();
      else renderLook();
      body.classList.toggle("m-paged", !scrolled());
      return reopenBook();
    }
    body.dataset.margins = settings.margins || "normal";
    applyTheme();
    if (marginsChanged) resizeView();
    if (columnChanged) window.DeskRead?.columnChanged();
    if (fontChanged) applyTypography(true);
    if (sheetKind === "look" || !on()) renderLook();
  }

  // ---------- Explanations and notes: #panel as the same sheet ----------
  const panel = $("#panel");
  let shownConv = null;
  function panelShown(show) {
    if (show && on()) closeSheet();
    const notesTab = !$("#notes").classList.contains("hidden");
    panel.classList.toggle("m-notes", notesTab);
    if (show && notesTab && on()) setPanelTop(true);
    syncPanelHead();
    window.DeskRead?.panelShown(show);
  }
  function setPanelTop(full) {
    panel.classList.toggle("full", full);
    body.style.setProperty("--panel-top", full ? "52px" : "47%");
  }
  function syncPanelHead() {
    const notesTab = !$("#notes").classList.contains("hidden");
    const title = $("#ps-title");
    if (notesTab) title.innerHTML = `Нотатки <span>${notes.length || ""}</span>`;
    else title.innerHTML = `Запитання <span>${conversations.size || ""}</span>`;
    // «В нотатки» is on each question now (2026-11-03).
    $("#ps-action").classList.add("hidden");
  }
  $("#ps-action").onclick = () => {
    const conv = shownConv;
    if (!conv) return;
    addNote({ cfiRange: conv.cfiRange, text: conv.context.selection, context: conv.context }).then(syncPanelHead);
  };
  for (const b of document.querySelectorAll("#panel .tab")) b.addEventListener("click", () => panelShown(true));

  // One explanation at a time in the sheet; the others wait behind their marks in the text.
  // «Запитання» (2026-11-03): the open question in full, the others folded under it (renderer.js listCards).
  function showConv(conv) {
    shownConv = conv;
    for (const c of conversations.values()) c.card.classList.toggle("m-off", c !== conv);
    // The open one goes to the top of the list, under the field.
    if (conv && conv.card.previousElementSibling !== $("#ask-book")) $("#ask-book").after(conv.card);
    listCards();
    syncPanelHead();
  }
  function convStarted(conv) {
    showConv(conv);
    const where = conv.card.querySelector(".where");
    const p = String(conv.cfiRange).startsWith("epubcfi") ? pageOf(conv.cfiRange) : null;
    where.textContent = [conv.context.chapter, p && `стор. ${p.page}`, "щойно"].filter(Boolean).join(" · ");
    // A question about a passage: the list scrolls to it, past the field. One about the book stays at the top.
    const box = $("#cards");
    if (conv.context.selection) requestAnimationFrame(() => (box.scrollTop += conv.card.getBoundingClientRect().top - box.getBoundingClientRect().top));
    else box.scrollTop = 0;
    if (!on()) return window.DeskRead?.convStarted(conv);
    if (!conv.context.selection) return setPanelTop(true);
    setPanelTop(false);
    revealAbove(conv.cfiRange);
  }
  function sheetFull() {
    if (on()) setPanelTop(true);
  }
  // The passage being explained stays in sight above the half-height sheet (scroll mode).
  function revealAbove(cfi) {
    if (!rendition || !scrolled()) return;
    setTimeout(() => {
      try {
        const r = rendition.getRange(cfi);
        const frame = r.startContainer.ownerDocument.defaultView.frameElement.getBoundingClientRect();
        const box = r.getBoundingClientRect();
        const top = frame.top + box.top;
        const bottom = frame.top + box.bottom;
        const limit = panel.getBoundingClientRect().top - 24;
        if (bottom <= limit) return;
        const by = Math.min(bottom - limit, top - 70);
        if (by > 0) rendition.manager.container.scrollBy({ top: by, behavior: "smooth" });
      } catch {
        /* the passage is not laid out */
      }
    }, 320);
  }

  // Notes (9f): tabs for the whole book and this chapter, newest first under chapter headings, no cards.
  let notesFilter = "all";
  function renderNotesPhone(box) {
    const here = $("#chapter-label").textContent.trim();
    // Newest first (Max); a chapter heading repeats when notes from two chapters alternate.
    const all = [...notes].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const inChapter = all.filter((n) => here && n.chapter === here);
    const explained = (n) => [...conversations.values()].some((c) => c.cfiRange === n.cfi);
    const withConv = on() ? [] : all.filter(explained);
    if (notesFilter === "chapter" && !here) notesFilter = "all";
    if (notesFilter === "conv" && (on() || !withConv.length)) notesFilter = "all";
    const list = notesFilter === "chapter" ? inChapter : notesFilter === "conv" ? withConv : all;
    // A computer has room for a third tab: notes with an explanation (10f).
    const tab = (f, label, n) => `<button type="button" data-f="${f}"${notesFilter === f ? ' class="on"' : ""}>${label} <span>${n}</span></button>`;
    box.innerHTML = `<div class="mn-tabs">${tab("all", "Уся книжка", all.length)}${tab("chapter", "Цей розділ", inChapter.length)}${withConv.length ? tab("conv", "З поясненням", withConv.length) : ""}</div>`;
    for (const b of box.querySelectorAll(".mn-tabs button")) b.onclick = () => ((notesFilter = b.dataset.f), renderNotesPhone(box));
    if (!list.length) {
      box.insertAdjacentHTML("beforeend", `<p class="m-empty">${notes.length ? "У цьому розділі нотаток немає." : "Нотаток ще немає. Виділіть текст і натисніть «В нотатки»."}</p>`);
      return;
    }
    let group = null;
    for (const note of list) {
      if (!group || group.dataset.chapter !== (note.chapter || "")) {
        group = document.createElement("section");
        group.className = "mn-group";
        group.dataset.chapter = note.chapter || "";
        group.innerHTML = `<h3 class="m-grp">${esc(note.chapter || "Без розділу")}</h3>`;
        box.appendChild(group);
      }
      const conv = [...conversations.values()].find((c) => c.cfiRange === note.cfi);
      const p = String(note.cfi).startsWith("epubcfi") ? pageOf(note.cfi) : null;
      const el = document.createElement("article");
      el.className = "mn note";
      el.dataset.id = note.id;
      el.innerHTML = `
        <div class="mn-q"><span></span></div>
        <textarea class="note-comment" rows="1" placeholder="Додати думку…"></textarea>
        <div class="mn-acts"><span class="mn-p">${p ? `стор. ${p.page}` : ""}<span class="mn-here"> · на екрані</span></span>
          <button type="button" class="explain${conv ? " has" : ""}">${conv ? "Пояснення" : "Пояснити"}</button>
          <button type="button" class="go">Перейти</button>
          <button type="button" class="delete">Видалити</button></div>`;
      el.querySelector(".mn-q span").textContent = note.text;
      el.querySelector(".explain").onclick = async () => {
        if (conv) return openConvCard(conv);
        if (settings.free) return showNotice("Пояснення працюють після входу. Це безкоштовно, потрібна лише пошта.", false);
        startExplanation({ cfiRange: note.cfi, text: note.text, context: await noteContext(note) });
      };
      const go = el.querySelector(".go");
      if (noteReachable(note)) go.onclick = () => goToNote(note);
      else go.disabled = true;
      el.querySelector(".delete").onclick = async () => {
        try {
          await notesStore.notesDelete(current.path, note.id);
        } catch (err) {
          if (err.message !== "login") showNotice(`Не вдалося видалити нотатку: ${err.message}`, false);
          return;
        }
        notes = notes.filter((n) => n.id !== note.id);
        unmarkNote(note);
        renderNotes();
      };
      const comment = el.querySelector(".note-comment");
      comment.value = note.comment || "";
      comment.oninput = () => fitComment(comment);
      comment.onchange = async () => {
        note.comment = comment.value.trim();
        redrawNote(note);
        try {
          await notesStore.notesUpdate(current.path, note.id, { comment: note.comment });
        } catch (err) {
          if (err.message !== "login") showNotice(`Не вдалося зберегти думку: ${err.message}`, false);
        }
      };
      group.appendChild(el);
    }
    syncPanelHead();
    requestAnimationFrame(() => box.querySelectorAll(".note-comment").forEach(fitComment));
  }

  // ---------- Search: after a jump, a bar with the match number instead of the caption ----------
  let findActive = false;
  function findShown(i, n) {
    findActive = n > 0;
    $("#m-find-n").textContent = `${i + 1} з ${n}`;
    $("#m-findbar").classList.toggle("hidden", !findActive || body.classList.contains("chrome-shown"));
  }
  function findClosed() {
    findActive = false;
    $("#m-findbar").classList.add("hidden");
  }
  $("#m-find-prev").onclick = () => window.BookSearch?.step(-1);
  $("#m-find-next").onclick = () => window.BookSearch?.step(1);
  $("#m-find-list").onclick = () => window.BookSearch?.list();
  $("#m-find-x").onclick = () => window.BookSearch?.close();

  // Leaving the book (home screen) puts the sheets away.
  new MutationObserver(() => body.classList.contains("library-open") && closeSheet()).observe(body, { attributes: true, attributeFilter: ["class"] });
  PHONE.addEventListener("change", () => (closeSheet(), $("#mlook").classList.add("hidden")));

  window.PhoneRead = {
    progress, pdfPage, ticks, bookOpened, chrome, notesCount, sheetOpen, closeSheet, panelShown, showConv, convStarted, sheetFull,
    renderNotes: renderNotesPhone, findShown, findClosed, renderLook, openSheet, pageOf, tocFollow,
    sheetKind: () => sheetKind, shownConv: () => shownConv, syncPanelHead,
  };
})();

/* global $, ePub, book, rendition, pdfView, current, notes, conversations, PHONE, TOUCH, toggleChrome, showPanel, hideSelToolbar,
   setFont, scrolled, resizeView, applyTypography, columnWidth, chapterTitle */
// The reading screen on a computer, turn 10 from Claude Design (2026-11-02). Shared parts (bars, contents, notes,
// «Вигляд») are in phone-read.js; here is what only a computer has: the header and the slider show while the mouse
// moves, the explanation, notes and search take a panel on the right and push the text aside, the contents a
// panel on the left, «Вигляд» a small window under «Аа», and single keys (E, N, T, Esc, ⌘F, ⌘+ ⌘−).
(function () {
  const desk = () => !PHONE.matches;
  const body = document.body;
  const reading = () => body.classList.contains("reading");
  const TOC_W = 340;
  const PW = { min: 360, max: 560, def: 420 };

  // ---------- Where the text goes: the window minus the open panels ----------
  let tocOpen = false;
  let searchOpen = false;
  const panelOpen = () => !body.classList.contains("panel-hidden");
  const rightOpen = () => panelOpen() || searchOpen;
  let pw = PW.def;
  try {
    pw = Math.min(PW.max, Math.max(PW.min, Number(localStorage.getItem("panelW")) || PW.def));
  } catch {
    /* storage is optional */
  }
  const area = () => window.innerWidth - (tocOpen ? TOC_W : 0) - (rightOpen() ? pw : 0);

  let resizeTimer = 0;
  function layout(reflow = true) {
    if (!desk()) return;
    body.style.setProperty("--d-pw", `${pw}px`);
    body.style.setProperty("--d-col", `${columnWidth()}px`);
    body.classList.toggle("d-toc", tocOpen);
    body.classList.toggle("d-right", rightOpen());
    // Pages on a wide window: a spread of two 440px pages 96px apart (10k); else one page as wide as the column.
    const spread = !scrolled() && area() >= 1100;
    body.classList.toggle("d-spread", spread);
    body.classList.toggle("d-paged", !scrolled());
    body.style.setProperty("--d-vw", `${spread ? 2 * (440 + 96) : columnWidth() + 96}px`);
    syncButtons();
    if (!reflow) return;
    // The text moves along with the panel (200 ms); epub.js lays the pages out again once it has.
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resizeView, 230);
  }
  window.addEventListener("resize", () => desk() && layout(false));

  function syncButtons() {
    const on = (d, v) => $(`.m-dnav [data-d="${d}"]`)?.classList.toggle("on", v);
    on("toc", tocOpen);
    on("search", searchOpen);
    on("notes", panelOpen() && !$("#notes").classList.contains("hidden"));
    on("look", !$("#mlook").classList.contains("hidden"));
  }

  // The contents next to a right panel only while the text keeps 680px; otherwise one of them goes.
  function tocShown(show) {
    tocOpen = show && desk();
    if (tocOpen && rightOpen() && area() < 680) closeRight();
    layout();
  }
  function closeRight() {
    if (searchOpen) window.BookSearch?.close();
    if (panelOpen()) showPanel(false);
  }
  function panelShown(show) {
    if (!desk()) return;
    if (show && searchOpen) window.BookSearch?.close();
    if (show && tocOpen && area() < 680) window.PhoneRead?.closeSheet();
    $("#ps-esc").classList.toggle("hidden", !show || !escHint || !$("#notes").classList.contains("hidden"));
    layout();
  }
  function searchShown(show) {
    if (!desk()) return;
    if (show && panelOpen()) showPanel(false);
    searchOpen = show;
    if (show && tocOpen && area() < 680) window.PhoneRead?.closeSheet();
    layout();
  }

  // The panel is as wide as the reader pulls it by its left edge (360–560px), remembered on this device.
  const grip = $("#panel-grip");
  let drag = null;
  grip.addEventListener("pointerdown", (e) => {
    if (!desk()) return;
    drag = { id: e.pointerId };
    grip.setPointerCapture(e.pointerId);
    body.classList.add("d-dragging");
  });
  grip.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    pw = Math.round(Math.min(PW.max, Math.max(PW.min, window.innerWidth - e.clientX)));
    layout(false);
  });
  const dragEnd = () => {
    if (!drag) return;
    drag = null;
    body.classList.remove("d-dragging");
    try {
      localStorage.setItem("panelW", String(pw));
    } catch {
      /* storage is optional */
    }
    layout();
  };
  grip.addEventListener("pointerup", dragEnd);
  grip.addEventListener("pointercancel", dragEnd);

  // ---------- The header and the slider show while the mouse moves (10b) ----------
  let hideTimer = 0;
  let pointer = { x: -1, y: -1 };
  const pinned = () => desk() && (!$("#mlook").classList.contains("hidden") || $("#m-top").matches(":hover") || $("#m-bottom").matches(":hover"));
  function hideSoon(ms) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => !pinned() && toggleChrome(false), ms);
  }
  // The text itself: the column in scroll mode, the pages in page mode.
  function inText(x, y) {
    const r = $("#reader").getBoundingClientRect();
    if (y < r.top + 56 || y > r.bottom - 52) return false;
    const half = (scrolled() ? columnWidth() : Math.min(r.width, parseFloat(getComputedStyle(body).getPropertyValue("--d-vw")) || 0) - 96) / 2;
    const mid = r.left + r.width / 2;
    return x > mid - half - 8 && x < mid + half + 8;
  }
  function moved(x, y) {
    if (!desk() || TOUCH.matches || !reading()) return;
    if (Math.abs(x - pointer.x) + Math.abs(y - pointer.y) < 3) return; // a twitch, or the page moving under a still mouse
    pointer = { x, y };
    if (pinned()) return clearTimeout(hideTimer);
    if (inText(x, y)) {
      if (body.classList.contains("chrome-shown")) hideSoon(250);
      return;
    }
    toggleChrome(true);
    hideSoon(2000);
  }
  document.addEventListener("mousemove", (e) => moved(e.clientX, e.clientY), { passive: true });
  document.addEventListener("mouseleave", () => desk() && reading() && hideSoon(600));
  for (const bar of [$("#m-top"), $("#m-bottom")]) bar.addEventListener("mouseleave", () => desk() && hideSoon(2000));
  // Moves over the page reach only its frame; epub.js passes them on with the frame's coordinates.
  function watchFrames(r) {
    r.on("mousemove", (e) => {
      const frame = e.view?.frameElement?.getBoundingClientRect();
      if (frame) moved(e.clientX + frame.left, e.clientY + frame.top);
    });
    r.on("mousedown", () => look(false));
  }

  // ---------- «Вигляд»: a window under «Аа» (10i) ----------
  function look(show = $("#mlook").classList.contains("hidden")) {
    if (!desk()) return;
    $("#mlook").classList.toggle("hidden", !show);
    if (show) {
      window.PhoneRead?.renderLook();
      toggleChrome(true);
      clearTimeout(hideTimer);
    } else if (reading() && !pinned()) hideSoon(2000);
    syncButtons();
  }
  document.addEventListener("mousedown", (e) => {
    if ($("#mlook").classList.contains("hidden") || e.target.closest("#mlook, .m-dnav [data-d='look']")) return;
    look(false);
  });

  // ---------- Header actions ----------
  for (const b of document.querySelectorAll(".m-dnav button")) {
    b.onclick = () => {
      const d = b.dataset.d;
      if (d === "look") return look();
      if (d === "full") return fullscreen();
      if (d === "search") return searchOpen ? window.BookSearch?.close() : window.BookSearch?.open();
      if (d === "toc") return tocOpen ? window.PhoneRead?.closeSheet() : window.PhoneRead?.openSheet("toc");
      if (d === "notes") {
        const shown = panelOpen() && !$("#notes").classList.contains("hidden");
        return showPanel(!shown, shown ? undefined : "notes");
      }
    };
  }

  // On the whole screen, without the browser's tabs and toolbar (Max, 2026-11-02). Esc or the button leaves it.
  const canFull = !!document.fullscreenEnabled;
  document.documentElement.classList.toggle("can-full", canFull);
  function fullscreen() {
    if (!canFull) return;
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    else document.documentElement.requestFullscreen?.().catch(() => {});
  }
  document.addEventListener("fullscreenchange", () => {
    const on = !!document.fullscreenElement;
    body.classList.toggle("d-full", on);
    const b = $('.m-dnav [data-d="full"]');
    b.title = on ? "Вийти з повного екрана (F)" : "На весь екран (F)";
    b.setAttribute("aria-label", on ? "Вийти з повного екрана" : "На весь екран");
  });

  // ---------- An explanation opens next to the text (10d) ----------
  // «Esc» in the panel's head for the first few explanations.
  let escHint = true;
  try {
    escHint = Number(localStorage.getItem("escHint") || 0) < 3;
  } catch {
    /* storage is optional */
  }
  function convStarted(conv) {
    if (!desk()) return;
    if (escHint) {
      try {
        const n = Number(localStorage.getItem("escHint") || 0) + 1;
        localStorage.setItem("escHint", String(n));
        escHint = n <= 3;
      } catch {
        /* storage is optional */
      }
    }
    $("#ps-esc").classList.toggle("hidden", !escHint);
    // The question field is ready at once; the passage stays in sight once the text has moved aside.
    setTimeout(() => conv.card.querySelector(".followup input")?.focus({ preventScroll: true }), 60);
    setTimeout(() => reveal(conv.cfiRange), 320);
  }
  function reveal(cfi) {
    if (!rendition || !String(cfi).startsWith("epubcfi")) return;
    try {
      const r = rendition.getRange(cfi);
      const frame = r.startContainer.ownerDocument.defaultView.frameElement.getBoundingClientRect();
      const box = r.getBoundingClientRect();
      const view = $("#viewer").getBoundingClientRect();
      const left = frame.left + box.left;
      const top = frame.top + box.top;
      if (left >= view.left && left < view.right && top >= view.top && top < view.bottom - 20) return;
    } catch {
      /* not laid out: go there */
    }
    rendition.display(cfi);
  }

  // ---------- Notes: hovering one outlines its passage on the page (10f) ----------
  function noteMark(note) {
    const views = rendition?.views();
    for (const view of views?.all ? views.all() : views || []) {
      const el = view.underlines?.[note.cfi]?.mark?.element;
      if (el) return el;
    }
    return null;
  }
  function onScreen(cfi) {
    const loc = rendition?.currentLocation?.();
    if (!loc?.start || !String(cfi).startsWith("epubcfi")) return false;
    try {
      const c = new ePub.CFI();
      return c.compare(cfi, loc.start.cfi) >= 0 && c.compare(cfi, loc.end.cfi) <= 0;
    } catch {
      return false;
    }
  }
  let hovered = null;
  function hover(id) {
    if (hovered) noteMark(hovered)?.classList.remove("d-hover");
    hovered = id ? notes.find((n) => n.id === id) : null;
    if (!hovered) return;
    const here = onScreen(hovered.cfi);
    $(`#notes .mn[data-id="${id}"]`)?.classList.toggle("here", here);
    if (here) noteMark(hovered)?.classList.add("d-hover");
  }
  $("#notes").addEventListener("mouseover", (e) => desk() && hover(e.target.closest(".mn")?.dataset.id || null));
  $("#notes").addEventListener("mouseleave", () => hover(null));

  // ---------- The slider: hovering shows the chapter and page under the mouse (10b) ----------
  const range = $("#m-range");
  const bubble = $("#m-bubble");
  let sliding = false;
  range.addEventListener("pointerdown", () => (sliding = true));
  range.addEventListener("pointerup", () => (sliding = false));
  range.addEventListener("mousemove", (e) => {
    if (!desk() || sliding) return;
    const box = range.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    let text = "";
    if (pdfView) text = `стор. ${Math.round(f * (pdfView.viewer.pagesCount - 1)) + 1}`;
    else if (book?.locationsReady) {
      const n = book.locations.length();
      const section = book.spine.get(new ePub.CFI(book.locations.cfiFromPercentage(f)).spinePos);
      const name = section && chapterTitle(section.href);
      text = `${name ? `${name} · ` : ""}стор. ${Math.round(f * (n - 1)) + 1}`;
    } else return;
    bubble.textContent = text;
    bubble.classList.remove("hidden");
    const w = bubble.offsetWidth;
    bubble.style.left = `${Math.min(box.width - w / 2, Math.max(w / 2, f * box.width))}px`;
    // The chapter's tick under the mouse turns dark.
    let hot = null;
    for (const i of document.querySelectorAll("#m-ticks i")) if (parseFloat(i.style.left) / 100 <= f) hot = i;
    for (const i of document.querySelectorAll("#m-ticks i.hot")) if (i !== hot) i.classList.remove("hot");
    hot?.classList.add("hot");
  });
  range.addEventListener("mouseleave", () => {
    if (!desk() || sliding) return;
    bubble.classList.add("hidden");
    for (const i of document.querySelectorAll("#m-ticks i.hot")) i.classList.remove("hot");
  });

  // ---------- The caption under the text ----------
  // Page mode: one caption, the chapter and «стор. 109 з 185» (Max, 2026-11-02: a caption under each page of a
  // spread had too many numbers).
  function relocated(location, p) {
    if (!desk() || scrolled() || !p) return;
    $("#progress-label").textContent = `стор. ${p.page} з ${p.total}`;
  }

  // ---------- Keys (Клавіші) ----------
  function key(e) {
    if (!desk() || !reading() || document.querySelector("dialog[open]")) return;
    const mod = e.metaKey || e.ctrlKey;
    const code = e.code;
    // ⌘F searches the book instead of the page; ⌘+ ⌘− change the font size, not the browser's zoom.
    if (mod && code === "KeyF") return e.preventDefault(), window.BookSearch?.open();
    if (mod && (code === "Equal" || code === "NumpadAdd")) return e.preventDefault(), setFont(10);
    if (mod && (code === "Minus" || code === "NumpadSubtract")) return e.preventDefault(), setFont(-10);
    if (mod || e.altKey) return;
    const field = e.target?.closest?.("input, textarea, select, [contenteditable]");
    const bar = $("#sel-toolbar");
    const selection = !bar.classList.contains("hidden") && !bar.classList.contains("mark");
    if (e.key === "Escape") {
      if (field && !field.closest("#cards")) return; // the search field closes the search itself
      const busy = [...conversations.values()].some((c) => c.busy);
      let act = null;
      if (selection) act = clearSelection;
      else if (!$("#mlook").classList.contains("hidden")) act = () => look(false);
      // An answer still being written stops first (Max, 2026-11-01; onKey); the next Esc closes the panel.
      else if (busy) return;
      else if (searchOpen) act = () => window.BookSearch?.close();
      else if (panelOpen()) act = () => showPanel(false);
      else if (tocOpen) act = () => window.PhoneRead?.closeSheet();
      if (!act) return;
      e.preventDefault();
      field?.blur();
      return act();
    }
    if (field || e.repeat || e.shiftKey) return;
    const pick = { KeyE: "explain", KeyN: "note", KeyT: "translate" }[code];
    if (selection && pick) {
      const b = bar.querySelector(`[data-action="${pick}"]`);
      if (b && !b.hidden) return e.preventDefault(), b.click();
    }
    if (code === "KeyF") return e.preventDefault(), fullscreen();
    if (code === "KeyT" && !pdfView) {
      e.preventDefault();
      return tocOpen ? window.PhoneRead?.closeSheet() : window.PhoneRead?.openSheet("toc");
    }
  }
  function clearSelection() {
    for (const c of rendition?.getContents?.() || []) c.window.getSelection()?.removeAllRanges();
    window.getSelection()?.removeAllRanges();
    hideSelToolbar();
  }
  document.addEventListener("keydown", key);

  // A computer turned into a phone-sized window (or back): the panels go.
  PHONE.addEventListener("change", () => {
    tocOpen = false;
    searchOpen = false;
    $("#mlook").classList.add("hidden");
    if (desk()) layout();
  });
  if (desk()) layout(false);

  window.DeskRead = {
    layout, tocShown, panelShown, searchShown, convStarted, relocated, look, key, watchFrames, mouseChrome: () => desk() && !TOUCH.matches,
    columnChanged: () => (layout(), scrolled() && applyTypography(false)),
  };
})();

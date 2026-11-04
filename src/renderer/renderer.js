/* global ePub, marked, DOMPurify, extractContext */
const $ = (sel) => document.querySelector(sel);
const BOOK_EXT = /\.(epub|pdf|mobi|azw|azw3|azw4|prc|kfx|fb2|docx|rtf|odt|txt|htmlz|lit|pdb)$/i;

const THEMES = {
  light: { body: { background: "#ffffff", color: "#1d1d1f" } },
  sepia: { body: { background: "#f6efe0", color: "#3b2f1e" } },
  dark: { body: { background: "#1e1e20", color: "#dcdcdc" }, a: { color: "#8ab4f8" } },
};
// Turn 9 on a phone, turn 10 on a computer (Claude Design, 2026-11-02): paper, ink and ochre like Мої книжки; the
// book text in the dark theme a little dimmer than the interface. Selection and the passage open in a sheet or the
// panel get the design's colours.
const THEMES_PHONE = {
  light: { body: { background: "#f7f4ee", color: "#1b1a17" }, "::selection": { background: "#e9d3a3" } },
  sepia: { body: { background: "#f2e8d5", color: "#3a3024" }, "::selection": { background: "#e3cc9c" } },
  dark: { body: { background: "#1a1916", color: "#d9d2c5" }, a: { color: "#d9a35a" }, "::selection": { background: "#5a4526" } },
};
const DARK_QUERY = window.matchMedia("(prefers-color-scheme: dark)");
const resolvedTheme = () => {
  const theme = settings?.theme || "auto";
  return theme === "auto" ? (DARK_QUERY.matches ? "dark" : "light") : THEMES[theme] ? theme : "light";
};
const themeCss = (name) =>
  Object.entries(THEMES_PHONE[name])
    .map(([sel, rules]) => `${sel}{${Object.entries(rules).map(([k, v]) => `${k}:${v}`).join(";")}}`)
    .join("\n");

function applyTheme() {
  document.body.dataset.theme = resolvedTheme();
  rendition?.getContents().forEach(styleContents);
}
const FONTS = {
  literata: "'Literata Variable', Literata, Georgia, serif",
  georgia: "Georgia, 'Iowan Old Style', serif",
  publisher: null, // keep the book's own fonts
};
const FONT_CSS = ["wght.css", "wght-italic.css"].map(
  (f) => new URL(`../../node_modules/@fontsource-variable/literata/${f}`, location.href).href
);
// Book text a bit larger than browser default, closer to the Kindle apps at 100%: 19px on a phone, 21px on a
// computer (turn 10).
const BASE_SCALE = matchMedia("(max-width: 760px)").matches ? 1.2 : 1.3125;
// The passage whose explanation is open in the sheet or the panel (turns 9, 10): a see-through ochre over the text.
const highlightStyle = () =>
  document.body.dataset.theme === "dark" ? { fill: "#d9a35a", "fill-opacity": "0.24" } : { fill: "#cd9646", "fill-opacity": "0.3" };

// The explanations panel opens with the first explanation (a sheet on a phone, the right panel on a computer).
document.body.classList.add("panel-hidden");
let touchStart = null;
const PHONE = matchMedia("(max-width: 760px)");
// Touch screens wider than a phone (iPad): desktop layout, but finger-sized controls and the
// selection bar at the bottom, clear of the system Copy / Translate menu.
const TOUCH = matchMedia("(pointer: coarse)");
document.documentElement.classList.toggle("touch", TOUCH.matches);
TOUCH.addEventListener("change", () => document.documentElement.classList.toggle("touch", TOUCH.matches));
// iPad held upright: the panel would squeeze the book into a narrow column, so it waits for the first explanation.
if (TOUCH.matches && matchMedia("(orientation: portrait)").matches) document.body.classList.add("panel-hidden");
// Inside the iPhone app (app/App.js adds ChytaiApp to the user agent) rather than Safari.
const IN_APP = /ChytaiApp/.test(navigator.userAgent);
document.documentElement.classList.toggle("in-app", IN_APP);
let settings = {};
let settingsReady = null; // set at the bottom once the wiring is done
let book = null;
let rendition = null;
let pdfView = null; // set instead of book/rendition when a PDF is open
let current = null; // { path, title, author }

// Books a publisher lets us show only in the app: while one is on screen, the app blocks screenshots
// and screen recording (app/App.js: FLAG_SECURE on Android, a blank capture on iOS). Off on the home
// screen, so a reader can still screenshot the library or a list.
let appProtected = false;
let bookShown = false; // current is kept after closeBook(), so this says whether it is on screen
function syncAppProtection() {
  const on = bookShown && (settings.protectedBooks || []).includes(current.path) && !document.body.classList.contains("library-open");
  if (!IN_APP || on === appProtected) return;
  appProtected = on;
  try { window.ReactNativeWebView?.postMessage(JSON.stringify({ type: "protect", on })); } catch {}
}
new MutationObserver(syncAppProtection).observe(document.body, { attributes: true, attributeFilter: ["class"] });
// Leaving the reader page (login, a site page) must not leave the block on behind it.
addEventListener("pagehide", () => {
  bookShown = false;
  syncAppProtection();
});
let pendingSelection = null; // last selection, for the floating toolbar
let reqCounter = 0;
const conversations = new Map(); // request id -> conversation state

// ---------- Settings ----------

async function loadSettings() {
  settings = await window.reader.getSettings();
  document.body.dataset.margins = settings.margins || "normal";
  applyTheme();
}

function openSettings() {
  $("#set-key").value = "";
  $("#key-hint").textContent = settings.apiKeyFromEnv
    ? "Використовується ключ зі змінної середовища ANTHROPIC_API_KEY."
    : settings.hasApiKey
      ? "Ключ збережено. Залиште поле порожнім, щоб не змінювати."
      : "Створіть ключ на platform.claude.com → API Keys.";
  $("#set-theme").value = settings.theme || "auto";
  $("#set-model").value = settings.model;
  $("#set-margins").value = settings.margins || "normal";
  $("#set-language").value = settings.language;
  $("#set-font").value = settings.font;
  $("#set-page-taps").value = settings.pageTaps ? "taps" : "scroll";
  $("#set-desk-scroll").value = settings.deskScroll ? "scroll" : "pages";
  $("#settings").showModal();
}

$("#settings").addEventListener("close", async () => {
  if ($("#settings").returnValue !== "save") return;
  const patch = {
    theme: $("#set-theme").value,
    model: $("#set-model").value,
    language: $("#set-language").value.trim() || "українська",
    font: $("#set-font").value,
    margins: $("#set-margins").value,
    pageTaps: $("#set-page-taps").value === "taps",
    deskScroll: $("#set-desk-scroll").value === "scroll",
  };
  const key = $("#set-key").value.trim();
  if (key) patch.apiKey = key;
  const fontChanged = patch.font !== settings.font;
  const marginsChanged = patch.margins !== (settings.margins || "normal");
  const wasScrolled = scrolled();
  settings = await window.reader.setSettings(patch);
  if (wasScrolled !== scrolled()) return reopenBook();
  document.body.dataset.margins = settings.margins || "normal";
  applyTheme();
  if (marginsChanged) resizeView();
  if (fontChanged) applyTypography(true);
});
$("#btn-logout").onclick = () => window.reader.logout?.();
$("#btn-admin").onclick = () => (location.href = "/admin");
$("#btn-print").onclick = () => printBook();
$("#btn-search").onclick = () => window.BookSearch?.open();

// On a phone the book scrolls as one continuous column unless page turns were chosen in settings;
// on a computer it turns pages unless continuous scrolling was chosen.
function scrolled() {
  return PHONE.matches ? !settings.pageTaps : !!settings.deskScroll;
}

// Opens the current book again at the place we are reading, e.g. after switching scroll/pages.
async function reopenBook() {
  if (!current?.source || current.pdf) return;
  const latest = await window.reader.getSettings();
  openBook({ ...current.source, position: latest.positions[current.posKey] || null, reflowPosition: latest.positions[current.posKey] || null });
}

// A little tighter on a phone, where every line counts; 21/34 on a computer (turn 10).
function lineHeight() {
  return PHONE.matches ? 1.6 : 1.62;
}

// The text column on a computer (turn 10, «Колонка» in «Вигляд»): narrow, normal or wide.
const COLUMNS = { narrow: 560, normal: 640, wide: 760 };
function columnWidth() {
  return COLUMNS[settings.column] || COLUMNS.normal;
}

// Kindle-like typography: book font replaced, justified text with hyphenation, calm line spacing.
function typographyCss() {
  const family = FONTS[settings.font];
  const font = family
    ? `body, p, div, span, li, blockquote, a, em, i, b, strong, h1, h2, h3, h4, h5, h6 { font-family: ${family} !important; }`
    : "";
  return `${font}
    body { line-height: ${lineHeight()} !important; font-kerning: normal; text-rendering: optimizeLegibility;
      -webkit-font-smoothing: antialiased; font-optical-sizing: auto; }
    p, li, blockquote { line-height: inherit !important; }
    p { text-align: justify; hyphens: auto; -webkit-hyphens: auto; widows: 2; orphans: 2; }
    h1, h2, h3 { line-height: 1.3 !important; hyphens: manual; }
    pre, code, kbd, samp { font-family: ui-monospace, Menlo, monospace !important; }
    /* epub.js pads a scrolled page by 1/12 of its width; use the same side space as page mode instead. */
    ${scrolled() ? "body { padding-left: 14px !important; padding-right: 14px !important; }" : ""}
    ${scrolled() && !PHONE.matches ? `body { max-width: ${columnWidth() + 28}px !important; margin-left: auto !important; margin-right: auto !important; }` : ""}`;
}

function styleContents(contents) {
  const doc = contents.document;
  FONT_CSS.forEach((href) => {
    if (!doc.querySelector(`link[href="${href}"]`)) {
      const link = doc.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      doc.head.appendChild(link);
    }
  });
  let style = doc.getElementById("ai-reader-typography");
  if (!style) {
    style = doc.createElement("style");
    style.id = "ai-reader-typography";
    doc.head.appendChild(style);
  }
  style.textContent = typographyCss();
  // The book's colours live in one element whose text is replaced on every switch. epub.js themes
  // kept a stylesheet per theme in the frame and re-filled the older one, so after light → dark →
  // light the dark sheet still came later and won: the page stayed black until the next chapter.
  let colors = doc.getElementById("chytai-theme");
  if (!colors) {
    colors = doc.createElement("style");
    colors.id = "chytai-theme";
    doc.head.appendChild(colors);
  }
  colors.textContent = themeCss(resolvedTheme());
  if (!doc.documentElement.lang) doc.documentElement.lang = book?.packaging?.metadata?.language || "en";
}

function applyTypography(reflow) {
  if (!rendition) return;
  rendition.getContents().forEach(styleContents);
  const cfi = rendition.currentLocation()?.start?.cfi;
  if (reflow && cfi) rendition.display(cfi);
}

// ---------- Book ----------

async function openBook(payload) {
  await settingsReady;
  $("#notice").classList.add("hidden");
  // Explanations belong to the book they were asked in; reopening the same book (PDF view switch) keeps them.
  if (payload.path !== current?.path) clearExplanations();
  closeBook();
  hideSelToolbar(true);
  $("#empty").classList.add("hidden");
  // A PDF is read as a book (Max, 2026-11-01: no «Оригінал PDF» switch any more). New uploads already come as
  // EPUB; an older PDF is converted here once and kept. A scan without text opens as pages.
  if (/\.pdf$/i.test(payload.name)) {
    const epub = await reflowPdf(payload);
    if (epub) return openEpub({ ...payload, data: epub, position: payload.reflowPosition }, { posKey: `${payload.path}#reflow`, source: payload });
    return openPdf(payload);
  }
  return openEpub(payload, { posKey: payload.path, source: payload });
}

// PDF -> EPUB in the renderer (pdf.js text), cached on disk by the main process.
async function reflowPdf(payload) {
  const PdfView = await waitForPdfModule();
  const cached = await window.reader.reflowGet(payload.path, PdfView.REFLOW_VERSION);
  if (cached) return cached;
  showNotice("Готую текст PDF для читання…", true);
  try {
    const epub = await PdfView.reflow(payload.data, (n, total) => showNotice(`Готую текст PDF для читання… ${n} / ${total}`, true));
    window.reader.reflowPut(payload.path, PdfView.REFLOW_VERSION, epub);
    $("#notice").classList.add("hidden");
    return epub;
  } catch (err) {
    const scan = err.message === "NO_TEXT";
    if (!scan) showNotice(`Не вдалося перетворити PDF на текст, відкриваю сторінки.\n${err.message}`, false);
    else $("#notice").classList.add("hidden");
    return null;
  }
}

async function openEpub(payload, { posKey, source }) {
  $("#viewer").classList.remove("hidden");
  $("#pdf-container").classList.add("hidden");

  // A publisher's book comes chapter by chapter from the server (payload.url), any other as a whole file.
  book = payload.url ? ePub(payload.url, { openAs: "directory" }) : ePub(payload.data);
  book.spine.hooks.content.register(stripScripts);
  // Our typography goes into the chapter before epub.js lays it out and finds the target page.
  // The rendition's content hook runs only after that, so a jump into the middle of a chapter (a
  // contents entry, a saved position) was measured in the book's own styles and landed elsewhere
  // once line height and font changed.
  book.spine.hooks.content.register((doc) => styleContents({ document: doc }));
  current = { path: payload.path, posKey, source, title: payload.name.replace(/\.[^.]+$/, ""), author: "", protected: !!payload.url, preview: !!payload.preview };
  bookShown = true;
  syncAppProtection();

  window.DeskRead?.layout(false); // the column and the spread for this mode, before the first layout
  rendition = book.renderTo("viewer", {
    width: "100%",
    height: "100%",
    // A computer turns a spread of two 440px pages, 96px apart, once the window has room for it (turn 10, 10k).
    ...(scrolled() ? { flow: "scrolled", manager: "continuous" } : PHONE.matches ? { flow: "paginated", spread: "auto", minSpreadWidth: 960 } : { flow: "paginated", spread: "auto", minSpreadWidth: 1000, gap: 96 }),
    // WebKit (iOS Safari) does not run our touch/selection listeners inside an iframe sandboxed
    // without allow-scripts, so allow scripts and strip the book's own ones in stripScripts.
    allowScriptedContent: true,
  });
  followFontLoad(rendition);
  rendition.hooks.content.register(styleContents);
  rendition.hooks.content.register((contents) => contents.on("linkClicked", rememberReturn));
  if (current.protected) rendition.hooks.content.register(limitCopy);
  rendition.themes.fontSize(`${bookFontSize() * BASE_SCALE}%`);

  rendition.on("selected", onSelected);
  rendition.on("relocated", onRelocated);
  rendition.on("rendered", () => decorateNoteMarks());
  rendition.on("keyup", onKey);
  rendition.hooks.content.register((contents) => contents.document.addEventListener("wheel", onWheel, { passive: true }));
  // Keys pressed while the page has focus reach only the book's frame; pass them on.
  rendition.on("keydown", (e) => (onPrintKey(e), e.defaultPrevented || window.DeskRead?.key(e), e.defaultPrevented || window.Shell?.key(e), window.DeskRead?.escFull(e)));
  window.DeskRead?.watchFrames(rendition);
  rendition.on("click", (e) => {
    // A plain click inside the page clears the selection. Touch taps are handled in onTouchEnd:
    // iOS Safari does not deliver clicks on plain text to the iframe's document listener.
    setTimeout(() => {
      const sel = rendition.getContents()[0]?.window.getSelection();
      if (!sel || sel.isCollapsed) hideSelToolbar();
    }, 0);
  });
  rendition.on("touchstart", (e) => (touchStart = { x: e.changedTouches[0].screenX, y: e.changedTouches[0].screenY, t: Date.now() }));
  rendition.on("touchend", onTouchEnd);
  // Touch taps that clear a selection send no click, so watch the selection itself: once it is gone,
  // its toolbar fades out instead of lingering over the page.
  rendition.hooks.content.register((contents) => {
    contents.document.addEventListener("selectionchange", () => {
      clearTimeout(selGoneTimer);
      selGoneTimer = setTimeout(() => {
        const sel = contents.window.getSelection();
        if (!sel || sel.isCollapsed) hideSelToolbar();
      }, 150);
    });
  });
  syncReading();

  // epub.js drops its views on a resize and shows the page again only once a location is known.
  // A resize while the first page is still loading (the library closing, the phone toolbar
  // hiding) therefore left a blank book; show the opening position again in that case.
  const mine = rendition;
  rendition.on("resized", () => {
    if (rendition === mine && !mine.location?.start) mine.display(payload.position || undefined);
  });

  // display() lays the page out again once the book's fonts are in (followFontLoad); the first layout
  // flashed for a moment before it (Max, 2026-11-02). The page shows when the second one is done, or
  // after a second and a half if the fonts are slow.
  const viewer = $("#viewer");
  viewer.style.opacity = "0";
  const reveal = () => (viewer.style.opacity = "");
  const revealLate = setTimeout(reveal, 1500);
  try {
    await rendition.display(payload.position || undefined);
  } finally {
    clearTimeout(revealLate);
    reveal();
  }
  // The reading area may have been measured before the layout settled (first load, toolbar
  // hiding on a phone); a re-measure now re-renders only if the size actually changed.
  requestAnimationFrame(resizeView);
  loadNotes();
  loadChats();
  watchFirstPage();
  jumpIfPending();

  const meta = await book.loaded.metadata;
  current.title = meta.title || current.title;
  current.author = meta.creator || "";
  current.meta = meta;
  $("#book-title").textContent = current.author ? `${current.title} · ${current.author}` : current.title;
  $("#running-head").textContent = current.title;
  document.title = current.title;
  window.PhoneRead?.bookOpened();

  const nav = await book.loaded.navigation;
  renderToc(nav.toc);
  $("#btn-toc").disabled = false;
  $("#btn-print").classList.toggle("hidden", current.protected);
  $("#btn-search").classList.remove("hidden");

  // Page-accurate progress needs the locations index; build it in the background.
  book.locations.generate(1600).then(() => {
    book.locationsReady = true; // before this, length() counts only the chapters done so far
    const location = rendition?.currentLocation();
    updateProgress(location);
    if (current && location?.start) window.reader.savePosition(current.posKey, location.start.cfi, readingProgress(location));
    addTocPages(book).then(() => window.PhoneRead?.ticks());
  });
}

// Literata may still be loading when a chapter appears: the target page is then found in a
// fallback font and drifts away once the real one arrives (first open, a slow phone connection).
// So every jump looks for its target again after the fonts are in, unless the reader has turned
// the page since. Wrapping display() also covers epub.js's own re-display after a resize.
function followFontLoad(r) {
  let seq = 0;
  const display = r.display.bind(r);
  r.display = async (target) => {
    const mine = ++seq;
    await display(target);
    if (target && scrolled()) holdPlace(r, target, () => mine === seq);
    const fonts = r.getContents().map((c) => c.document.fonts);
    if (!target || fonts.every((f) => f.status === "loaded")) return;
    await Promise.all(fonts.map((f) => f.ready));
    if (mine === seq && rendition === r) await display(target);
  };
  for (const turn of ["next", "prev"]) {
    const go = r[turn].bind(r);
    r[turn] = () => (seq++, go());
  }
}

// Scroll mode: after a jump epub.js puts the previous chapter above the target and keeps the
// place by scrolling down as much as that chapter grows while it lays out. In WebKit (the iPhone
// app) that did not hold: Chapter 7 from the contents ended up in the second half of Chapter 6.
// So after a jump keep the target at the top ourselves until the chapters around it have settled
// (no correction needed for a second and a half) or the reader scrolls.
function holdPlace(r, target, current) {
  const container = r.manager?.container;
  const section = book?.spine.get(target);
  if (!container || !section) return;
  let stopped = false;
  const stop = () => (stopped = true);
  const events = ["wheel", "touchstart", "mousedown", "keydown"];
  events.forEach((e) => container.addEventListener(e, stop, { passive: true }));
  ["touchstart", "keydown"].forEach((e) => r.on(e, stop));
  const start = Date.now();
  let moved = start;
  const tick = () => {
    const now = Date.now();
    if (stopped || !current() || rendition !== r || now - moved > 1500 || now - start > 10000) {
      events.forEach((e) => container.removeEventListener(e, stop));
      ["touchstart", "keydown"].forEach((e) => r.off(e, stop));
      return;
    }
    const view = r.manager.views.find(section);
    if (view?.contents) {
      const inside = target.includes("#") || target.startsWith("epubcfi(") ? view.locationOf(target).top : 0;
      const top = Math.round(view.offset().top + inside);
      if (Math.abs(container.scrollTop - top) > 1) {
        container.scrollTop = top;
        moved = now;
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// epub.js throws from resize() until its stage exists (the book is still being parsed), and a
// resize with unchanged bounds is a no-op, so this is safe to call at any time.
function resizeView() {
  if (pdfView) pdfView.resize();
  else if (rendition?.manager?.stage) rendition.resize();
}

function closeBook() {
  $("#btn-print").classList.add("hidden");
  $("#btn-search").classList.add("hidden");
  // A failure while tearing down the previous book must never block opening the next one.
  for (const item of [rendition, book, pdfView]) {
    try {
      item?.destroy();
    } catch (err) {
      console.warn("close failed", err);
    }
  }
  rendition = book = pdfView = null;
  bookShown = false;
  syncAppProtection();
  returnCfi = null;
  $("#btn-back").classList.add("hidden");
  syncReading();
}

// ---------- Footnotes: a way back after following a link inside the book ----------

let returnCfi = null;

function rememberReturn() {
  // Still the page with the link: epub.js only starts moving after this event.
  const cfi = rendition?.currentLocation()?.start?.cfi;
  if (!cfi) return;
  returnCfi = cfi;
  $("#btn-back").classList.remove("hidden");
}

$("#btn-back").onclick = () => {
  if (returnCfi) rendition?.display(returnCfi);
  returnCfi = null;
  $("#btn-back").classList.add("hidden");
};

// ---------- Phone: full-height reading ----------
// While a book is on screen the toolbar is hidden; a tap in the middle of the page shows it.

function syncReading() {
  if (document.body.classList.contains("library-open")) hideSelToolbar(true); // the bar has no book to act on there
  const reading = !!(rendition || pdfView) && !document.body.classList.contains("library-open");
  if (reading === document.body.classList.contains("reading")) return;
  document.body.classList.toggle("reading", reading);
  document.body.classList.remove("chrome-shown");
  // The page area just changed height, so epub.js has to re-paginate.
  setTimeout(resizeView, 50);
}

function toggleChrome(show = !document.body.classList.contains("chrome-shown")) {
  if (!document.body.classList.contains("reading")) return;
  document.body.classList.toggle("chrome-shown", show);
  if (!show) $("#toc").classList.add("hidden");
  window.PhoneRead?.chrome(show);
}

// Escape hatch: when a chapter never renders (a broken book, a WebKit quirk), taps inside the page
// never reach us and the toolbar could not be brought back. The running head at the top and the
// bare page area outside the chapter frames still get taps, so a tap there shows the toolbar.
$("#running-head").addEventListener("click", () => toggleChrome(true));
const panelOverPage = () => PHONE.matches && (!document.body.classList.contains("panel-hidden") || !!window.PhoneRead?.sheetOpen());
$("#viewer").addEventListener("click", (e) => {
  if (panelOverPage()) return closeSheets();
  if (e.target.tagName !== "IFRAME") toggleChrome();
});

function closeSheets() {
  window.PhoneRead?.closeSheet();
  if (!document.body.classList.contains("panel-hidden")) showPanel(false);
}

// Original-layout PDFs scroll instead of paging, so any tap in the middle band toggles the toolbar.
$("#pdf-container").addEventListener("click", (e) => {
  const x = e.clientX / window.innerWidth;
  if (x > 0.25 && x < 0.75 && !e.target.closest("a")) toggleChrome();
});

new MutationObserver(syncReading).observe(document.body, { attributes: true, attributeFilter: ["class"] });
PHONE.addEventListener("change", syncReading);

async function waitForPdfModule() {
  while (!window.PdfView) await new Promise((r) => setTimeout(r, 50));
  return window.PdfView;
}

async function openPdf(payload) {
  $("#viewer").classList.add("hidden");
  $("#pdf-container").classList.remove("hidden");
  current = { path: payload.path, posKey: payload.path, source: payload, title: payload.name.replace(/\.[^.]+$/, ""), author: "", pdf: true };
  bookShown = true;
  syncAppProtection();
  const PdfView = await waitForPdfModule();
  pdfView = await PdfView.open($("#pdf-container"), payload.data, {
    position: payload.position,
    onPageChange: (page, total) => {
      window.reader.savePosition(current.posKey, `pdf:${page}`, { pct: Math.round((page / total) * 100), chapter: "" });
      $("#progress-label").textContent = `${page} / ${total}`;
      window.PhoneRead?.pdfPage(page, total);
      hideSelToolbar();
    },
  });
  pdfView.setZoom(bookFontSize());
  syncReading();
  const meta = await pdfView.metadata();
  current.title = meta.title || current.title;
  current.author = meta.author;
  $("#book-title").textContent = current.author ? `${current.title} · ${current.author}` : current.title;
  $("#running-head").textContent = current.title;
  $("#chapter-label").textContent = "";
  document.title = current.title;
  window.PhoneRead?.bookOpened();
  const toc = await pdfView.toc();
  renderToc(toc);
  $("#btn-toc").disabled = !toc.length;
  loadNotes();
  loadChats();
  jumpIfPending();
}

async function onPdfMouseUp() {
  // Let the browser finish updating the selection first.
  await new Promise((r) => setTimeout(r, 0));
  const sel = window.getSelection();
  if (!pdfView || !sel || sel.isCollapsed || !sel.rangeCount) return hideSelToolbar();
  const range = sel.getRangeAt(0);
  if (!$("#pdf-container").contains(range.commonAncestorContainer)) return;
  const text = range.toString().trim();
  if (!text) return;
  const ctx = await pdfView.extractContext(range);
  handleSelection(range, `pdf:${ctx.page}:${ctx.selection}`, { ...ctx, chapter: `сторінка ${ctx.page}` }, { top: 0, left: 0 });
}

function renderToc(items) {
  const list = $("#toc-list");
  list.innerHTML = "";
  const add = (entries, depth) => {
    entries.forEach((item) => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.textContent = item.label.trim();
      a.dataset.href = item.href;
      a.style.paddingLeft = `${12 + depth * 14}px`;
      a.onclick = () => {
        if (pdfView) pdfView.goTo(item.href);
        else rendition.display(item.href);
        $("#toc").classList.add("hidden");
        toggleChrome(false);
      };
      li.appendChild(a);
      list.appendChild(li);
      if (item.subitems?.length) add(item.subitems, depth + 1);
    });
  };
  add(items, 0);
}

// Page numbers are the ~1600-character chunks of the locations index, not screen pages,
// so they stay the same across font sizes, devices and scroll mode.
async function addTocPages(forBook) {
  const links = [...$("#toc-list").querySelectorAll("a[data-href]")];
  for (const a of links) {
    const [path, fragment] = a.dataset.href.split("#");
    const section = forBook.spine.get(path);
    if (!section) continue;
    let cfi;
    try {
      const doc = await section.load(forBook.load.bind(forBook));
      const el = (fragment && doc.getElementById(decodeURIComponent(fragment))) || doc.body || doc.documentElement;
      cfi = section.cfiFromElement(el);
    } catch {
      continue;
    }
    if (book !== forBook) return;
    const span = document.createElement("span");
    span.className = "toc-page";
    span.textContent = forBook.locations.locationFromCfi(cfi) + 1;
    a.appendChild(span);
  }
}

// Several contents entries can point into one file (a whole book in one file, chapters as anchors). Then
// the chapter is the last of them whose anchor comes before the place being read; without a place (search
// results) or the anchors, the first one. «Тигролови» showed «Розділ шостий» on page ten (Max, 2026-10-28).
function chapterTitle(href, cfi) {
  if (!book?.navigation || !href) return "";
  const base = href.split("#")[0];
  const found = [];
  const walk = (items) => {
    for (const item of items) {
      const file = item.href.split("#")[0];
      if (file.endsWith(base) || base.endsWith(file)) found.push(item);
      if (item.subitems?.length) walk(item.subitems);
    }
  };
  walk(book.navigation.toc);
  if (found.length < 2) return found[0]?.label.trim() || "";
  let range = null;
  try {
    range = cfi && rendition?.getRange(cfi);
  } catch {
    /* not laid out */
  }
  if (!range) return found[0].label.trim();
  const doc = range.startContainer.ownerDocument;
  const here = doc.createRange();
  here.setStart(range.startContainer, range.startOffset);
  let best = found[0];
  for (const item of found) {
    const frag = item.href.split("#")[1];
    if (!frag) continue;
    const el = doc.getElementById(decodeURIComponent(frag));
    if (!el) continue;
    const at = doc.createRange();
    at.setStartBefore(el);
    if (at.compareBoundaryPoints(Range.START_TO_START, here) <= 0) best = item;
  }
  return best.label.trim();
}

function onRelocated(location) {
  if (current) window.reader.savePosition(current.posKey, location.start.cfi, readingProgress(location));
  if (current?.protected) reportChapter(location.start?.index);
  updateProgress(location);
  // While scrolling, a selection may move off screen and back; its toolbar is pinned at the bottom anyway.
  if (!scrolled()) hideSelToolbar();
  // On a computer the mouse shows and hides the header (desk-read.js); a relayout must not take it away.
  if (!window.DeskRead?.mouseChrome()) toggleChrome(false);
}

// How far into the book and which chapter, for the home screen; nothing until the locations index exists.
function readingProgress(location) {
  // Outside the app a publisher's book is only its beginning, so a percentage would mislead.
  if (!book?.locations.length() || !location?.start || current?.preview) return undefined;
  return { pct: Math.round(book.locations.percentageFromCfi(location.start.cfi) * 100), chapter: chapterTitle(location.start.href, location.start.cfi), ...chapterNumber(location.start.index) };
}
// «розділ 8 з 23» on the home screen: the contents' top-level entries, the last one at or before this page.
function chapterNumber(spineIndex) {
  const top = (book?.navigation?.toc || []).map((t) => book.spine.get(t.href)?.index).filter((i) => Number.isInteger(i));
  if (top.length < 2 || !Number.isInteger(spineIndex)) return {};
  const part = top.filter((i) => i <= spineIndex).length;
  return part ? { part, parts: top.length } : {};
}

function updateProgress(location) {
  if (!location?.start) return;
  window.PhoneRead?.progress(location);
  $("#chapter-label").textContent = chapterTitle(location.start.href, location.start.cfi);
  if (book.locations.length() && !current?.preview) {
    $("#progress-label").textContent = `${Math.round(book.locations.percentageFromCfi(location.start.cfi) * 100)}%`;
  }
}

// A publisher's book: the chapter on screen counts for the publisher's report (server/protected.js); a
// chapter that was only measured or searched does not.
function reportChapter(index) {
  if (!Number.isInteger(index) || current.reported === index) return;
  current.reported = index;
  fetch("/api/pbook-read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: current.path, chapter: index }), credentials: "same-origin" }).catch(() => {});
}

// A publisher's book gives a quote to the clipboard, not whole chapters.
const COPY_MAX = 500;
function limitCopy(contents) {
  contents.document.addEventListener("copy", (e) => {
    const text = String(contents.window.getSelection() || "");
    if (text.length <= COPY_MAX) return;
    e.preventDefault();
    e.clipboardData?.setData("text/plain", text.slice(0, COPY_MAX));
  });
}

// Books never get to run code: drop <script> elements and inline on* handlers before rendering.
function stripScripts(doc) {
  for (const el of [...doc.querySelectorAll("*")]) {
    if (el.localName === "script") { el.remove(); continue; }
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.name) || /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
    }
  }
}

// Touch screens: swipe left/right to turn pages; a tap near the edge does the same.
// In scroll mode the finger scrolls the page, and any tap just shows or hides the toolbar.
function onTouchEnd(e) {
  if (!touchStart) return;
  const t = e.changedTouches[0];
  const dx = t.screenX - touchStart.x;
  const dy = t.screenY - touchStart.y;
  const ms = Date.now() - touchStart.t;
  touchStart = null;
  if (Math.abs(dx) >= 12 || Math.abs(dy) >= 12) fontPlace = null;
  const sel = rendition?.getContents()[0]?.window.getSelection();
  if (sel && !sel.isCollapsed) return;
  if (!scrolled() && ms < 600 && Math.abs(dx) >= 40 && Math.abs(dx) > Math.abs(dy)) {
    dx < 0 ? rendition?.next() : rendition?.prev();
  } else if (ms < 400 && Math.abs(dx) < 12 && Math.abs(dy) < 12 && !e.target?.closest?.("a")) {
    // On a phone a tap on the page puts the open panel away first (Max, 2026-11-01).
    if (panelOverPage()) return closeSheets();
    tapToPage(t, e.view);
  }
}

// The iframe is as wide as the whole chapter (one column per page), so translate the touch
// into page coordinates before deciding which edge was tapped.
function tapToPage(t, win) {
  const frame = win?.frameElement?.getBoundingClientRect();
  const box = $("#viewer").getBoundingClientRect();
  const x = t.clientX + (frame ? frame.left : 0) - box.left;
  if (scrolled()) toggleChrome();
  else if (x < box.width * 0.3) rendition?.prev();
  else if (x > box.width * 0.7) rendition?.next();
  else toggleChrome();
}

function onKey(e) {
  if (e.target?.closest?.("input, textarea, select, dialog")) return;
  if (document.body.classList.contains("library-open")) return; // the home screen covers the book
  // Esc stops an explanation still being written (Max, 2026-11-01).
  if (e.key === "Escape") {
    for (const conv of conversations.values()) if (conv.busy) window.reader.abort(conv.reqId);
    return;
  }
  const view = pdfView || rendition;
  if (!view) return;
  // In page mode the up/down arrows turn pages too; while scrolling they scroll.
  const paged = !scrolled();
  if (/^(Arrow|Page)|^ $/.test(e.key)) fontPlace = null; // moved on: a font change starts from here
  if (e.key === "ArrowLeft" || e.key === "PageUp" || (paged && e.key === "ArrowUp") || (e.key === " " && e.shiftKey)) view.prev();
  if (e.key === "ArrowRight" || e.key === "PageDown" || (paged && e.key === "ArrowDown") || (e.key === " " && !e.shiftKey)) view.next();
}

// Page mode on a computer: scrolling down with the mouse wheel or trackpad turns the page, as people
// expect it to. One turn per gesture: a trackpad keeps sending wheel events while it coasts.
let wheelQuietAt = 0;
function onWheel(e) {
  fontPlace = null;
  if (!rendition || scrolled() || document.body.classList.contains("library-open")) return;
  const now = Date.now();
  const busy = now < wheelQuietAt;
  const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
  if (!busy && Math.abs(d) < 4) return;
  wheelQuietAt = now + 250;
  if (busy) return;
  if (d > 0) rendition.next();
  else rendition.prev();
}

// ---------- Selection ----------

function onSelected(cfiRange, contents) {
  const sel = contents.window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const text = range.toString().trim();
  if (!text) return;

  const ctx = extractContext(contents.document, range);
  const chapter = chapterTitle(contents.section?.href || rendition.currentLocation()?.start?.href, cfiRange);
  handleSelection(range, cfiRange, { ...ctx, chapter }, contents.document.defaultView.frameElement.getBoundingClientRect());
}

// Shared by EPUB and PDF: remember the selection and show the toolbar; «Пояснити» there explains it.
// `frame` is the offset of the document holding the range (the epub iframe, or 0,0 for PDF).
function handleSelection(range, cfiRange, ctx, frame) {
  pendingSelection = {
    cfiRange,
    text: range.toString().trim(),
    context: { ...ctx, bookTitle: current.title, author: current.author },
  };
  const bar = $("#sel-toolbar");
  bar.classList.remove("mark");
  bar.querySelector('[data-action="translate"]').hidden = isUkrainian(pendingSelection.text);
  const quote = pendingSelection.text.replace(/\s+/g, " ");
  bar.querySelector(".st-quote").textContent = quote.length > 300 ? quote.slice(0, 300) + "…" : quote;
  // A new selection starts with an empty field; moving the ends of the one on screen keeps what is written.
  if (bar.classList.contains("hidden")) setAskField("");
  showSelToolbar(range, frame);
}

// The selection's question field: «Пояснити» asks for an explanation, a question turns it into «Запитати».
function setAskField(text) {
  const field = $("#st-q");
  field.value = text;
  syncAskField();
}
function syncAskField() {
  const has = !!$("#st-q").value.trim();
  const bar = $("#sel-toolbar");
  bar.classList.toggle("asking", has);
  bar.querySelector('[data-action="explain"] span').textContent = has ? "Запитати" : "Пояснити";
}
$("#st-q").addEventListener("input", syncAskField);
$("#st-q").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("#sel-toolbar [data-action=explain]").click();
  } else if (e.key === "Escape") {
    e.preventDefault();
    hideSelToolbar(true);
  }
});
// Typing a question takes the focus out of the book, and the browser may drop the selection there; the passage
// stays marked while the question is written.
let askMark = "";
$("#st-q").addEventListener("focus", () => {
  const cfi = pendingSelection?.cfiRange;
  if (!rendition || !cfi || !String(cfi).startsWith("epubcfi") || askMark === cfi) return;
  dropAskMark();
  try {
    rendition.annotations.highlight(cfi, {}, () => {}, "st-hl", highlightStyle());
    askMark = cfi;
    for (const c of rendition.getContents()) c.window.getSelection()?.removeAllRanges();
  } catch {
    /* cosmetic */
  }
});
function dropAskMark() {
  if (!askMark) return;
  try {
    rendition?.annotations.remove(askMark, "highlight");
  } catch {
    /* ignore */
  }
  askMark = "";
}
// The phone's keyboard covers the bottom of the screen: the card rides above it.
window.visualViewport?.addEventListener("resize", () => {
  const vv = window.visualViewport;
  const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  document.body.style.setProperty("--kb", `${Math.round(kb)}px`);
});

// No «Переклад» in Ukrainian books (Max, 2026-10-26): the book says so, or the text has і/ї/є/ґ.
function isUkrainian(text) {
  const lang = String(book?.packaging?.metadata?.language || "").toLowerCase();
  return lang.startsWith("uk") || /[іїєґ]/i.test(text);
}

function showSelToolbar(range, frame) {
  const rect = range.getBoundingClientRect();
  const bar = $("#sel-toolbar");
  bar.classList.remove("hidden");
  // A notice at the bottom (a guest's welcome, «Додано книжку») would cover the bar on a phone; it has
  // been read by now. An upload still running keeps its progress.
  if (!$("#notice").classList.contains("busy")) $("#notice").classList.add("hidden");
  // Phone (Safari and the app alike): the bar sits at the bottom of the screen (CSS), clear of
  // the system Copy / Translate menu, which the app cannot reliably hide either.
  // Desktop: above the selection, or below when there is no room.
  if (PHONE.matches) return bar.removeAttribute("style");
  if (TOUCH.matches) {
    // iPad: bottom of the page column (CSS), centred under the book rather than the whole window.
    const r = $("#reader").getBoundingClientRect();
    bar.removeAttribute("style");
    bar.style.left = `${r.left + r.width / 2}px`;
    return;
  }
  // The yellow's menu: over the start of the passage, ~10px above the line; under its end when there is no room
  // (turn 10, 10c). The question card (2026-11-03): under the selection, so it stays in sight; over it when the
  // card does not fit below.
  const first = range.getClientRects()[0] || rect;
  let top, left;
  if (bar.classList.contains("mark")) {
    const above = frame.top + first.top - bar.offsetHeight - 10;
    left = frame.left + first.left + Math.min(first.width, 200) / 2 - bar.offsetWidth / 2;
    top = Math.max(8, above < 8 ? frame.top + rect.bottom + 10 : above);
  } else {
    const below = frame.top + rect.bottom + 12;
    const above = frame.top + rect.top - bar.offsetHeight - 12;
    left = frame.left + first.left;
    top = below + bar.offsetHeight <= window.innerHeight - 8 ? below : Math.max(8, above);
  }
  bar.style.top = `${top}px`;
  bar.style.left = `${Math.min(Math.max(8, left), window.innerWidth - bar.offsetWidth - 8)}px`;
}

// A chapter that epub.js reports as displayed can still come up blank (seen in the iPhone app).
// Say so after a moment, with the way out, instead of a silent white screen.
function watchFirstPage() {
  const mine = rendition;
  setTimeout(() => {
    if (!rendition || rendition !== mine) return;
    const doc = rendition.getContents()[0]?.document;
    const shown = doc?.body && (doc.body.scrollHeight > 0 || doc.body.textContent.trim());
    if (shown) return;
    showNotice("Сторінка не відобразилась. Тапніть назву книжки вгорі, щоб повернутись у бібліотеку.", false);
  }, 4000);
}

let selGoneTimer = 0;
// force: the book closed or the reader said so (Esc, a question sent); otherwise a question being written or
// dictated keeps the card, though the selection it came from is gone.
function hideSelToolbar(force) {
  const bar = $("#sel-toolbar");
  // The tap that opened the yellow's menu also looks like a click that clears the selection.
  if (bar.classList.contains("mark") && Date.now() - markShownAt < 400) return;
  if (force !== true && !bar.classList.contains("hidden") && !bar.classList.contains("mark") && (document.activeElement === $("#st-q") || window.Dictation?.field() === "st-q")) return;
  if (window.Dictation?.field() === "st-q") window.Dictation.stop();
  if (document.activeElement === $("#st-q")) $("#st-q").blur();
  bar.classList.add("hidden");
  dropAskMark();
}

// A click on the card keeps the selection in the book; the question field takes the focus as usual.
$("#sel-toolbar").addEventListener("mousedown", (e) => e.target.closest("textarea") || e.preventDefault());
$("#sel-toolbar").addEventListener("click", (e) => {
  const action = e.target.closest("[data-action]")?.dataset.action;
  if (!action) return;
  if ($("#sel-toolbar").classList.contains("mark")) return onMarkAction(action);
  if (!pendingSelection) return;
  if (action === "mic") return window.Dictation.toggle("st-q", "#sel-toolbar .st-mic", dictationTidy);
  const snapshot = pendingSelection;
  const question = $("#st-q").value.trim();
  // A free book read without an account: explanations and notes come with one (they cost Max tokens).
  if (settings.free) {
    hideSelToolbar();
    showNotice("Пояснення, питання і нотатки працюють після входу. Це безкоштовно, потрібна лише пошта.", false);
    return noticeLink(settings.free.signIn, "Увійти");
  }
  hideSelToolbar(true);
  try {
    for (const c of rendition?.getContents?.() || []) c.window.getSelection()?.removeAllRanges();
  } catch {
    /* ignore */
  }
  if (action === "note") {
    // A question written but kept as a note: it becomes the note's thought.
    addNote({ ...snapshot, comment: question });
  } else {
    startExplanation(snapshot, { mode: action === "translate" ? "translate" : "explain", question: action === "translate" ? "" : question });
  }
});

// Dictated words tidied with this book's title (dictation.js).
const dictationTidy = (said) => (window.reader.tidy && current && !settings.free ? window.reader.tidy(current.title, current.author, said) : said);

function onMarkAction(action) {
  const conv = pendingMark;
  markShownAt = 0;
  hideSelToolbar();
  if (!conv) return;
  if (action === "open") return openConvCard(conv);
  // A note takes the yellow's place: its own bars or underline mark the passage from now on.
  unhighlightConv(conv);
  if (action === "mark-note") addNote({ cfiRange: conv.cfiRange, text: conv.context.selection, context: conv.context });
}

// ---------- Explanations panel ----------

function md(text) {
  return DOMPurify.sanitize(marked.parse(text || ""));
}

function modelLabel(model) {
  return (model || "")
    .replace(/^claude-/, "")
    .replace(/-(\d+)-(\d+)$/, " $1.$2")
    .replace(/-(\d+)$/, " $1")
    .replace(/^./, (c) => c.toUpperCase());
}

// «Пояснити» explains on the main model; «Переклад» only translates, on the cheaper one.
function startExplanation(selection, { mode = "explain", question = "" } = {}) {
  showPanel(true, "cards");

  // Same selection already explained: just bring that card into view. A question about it is a new one.
  for (const conv of question ? [] : conversations.values()) {
    if ((conv.cfiRange === selection.cfiRange || conv.context.selection === selection.context.selection) && conv.mode === mode) {
      highlightConv(conv);
      window.PhoneRead?.showConv(conv);
      conv.card.scrollIntoView({ behavior: "smooth", block: "nearest" });
      flash(conv.card);
      return conv.card;
    }
  }

  const conv = makeConv({ cfiRange: selection.cfiRange, context: selection.context, mode });
  // The new card is at the top; bring it into view even if the list was scrolled down.
  $("#panel-body").scrollTop = 0;
  highlightConv(conv);
  window.PhoneRead?.convStarted(conv);
  runTurn(conv, question || null);
  return conv.card;
}

// A card in the panel with its talk. New ones and kept ones (reopening the book) are made the same way.
function makeConv({ cfiRange, context, mode, sid: keptId }) {
  const id = `r${++reqCounter}`;
  const card = document.createElement("article");
  card.className = mode === "translate" ? "card translation" : "card";
  card.dataset.id = id;
  const quote = context.selection || "";
  card.innerHTML = `
    <blockquote class="quote"></blockquote>
    <div class="thread"></div>
    <div class="meta"><span class="model"></span>
      <span class="actions">
        <button class="link more hidden" title="Пояснити детальніше">Детальніше</button>
        <button class="link stop hidden">Зупинити</button>
        <button class="link retry hidden">Ще раз</button>
      </span>
    </div>
    <div class="c-acts"><span class="where"></span><button type="button" class="link c-note hidden">В нотатки</button><button type="button" class="link forget hidden">Видалити</button></div>
    <form class="followup"><input type="text" placeholder="Уточнити…" enterkeyhint="send" /><button type="submit" class="ask" aria-label="Запитати"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg></button></form>`;
  card.querySelector(".quote").textContent = quote.length > 280 ? quote.slice(0, 280) + "…" : quote;
  if (!quote) card.classList.add("c-book"); // a question about the book, no passage
  $("#q-head").after(card);

  // sid: the id it is kept under on the server; turns: [{ q, a }] answered so far.
  const sid = keptId || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const conv = { id, sid, card, mode, cfiRange, context, messages: null, turns: [], at: Date.now(), busy: false };
  conversations.set(id, conv);

  card.querySelector(".forget").onclick = () => forgetConv(conv);
  // «Запитання» (2026-11-03): a folded question opens in its place; «До тексту» goes to its passage (or the page
  // it was asked on), «В нотатки» keeps the passage.
  card.addEventListener("click", (e) => {
    if (!card.classList.contains("m-off") || e.target.closest("button, a, input, form")) return;
    openConvCard(conv);
    highlightConv(conv);
  });
  // The chapter · page line takes you to the passage (Max 2026-11-03: no «До тексту» button).
  card.querySelector(".c-acts .where").onclick = (e) => {
    if (!e.currentTarget.classList.contains("c-go")) return;
    e.stopPropagation();
    goToConv(conv);
  };
  card.querySelector(".c-note").onclick = () =>
    addNote({ cfiRange: conv.cfiRange, text: conv.context.selection, context: conv.context }).then(() => syncConvActs(conv));
  syncConvActs(conv);
  queueMicrotask(listCards);
  card.querySelector(".followup input").oninput = (e) => card.querySelector(".followup").classList.toggle("filled", !!e.target.value.trim());

  card.querySelector(".stop").onclick = () => window.reader.abort(conv.reqId);
  card.querySelector(".more").onclick = () => {
    if (conv.busy || !conv.messages) return;
    card.querySelector(".more").classList.add("hidden");
    runTurn(conv, "Детальніше");
  };
  card.querySelector(".retry").onclick = () => {
    // The failed turn never reached conv.messages, so only its DOM needs undoing.
    const thread = conv.card.querySelector(".thread");
    thread.lastElementChild?.remove();
    if (conv.lastQuestion) thread.lastElementChild?.remove();
    runTurn(conv, conv.lastQuestion);
  };
  card.querySelector(".followup").onsubmit = (e) => {
    e.preventDefault();
    const input = card.querySelector(".followup input");
    const q = input.value.trim();
    if (!q || conv.busy) return;
    input.value = "";
    card.querySelector(".followup").classList.remove("filled");
    runTurn(conv, q);
    window.PhoneRead?.sheetFull();
  };

  if (mode === "translate") card.querySelector(".followup input").placeholder = "Запитати про переклад…";
  return conv;
}

function runTurn(conv, question) {
  conv.lastQuestion = question;
  const thread = conv.card.querySelector(".thread");
  if (question) {
    const q = document.createElement("div");
    q.className = "question";
    q.textContent = question;
    thread.appendChild(q);
  }
  const answer = document.createElement("div");
  answer.className = "answer streaming";
  answer.innerHTML = `<span class="dots"><i></i><i></i><i></i></span>`;
  thread.appendChild(answer);

  let request;
  if (!conv.messages) {
    request = { context: { ...conv.context, question: question || undefined }, mode: conv.mode };
  } else {
    request = { messages: [...conv.messages, { role: "user", content: question }], mode: conv.mode };
  }

  const reqId = `${conv.id}-${Date.now()}`;
  conv.reqId = reqId;
  conv.busy = true;
  conv.answerEl = answer;
  conv.text = "";
  setBusy(conv, true);
  window.reader.explain(reqId, request);
}

function setBusy(conv, busy) {
  conv.card.querySelector(".stop").classList.toggle("hidden", !busy);
  conv.card.querySelector(".retry").classList.add("hidden");
  if (busy) conv.card.querySelector(".more").classList.add("hidden");
  conv.card.querySelector(".followup input").disabled = busy;
}

window.reader.onAiEvent((reqId, ev) => {
  const conv = [...conversations.values()].find((c) => c.reqId === reqId);
  if (!conv) return;
  const el = conv.answerEl;
  if (ev.type === "text") {
    conv.text += ev.text;
    el.innerHTML = md(conv.text);
    return;
  }
  conv.busy = false;
  setBusy(conv, false);
  el.classList.remove("streaming");
  if (ev.type === "done") {
    conv.messages = ev.messages;
    if (conv.text) {
      conv.turns.push({ q: conv.lastQuestion || "", a: conv.text });
      conv.model = ev.model || "";
      saveConv(conv);
    }
    conv.card.querySelector(".forget").classList.remove("hidden");
    // One "more detail" per card: after it, the follow-up field is the way to ask further.
    if (conv.mode !== "translate" && conv.lastQuestion !== "Детальніше") conv.card.querySelector(".more").classList.remove("hidden");
    conv.card.querySelector(".model").textContent = (conv.mode === "translate" ? "Переклад · " : "") + modelLabel(ev.model) + (ev.truncated ? " · обрізано" : "");
    if (!conv.text) el.innerHTML = `<em>Порожня відповідь.</em>`;
  } else if (ev.type === "aborted") {
    if (!conv.text) el.innerHTML = `<em>Зупинено.</em>`;
    conv.card.querySelector(".retry").classList.remove("hidden");
  } else if (ev.type === "error") {
    el.innerHTML = "";
    const err = document.createElement("div");
    err.className = "error";
    err.textContent = ev.message;
    el.appendChild(err);
    conv.card.querySelector(".retry").classList.remove("hidden");
    if (/налаштуваннях/.test(ev.message)) openSettings();
  }
});

function flash(card) {
  card.classList.remove("flash");
  void card.offsetWidth;
  card.classList.add("flash");
}

// Phone: the explanations sheet is resized by dragging its header; the height is remembered on this device.
// Dragging it down past the lowest height, or flicking it down, puts it away like an iOS sheet.
(() => {
  const head = $("#panel .panel-head");
  const panel = $("#panel");
  const MIN = 0.15, MAX = 0.85;
  const clamp = (f) => Math.min(MAX, Math.max(MIN, f));
  const setTop = (f) => document.body.style.setProperty("--panel-top", `${(f * 100).toFixed(1)}%`);
  let rest = 0.6; // the height the sheet comes back at
  try {
    const saved = Number(localStorage.getItem("panelTop"));
    if (saved) rest = clamp(saved);
  } catch {}
  setTop(rest);
  let drag = null;
  head.addEventListener("pointerdown", (e) => {
    if (!PHONE.matches || e.target.closest("button")) return;
    const box = $("#layout").getBoundingClientRect();
    drag = { box, id: e.pointerId, y: e.clientY, t: e.timeStamp, v: 0 };
    panel.classList.add("dragging");
    head.setPointerCapture(e.pointerId);
  });
  head.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dt = e.timeStamp - drag.t;
    if (dt > 0) drag.v = (e.clientY - drag.y) / dt; // px per ms, positive is down
    drag.y = e.clientY;
    drag.t = e.timeStamp;
    drag.f = (e.clientY - drag.box.top) / drag.box.height;
    // Below the lowest height the sheet follows the finger off the screen; above the top it stops.
    setTop(drag.f > MAX ? drag.f : clamp(drag.f));
  });
  const end = (e) => {
    if (!drag) return;
    panel.classList.remove("dragging");
    const { f, v } = drag;
    drag = null;
    if (!f) return;
    if (e.type === "pointerup" && (f > MAX + 0.04 || (v > 0.8 && f > rest))) {
      // Put away: it slides down from where the finger left it, and opens next time at its old height.
      showPanel(false);
      setTimeout(() => setTop(rest), 260);
      return;
    }
    rest = clamp(f);
    setTop(rest);
    try { localStorage.setItem("panelTop", String(rest)); } catch {}
  };
  head.addEventListener("pointerup", end);
  head.addEventListener("pointercancel", end);
})();

// The yellow marks only the explanation being read. Once its card is out of sight (the panel closed, the
// Notes tab, a newer explanation) the yellow goes and a small asterisk after the passage stays, like a
// footnote: a tap on it opens the explanation again (Max, 2026-10-27: «прибирати автоматично, але залишати
// asterisk як типу сноску»). A tap on the yellow offers the explanation, a note or removing it.
function highlightConv(conv) {
  if (!conv.context.selection || !String(conv.cfiRange).startsWith("epubcfi")) return;
  for (const other of conversations.values()) if (other !== conv && other.marked === "yellow") starConv(other);
  try {
    unhighlightConv(conv);
    rendition.annotations.highlight(conv.cfiRange, { id: conv.id }, () => showMarkToolbar(conv), "ai-hl", highlightStyle());
    conv.marked = "yellow";
  } catch {
    /* highlighting is cosmetic */
  }
}

function starConv(conv) {
  unhighlightConv(conv);
  if (!conv.context.selection || !String(conv.cfiRange).startsWith("epubcfi")) return;
  // A note on the very same words already marks them (and shares the annotation's key).
  if (notes.some((n) => n.cfi === conv.cfiRange)) return;
  try {
    rendition.annotations.underline(conv.cfiRange, { id: conv.id }, () => {
      highlightConv(conv);
      openConvCard(conv);
    }, "ai-star");
    conv.marked = "star";
    decorateNoteMarks();
  } catch {
    /* cosmetic too */
  }
}

function unhighlightConv(conv) {
  try {
    if (conv.marked === "yellow") rendition?.annotations.remove(conv.cfiRange, "highlight");
    if (conv.marked === "star") rendition?.annotations.remove(conv.cfiRange, "underline");
  } catch {
    /* ignore */
  }
  conv.marked = "";
}

function unhighlightConvs() {
  for (const conv of conversations.values()) unhighlightConv(conv);
}

// Panel closed or on another tab: the yellow turns into asterisks.
function starConvs() {
  for (const conv of conversations.values()) if (conv.marked === "yellow") starConv(conv);
}

let pendingMark = null; // the explanation whose yellow was tapped, for the toolbar
let markShownAt = 0;
function showMarkToolbar(conv) {
  let range;
  try {
    range = rendition.getRange(conv.cfiRange);
  } catch {
    /* fall back to opening the card */
  }
  // A click on a mark opens it in the sheet or the panel (turns 9, 10).
  if (!range || PHONE.matches || !TOUCH.matches) return openConvCard(conv);
  pendingMark = conv;
  markShownAt = Date.now();
  const bar = $("#sel-toolbar");
  bar.classList.add("mark");
  bar.querySelector('[data-action="open"]').textContent = conv.mode === "translate" ? "Переклад" : "Пояснення";
  showSelToolbar(range, range.startContainer.ownerDocument.defaultView.frameElement.getBoundingClientRect());
}

function openConvCard(conv) {
  showPanel(true, "cards");
  window.PhoneRead?.showConv(conv);
  conv.card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  flash(conv.card);
}

function showPanel(show, tab) {
  document.body.classList.toggle("panel-hidden", !show);
  if (tab) showTab(tab);
  window.PhoneRead?.panelShown(show);
  if (!show) starConvs();
  // epub.js needs a resize to reflow pages after the layout changes width.
  setTimeout(resizeView, 220);
}

function clearExplanations() {
  for (const conv of conversations.values()) if (conv.busy) window.reader.abort(conv.reqId);
  unhighlightConvs();
  conversations.clear();
  for (const c of $("#cards").querySelectorAll(".card")) c.remove();
  cardsAll = false;
  listCards();
}

// «Очистити» in the panel: the book's kept explanations go too.
$("#btn-clear").onclick = () => {
  if (current && window.reader.chatsClear) window.reader.chatsClear(current.path).catch(() => {});
  clearExplanations();
};

// Phone: «Очистити розмову» at the end of one explanation removes it and its mark in the text.
function forgetConv(conv) {
  if (conv.busy) window.reader.abort(conv.reqId);
  unhighlightConv(conv);
  conversations.delete(conv.id);
  conv.card.remove();
  if (current && conv.turns.length) window.reader.chatDelete?.(current.path, conv.sid).catch(() => {});
  listCards();
  renderNotes();
}

// ---------- «Запитання»: the list in the panel (2026-11-03, like a paper book's questions) ----------

// The open question on top of the others, then the last three folded and «Показати всі N» for the rest.
let cardsAll = false;
function listCards() {
  const cards = [...$("#cards").querySelectorAll(".card")];
  let folded = 0;
  let open = null;
  for (const c of cards) {
    // One question open at a time, as on a paper book's page; any other open one folds (Max 2026-11-03: he saw ~10).
    if (!c.classList.contains("m-off")) {
      if (!open) open = c;
      else c.classList.add("m-off");
    }
    const off = c.classList.contains("m-off");
    if (off) folded++;
    c.classList.toggle("c-more", !cardsAll && off && folded > 3);
  }
  const more = $("#cards-more");
  const hidden = cards.filter((c) => c.classList.contains("c-more")).length;
  more.textContent = `Показати всі ${cards.length}`;
  more.classList.toggle("hidden", !hidden);
  $("#panel-empty").classList.toggle("hidden", cards.length > 0);
  for (const conv of conversations.values()) syncConvActs(conv);
  $("#q-head").innerHTML = `Запитання${cards.length ? ` · ${cards.length}` : ""}`;
  window.PhoneRead?.notesCount();
  window.PhoneRead?.syncPanelHead?.();
}
$("#cards-more").onclick = () => ((cardsAll = true), listCards());

function syncConvActs(conv) {
  const card = conv.card;
  const saved = notes.some((n) => n.cfi === conv.cfiRange);
  card.querySelector(".c-note").classList.toggle("hidden", !conv.context.selection || saved || !String(conv.cfiRange).startsWith("epubcfi"));
  card.querySelector(".c-acts .where").classList.toggle("c-go", !(!conv.cfiRange || !String(conv.cfiRange).startsWith("epubcfi") || !rendition));
}

// To the passage (or the page a book question was asked on); a phone puts the list away to show it.
function goToConv(conv) {
  if (!rendition || !String(conv.cfiRange).startsWith("epubcfi")) return;
  if (PHONE.matches) showPanel(false);
  rememberReturn();
  rendition.display(conv.cfiRange).then(() => highlightConv(conv)).catch(() => {});
}

// What is on the screen and just before it, for a question about the book.
function pageContext() {
  try {
    const loc = rendition?.currentLocation?.();
    if (!loc?.start) return {};
    const contents = rendition.getContents().find((c) => c.sectionIndex === loc.start.index) || rendition.getContents()[0];
    const doc = contents.document;
    const a = rendition.getRange(loc.start.cfi);
    let b = null;
    try {
      b = loc.end?.index === loc.start.index ? rendition.getRange(loc.end.cfi) : null;
    } catch {
      /* the end is in another chapter */
    }
    const r = doc.createRange();
    r.setStart(a.startContainer, a.startOffset);
    if (b) r.setEnd(b.endContainer, b.endOffset);
    else r.setEnd(doc.body, doc.body.childNodes.length);
    const ctx = extractContext(doc, r);
    return { page: ctx.selection.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim().slice(0, 5000), before: ctx.before };
  } catch {
    return {};
  }
}

// «Запитати» (the bottom bar on a phone, the header or Q on a computer): the list, its field ready.
function openAsk() {
  if (!current) return;
  showPanel(true, "cards");
  window.PhoneRead?.sheetFull();
  $("#panel-body").scrollTop = 0;
  setTimeout(() => $("#ab-q").focus(), PHONE.matches ? 0 : 60);
}

function askBook(question) {
  if (!current || !question) return;
  if (settings.free) {
    showNotice("Пояснення, питання і нотатки працюють після входу. Це безкоштовно, потрібна лише пошта.", false);
    return noticeLink(settings.free.signIn, "Увійти");
  }
  const loc = rendition?.currentLocation?.();
  const cfiRange = loc?.start?.cfi || (pdfView ? `pdf:${pdfView.viewer.currentPageNumber}` : "");
  const chapter = $("#chapter-label").textContent.trim();
  const conv = makeConv({ cfiRange, context: { selection: "", ...pageContext(), chapter, bookTitle: current.title, author: current.author }, mode: "explain" });
  window.PhoneRead?.convStarted(conv);
  runTurn(conv, question);
  listCards();
}

$("#ask-book").addEventListener("submit", (e) => {
  e.preventDefault();
  const field = $("#ab-q");
  const q = field.value.trim();
  if (!q) return field.focus();
  if (window.Dictation?.field() === "ab-q") window.Dictation.stop();
  field.value = "";
  field.blur();
  askBook(q);
});
$("#ab-q").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) e.preventDefault(), $("#ask-book").requestSubmit();
});
// «+ Нотатка»: a thought of the reader's own, kept at the page on screen.
function noteForm(open) {
  const form = $("#note-form");
  if (!open) window.Dictation.field() === "nf-text" && window.Dictation.stop();
  form.classList.toggle("hidden", !open);
  if (open) setTimeout(() => $("#nf-text").focus(), 30);
}
$("#note-add").onclick = () => noteForm($("#note-form").classList.contains("hidden"));
$("#note-form .nf-mic").onclick = () => window.Dictation.toggle("nf-text", "#note-form .nf-mic", dictationTidy);
$("#note-form").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("#nf-text").value.trim();
  if (!text || !current) return;
  const at = rendition?.currentLocation?.()?.start?.cfi || "";
  const note = { cfi: `mine:${Date.now().toString(36)}:${at}`, posKey: current.posKey, text, chapter: $("#chapter-label")?.textContent.trim() || "" };
  try {
    const saved = await notesStore.notesAdd(current.path, note);
    if (!notes.some((n) => n.id === saved.id)) notes.push(saved);
    $("#nf-text").value = "";
    noteForm(false);
    renderNotes();
  } catch (err) {
    if (err.message !== "login") showNotice(`Не вдалося зберегти нотатку: ${err.message}`, false);
  }
};
$("#ask-book .ab-mic").onclick = () => window.Dictation.toggle("ab-q", "#ask-book .ab-mic", dictationTidy);

// ---------- Kept explanations (Max 2026-11-03: saved like a paper book's questions) ----------

// Every answered turn keeps the card on the server, with the talk so far for follow-ups after a reopen.
function saveConv(conv) {
  if (!current || !window.reader.chatSave) return;
  conv.at = Date.now();
  window.reader
    .chatSave(current.path, {
      id: conv.sid, cfi: conv.cfiRange, posKey: current.posKey, mode: conv.mode, sel: conv.context.selection || "",
      chapter: conv.context.chapter || "", turns: conv.turns, messages: conv.messages, model: conv.model || "", at: conv.at,
    })
    .catch(() => {});
}

// Reopening the book: the kept cards come back (newest on top) and their passages get the asterisk.
async function loadChats() {
  const path = current?.path;
  if (!path || !window.reader.chatsList) return;
  let list;
  try {
    list = await window.reader.chatsList(path);
  } catch {
    return;
  }
  if (current?.path !== path || !list?.length) return;
  const have = new Set([...conversations.values()].map((c) => c.sid));
  const reachable = (c) => (c.cfi.startsWith("pdf:") ? !!pdfView : !!rendition && (c.posKey || path) === current.posKey);
  const kept = list.filter((c) => !have.has(c.id) && reachable(c)).sort((a, b) => (a.at || 0) - (b.at || 0));
  if (!kept.length) return;
  const none = !have.size;

  for (const c of kept) {
    const conv = makeConv({ cfiRange: c.cfi, context: { selection: c.sel, chapter: c.chapter, bookTitle: current.title, author: current.author }, mode: c.mode, sid: c.id });
    conv.turns = c.turns || [];
    conv.messages = c.messages || null;
    conv.model = c.model || "";
    conv.at = c.at || 0;
    const thread = conv.card.querySelector(".thread");
    conv.turns.forEach((t) => {
      if (t.q) thread.insertAdjacentHTML("beforeend", `<div class="question"></div>`), (thread.lastElementChild.textContent = t.q);
      thread.insertAdjacentHTML("beforeend", `<div class="answer">${md(t.a)}</div>`);
    });
    conv.card.querySelector(".where").textContent = [c.chapter, c.at ? new Date(c.at).toLocaleDateString("uk-UA", { day: "numeric", month: "long" }) : ""].filter(Boolean).join(" · ");
    conv.card.querySelector(".forget").classList.remove("hidden");
    if (conv.mode !== "translate" && !conv.turns.some((t) => t.q === "Детальніше")) conv.card.querySelector(".more").classList.remove("hidden");
    conv.card.querySelector(".model").textContent = (conv.mode === "translate" ? "Переклад · " : "") + modelLabel(conv.model);
    conv.card.classList.add("m-off"); // a phone shows one explanation at a time
    if (!c.cfi.startsWith("pdf:")) starConv(conv);
  }
  // The panel shows one explanation at a time: the newest kept one, until another is opened.
  if (none) window.PhoneRead?.showConv([...conversations.values()].pop());
  listCards();
  showPendingChat();
}

// ---------- Notes: passages saved with "Зберегти", per reader and per book ----------

// The web bridge keeps notes on the server; the Mac app keeps them in this window's storage.
const notesStore = window.reader.notesList
  ? window.reader
  : (() => {
      const key = (bookPath) => `notes:${bookPath}`;
      const read = (bookPath) => {
        try {
          return JSON.parse(localStorage.getItem(key(bookPath))) || [];
        } catch {
          return [];
        }
      };
      const write = (bookPath, list) => localStorage.setItem(key(bookPath), JSON.stringify(list));
      return {
        notesList: async (bookPath) => read(bookPath),
        notesAdd: async (bookPath, note) => {
          const list = read(bookPath);
          const saved = list.find((n) => n.cfi === note.cfi) || { ...note, id: `n${Date.now()}`, comment: "", createdAt: Date.now() };
          if (!list.includes(saved)) write(bookPath, [...list, saved]);
          return saved;
        },
        notesUpdate: async (bookPath, id, patch) => write(bookPath, read(bookPath).map((n) => (n.id === id ? { ...n, ...patch } : n))),
        notesDelete: async (bookPath, id) => write(bookPath, read(bookPath).filter((n) => n.id !== id)),
      };
    })();

let notes = []; // notes of the open book, oldest first

// One panel like a paper book's page (Max 2026-11-03): the question field and «Запитання» on top, «Нотатки» under
// them. A «tab» is now where the panel is scrolled to: the top, or the notes (a note opened from the text).
let lastTab = "cards";
const panelTab = () => "cards";
function showTab(tab) {
  lastTab = tab;
  $("#btn-clear").classList.add("hidden");
  requestAnimationFrame(() => document.querySelectorAll(".note-comment").forEach(fitComment));
}

const notesTabShown = () => !document.body.classList.contains("panel-hidden") && lastTab === "notes";

async function loadNotes() {
  const path = current?.path;
  notes = [];
  renderNotes();
  if (!path) return;
  try {
    const list = await notesStore.notesList(path);
    if (current?.path !== path) return;
    notes = list;
  } catch (err) {
    console.warn("could not load notes", err);
  }
  renderNotes();
  notes.forEach(markNote);
}

// Notes taken in one view of a PDF (as a book, or the original pages) only point into that view.
function noteReachable(note) {
  if (note.cfi.startsWith("pdf:")) return !!pdfView;
  return !!rendition && (note.posKey || current.path) === current.posKey;
}

// A note in the reader's own words («+ Нотатка», 2026-11-03) has no passage: its cfi is «mine:<id>:<the page's cfi>»,
// unique so that two thoughts on one page stay two notes, and nothing is drawn in the text for it.
const isMine = (note) => String(note?.cfi || "").startsWith("mine:");
const noteTarget = (note) => (isMine(note) ? note.cfi.split(":").slice(2).join(":") : note.cfi);

function markNote(note) {
  if (!rendition || !noteReachable(note) || isMine(note)) return;
  try {
    rendition.annotations.underline(note.cfi, { note: note.id }, () => openNote(note.id), "note-ul");
    decorateNoteMarks();
  } catch {
    /* marking is cosmetic */
  }
}

// epub.js draws a note as an underline mark (an SVG group over the page, with a rect per line);
// we draw a bar in each margin alongside those lines instead.
// The mark redraws itself on every relayout, so its render is wrapped once per mark.
function decorateNoteMarks() {
  const views = rendition?.views();
  for (const view of views?.all ? views.all() : views || []) {
    for (const { mark } of Object.values(view.underlines || {})) {
      if ((mark.className !== "note-ul" && mark.className !== "ai-star") || mark.bracketed) continue;
      const render = mark.render;
      const draw = mark.className === "ai-star" ? drawStar : drawBars;
      mark.render = function () {
        render.call(this);
        draw(this);
      };
      mark.bracketed = true;
      mark.render();
    }
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";
// Turns 9 and 10: a note is a soft fill behind its lines (CSS on the line rects).
function drawBars(mark) {
  mark.element.classList.add("m-fill");
}

// An explanation put away: a dotted underline under its lines, which take a tap or a click.
function drawStar(mark) {
  const g = mark.element;
  const rects = [...g.querySelectorAll("rect")]
    .map((r) => ({ x: +r.getAttribute("x"), y: +r.getAttribute("y"), w: +r.getAttribute("width"), h: +r.getAttribute("height") }))
    .filter((r) => r.w > 0 && r.h > 0);
  g.replaceChildren();
  const last = rects.at(-1);
  if (!last) return;
  // Turns 9 and 10: an explained passage gets a dotted ochre underline; its lines, a little taller, take the tap.
  for (const r of rects) {
    const hit = document.createElementNS(SVG_NS, "rect");
    for (const [k, v] of Object.entries({ class: "star-hit", x: r.x, y: r.y - 4, width: r.w, height: r.h + 10 })) hit.setAttribute(k, v);
    const line = document.createElementNS(SVG_NS, "line");
    const y = r.y + r.h + 3;
    for (const [k, v] of Object.entries({ class: "dots-ul", x1: r.x, x2: r.x + r.w, y1: y, y2: y })) line.setAttribute(k, v);
    g.append(hit, line);
  }
}

// Redraw a note's marks after its comment appeared or went away.
function redrawNote(note) {
  const views = rendition?.views();
  for (const view of views?.all ? views.all() : views || []) view.underlines?.[note.cfi]?.mark.render();
}

function unmarkNote(note) {
  try {
    rendition?.annotations.remove(note.cfi, "underline");
  } catch {
    /* ignore */
  }
}

async function addNote(selection) {
  if (!current) return;
  const note = {
    cfi: selection.cfiRange,
    posKey: current.posKey,
    text: selection.text || selection.context.selection,
    chapter: selection.context.chapter || "",
  };
  // The selection is done with once it is saved; clear it so the next tap turns the page.
  try {
    rendition?.getContents()[0]?.window.getSelection().removeAllRanges();
    if (pdfView) window.getSelection().removeAllRanges();
  } catch {
    /* ignore */
  }
  try {
    const saved = await notesStore.notesAdd(current.path, note);
    if (selection.comment && !saved.comment) {
      saved.comment = selection.comment;
      await notesStore.notesUpdate(current.path, saved.id, { comment: saved.comment }).catch(() => {});
    }
    if (!notes.some((n) => n.id === saved.id)) {
      notes.push(saved);
      markNote(saved);
    }
    renderNotes();
    toast("Додано в нотатки");
    if (notesTabShown()) openNote(saved.id);
  } catch (err) {
    if (err.message !== "login") showNotice(`Не вдалося зберегти нотатку: ${err.message}`, false);
  }
}

function openNote(id) {
  showPanel(true, "notes");
  const el = $(`#notes [data-id="${id}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  flash(el);
}

// A note picked on the home screen: open its book (unless it is the one on screen) and go to the passage.
let pendingJump = null; // { path, note }
function openNoteInBook(path, note) {
  if (current?.path === path && (rendition || pdfView)) return goToNote(note);
  pendingJump = { path, note };
  window.reader.openPath(path);
}
// A kept explanation picked elsewhere (search): open its book, go to the passage and open its card.
let pendingChat = null; // { path, id }
function openChatInBook(path, id) {
  pendingChat = { path, id };
  if (current?.path === path && (rendition || pdfView)) return showPendingChat();
  window.reader.openPath(path);
}
function showPendingChat() {
  if (!pendingChat || pendingChat.path !== current?.path) return;
  const conv = [...conversations.values()].find((c) => c.sid === pendingChat.id);
  if (!conv) return;
  pendingChat = null;
  goToNote({ cfi: conv.cfiRange });
  highlightConv(conv);
  openConvCard(conv);
}
function jumpIfPending() {
  if (!pendingJump || pendingJump.path !== current?.path) return;
  const { note } = pendingJump;
  pendingJump = null;
  if (note.cfi.startsWith("pdf:") ? pdfView : rendition && (note.posKey || current.path) === current.posKey) goToNote(note);
}

function goToNote(note) {
  if (note.cfi.startsWith("pdf:")) {
    const page = Number(note.cfi.split(":")[1]);
    if (pdfView && page) pdfView.viewer.currentPageNumber = page;
  } else if (noteTarget(note)) {
    rendition?.display(noteTarget(note));
  }
  if (PHONE.matches) showPanel(false);
}

function renderNotes() {
  const box = $("#notes");
  box.innerHTML = "";
  window.PhoneRead?.notesCount();
  for (const conv of conversations.values()) syncConvActs(conv);
  if (!current) {
    box.innerHTML = `<div class="panel-empty">Відкрийте книжку, щоб побачити її нотатки.</div>`;
    return;
  }
  if (!notes.length) {
    box.innerHTML = `<div class="panel-empty">Нотаток ще немає. Виділіть текст і натисніть «В нотатки».</div>`;
    return;
  }
  // One list on a phone and a computer (turns 9, 10): grouped by chapter, with tabs (phone-read.js).
  window.PhoneRead.renderNotes(box);
}

// The passage around a note, for its explanation: from the chapter the note is in when the book can give it,
// otherwise the note's own text only.
async function noteContext(note) {
  let ctx = { selection: note.text, before: "", after: "" };
  try {
    if (book && rendition && String(note.cfi || "").startsWith("epubcfi")) {
      let range = rendition.getRange(note.cfi);
      if (!range) {
        const section = book.spine.get(note.cfi);
        const el = section && (await section.load(book.load.bind(book)));
        const doc = el?.ownerDocument || el;
        if (doc) range = new ePub.CFI(note.cfi).toRange(doc);
      }
      if (range) ctx = { ...extractContext(range.startContainer.ownerDocument, range), selection: note.text };
    }
  } catch {
    /* the note's text alone will do */
  }
  return { ...ctx, chapter: note.chapter || "", bookTitle: current.title, author: current.author };
}

// Grow the comment field with its text; a hidden panel measures 0, so it is fitted again when shown.
function fitComment(el) {
  if (!el.offsetParent) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

let toastTimer = null;
function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.add("shown");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("shown"), 1600);
}

$("#btn-notes").onclick = () => (notesTabShown() ? showPanel(false) : showPanel(true, "notes"));

// ---------- Toolbar and window wiring ----------

$("#btn-open").onclick = () => window.reader.chooseBook();
$("#btn-open-empty").onclick = () => window.reader.chooseBook();
$("#btn-toc").onclick = () => $("#toc").classList.toggle("hidden");
// A click anywhere else puts the contents away (taps inside the page close it through toggleChrome).
document.addEventListener("click", (e) => {
  if (!e.target.closest("#toc, #btn-toc")) $("#toc").classList.add("hidden");
});
$("#btn-panel").onclick = () => showPanel(document.body.classList.contains("panel-hidden") || notesTabShown(), "cards");
$("#btn-panel-close").onclick = () => showPanel(false);
$("#btn-settings").onclick = openSettings;
$("#prev").onclick = () => (pdfView || rendition)?.prev();
$("#next").onclick = () => (pdfView || rendition)?.next();

// Font size belongs to the book: changed in one book, it stays there; any other book opens at 100%.
function bookFontSize() {
  return settings.fontSizes?.[current?.path] || 100;
}

let fontPlace = null; // where the reader was when the font size started changing
async function setFont(delta) {
  if (!current) return;
  const size = Math.min(200, Math.max(70, bookFontSize() + delta));
  settings.fontSizes = { ...settings.fontSizes, [current.path]: size };
  // A new size reflows every page; go back to the words that were on screen, or the place drifts away
  // (Max, 2026-10-28: «губиться позиція в тексті»).
  // Several taps in a row keep coming back to the place of the first one, so they don't drift.
  const now = Date.now();
  if (!fontPlace || now - fontPlace.at > 15000 || fontPlace.book !== current.path) {
    fontPlace = { cfi: rendition?.currentLocation?.()?.start?.cfi, book: current.path };
  }
  fontPlace.at = now;
  const place = fontPlace.cfi;
  rendition?.themes.fontSize(`${size * BASE_SCALE}%`);
  if (place) requestAnimationFrame(() => rendition?.display(place));
  pdfView?.setZoom(size);
  settings = await window.reader.setSettings({ fontSizes: settings.fontSizes });
}
$("#btn-font-down").onclick = () => setFont(-10);
$("#btn-font-up").onclick = () => setFont(10);

// "Як у системі" follows the phone's or Mac's light/dark switch, also while a book is open.
DARK_QUERY.addEventListener("change", () => settings?.theme === "auto" && applyTheme());

document.addEventListener("keyup", onKey);
["#viewer", "#prev", "#next"].forEach((id) => $(id).addEventListener("wheel", onWheel, { passive: true }));
window.addEventListener("resize", () => hideSelToolbar());
$("#pdf-container").addEventListener("mouseup", onPdfMouseUp);
$("#pdf-container").addEventListener("scroll", () => hideSelToolbar(), { passive: true });

// Drag & drop a book anywhere on the window.
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  const file = [...e.dataTransfer.files].find((f) => BOOK_EXT.test(f.name));
  if (file) window.reader.openPath(window.reader.pathForFile(file));
});

window.reader.onBookOpen((payload) =>
  openBook(payload).catch((err) => {
    // Never leave a half-opened book on screen with no way out: back to the library, with the reason.
    console.error(err);
    closeBook();
    showNotice(`Не вдалося відкрити книжку: ${err.message}`, false);
    window.Shell?.show("home");
  }),
);
window.reader.onShowSettings(openSettings);
window.reader.onBookConverting((name) => showNotice(`Конвертую «${name}» через Calibre…`, true));
window.reader.onBookError((message) => showNotice(message, false));

// A finished notice goes away by itself after a few seconds, longer for a longer text (Max, 2026-11-01:
// no «Закрити» button); a tap on it hides it at once. A busy one stays until the next notice.
let noticeTimer = 0;
function showNotice(text, busy) {
  const box = $("#notice");
  box.querySelector(".notice-text").textContent = text;
  box.classList.toggle("busy", busy);
  box.classList.remove("hidden");
  clearTimeout(noticeTimer);
  if (!busy) noticeTimer = setTimeout(() => box.classList.add("hidden"), Math.min(12000, 4000 + 40 * text.length));
}
$("#notice").addEventListener("click", (e) => !e.target.closest("a, button") && !$("#notice").classList.contains("busy") && $("#notice").classList.add("hidden"));
// A link at the end of the notice shown last («Увійти», «Завантажити EPUB»); the next notice drops it.
function noticeLink(href, label) {
  const a = document.createElement("a");
  a.href = href;
  a.textContent = label;
  a.className = "notice-link";
  $("#notice .notice-text").append(" ", a);
}
window.reader.onTogglePanel(() => showPanel(document.body.classList.contains("panel-hidden")));

// ---------- Print: the book's text on paper, without the panel, toolbar or notices ----------
// Ctrl/Cmd+P prints the whole book (svoloshyn: «роздрукувати казку дитині»). Books shared by their
// author's permission have no file to download, so printing them gives the current chapter only.
// The browser's own Print menu gives no time to load the other chapters: it prints the chapter on screen.

// The book's font lives in the page frames; the printed copy needs it here too (it loads only when used).
for (const href of FONT_CSS) document.head.append(Object.assign(document.createElement("link"), { rel: "stylesheet", href }));
const printBox = document.createElement("div");
printBox.id = "print-book";
document.body.append(printBox);

const printWholeBook = () => !(settings.noFileBooks || []).includes(current?.path);

function printHead() {
  const h = document.createElement("header");
  h.className = "print-head";
  h.innerHTML = `<div class="print-title"></div><div class="print-author"></div>`;
  h.querySelector(".print-title").textContent = current?.title || "";
  h.querySelector(".print-author").textContent = current?.author || "";
  return h;
}

function printSection(body) {
  const sec = document.createElement("section");
  sec.className = "print-section";
  for (const el of body.querySelectorAll("script, style, link")) el.remove();
  for (const a of body.querySelectorAll("a[href]")) a.removeAttribute("href");
  sec.innerHTML = body.innerHTML;
  return sec;
}

// What is on screen now: the chapter being read (or every chapter laid out, for a whole book).
function fillPrintFromScreen() {
  const index = rendition?.currentLocation?.()?.start?.index;
  const all = rendition?.getContents() || [];
  const shown = all.filter((c) => c.sectionIndex === index);
  printBox.replaceChildren(printHead(), ...(shown.length ? shown : all).map((c) => printSection(c.document.body.cloneNode(true))), printColophon());
  printBox.style.fontFamily = FONTS[settings.font] || "";
}

// The last page: where the text comes from, and a way back to it in Chytai (Max: «звідки книжка і
// посилання на сайт + qr маленький»). A free-shelf book's QR opens its page in the site's catalog
// («qr код має вести на сайт каталога»); any other book's, the site.
const READER_URL = "https://app.chytai.org.ua";
const SITE_URL = "https://chytai.org.ua";

function printSource() {
  const m = current?.meta || {};
  const rights = String(m.rights || "").trim();
  const publisher = String(m.publisher || "").trim();
  const id = String(m.identifier || "");
  const permitted = (settings.noFileBooks || []).includes(current?.path);
  if (/^Суспільне надбання/.test(rights)) return rights;
  if (publisher === "Standard Ebooks") return "Суспільне надбання. Текст: Standard Ebooks (standardebooks.org).";
  if (/gutenberg\.org/.test(id) || /^Public domain/i.test(rights)) return "Суспільне надбання. Текст: Project Gutenberg (gutenberg.org).";
  const parts = [];
  if (permitted) parts.push("Публікується з дозволу автора.");
  if (publisher) parts.push(`Видавець: ${publisher}.`);
  if (rights && rights.length < 120) parts.push(rights.replace(/\.?$/, "."));
  return parts.join(" ");
}

function printColophon() {
  const free = (settings.freeBooks || []).includes(current?.path);
  const link = free ? `${SITE_URL}/free-book/${encodeURIComponent(current.path)}` : SITE_URL;
  const foot = document.createElement("footer");
  foot.className = "print-colophon";
  foot.innerHTML = `<div class="pc-book"></div><div class="pc-author"></div><div class="pc-source"></div>
    <div class="pc-qr"></div><div class="pc-from"></div><div class="pc-link"></div>`;
  foot.querySelector(".pc-book").textContent = current?.title || "";
  foot.querySelector(".pc-author").textContent = current?.author || "";
  foot.querySelector(".pc-source").textContent = printSource();
  foot.querySelector(".pc-from").textContent = free
    ? "Надруковано з Chytai. Цю книжку можна безкоштовно читати на телефоні чи комп'ютері:"
    : "Надруковано з Chytai, читалки й сайту про книжки:";
  foot.querySelector(".pc-link").textContent = SITE_URL.replace(/^https:\/\//, "");
  try {
    const qr = qrcode(0, "M");
    qr.addData(link);
    qr.make();
    foot.querySelector(".pc-qr").innerHTML = qr.createSvgTag({ cellSize: 2, margin: 0, scalable: true });
  } catch {
    /* no QR, the link is there */
  }
  return foot;
}

async function fillPrintWholeBook() {
  const parts = [];
  for (const section of book.spine.spineItems) {
    if (section.linear === false || section.properties?.includes?.("nav")) continue;
    try {
      const doc = (await section.load(book.load.bind(book))).ownerDocument;
      const body = doc.body || doc.querySelector("body");
      if (!body) continue;
      const clone = document.importNode(body, true);
      // Pictures point into the book file; give them the same blob URLs the pages use.
      for (const img of clone.querySelectorAll("img[src], image")) {
        const attr = img.tagName.toLowerCase() === "img" ? "src" : img.hasAttribute("href") ? "href" : "xlink:href";
        const src = img.getAttribute(attr);
        if (!src || /^(data|blob|https?):/.test(src)) continue;
        try {
          const abs = decodeURI(new URL(src, `https://book${section.url.startsWith("/") ? "" : "/"}${section.url}`).pathname);
          const url = book.archive ? await book.archive.createUrl(abs) : abs;
          img.setAttribute(attr, url);
        } catch {
          img.remove();
        }
      }
      parts.push(printSection(clone));
    } catch {
      /* a chapter that does not load is left out */
    } finally {
      section.unload?.();
    }
  }
  printBox.replaceChildren(printHead(), ...parts, printColophon());
  printBox.style.fontFamily = FONTS[settings.font] || "";
}

let printReady = false;
async function printBook() {
  if (current?.protected) return showNotice("Цю книжку не можна друкувати.", false);
  if (!rendition || current?.pdf) return window.print();
  showNotice("Готую книжку до друку…", true);
  try {
    if (printWholeBook()) await fillPrintWholeBook();
    else fillPrintFromScreen();
  } finally {
    $("#notice").classList.add("hidden");
  }
  printReady = true;
  document.body.classList.add("printing");
  await document.fonts?.ready;
  window.print();
}

function onPrintKey(e) {
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "p" && rendition && !current?.pdf) {
    e.preventDefault();
    printBook();
  }
}
document.addEventListener("keydown", onPrintKey);

window.addEventListener("beforeprint", () => {
  if (!rendition || current?.pdf) return;
  if (current?.protected) printBox.replaceChildren(printHead(), Object.assign(document.createElement("p"), { textContent: "Цю книжку не можна друкувати." }));
  else if (!printReady) fillPrintFromScreen();
  document.body.classList.add("printing");
});
window.addEventListener("afterprint", () => {
  document.body.classList.remove("printing");
  printBox.replaceChildren();
  printReady = false;
});

settingsReady = loadSettings();
settingsReady.then(() => {
  if (!settings.hasApiKey) setTimeout(openSettings, 300);
});

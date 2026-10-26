/* global ePub, marked, DOMPurify, extractContext */
const $ = (sel) => document.querySelector(sel);
const BOOK_EXT = /\.(epub|pdf|mobi|azw|azw3|azw4|prc|kfx|fb2|docx|rtf|odt|txt|htmlz|lit|pdb)$/i;

const THEMES = {
  light: { body: { background: "#ffffff", color: "#1d1d1f" } },
  sepia: { body: { background: "#f6efe0", color: "#3b2f1e" } },
  dark: { body: { background: "#1e1e20", color: "#dcdcdc" }, a: { color: "#8ab4f8" } },
};
const DARK_QUERY = window.matchMedia("(prefers-color-scheme: dark)");
const resolvedTheme = () => {
  const theme = settings?.theme || "auto";
  return theme === "auto" ? (DARK_QUERY.matches ? "dark" : "light") : THEMES[theme] ? theme : "light";
};
const themeCss = (name) =>
  Object.entries(THEMES[name])
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
// Book text a bit larger than browser default, closer to the Kindle apps at 100%.
const BASE_SCALE = 1.2;
const HIGHLIGHT_STYLE = { fill: "#ffd54a", "fill-opacity": "0.35", "mix-blend-mode": "multiply" };

// On a phone the explanations panel is a sheet over the page, so it starts hidden and opens with the first explanation.
if (matchMedia("(max-width: 760px)").matches) document.body.classList.add("panel-hidden");
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
  if (settings.web && !settings.guest) fillDemoBooks();
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
  $("#set-style").value = settings.explainStyle || "default";
  $("#set-custom-style").value = settings.customStyle || "";
  $("#custom-style-row").hidden = $("#set-style").value !== "custom";
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
    explainStyle: $("#set-style").value,
    customStyle: $("#set-custom-style").value.trim(),
    font: $("#set-font").value,
    margins: $("#set-margins").value,
    pageTaps: $("#set-page-taps").value === "taps",
    deskScroll: $("#set-desk-scroll").value === "scroll",
  };
  const key = $("#set-key").value.trim();
  if (key) patch.apiKey = key;
  if (settings.web && !settings.guest && $("#set-demo-book").options.length) patch.demoBook = $("#set-demo-book").value;
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
$("#set-style").onchange = () => {
  $("#custom-style-row").hidden = $("#set-style").value !== "custom";
  if (!$("#custom-style-row").hidden) $("#set-custom-style").focus();
};
$("#btn-logout").onclick = () => window.reader.logout?.();
$("#btn-admin").onclick = () => (location.href = "/admin");
$("#btn-print").onclick = () => printBook();

// Family members choose which library book guests see in the demo (web only).
async function fillDemoBooks() {
  const select = $("#set-demo-book");
  const builtIn = settings.demoDefault ? `Вбудована (${settings.demoDefault.replace(/\.(epub|pdf)$/i, "")})` : "Немає вбудованої";
  select.innerHTML = `<option value="">${builtIn}</option>`;
  try {
    const { books } = await window.reader.libraryList();
    for (const b of [...books].sort((x, y) => x.title.localeCompare(y.title, "uk"))) {
      const opt = document.createElement("option");
      opt.value = b.path;
      opt.textContent = `${b.title}${b.authors[0] ? ` — ${b.authors[0]}` : ""}`;
      select.append(opt);
    }
  } catch {
    /* the library is optional here */
  }
  select.value = settings.demoBook || "";
  if (select.value !== (settings.demoBook || "")) select.value = "";
}

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

// A little tighter on a phone, where every line counts.
function lineHeight() {
  return PHONE.matches ? 1.6 : 1.7;
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
    ${scrolled() && !PHONE.matches ? "body { max-width: 680px !important; margin-left: auto !important; margin-right: auto !important; }" : ""}`;
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
  hideSelToolbar();
  $("#empty").classList.add("hidden");
  const isPdf = /\.pdf$/i.test(payload.name);
  $("#btn-pdf-mode").classList.toggle("hidden", !isPdf);
  if (isPdf) {
    $("#btn-pdf-mode").textContent = settings.pdfMode === "reflow" ? "Оригінал PDF" : "Як книжка";
    if (settings.pdfMode === "reflow") {
      const epub = await reflowPdf(payload);
      if (epub) {
        const position = payload.carryPage ? await reflowHrefForPage(epub, payload.carryPage) : payload.reflowPosition;
        return openEpub({ ...payload, data: epub, position }, { posKey: `${payload.path}#reflow`, source: payload });
      }
    }
    return openPdf(payload.carryPage ? { ...payload, position: `pdf:${payload.carryPage}` } : payload);
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
    showNotice(scan ? "У цьому PDF немає тексту (схоже на скан), тому відкриваю оригінал." : `Не вдалося перекласти PDF, відкриваю оригінал.\n${err.message}`, false);
    return null;
  }
}

async function openEpub(payload, { posKey, source }) {
  $("#viewer").classList.remove("hidden");
  $("#pdf-container").classList.add("hidden");

  book = ePub(payload.data);
  book.spine.hooks.content.register(stripScripts);
  // Our typography goes into the chapter before epub.js lays it out and finds the target page.
  // The rendition's content hook runs only after that, so a jump into the middle of a chapter (a
  // contents entry, a saved position) was measured in the book's own styles and landed elsewhere
  // once line height and font changed.
  book.spine.hooks.content.register((doc) => styleContents({ document: doc }));
  current = { path: payload.path, posKey, source, title: payload.name.replace(/\.[^.]+$/, ""), author: "" };

  rendition = book.renderTo("viewer", {
    width: "100%",
    height: "100%",
    ...(scrolled() ? { flow: "scrolled", manager: "continuous" } : { flow: "paginated", spread: "auto", minSpreadWidth: 960 }),
    // WebKit (iOS Safari) does not run our touch/selection listeners inside an iframe sandboxed
    // without allow-scripts, so allow scripts and strip the book's own ones in stripScripts.
    allowScriptedContent: true,
  });
  followFontLoad(rendition);
  rendition.themes.default({
    "::selection": { background: "rgba(255, 200, 0, 0.45)" },
  });
  rendition.hooks.content.register(styleContents);
  rendition.hooks.content.register((contents) => contents.on("linkClicked", rememberReturn));
  rendition.themes.fontSize(`${bookFontSize() * BASE_SCALE}%`);

  rendition.on("selected", onSelected);
  rendition.on("relocated", onRelocated);
  rendition.on("rendered", () => decorateNoteMarks());
  rendition.on("keyup", onKey);
  rendition.hooks.content.register((contents) => contents.document.addEventListener("wheel", onWheel, { passive: true }));
  // Keys pressed while the page has focus reach only the book's frame; pass them on.
  rendition.on("keydown", (e) => (onPrintKey(e), e.defaultPrevented || window.Shell?.key(e)));
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

  await rendition.display(payload.position || undefined);
  // The reading area may have been measured before the layout settled (first load, toolbar
  // hiding on a phone); a re-measure now re-renders only if the size actually changed.
  requestAnimationFrame(resizeView);
  loadNotes();
  watchFirstPage();
  jumpIfPending();

  const meta = await book.loaded.metadata;
  current.title = meta.title || current.title;
  current.author = meta.creator || "";
  current.meta = meta;
  $("#book-title").textContent = current.author ? `${current.title} · ${current.author}` : current.title;
  $("#running-head").textContent = current.title;
  document.title = current.title;

  const nav = await book.loaded.navigation;
  renderToc(nav.toc);
  $("#btn-toc").disabled = false;
  $("#btn-print").classList.remove("hidden");

  // Page-accurate progress needs the locations index; build it in the background.
  book.locations.generate(1600).then(() => {
    const location = rendition?.currentLocation();
    updateProgress(location);
    if (current && location?.start) window.reader.savePosition(current.posKey, location.start.cfi, readingProgress(location));
    addTocPages(book);
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
  // A failure while tearing down the previous book must never block opening the next one.
  for (const item of [rendition, book, pdfView]) {
    try {
      item?.destroy();
    } catch (err) {
      console.warn("close failed", err);
    }
  }
  rendition = book = pdfView = null;
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
  const reading = PHONE.matches && !!(rendition || pdfView) && !document.body.classList.contains("library-open");
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
}

// Escape hatch: when a chapter never renders (a broken book, a WebKit quirk), taps inside the page
// never reach us and the toolbar could not be brought back. The running head at the top and the
// bare page area outside the chapter frames still get taps, so a tap there shows the toolbar.
$("#running-head").addEventListener("click", () => toggleChrome(true));
$("#viewer").addEventListener("click", (e) => {
  if (e.target.tagName !== "IFRAME") toggleChrome();
});

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
  const PdfView = await waitForPdfModule();
  pdfView = await PdfView.open($("#pdf-container"), payload.data, {
    position: payload.position,
    onPageChange: (page, total) => {
      window.reader.savePosition(current.posKey, `pdf:${page}`, { pct: Math.round((page / total) * 100), chapter: "" });
      $("#progress-label").textContent = `${page} / ${total}`;
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
  const toc = await pdfView.toc();
  renderToc(toc);
  $("#btn-toc").disabled = !toc.length;
  loadNotes();
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

function chapterTitle(href) {
  if (!book?.navigation || !href) return "";
  const base = href.split("#")[0];
  let found = "";
  const walk = (items) => {
    for (const item of items) {
      if (item.href.split("#")[0].endsWith(base) || base.endsWith(item.href.split("#")[0])) {
        found = item.label.trim();
      }
      if (item.subitems?.length) walk(item.subitems);
    }
  };
  walk(book.navigation.toc);
  return found;
}

function onRelocated(location) {
  if (current) window.reader.savePosition(current.posKey, location.start.cfi, readingProgress(location));
  updateProgress(location);
  // While scrolling, a selection may move off screen and back; its toolbar is pinned at the bottom anyway.
  if (!scrolled()) hideSelToolbar();
  toggleChrome(false);
}

// How far into the book and which chapter, for the home screen; nothing until the locations index exists.
function readingProgress(location) {
  if (!book?.locations.length() || !location?.start) return undefined;
  return { pct: Math.round(book.locations.percentageFromCfi(location.start.cfi) * 100), chapter: chapterTitle(location.start.href) };
}

function updateProgress(location) {
  if (!location?.start) return;
  $("#chapter-label").textContent = chapterTitle(location.start.href);
  if (book.locations.length()) {
    $("#progress-label").textContent = `${Math.round(book.locations.percentageFromCfi(location.start.cfi) * 100)}%`;
  }
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
  const sel = rendition?.getContents()[0]?.window.getSelection();
  if (sel && !sel.isCollapsed) return;
  if (!scrolled() && ms < 600 && Math.abs(dx) >= 40 && Math.abs(dx) > Math.abs(dy)) {
    dx < 0 ? rendition?.next() : rendition?.prev();
  } else if (ms < 400 && Math.abs(dx) < 12 && Math.abs(dy) < 12 && !e.target?.closest?.("a")) {
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
  const view = pdfView || rendition;
  if (!view) return;
  // In page mode the up/down arrows turn pages too; while scrolling they scroll.
  const paged = !scrolled();
  if (e.key === "ArrowLeft" || e.key === "PageUp" || (paged && e.key === "ArrowUp") || (e.key === " " && e.shiftKey)) view.prev();
  if (e.key === "ArrowRight" || e.key === "PageDown" || (paged && e.key === "ArrowDown") || (e.key === " " && !e.shiftKey)) view.next();
}

// Page mode on a computer: scrolling down with the mouse wheel or trackpad turns the page, as people
// expect it to. One turn per gesture: a trackpad keeps sending wheel events while it coasts.
let wheelQuietAt = 0;
function onWheel(e) {
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
  const chapter = chapterTitle(contents.section?.href || rendition.currentLocation()?.start?.href);
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
  showSelToolbar(range, frame);
}

function showSelToolbar(range, frame) {
  const rect = range.getBoundingClientRect();
  const bar = $("#sel-toolbar");
  bar.classList.remove("hidden");
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
  const above = frame.top + rect.top - bar.offsetHeight - 8;
  const left = frame.left + rect.left + rect.width / 2 - bar.offsetWidth / 2;
  const top = Math.max(48, above < 48 ? frame.top + rect.bottom + 8 : above);
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
function hideSelToolbar() {
  $("#sel-toolbar").classList.add("hidden");
}

$("#sel-toolbar").addEventListener("mousedown", (e) => e.preventDefault());
$("#sel-toolbar").addEventListener("click", (e) => {
  const action = e.target.dataset.action;
  if (!action || !pendingSelection) return;
  const snapshot = pendingSelection;
  // A free book read without an account: explanations and notes come with one (they cost Max tokens).
  if (settings.free) {
    hideSelToolbar();
    showNotice("Пояснення, питання і нотатки працюють після входу. Це безкоштовно, потрібна лише пошта.", false);
    return noticeLink(settings.free.signIn, "Увійти");
  }
  if (action === "note") {
    addNote(snapshot);
  } else {
    startExplanation(snapshot, { ask: action === "ask" });
  }
  hideSelToolbar();
});

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

// «Пояснити» starts with a quick note at once; «Запитати» opens the card with the question field instead.
function startExplanation(selection, { ask = false } = {}) {
  showPanel(true, "cards");
  $("#panel-empty")?.remove();

  // Same selection already explained: just bring that card into view.
  for (const conv of ask ? [] : conversations.values()) {
    if ((conv.cfiRange === selection.cfiRange || conv.context.selection === selection.context.selection) && !conv.ask) {
      highlightConv(conv);
      conv.card.scrollIntoView({ behavior: "smooth", block: "nearest" });
      flash(conv.card);
      return conv.card;
    }
  }

  const id = `r${++reqCounter}`;
  const card = document.createElement("article");
  card.className = "card";
  card.dataset.id = id;
  const quote = selection.context.selection;
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
    <form class="followup"><input type="text" placeholder="Уточнити питання…" /></form>`;
  card.querySelector(".quote").textContent = quote.length > 280 ? quote.slice(0, 280) + "…" : quote;
  $("#cards").prepend(card);
  // The new card is at the top; bring it into view even if the list was scrolled down.
  $("#cards").scrollTop = 0;

  const conv = { id, card, ask, cfiRange: selection.cfiRange, context: selection.context, messages: null, busy: false };
  conversations.set(id, conv);

  highlightConv(conv);

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
    runTurn(conv, q);
  };

  if (ask) {
    const input = card.querySelector(".followup input");
    input.placeholder = "Ваше питання про цей фрагмент…";
    input.focus();
  } else {
    runTurn(conv, null);
  }
  return card;
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
    request = { context: { ...conv.context, question: question || undefined }, quick: !question };
  } else {
    request = { messages: [...conv.messages, { role: "user", content: question }] };
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
    // One "more detail" per card: after it, the follow-up field is the way to ask further.
    if (!conv.ask && conv.lastQuestion !== "Детальніше") conv.card.querySelector(".more").classList.remove("hidden");
    conv.card.querySelector(".model").textContent = modelLabel(ev.model) + (ev.truncated ? " · обрізано" : "");
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

function highlightConv(conv) {
  try {
    rendition.annotations.remove(conv.cfiRange, "highlight");
    rendition.annotations.highlight(conv.cfiRange, { id: conv.id }, () => {
      showPanel(true, "cards");
      conv.card.scrollIntoView({ behavior: "smooth", block: "nearest" });
      flash(conv.card);
    }, "ai-hl", HIGHLIGHT_STYLE);
  } catch {
    /* highlighting is cosmetic */
  }
}

// No yellow is left behind once the cards are out of sight (panel closed or the Notes tab open):
// a tap on it would open the explanation again instead of letting the reader select the text for a
// note (Max, 2026-10-24). The cards stay in the panel; explaining the same text again marks it again.
function unhighlightConvs() {
  for (const conv of conversations.values()) {
    try {
      rendition?.annotations.remove(conv.cfiRange, "highlight");
    } catch {
      /* ignore */
    }
  }
}

function showPanel(show, tab) {
  document.body.classList.toggle("panel-hidden", !show);
  if (!show) unhighlightConvs();
  if (tab) showTab(tab);
  // epub.js needs a resize to reflow pages after the layout changes width.
  setTimeout(resizeView, 220);
}

function clearExplanations() {
  for (const conv of conversations.values()) if (conv.busy) window.reader.abort(conv.reqId);
  unhighlightConvs();
  conversations.clear();
  $("#cards").innerHTML = `<div id="panel-empty" class="panel-empty">Виділіть текст у книжці, щоб отримати пояснення в контексті.</div>`;
}

$("#btn-clear").onclick = clearExplanations;

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

function showTab(tab) {
  for (const b of document.querySelectorAll("#panel .tab")) b.classList.toggle("active", b.dataset.tab === tab);
  $("#cards").classList.toggle("hidden", tab !== "cards");
  $("#notes").classList.toggle("hidden", tab !== "notes");
  if (tab !== "cards") unhighlightConvs();
  $("#btn-clear").classList.toggle("hidden", tab !== "cards");
  if (tab === "notes") requestAnimationFrame(() => document.querySelectorAll(".note-comment").forEach(fitComment));
}
for (const b of document.querySelectorAll("#panel .tab")) b.onclick = () => showTab(b.dataset.tab);

const notesTabShown = () => !document.body.classList.contains("panel-hidden") && !$("#notes").classList.contains("hidden");

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

function markNote(note) {
  if (!rendition || !noteReachable(note)) return;
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
      if (mark.className !== "note-ul" || mark.bracketed) continue;
      const render = mark.render;
      mark.render = function () {
        render.call(this);
        drawBars(this);
      };
      mark.bracketed = true;
      mark.render();
    }
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";
function drawBars(mark) {
  const g = mark.element;
  const rects = [...g.querySelectorAll("rect")]
    .map((r) => ({ x: +r.getAttribute("x"), y: +r.getAttribute("y"), w: +r.getAttribute("width"), h: +r.getAttribute("height") }))
    .filter((r) => r.w > 0 && r.h > 0);
  // A passage that runs onto the next page continues in the next column: the text jumps back up.
  const cols = [];
  for (const r of rects) {
    const col = cols.at(-1);
    if (col && r.y >= col.at(-1).y - 2) col.push(r);
    else cols.push([r]);
  }
  const add = (tag, attrs) => {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    g.appendChild(el);
    return el;
  };
  // The same note always wobbles the same way, so a relayout doesn't redraw it differently.
  let seed = [...String(mark.data?.note || "")].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) - 0.5;
  // A short part of a paragraph (up to three lines) is underlined by hand under the exact words;
  // whole paragraphs and longer passages get the bars, which read more calmly than many lines of ink.
  const lines = new Set(rects.map((r) => Math.round(r.y))).size;
  const comment = notes.find((n) => n.id === mark.data?.note)?.comment || "";
  if (rects.length) drawCommentMark(add, rects.at(-1), !!comment);
  if (lines <= 3 && !coversWholeParagraphs(mark.range)) {
    for (const r of rects) {
      const y = r.y + r.h - 1;
      add("path", { class: "bar under", d: `M${r.x + rand()},${y + rand() * 1.5}` + wobbleAcross(r.x, r.x + r.w, y, rand) });
    }
    return;
  }
  for (const col of cols) {
    const top = Math.min(...col.map((r) => r.y)) + 1;
    const bottom = Math.max(...col.map((r) => r.y + r.h)) - 1;
    const left = Math.min(...col.map((r) => r.x)) - 8;
    const right = Math.max(...col.map((r) => r.x + r.w)) + 8;
    // Left: hooks in at the top, then runs down; right: runs down and hooks in at the bottom.
    add("path", { class: "bar", d: `M${left + 7},${top - 2 + rand() * 2} Q${left + 1},${top - 1} ${left},${top + 6}` + wobble(left, top + 6, bottom, rand) });
    add("path", { class: "bar", d: `M${right + rand() * 2},${top}` + wobble(right, top, bottom - 6, rand) + ` Q${right + 1},${bottom + 1} ${right - 7},${bottom + 2 + rand() * 2}` });
  }
}

// A note with a comment gets a small asterisk after its last word; tapping the passage shows it.
function drawCommentMark(add, last, commented) {
  if (!commented) return;
  add("text", { class: "comment-mark", x: last.x + last.w + 1, y: last.y + 2, "dominant-baseline": "hanging" }).textContent = "*";
}

// Redraw a note's marks after its comment appeared or went away.
function redrawNote(note) {
  const views = rendition?.views();
  for (const view of views?.all ? views.all() : views || []) view.underlines?.[note.cfi]?.mark.render();
}

// A horizontal pencil stroke from x1 to x2 near y.
function wobbleAcross(x1, x2, y, rand) {
  const steps = Math.max(1, Math.round((x2 - x1) / 40));
  let d = "";
  for (let i = 1; i <= steps; i++) {
    const x = x1 + ((x2 - x1) * i) / steps;
    d += ` Q${x - (x2 - x1) / steps / 2},${y + rand() * 2.2} ${x},${y + rand() * 1.2}`;
  }
  return d;
}

function blockOf(node) {
  return (node?.nodeType === 1 ? node : node?.parentElement)?.closest("p, li, blockquote, h1, h2, h3, h4, h5, h6, div, dd, dt, td");
}

// True when the range starts at the beginning of a paragraph and ends at the end of one.
function coversWholeParagraphs(range) {
  if (!range) return true;
  const doc = range.startContainer.ownerDocument;
  const gap = (from, to) => {
    if (!from || !to) return "";
    const r = doc.createRange();
    r.setStart(...from);
    r.setEnd(...to);
    return r.toString().trim();
  };
  const first = blockOf(range.startContainer);
  const last = blockOf(range.endContainer);
  if (!first || !last) return true;
  const end = [range.endContainer, range.endOffset];
  // iOS often ends a paragraph selection at the very start of the next one.
  const endsWhole = !gap(end, [last, last.childNodes.length]) || (last !== first && !gap([last, 0], end));
  return !gap([first, 0], [range.startContainer, range.startOffset]) && endsWhole;
}

// A vertical pencil stroke from y1 to y2 near x: it drifts a little side to side.
function wobble(x, y1, y2, rand) {
  const steps = Math.max(1, Math.round((y2 - y1) / 28));
  let d = "";
  for (let i = 1; i <= steps; i++) {
    const y = y1 + ((y2 - y1) * i) / steps;
    const cy = y - (y2 - y1) / steps / 2;
    d += ` Q${x + rand() * 3},${cy} ${x + (i === steps ? 0 : rand() * 1.6)},${y}`;
  }
  return d;
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
  } else {
    rendition?.display(note.cfi);
  }
  if (PHONE.matches) showPanel(false);
}

function noteDate(ms) {
  return new Date(ms).toLocaleDateString("uk-UA", { day: "numeric", month: "short" });
}

function renderNotes() {
  const box = $("#notes");
  box.innerHTML = "";
  if (!current) {
    box.innerHTML = `<div class="panel-empty">Відкрийте книжку, щоб побачити її нотатки.</div>`;
    return;
  }
  if (!notes.length) {
    box.innerHTML = `<div class="panel-empty">Нотаток ще немає. Виділіть текст і натисніть «Зберегти».</div>`;
    return;
  }
  // Newest on top, like the explanations.
  for (const note of [...notes].reverse()) {
    const card = document.createElement("article");
    card.className = "card note";
    card.dataset.id = note.id;
    card.innerHTML = `
      <blockquote class="quote"></blockquote>
      <textarea class="note-comment" rows="1" placeholder="Додати думку…"></textarea>
      <div class="meta"><span class="where"></span>
        <span class="actions">
          <button class="link go">Перейти</button>
          <button class="link delete">Видалити</button>
        </span>
      </div>`;
    card.querySelector(".quote").textContent = note.text;
    card.querySelector(".where").textContent = [note.chapter, noteDate(note.createdAt)].filter(Boolean).join(" · ");
    const go = card.querySelector(".go");
    if (noteReachable(note)) go.onclick = () => goToNote(note);
    else (go.disabled = true), (go.title = "Ця нотатка з іншого вигляду PDF");
    card.querySelector(".delete").onclick = async () => {
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
    const comment = card.querySelector(".note-comment");
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
    box.appendChild(card);
  }
  requestAnimationFrame(() => box.querySelectorAll(".note-comment").forEach(fitComment));
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
$("#btn-pdf-mode").onclick = async () => {
  if (!current?.source) return;
  // Carry the current PDF page over to the other view.
  const carryPage = pdfView ? pdfView.page : currentReflowPage();
  settings = await window.reader.setSettings({ pdfMode: settings.pdfMode === "reflow" ? "original" : "reflow" });
  const latest = await window.reader.getSettings();
  openBook({
    ...current.source,
    position: latest.positions[current.path] || null,
    reflowPosition: latest.positions[`${current.path}#reflow`] || null,
    carryPage,
  });
};

// Reflowed PDFs carry id="page-N" on the first block of each PDF page; find the one we're on.
function currentReflowPage() {
  try {
    const loc = rendition?.currentLocation();
    const contents = rendition?.getContents()[0];
    const range = loc?.start?.cfi && contents?.range(loc.start.cfi);
    let el = range?.startContainer;
    el = el?.nodeType === 1 ? el : el?.parentElement;
    while (el && el.tagName !== "BODY") {
      for (let sib = el; sib; sib = sib.previousElementSibling) {
        const m = /^page-(\d+)$/.exec(sib.id || "");
        if (m) return Number(m[1]);
      }
      el = el.parentElement;
    }
  } catch (err) {
    console.warn("could not map position to a PDF page", err);
  }
  return null;
}

async function reflowHrefForPage(epub, page) {
  try {
    const zip = await JSZip.loadAsync(epub.slice(0));
    const map = JSON.parse(await zip.file("OEBPS/pagemap.json").async("string"));
    return map[page] || null;
  } catch {
    return null; // older cached conversion without a page map
  }
}
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

async function setFont(delta) {
  if (!current) return;
  const size = Math.min(200, Math.max(70, bookFontSize() + delta));
  settings.fontSizes = { ...settings.fontSizes, [current.path]: size };
  rendition?.themes.fontSize(`${size * BASE_SCALE}%`);
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

function showNotice(text, busy) {
  const box = $("#notice");
  box.querySelector(".notice-text").textContent = text;
  box.classList.toggle("busy", busy);
  box.classList.remove("hidden");
}
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
  if (!printReady) fillPrintFromScreen();
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

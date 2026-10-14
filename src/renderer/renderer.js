/* global ePub, marked, DOMPurify, extractContext */
const $ = (sel) => document.querySelector(sel);
const BOOK_EXT = /\.(epub|pdf|mobi|azw|azw3|azw4|prc|kfx|fb2|docx|rtf|odt|txt|htmlz|lit|pdb)$/i;

const THEMES = {
  light: { body: { background: "#ffffff", color: "#1d1d1f" } },
  sepia: { body: { background: "#f6efe0", color: "#3b2f1e" } },
  dark: { body: { background: "#1e1e20", color: "#dcdcdc" }, a: { color: "#8ab4f8" } },
};
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
let autoTimer = null;
let reqCounter = 0;
const conversations = new Map(); // request id -> conversation state

// ---------- Settings ----------

async function loadSettings() {
  settings = await window.reader.getSettings();
  document.body.dataset.theme = settings.theme;
  document.body.dataset.margins = settings.margins || "normal";
  $("#theme-select").value = settings.theme;
}

function openSettings() {
  if (settings.web && !settings.guest) fillDemoBooks();
  $("#set-key").value = "";
  $("#key-hint").textContent = settings.apiKeyFromEnv
    ? "Використовується ключ зі змінної середовища ANTHROPIC_API_KEY."
    : settings.hasApiKey
      ? "Ключ збережено. Залиште поле порожнім, щоб не змінювати."
      : "Створіть ключ на platform.claude.com → API Keys.";
  $("#set-model").value = settings.model;
  $("#set-margins").value = settings.margins || "normal";
  $("#set-language").value = settings.language;
  $("#set-auto").checked = settings.autoExplain;
  $("#set-font").value = settings.font;
  $("#set-page-taps").value = settings.pageTaps ? "taps" : "scroll";
  $("#settings").showModal();
}

$("#settings").addEventListener("close", async () => {
  if ($("#settings").returnValue !== "save") return;
  const patch = {
    model: $("#set-model").value,
    language: $("#set-language").value.trim() || "українська",
    autoExplain: $("#set-auto").checked,
    font: $("#set-font").value,
    margins: $("#set-margins").value,
    pageTaps: $("#set-page-taps").value === "taps",
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
  if (marginsChanged) resizeView();
  if (fontChanged) applyTypography(true);
});
$("#btn-logout").onclick = () => window.reader.logout?.();
$("#btn-admin").onclick = () => (location.href = "/admin");

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

// On a phone the book scrolls as one continuous column unless page turns were chosen in settings.
function scrolled() {
  return PHONE.matches && !settings.pageTaps;
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
    ${scrolled() ? "body { padding-left: 14px !important; padding-right: 14px !important; }" : ""}`;
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
  current = { path: payload.path, posKey, source, title: payload.name.replace(/\.[^.]+$/, ""), author: "" };

  rendition = book.renderTo("viewer", {
    width: "100%",
    height: "100%",
    ...(scrolled() ? { flow: "scrolled", manager: "continuous" } : { flow: "paginated", spread: "auto", minSpreadWidth: 960 }),
    // WebKit (iOS Safari) does not run our touch/selection listeners inside an iframe sandboxed
    // without allow-scripts, so allow scripts and strip the book's own ones in stripScripts.
    allowScriptedContent: true,
  });
  Object.entries(THEMES).forEach(([name, rules]) => rendition.themes.register(name, rules));
  rendition.themes.default({
    "::selection": { background: "rgba(255, 200, 0, 0.45)" },
  });
  rendition.hooks.content.register(styleContents);
  rendition.hooks.content.register((contents) => contents.on("linkClicked", rememberReturn));
  rendition.themes.select(settings.theme);
  rendition.themes.fontSize(`${bookFontSize() * BASE_SCALE}%`);

  rendition.on("selected", onSelected);
  rendition.on("relocated", onRelocated);
  rendition.on("rendered", () => decorateNoteMarks());
  rendition.on("keyup", onKey);
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
  syncReading();

  await rendition.display(payload.position || undefined);
  // The reading area may have been measured before the layout settled (first load, toolbar
  // hiding on a phone); a re-measure now re-renders only if the size actually changed.
  requestAnimationFrame(resizeView);
  loadNotes();

  const meta = await book.loaded.metadata;
  current.title = meta.title || current.title;
  current.author = meta.creator || "";
  $("#book-title").textContent = current.author ? `${current.title} · ${current.author}` : current.title;
  $("#running-head").textContent = current.title;
  document.title = current.title;

  const nav = await book.loaded.navigation;
  renderToc(nav.toc);
  $("#btn-toc").disabled = false;

  // Page-accurate progress needs the locations index; build it in the background.
  book.locations.generate(1600).then(() => updateProgress(rendition.currentLocation()));
}

// epub.js throws from resize() until its stage exists (the book is still being parsed), and a
// resize with unchanged bounds is a no-op, so this is safe to call at any time.
function resizeView() {
  if (pdfView) pdfView.resize();
  else if (rendition?.manager?.stage) rendition.resize();
}

function closeBook() {
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
      window.reader.savePosition(current.posKey, `pdf:${page}`);
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
  if (current) window.reader.savePosition(current.posKey, location.start.cfi);
  updateProgress(location);
  // While scrolling, a selection may move off screen and back; its toolbar is pinned at the bottom anyway.
  if (!scrolled()) hideSelToolbar();
  toggleChrome(false);
}

function updateProgress(location) {
  if (!location?.start) return;
  $("#chapter-label").textContent = chapterTitle(location.start.href);
  if (book.locations.length()) {
    const pct = Math.round(book.locations.percentageFromCfi(location.start.cfi) * 100);
    $("#progress-label").textContent = `${pct}%`;
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
  const view = pdfView || rendition;
  if (!view) return;
  if (e.key === "ArrowLeft" || e.key === "PageUp") view.prev();
  if (e.key === "ArrowRight" || e.key === "PageDown" || (e.key === " " && !e.shiftKey)) view.next();
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

// Shared by EPUB and PDF: remember the selection, show the toolbar, maybe auto-explain.
// `frame` is the offset of the document holding the range (the epub iframe, or 0,0 for PDF).
function handleSelection(range, cfiRange, ctx, frame) {
  pendingSelection = {
    cfiRange,
    text: range.toString().trim(),
    context: { ...ctx, bookTitle: current.title, author: current.author },
  };
  showSelToolbar(range, frame);

  clearTimeout(autoTimer);
  // On a phone the selection grows by dragging handles, so it would fire on the first word: explain only on a tap.
  if (settings.autoExplain && !PHONE.matches) {
    // Short pause so a still-adjusting selection doesn't fire several requests.
    const snapshot = pendingSelection;
    autoTimer = setTimeout(() => {
      if (pendingSelection === snapshot) startExplanation(snapshot, { deep: false });
    }, 450);
  }
}

function showSelToolbar(range, frame) {
  const rect = range.getBoundingClientRect();
  const bar = $("#sel-toolbar");
  bar.classList.remove("hidden");
  // Phone (Safari and the app alike): the bar sits at the bottom of the screen (CSS), clear of
  // the system Copy / Translate menu, which the app cannot reliably hide either.
  // Desktop: above the selection, or below when there is no room.
  if (PHONE.matches) return bar.removeAttribute("style");
  const above = frame.top + rect.top - bar.offsetHeight - 8;
  const left = frame.left + rect.left + rect.width / 2 - bar.offsetWidth / 2;
  const top = Math.max(48, above < 48 ? frame.top + rect.bottom + 8 : above);
  bar.style.top = `${top}px`;
  bar.style.left = `${Math.min(Math.max(8, left), window.innerWidth - bar.offsetWidth - 8)}px`;
}

function hideSelToolbar() {
  $("#sel-toolbar").classList.add("hidden");
}

$("#sel-toolbar").addEventListener("mousedown", (e) => e.preventDefault());
$("#sel-toolbar").addEventListener("click", (e) => {
  const action = e.target.dataset.action;
  if (!action || !pendingSelection) return;
  clearTimeout(autoTimer);
  const snapshot = pendingSelection;
  if (action === "copy") {
    navigator.clipboard?.writeText(snapshot.text).catch(() => {});
  } else if (action === "note") {
    addNote(snapshot);
  } else {
    startExplanation(snapshot, { deep: false });
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

function startExplanation(selection, { deep }) {
  showPanel(true, "cards");
  $("#panel-empty")?.remove();

  // Same selection already explained the same way: just bring that card into view.
  for (const conv of conversations.values()) {
    if ((conv.cfiRange === selection.cfiRange || conv.context.selection === selection.context.selection) && conv.deep === deep) {
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

  const conv = { id, card, deep, cfiRange: selection.cfiRange, context: selection.context, messages: null, busy: false };
  conversations.set(id, conv);

  try {
    rendition.annotations.remove(selection.cfiRange, "highlight");
    rendition.annotations.highlight(selection.cfiRange, { id }, () => {
      showPanel(true, "cards");
      card.scrollIntoView({ behavior: "smooth", block: "nearest" });
      flash(card);
    }, "ai-hl", HIGHLIGHT_STYLE);
  } catch {
    /* highlighting is cosmetic */
  }

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

  runTurn(conv, null);
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
    request = { context: { ...conv.context, question: question || undefined }, deep: conv.deep };
  } else {
    request = { messages: [...conv.messages, { role: "user", content: question }], deep: conv.deep };
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
    if (conv.lastQuestion !== "Детальніше") conv.card.querySelector(".more").classList.remove("hidden");
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
(() => {
  const head = $("#panel .panel-head");
  const MIN = 0.15, MAX = 0.85;
  const setTop = (f) => document.body.style.setProperty("--panel-top", `${(Math.min(MAX, Math.max(MIN, f)) * 100).toFixed(1)}%`);
  try {
    const saved = Number(localStorage.getItem("panelTop"));
    if (saved) setTop(saved);
  } catch {}
  let drag = null;
  head.addEventListener("pointerdown", (e) => {
    if (!PHONE.matches || e.target.closest("button")) return;
    const box = $("#layout").getBoundingClientRect();
    drag = { box, id: e.pointerId };
    head.setPointerCapture(e.pointerId);
  });
  head.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.f = (e.clientY - drag.box.top) / drag.box.height;
    setTop(drag.f);
  });
  const end = () => {
    if (drag?.f) try { localStorage.setItem("panelTop", String(Math.min(MAX, Math.max(MIN, drag.f)))); } catch {}
    drag = null;
  };
  head.addEventListener("pointerup", end);
  head.addEventListener("pointercancel", end);
})();

function showPanel(show, tab) {
  document.body.classList.toggle("panel-hidden", !show);
  if (tab) showTab(tab);
  // epub.js needs a resize to reflow pages after the layout changes width.
  setTimeout(resizeView, 220);
}

$("#btn-clear").onclick = () => {
  for (const conv of conversations.values()) {
    if (conv.busy) window.reader.abort(conv.reqId);
    try {
      rendition?.annotations.remove(conv.cfiRange, "highlight");
    } catch {
      /* ignore */
    }
  }
  conversations.clear();
  $("#cards").innerHTML = `<div id="panel-empty" class="panel-empty">Виділіть текст у книжці, щоб отримати пояснення в контексті.</div>`;
};

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
// we draw pencil brackets in the margins around those lines instead, plus the note's emoji.
// The mark redraws itself on every relayout, so its render is wrapped once per mark.
function decorateNoteMarks() {
  const views = rendition?.views();
  for (const view of views?.all ? views.all() : views || []) {
    for (const { mark } of Object.values(view.underlines || {})) {
      if (mark.className !== "note-ul" || mark.bracketed) continue;
      const render = mark.render;
      mark.render = function () {
        render.call(this);
        drawBrackets(this);
      };
      mark.bracketed = true;
      mark.render();
    }
  }
}

// Redraw one note's marks after its emoji changed.
function redrawNote(note) {
  const views = rendition?.views();
  for (const view of views?.all ? views.all() : views || []) view.underlines?.[note.cfi]?.mark.render();
}

const SVG_NS = "http://www.w3.org/2000/svg";
// How a saved passage is marked in the text: "brackets" (pencil brackets in both margins),
// "bar" (one line in the left margin), "margin" (faint tint plus a dot or the emoji in the
// margin) or "pencil" (a wavy pencil underline).
let noteMarkStyle = "brackets";
function drawBrackets(mark) {
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
  const note = notes.find((n) => n.id === mark.data?.note);
  const add = (tag, attrs) => {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    g.appendChild(el);
    return el;
  };
  cols.forEach((col, i) => {
    const top = Math.min(...col.map((r) => r.y)) - 1;
    const bottom = Math.max(...col.map((r) => r.y + r.h)) + 1;
    const left = Math.min(...col.map((r) => r.x)) - 8;
    const right = Math.max(...col.map((r) => r.x + r.w)) + 8;
    const mid = (top + bottom) / 2;
    let emojiAt = [right, top];
    if (noteMarkStyle === "brackets") {
      const t = 9; // length of the bracket's ends; the spine bows out a little, like a pencil stroke
      add("path", { class: "bracket", d: `M${left + t},${top} Q${left},${top} ${left},${top + 5} Q${left - 1.5},${mid} ${left},${bottom - 5} Q${left},${bottom} ${left + t},${bottom}` });
      add("path", { class: "bracket", d: `M${right - t},${top} Q${right},${top} ${right},${top + 5} Q${right + 1.5},${mid} ${right},${bottom - 5} Q${right},${bottom} ${right - t},${bottom}` });
    } else if (noteMarkStyle === "bar") {
      add("path", { class: "bar", d: `M${left},${top + 3} Q${left - 1},${mid} ${left},${bottom - 3}` });
      emojiAt = [left, top - 2];
    } else if (noteMarkStyle === "margin") {
      for (const r of col) add("rect", { class: "tint", x: r.x - 2, y: r.y, width: r.w + 4, height: r.h, rx: 3 });
      if (i === 0 && !note?.emoji) add("circle", { class: "dot", cx: right + 1, cy: col[0].y + col[0].h / 2, r: 3 });
      emojiAt = [right + 1, col[0].y + col[0].h / 2];
    } else if (noteMarkStyle === "pencil") {
      for (const r of col) {
        const y = r.y + r.h + 1;
        let d = `M${r.x},${y}`;
        for (let x = r.x; x < r.x + r.w; x += 8) d += ` q2,-2 4,0 t4,0`;
        add("path", { class: "pencil", d });
      }
    }
    if (i === 0 && note?.emoji) {
      const emoji = add("text", { class: "note-emoji", x: emojiAt[0], y: emojiAt[1], "text-anchor": "middle", "dominant-baseline": "central" });
      emoji.textContent = note.emoji;
    }
  });
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
      <div class="emoji-picker hidden"></div>
      <div class="meta"><span class="where"></span>
        <span class="actions">
          <button class="link emoji-btn" title="Поставити емодзі"></button>
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
    wireEmoji(card, note);
    const comment = card.querySelector(".note-comment");
    comment.value = note.comment || "";
    comment.oninput = () => fitComment(comment);
    comment.onchange = async () => {
      note.comment = comment.value.trim();
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

const EMOJIS = ["❤️", "👏", "🚬", "😂", "🤔", "🔥", "😢", "‼️"];

// The emoji button opens a row of common ones plus a field for any other (the phone's emoji keyboard).
function wireEmoji(card, note) {
  const btn = card.querySelector(".emoji-btn");
  const picker = card.querySelector(".emoji-picker");
  btn.textContent = note.emoji || "☺︎ +";
  btn.classList.toggle("set", !!note.emoji);
  btn.onclick = () => {
    if (!picker.classList.toggle("hidden") && !picker.childElementCount) {
      for (const e of EMOJIS) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = e;
        b.onclick = () => setEmoji(note, note.emoji === e ? "" : e);
        picker.appendChild(b);
      }
      const other = document.createElement("input");
      other.placeholder = "інший";
      other.maxLength = 16;
      other.onchange = () => other.value.trim() && setEmoji(note, other.value.trim());
      picker.appendChild(other);
      if (note.emoji) {
        const off = document.createElement("button");
        off.type = "button";
        off.className = "link";
        off.textContent = "Прибрати";
        off.onclick = () => setEmoji(note, "");
        picker.appendChild(off);
      }
    }
  };
}

async function setEmoji(note, emoji) {
  const before = note.emoji || "";
  note.emoji = emoji;
  renderNotes();
  redrawNote(note);
  try {
    await notesStore.notesUpdate(current.path, note.id, { emoji });
  } catch (err) {
    note.emoji = before;
    renderNotes();
    redrawNote(note);
    if (err.message !== "login") showNotice(`Не вдалося зберегти емодзі: ${err.message}`, false);
  }
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

async function setTheme(theme) {
  document.body.dataset.theme = theme;
  $("#theme-select").value = theme;
  rendition?.themes.select(theme);
  settings = await window.reader.setSettings({ theme });
}
$("#theme-select").onchange = (e) => setTheme(e.target.value);
// Phones have no room for the select, so a toolbar button cycles light → sepia → dark.
const THEME_ORDER = ["light", "sepia", "dark"];
$("#btn-theme").onclick = () => setTheme(THEME_ORDER[(THEME_ORDER.indexOf(settings.theme) + 1) % THEME_ORDER.length]);

document.addEventListener("keyup", onKey);
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

window.reader.onBookOpen((payload) => openBook(payload).catch((err) => alert(`Не вдалося відкрити книжку: ${err.message}`)));
window.reader.onShowSettings(openSettings);
window.reader.onBookConverting((name) => showNotice(`Конвертую «${name}» через Calibre…`, true));
window.reader.onBookError((message) => showNotice(message, false));

function showNotice(text, busy) {
  const box = $("#notice");
  box.querySelector(".notice-text").textContent = text;
  box.classList.toggle("busy", busy);
  box.classList.remove("hidden");
}
window.reader.onTogglePanel(() => showPanel(document.body.classList.contains("panel-hidden")));

settingsReady = loadSettings();
settingsReady.then(() => {
  if (!settings.hasApiKey) setTimeout(openSettings, 300);
});

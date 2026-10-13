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
  const fontChanged = patch.font !== settings.font;
  const marginsChanged = patch.margins !== (settings.margins || "normal");
  const wasScrolled = scrolled();
  settings = await window.reader.setSettings(patch);
  if (wasScrolled !== scrolled()) return reopenBook();
  document.body.dataset.margins = settings.margins || "normal";
  if (marginsChanged) (pdfView || rendition)?.resize();
  if (fontChanged) applyTypography(true);
});
$("#btn-logout").onclick = () => window.reader.logout?.();

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
  setTimeout(() => (pdfView || rendition)?.resize(), 50);
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
  // Phones: the bar sits at the bottom of the screen (CSS), clear of the system Copy / Look Up menu.
  if (PHONE.matches) return bar.removeAttribute("style");
  const top = frame.top + rect.top - bar.offsetHeight - 8;
  const left = frame.left + rect.left + rect.width / 2 - bar.offsetWidth / 2;
  bar.style.top = `${Math.max(48, top < 48 ? frame.top + rect.bottom + 8 : top)}px`;
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
  if (action === "ask") {
    const card = startExplanation(snapshot, { deep: false, askOnly: true });
    card?.querySelector(".followup input")?.focus();
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

function startExplanation(selection, { deep, askOnly = false }) {
  showPanel(true);
  $("#panel-empty")?.remove();

  // Same selection already explained the same way: just bring that card into view.
  for (const conv of conversations.values()) {
    if ((conv.cfiRange === selection.cfiRange || conv.context.selection === selection.context.selection) && conv.deep === deep && !askOnly) {
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
      showPanel(true);
      card.scrollIntoView({ behavior: "smooth", block: "nearest" });
      flash(card);
    }, "ai-hl", HIGHLIGHT_STYLE);
  } catch {
    /* highlighting is cosmetic */
  }

  card.querySelector(".stop").onclick = () => window.reader.abort(conv.reqId);
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

  if (!askOnly) runTurn(conv, null);
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

function showPanel(show) {
  document.body.classList.toggle("panel-hidden", !show);
  // epub.js needs a resize to reflow pages after the layout changes width.
  setTimeout(() => (pdfView || rendition)?.resize(), 220);
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
$("#btn-panel").onclick = () => showPanel(document.body.classList.contains("panel-hidden"));
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

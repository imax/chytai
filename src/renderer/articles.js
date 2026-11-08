// «Статті» in the reader (Max, 2026-11-08: «читати прямо в ній, і може без epub»). The articles live on
// chytai.org.ua (/articles); here they open like a book: the reader's server shows an article's text to epub.js as
// an unpacked book made on the fly (/api/abook/<slug>/…), so the reading screen, «Зміст», «Аа», «Пояснити» and
// «Зберегти» are the book's own. What a reader does in an article goes to the site's tables, not to the reader's:
// explanations (shared, like the site's margins), highlights and their notes (public there, as on the site) and
// the paragraph reached. This file sits between the reader's screen and web-bridge.js: for a path «article:<slug>»
// it answers the bridge's calls itself, and leaves every book to the bridge.
(() => {
  const R = window.reader;
  if (!R || typeof R.libraryList !== "function" || !document.body.classList.contains("web")) return;
  const PREFIX = "article:";
  const isArticle = (p) => typeof p === "string" && p.startsWith(PREFIX);
  const slugOf = (p) => String(p).slice(PREFIX.length);

  async function call(method, url, body) {
    const res = await fetch(url, { method, credentials: "same-origin", headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 401) {
      location.href = "/login";
      throw new Error("login");
    }
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.error) throw new Error(j.error || `HTTP ${res.status}`);
    return j;
  }

  // The renderer's listeners for an opened book and for an explanation's answer, kept to call them here too.
  const openers = [];
  const aiListeners = [];
  const onBookOpen = R.onBookOpen;
  R.onBookOpen = (cb) => (openers.push(cb), onBookOpen(cb));
  const onAiEvent = R.onAiEvent;
  R.onAiEvent = (cb) => (aiListeners.push(cb), onAiEvent(cb));
  const aiSend = (id, ev) => aiListeners.forEach((cb) => cb(id, ev));

  // ---------- The open article: its text as a document, to turn a passage into a place and back ----------
  // A CFI is how the reading screen marks and finds a passage; the site knows a passage by its paragraph and words.
  const open = new Map(); // slug -> { info, doc }
  const CFI_BASE = "/6/2[text]"; // the one chapter: the spine's first item, id «text» (server/index.js articleEntry)
  async function textDoc(slug) {
    const res = await fetch(`/api/abook/${encodeURIComponent(slug)}/OEBPS/text.xhtml`, { credentials: "same-origin" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return new DOMParser().parseFromString(await res.text(), "application/xhtml+xml");
  }
  function blockOfCfi(doc, cfi) {
    try {
      const range = new ePub.CFI(cfi).toRange(doc);
      const el = range?.startContainer?.nodeType === 1 ? range.startContainer : range?.startContainer?.parentElement;
      const b = el?.closest?.("[data-block]");
      return b ? Number(b.getAttribute("data-block")) : null;
    } catch {
      return null;
    }
  }
  // The quote's words in its paragraph, as a range: the text nodes walked in order, whitespace taken as it comes.
  function cfiOf(doc, block, quote) {
    const el = doc.querySelector(`[data-block="${block}"]`);
    if (!el) return null;
    const nodes = [];
    const walk = doc.createTreeWalker(el, 4);
    let text = "";
    while (walk.nextNode()) nodes.push([walk.currentNode, text.length]), (text += walk.currentNode.nodeValue);
    const squash = (s) => s.replace(/\s+/g, " ");
    // Map positions in the squashed text back to the real one.
    const map = [];
    let flat = "";
    for (let i = 0; i < text.length; i++) {
      if (/\s/.test(text[i]) && /\s$/.test(flat)) continue;
      map.push(i);
      flat += /\s/.test(text[i]) ? " " : text[i];
    }
    const at = flat.indexOf(squash(String(quote).trim()));
    if (at < 0) return null;
    const from = map[at];
    const to = map[at + squash(String(quote).trim()).length - 1] + 1;
    const point = (pos) => {
      let n = nodes[0];
      for (const x of nodes) if (x[1] <= pos) n = x;
      return [n[0], Math.min(pos - n[1], n[0].nodeValue.length)];
    };
    try {
      const range = doc.createRange();
      range.setStart(...point(from));
      range.setEnd(...point(to));
      return new ePub.CFI(range, CFI_BASE).toString();
    } catch {
      return null;
    }
  }

  async function openArticle(slug) {
    const box = document.getElementById("notice");
    const slow = setTimeout(() => typeof showNotice === "function" && showNotice("Відкриваю статтю…", true), 400);
    try {
      const [info, doc] = await Promise.all([call("GET", `/api/articles/${encodeURIComponent(slug)}`), textDoc(slug)]);
      open.set(slug, { info, doc });
      const kept = await localPlace(slug);
      const position = kept || (info.read && info.read.block > 1 ? `text.xhtml#p${info.read.block + 1}` : null);
      const payload = { path: PREFIX + slug, name: info.title, url: new URL(`/api/abook/${encodeURIComponent(slug)}/`, location.href).href, article: slug, position };
      openers.forEach((cb) => cb(payload));
    } catch (err) {
      if (err.message !== "login") typeof showNotice === "function" && showNotice(err instanceof TypeError ? "Немає з'єднання: статті поки відкриваються лише онлайн." : `Не вдалося відкрити статтю: ${err.message}`, false);
    } finally {
      clearTimeout(slow);
      if (box?.querySelector(".notice-text")?.textContent === "Відкриваю статтю…") box.classList.add("hidden");
    }
  }

  // ---------- The place read: on this device exactly, on the site by paragraph ----------
  const PLACES = "chytai:article-places";
  const PLACES_MAX = 100; // the oldest go: a few bytes each, never more than this many
  function places() {
    try {
      return JSON.parse(localStorage.getItem(PLACES)) || {};
    } catch {
      return {};
    }
  }
  async function localPlace(slug) {
    return places()[slug]?.cfi || null;
  }
  let readTimer = null;
  function keepPlace(slug, cfi) {
    const all = places();
    all[slug] = { cfi, at: Date.now() };
    const keys = Object.keys(all).sort((a, b) => all[b].at - all[a].at);
    for (const k of keys.slice(PLACES_MAX)) delete all[k];
    try {
      localStorage.setItem(PLACES, JSON.stringify(all));
    } catch {}
    clearTimeout(readTimer);
    readTimer = setTimeout(() => {
      const doc = open.get(slug)?.doc;
      const block = doc && blockOfCfi(doc, cfi);
      if (Number.isInteger(block)) call("POST", `/api/articles/${encodeURIComponent(slug)}/read`, { block }).catch(() => {});
    }, 1500);
  }

  // ---------- The bridge's calls for an article ----------
  const wrap = (name, fn) => {
    const orig = R[name];
    R[name] = (path, ...rest) => (isArticle(path) ? fn(slugOf(path), ...rest) : orig?.(path, ...rest));
  };
  const openPath = R.openPath;
  R.openPath = (target) => (isArticle(target) ? openArticle(slugOf(target)) : openPath(target));
  wrap("savePosition", (slug, cfi) => {
    window.ReadingTime?.poke();
    if (typeof cfi === "string" && !cfi.startsWith("pdf:")) keepPlace(slug, cfi);
  });
  const noteOf = (slug, h) => ({ id: h.id, cfi: cfiOf(open.get(slug).doc, h.block, h.quote), posKey: PREFIX + slug, text: h.quote, comment: h.note || "", chapter: "", createdAt: Date.parse(h.at) || Date.now(), block: h.block });
  wrap("notesList", async (slug) => {
    const a = open.get(slug);
    if (!a) return [];
    return (a.info.highlights || []).map((h) => noteOf(slug, h)).filter((n) => n.cfi);
  });
  wrap("notesAdd", async (slug, note) => {
    const a = open.get(slug);
    const block = a && blockOfCfi(a.doc, note.cfi);
    if (!Number.isInteger(block)) throw new Error("Не вдалося знайти абзац.");
    const h = await call("POST", `/api/articles/${encodeURIComponent(slug)}/highlight`, { block, quote: note.text });
    a.info.highlights = [...(a.info.highlights || []).filter((x) => x.id !== h.id), h];
    return { ...noteOf(slug, h), cfi: note.cfi };
  });
  wrap("notesUpdate", async (slug, id, patch) => {
    if (typeof patch?.comment !== "string") return;
    await call("POST", `/api/articles/hl/${encodeURIComponent(id)}/note`, { note: patch.comment });
  });
  wrap("notesDelete", async (slug, id) => {
    await call("POST", `/api/articles/hl/${encodeURIComponent(id)}/delete`);
  });
  // Explanations are the site's, everyone's: they come with the article and are kept there, never here.
  wrap("chatsList", async (slug) => {
    const a = open.get(slug);
    if (!a) return [];
    return (a.info.explanations || []).map((e) => ({ id: `ae-${e.id}`, cfi: cfiOf(a.doc, e.block, e.quote), posKey: PREFIX + slug, mode: "explain", sel: e.quote, chapter: "", turns: [{ q: "", a: e.text }], messages: null, model: e.model || "", at: Date.parse(e.at) || 0 })).filter((c) => c.cfi);
  });
  wrap("chatSave", async () => {});
  wrap("chatDelete", async () => {});
  wrap("chatsClear", async () => {});
  const explain = R.explain;
  R.explain = async (id, request) => {
    if (!request?.article) return explain(id, request);
    const slug = request.article;
    const a = open.get(slug);
    try {
      if (request.context?.question) throw new Error("У статтях поки можна лише «Пояснити».");
      const block = a && blockOfCfi(a.doc, request.cfi);
      if (!Number.isInteger(block)) throw new Error("Не вдалося знайти абзац.");
      const e = await call("POST", `/api/articles/${encodeURIComponent(slug)}/explain`, { block, quote: request.context?.selection || "" });
      a.info.explanations = [...(a.info.explanations || []).filter((x) => x.id !== e.id), e];
      aiSend(id, { type: "text", text: e.text });
      aiSend(id, { type: "done", messages: null, model: e.model });
    } catch (err) {
      if (err.message === "login") return;
      aiSend(id, { type: "error", message: err instanceof TypeError ? "Немає з'єднання з інтернетом. Пояснення з'являться, коли мережа повернеться." : err.message });
    }
  };

  // ---------- The list, for the «Статті» page (home.js) ----------
  R.articlesList = () => call("GET", "/api/articles");
  R.articleAdd = (url) => call("POST", "/api/articles", { url });
  R.articleLater = (slug, on) => call("POST", `/api/articles/${encodeURIComponent(slug)}/later`, { on });
  R.articleDrop = (slug) => call("POST", `/api/articles/${encodeURIComponent(slug)}/drop`);
  R.articleUndrop = (slug, later) => call("POST", `/api/articles/${encodeURIComponent(slug)}/undrop`, { later });
})();

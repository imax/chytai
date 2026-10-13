/* global $, book, rendition, pdfView, chapterTitle */
// ⌘F: full-text search across the open book (EPUB, reflowed PDF or original PDF).
(function () {
  const MAX_RESULTS = 500;
  const SEARCH_HL = { fill: "#ff9f1a", "fill-opacity": "0.45", "mix-blend-mode": "multiply" };
  const state = { query: "", results: [], index: -1, token: 0, highlighted: null };

  const box = $("#search");
  const input = $("#search-input");
  const list = $("#search-results");
  const count = $("#search-count");

  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  function open() {
    if (!book && !pdfView) return;
    box.classList.remove("hidden");
    input.focus();
    input.select();
  }

  function close() {
    state.token++;
    box.classList.add("hidden");
    clearHighlight();
    pdfView?.clearMatches();
  }

  function clearHighlight() {
    if (state.highlighted && rendition) {
      try {
        rendition.annotations.remove(state.highlighted, "highlight");
      } catch {
        /* already gone */
      }
    }
    state.highlighted = null;
  }

  function renderCount(done) {
    const n = state.results.length;
    if (!state.query) count.textContent = "";
    else if (!n) count.textContent = done ? "немає збігів" : "шукаю…";
    else count.textContent = `${state.index >= 0 ? state.index + 1 + " з " : ""}${n}${n >= MAX_RESULTS ? "+" : ""}${done ? "" : "…"}`;
  }

  function addResult(r) {
    const i = state.results.length;
    state.results.push(r);
    const li = document.createElement("li");
    // Excerpt with the match marked (case-insensitive).
    const lower = r.excerpt.toLowerCase();
    const at = lower.indexOf(state.query.toLowerCase());
    const html =
      at < 0
        ? esc(r.excerpt)
        : `${at > 0 ? "…" : ""}${esc(r.excerpt.slice(0, at))}<mark>${esc(r.excerpt.slice(at, at + state.query.length))}</mark>${esc(r.excerpt.slice(at + state.query.length))}…`;
    li.innerHTML = `<span class="where">${esc(r.where || "")}</span>${html}`;
    li.onclick = () => go(i);
    list.appendChild(li);
  }

  async function run(query) {
    const token = ++state.token;
    const cancelled = () => token !== state.token;
    state.query = query;
    state.results = [];
    state.index = -1;
    list.innerHTML = "";
    clearHighlight();
    if (!query || query.length < 2) return renderCount(true);
    renderCount(false);

    if (pdfView) {
      await pdfView.search(
        query,
        (r) => {
          if (cancelled() || state.results.length >= MAX_RESULTS) return;
          addResult({ page: r.page, excerpt: r.excerpt, where: `Сторінка ${r.page}` });
          renderCount(false);
        },
        () => cancelled() || state.results.length >= MAX_RESULTS
      );
    } else if (book) {
      for (const item of book.spine.spineItems) {
        if (cancelled() || state.results.length >= MAX_RESULTS) break;
        try {
          await item.load(book.load.bind(book));
          const found = item.find(query) || [];
          const where = chapterTitle(item.href);
          for (const f of found) {
            if (state.results.length >= MAX_RESULTS) break;
            addResult({ cfi: f.cfi, excerpt: f.excerpt.trim(), where });
          }
        } catch (err) {
          console.warn("search failed in", item.href, err);
        } finally {
          item.unload();
        }
        renderCount(false);
        await new Promise((r) => setTimeout(r, 0)); // keep the UI responsive on big books
      }
    }
    if (!cancelled()) renderCount(true);
  }

  async function go(i) {
    if (!state.results.length) return;
    state.index = (i + state.results.length) % state.results.length;
    const r = state.results[state.index];
    list.querySelectorAll("li.active").forEach((li) => li.classList.remove("active"));
    const li = list.children[state.index];
    li?.classList.add("active");
    li?.scrollIntoView({ block: "nearest" });
    renderCount(true);

    if (pdfView && r.page) {
      pdfView.showMatch(state.query, r.page);
    } else if (rendition && r.cfi) {
      clearHighlight();
      await rendition.display(r.cfi);
      try {
        rendition.annotations.highlight(r.cfi, {}, null, "search-hl", SEARCH_HL);
        state.highlighted = r.cfi;
      } catch {
        /* cosmetic */
      }
    }
  }

  let debounce = null;
  input.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => run(input.value.trim()), 250);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      close();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (input.value.trim() !== state.query) run(input.value.trim()).then(() => go(0));
      else go(state.index + (e.shiftKey ? -1 : 1));
    }
  });
  $("#search-next").onclick = () => go(state.index + 1);
  $("#search-prev").onclick = () => go(state.index - 1);
  $("#search-close").onclick = close;

  // A different book was opened: old results no longer apply.
  new MutationObserver(() => {
    close();
    input.value = "";
    state.query = "";
    list.innerHTML = "";
    count.textContent = "";
  }).observe($("#book-title"), { childList: true, characterData: true, subtree: true });

  window.reader.onFind((action) => {
    if (action === "open") open();
    else if (box.classList.contains("hidden")) open();
    else go(state.index + (action === "prev" ? -1 : 1));
  });
})();

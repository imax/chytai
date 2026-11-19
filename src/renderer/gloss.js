// «Словничок» (Max, 2026-11-15): in a free-shelf classic or a reader's upload that has one (server/glossary.js), the old and dialect
// words are underlined with dots, and a tap or a click on one shows its meaning in a small card over the word.
// The underline is a CSS Custom Highlight: the book's DOM is not touched, so positions, notes and selections stay
// as they were. Browsers without it (iOS before 17.2) get no underline and no card. Off in «Аа» → «Словничок».
window.Gloss = (() => {
  // Only the stress marks go: й and ї carry marks of their own in NFD.
  const key = (s) => String(s || "").normalize("NFD").replace(/[\u0300\u0301]/g, "").normalize("NFC").toLowerCase().replace(/['’`ʼ]/g, "ʼ");
  // A word: letters, stress marks, apostrophes and hyphens inside it.
  const WORD = /[\p{L}\p{M}]+(?:['’`ʼ-][\p{L}\p{M}]+)*/gu;
  let forms = null; // key -> meaning, for the book on screen
  // «Словничок 2»: key -> 1 (the sentence is unclear without it) or 2 (a hint helps), and key -> the
  // word's dictionary form, which «Знаю» keeps (settings.glossKnown: every form of it goes).
  let levels = null;
  let words = null;
  // The book's people and places: key -> [who or what, the full name] (server/glossary.js buildNames). Never
  // underlined; the card of a selected capitalised word reads them, so it doesn't make up who «Васюта» is.
  let names = null;
  let contentsOf = () => [];
  let longest = 1; // words in the longest expression
  let book = null;
  const marked = new WeakMap(); // a chapter's document -> [{ range, text, gloss }]
  const tip = document.getElementById("gloss-tip");
  let shown = null; // { doc }

  const enabled = () => !!forms && settings.gloss !== "off";
  const wordOf = (k) => words?.[k] || k;
  // «Менше» (on) underlines level 1 only, «Більше» (more) both; a reader's known words never.
  const visible = (k, known) => (!levels || levels[k] !== 2 || settings.gloss === "more") && !known.has(wordOf(k));

  // Called when a book opens; marks the chapters already on screen once the list is in.
  let seen = false;
  async function load(name, contentsList) {
    forms = null;
    levels = null;
    words = null;
    names = null;
    book = name;
    seen = false;
    contentsOf = contentsList || (() => []);
    hide();
    sentAt = null;
    quiet = false;
    clearTimeout(again);
    // Any EPUB may have one, made by parts once asked for (Max 2026-11-18): asked each time, but not a publisher's.
    if (!name || !/\.epub$/i.test(name) || (settings.protectedBooks || []).includes(name)) return;
    await fetchList(name);
  }
  async function fetchList(name) {
    try {
      const res = await fetch(`/api/glossary?book=${encodeURIComponent(name)}`, { credentials: "same-origin" });
      if (!res.ok || book !== name) return;
      const data = await res.json();
      if (book !== name) return;
      forms = data.forms || {};
      levels = data.levels || null;
      words = data.words || null;
      names = data.names || null;
      longest = Math.max(1, ...Object.keys(forms).map((k) => k.split(" ").length));
    } catch {
      return;
    }
    // A book opened with a list on (/admin/reader «Функції»: readers who had underlined words vs those who tapped one).
    if (!seen && enabled() && Object.keys(forms).length) seen = true, window.ReadingTime?.count("gloss-book");
    for (const c of contentsOf() || []) mark(c);
  }

  // Where the reader is (renderer.js onRelocated, 0..100): the server makes the list's part there and the next ones
  // if they are missing (server/glossary.js `ahead`); once they are made, the list is asked again and marked. Sent
  // when the place moved by 2% or more.
  let sentAt = null;
  let quiet = false;
  let again = 0;
  async function at(pct) {
    if (!book || !/\.epub$/i.test(book) || (settings.protectedBooks || []).includes(book) || !Number.isFinite(pct)) return;
    if (quiet || (sentAt != null && Math.abs(pct - sentAt) < 2)) return;
    sentAt = pct;
    const name = book;
    try {
      const res = await fetch("/api/glossary/at", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ book: name, pct }) });
      const r = await res.json();
      if (book !== name) return;
      if (r.none || r.off) quiet = true; // no list asked for: nothing to send until the book opens again
      if (r.started || r.busy || r.progress?.building) wait(name, 0);
    } catch {}
  }
  // A part takes Opus a minute or two: the list is asked again then, a few times while it is being made.
  function wait(name, tries) {
    clearTimeout(again);
    again = setTimeout(async () => {
      if (book !== name) return;
      await fetchList(name);
      try {
        const p = await (await fetch(`/api/glossary/status?book=${encodeURIComponent(name)}`, { credentials: "same-origin" })).json();
        if (p.building && tries < 8) wait(name, tries + 1);
      } catch {}
    }, tries ? 60000 : 90000);
  }

  function style(contents) {
    const doc = contents.document;
    let el = doc.getElementById("chytai-gloss");
    if (!el) {
      el = doc.createElement("style");
      el.id = "chytai-gloss";
      doc.head.appendChild(el);
    }
    const css = getComputedStyle(document.body);
    const line = css.getPropertyValue("--m-bar").trim() || "#b5803a";
    const hit = css.getPropertyValue("--m-hit").trim() || "#f0dca9";
    el.textContent = `::highlight(gl){text-decoration:underline dotted ${line};text-decoration-thickness:2px;text-underline-offset:0.22em}::highlight(gl-on){background-color:${hit}}`;
  }

  function mark(contents) {
    const doc = contents.document;
    const win = contents.window;
    if (!doc?.body) return;
    win.CSS?.highlights?.delete("gl");
    win.CSS?.highlights?.delete("gl-on");
    marked.delete(doc);
    if (!enabled() || !win.CSS?.highlights || !win.Highlight) return;
    style(contents);
    const found = [];
    const seen = new Set();
    const known = new Set(settings.glossKnown || []); // a word is underlined the first time in a chapter only: «од» 187 times was a page of dots
    const walk = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    for (let node = walk.nextNode(); node; node = walk.nextNode()) {
      const text = node.data;
      if (text.length < 2) continue;
      const words = [...text.matchAll(WORD)];
      for (let i = 0; i < words.length; ) {
        let took = 0;
        // The longest expression first: «по всій Україні» before «всій».
        for (let n = Math.min(longest, words.length - i); n >= 1 && !took; n--) {
          const first = words[i];
          const last = words[i + n - 1];
          const span = text.slice(first.index, last.index + last[0].length);
          if (n > 1 && /[^\s\p{L}\p{M}'’`ʼ-]/u.test(span)) continue; // only spaces between the words
          const k = key(span).replace(/\s+/g, " ");
          const gloss = forms?.[k];
          if (!gloss) continue;
          took = n;
          // Once a chapter for each word and meaning: «зимовник» of bees and of a steppe homestead are two.
          const once = `${wordOf(k)}|${gloss}`;
          if (seen.has(once) || !visible(k, known)) continue;
          seen.add(once);
          const range = doc.createRange();
          range.setStart(node, first.index);
          range.setEnd(node, last.index + last[0].length);
          found.push({ range, text: span.replace(/\u0301/g, ""), gloss, k });
        }
        i += took || 1;
      }
    }
    marked.set(doc, found);
    if (found.length) win.CSS.highlights.set("gl", new win.Highlight(...found.map((f) => f.range)));
  }

  // A tap or a click at (x, y) inside a chapter's frame: shows the card when it is on a marked word.
  function tap(x, y, doc) {
    const was = shown;
    hide();
    const list = doc && marked.get(doc);
    if (!list?.length) return false;
    const inside = (r) => [...r.getClientRects()].some((b) => x >= b.left - 3 && x <= b.right + 3 && y >= b.top - 4 && y <= b.bottom + 4);
    const hit = list.find((f) => inside(f.range));
    if (!hit) return !!was; // a tap that only put the card away does not turn the page
    show(hit, doc);
    return true;
  }

  function show(hit, doc) {
    window.ReadingTime?.count("gloss");
    const win = doc.defaultView;
    win.CSS.highlights.set("gl-on", new win.Highlight(hit.range));
    tip.replaceChildren();
    const b = document.createElement("b");
    b.textContent = hit.text;
    tip.append(b, ` — ${hit.gloss}`);
    {
      // «Більше не показувати» (was «Знаю це слово», often a phrase): not underlined for this reader any more, in this
      // book and every other; on every card.
      const know = document.createElement("button");
      know.type = "button";
      know.className = "gl-know";
      know.dataset.act = "gloss-know";
      know.textContent = "Більше не показувати"; // often a phrase, not a word (Max 2026-11-17)
      know.onclick = () => {
        const list = [...(settings.glossKnown || []).filter((w) => w !== wordOf(hit.k)), wordOf(hit.k)].slice(-3000);
        settings.glossKnown = list;
        window.reader.setSettings({ glossKnown: list }).catch(() => {});
        hide();
        for (const c of contentsOf() || []) mark(c);
      };
      tip.append(know);
    }
    tip.classList.remove("hidden");
    const frame = win.frameElement?.getBoundingClientRect() || { left: 0, top: 0 };
    const r = hit.range.getClientRects()[0] || hit.range.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const left = Math.min(Math.max(8, frame.left + r.left + r.width / 2 - w / 2), innerWidth - w - 8);
    const above = frame.top + r.top - h - 10;
    tip.style.left = `${left}px`;
    tip.style.top = `${above >= 8 ? above : frame.top + r.bottom + 10}px`;
    shown = { doc };
  }

  function hide() {
    if (!shown) return;
    shown.doc.defaultView?.CSS?.highlights?.delete("gl-on");
    shown = null;
    tip.classList.add("hidden");
  }

  // A tap anywhere outside the book's frames (the bars, the margins) puts the card away.
  addEventListener("pointerdown", (e) => !e.target.closest?.("#gloss-tip") && hide(), true);

  // The book's meaning of a selected word or expression, any level (renderer.js shows it at once on the card).
  // A capitalised word that is one of the book's names reads the names first («Тур» is Кирило Тур, «тур» a wild ox);
  // a full name of two words or more comes before what it says («Васюті — Васюта Ніженський, ніжинський полковник»).
  const lookup = (text) => {
    const k = key(text).replace(/\s+/g, " ").trim();
    const n = /^\p{Lu}/u.test(text.trim()) && names?.[k];
    if (n) return { text: text.trim(), gloss: n[1].includes(" ") && key(n[1]) !== k ? `${n[1]}, ${n[0]}` : n[0], name: true };
    return forms?.[k] ? { text: text.trim(), gloss: forms[k] } : null;
  };

  return { load, at, mark, style: (c) => enabled() && marked.has(c.document) && style(c), tap, hide, lookup, has: () => !!forms, levels: () => !!levels };
})();

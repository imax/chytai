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
  let contentsOf = () => [];
  let longest = 1; // words in the longest expression
  let book = null;
  // Words ahead (Max 2026-11-17: «щоб було підсвічене як словник», then «вмикай» for everyone signed in): the words
  // Sonnet prepared for the passages around the reader (word-ahead.js) are underlined the same way, after the book's own list.
  // Off again (Max 2026-11-17, an hour after turning it on: «ліки», «демони» underlined, «підказки тупі», «треба було зі
  // словником залишатись»). The words ahead only make a selected word's card instant. The code stays: set it to true
  // to underline them again (only level 1 in «Менше», never in a book with its own list).
  const UNDERLINE_AHEAD = false;
  let ahead = new Map();
  let aheadBase = new Map(); // key -> the word's dictionary form, for «Більше не показувати»
  let aheadLevel = new Map(); // key -> 1 (the sentence is unclear without it) | 2; none = 2
  const marked = new WeakMap(); // a chapter's document -> [{ range, text, gloss }]
  const tip = document.getElementById("gloss-tip");
  let shown = null; // { doc }

  const enabled = () => (!!forms || ahead.size > 0) && settings.gloss !== "off";
  const wordOf = (k) => words?.[k] || aheadBase.get(k) || k;
  // «Менше» (on) underlines level 1 only, «Більше» (more) both; a reader's known words never.
  const level = (k) => (forms?.[k] ? (levels ? levels[k] : 1) : aheadLevel.get(k) || 2);
  const visible = (k, known) => (level(k) !== 2 || settings.gloss === "more") && !known.has(wordOf(k));

  // Called when a book opens; marks the chapters already on screen once the list is in.
  async function load(name, contentsList) {
    forms = null;
    levels = null;
    words = null;
    ahead = new Map();
    aheadBase = new Map();
    aheadLevel = new Map();
    book = name;
    contentsOf = contentsList || (() => []);
    hide();
    // A reader's own upload may have got one since the page loaded (made in the background): asked each time.
    const own = !settings.guest && /\.epub$/i.test(name || "") && !(settings.freeBooks || []).includes(name);
    if (!name || !((settings.glossaries || []).includes(name) || own)) return;
    try {
      const res = await fetch(`/api/glossary?book=${encodeURIComponent(name)}`, { credentials: "same-origin" });
      if (!res.ok || book !== name) return;
      const data = await res.json();
      forms = data.forms || {};
      levels = data.levels || null;
      words = data.words || null;
      longest = Math.max(1, ...Object.keys(forms).map((k) => k.split(" ").length));
    } catch {
      return;
    }
    for (const c of contentsList() || []) mark(c);
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
          // A book with its own list underlines only that list (Max 2026-11-17: the words ahead added «ліки», «демони»);
          // its words ahead still make a selected word's card instant (word-ahead.js).
          const gloss = forms ? forms[k] : ahead.get(k);
          if (!gloss) continue;
          took = n;
          // Once a chapter for each word and meaning: «зимовник» of bees and of a steppe homestead are two.
          const once = `${wordOf(k)}|${gloss}`;
          if (seen.has(once) || !visible(k, known)) continue;
          seen.add(once);
          const range = doc.createRange();
          range.setStart(node, first.index);
          range.setEnd(node, last.index + last[0].length);
          found.push({ range, text: span.replace(/\u0301/g, ""), gloss, k, ahead: !forms?.[k] });
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
    window.ReadingTime?.count(hit.ahead ? "gloss-ahead" : "gloss");
    const win = doc.defaultView;
    win.CSS.highlights.set("gl-on", new win.Highlight(hit.range));
    tip.replaceChildren();
    const b = document.createElement("b");
    b.textContent = hit.text;
    tip.append(b, ` — ${hit.gloss}`);
    {
      // «Більше не показувати» (was «Знаю це слово»): not underlined for this reader any more, in this book and every other. On every card, the
      // book's list and the words prepared ahead alike (Max 2026-11-17: one «Словничок», not two kinds of dots).
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
  const lookup = (text) => {
    const k = key(text).replace(/\s+/g, " ").trim();
    return forms?.[k] ? { text: text.trim(), gloss: forms[k] } : null;
  };

  // New words ready ahead: underline them in the chapters on screen too.
  function addAhead(map, base, lv) {
    if (!UNDERLINE_AHEAD || settings.guest || !map) return;
    let added = 0;
    for (const [w, m] of Object.entries(map)) {
      const k = key(w).replace(/\s+/g, " ").trim();
      if (!k || !m || forms?.[k] || ahead.has(k)) continue;
      ahead.set(k, m);
      if (base?.[w]) aheadBase.set(k, key(base[w]));
      if (lv?.[w]) aheadLevel.set(k, lv[w]);
      added++;
    }
    if (added) for (const c of contentsOf() || []) mark(c);
  }

  return { load, mark, addAhead, style: (c) => enabled() && marked.has(c.document) && style(c), tap, hide, lookup, has: () => !!forms || ahead.size > 0, levels: () => !!levels || (!forms && ahead.size > 0) };
})();

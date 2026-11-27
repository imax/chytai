// «Згадані книжки» (Max 2026-11-26, variants А + 1 of canvas Tr7MtCsSnwRHxpKUgyDuTS): books named in explanations and
// in the book's text, so they don't get lost.
// - Explanations: Opus writes a title as [«Уліссі»](book:Джеймс Джойс|Улісс) (src/ai.js); `prep` / `post` (renderer.js
//   md) make it a tappable title (a.bk). Explanations kept before the links get theirs from the list the server keeps
//   (`q` = the words in the answer that name the book; server/mentions.js `fromChats`).
// - The text: a chapter's titles from the server (Haiku, once a file for every reader), the first place of each in the
//   chapter underlined with a solid line (a CSS Custom Highlight, as «Словничок»: the book's DOM is not touched).
//   «Аа» → «Згадані книжки» → «Ні» takes the lines away (`mentions`, per device); the titles are still kept.
// - A tap on either: the book's card (paper.js Paper.card): where it was met, where to get it (want.js Want.where),
//   «Про книжку», «Хочу прочитати» (the site's shelf), the page on Chytai, «Прибрати зі згаданих».
// The list itself is in «Нотатки» (scratch.js): «Згадані книжки» and a book's «Книжки» tab.
window.Mentions = (() => {
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ESC[c]);
  const SPIN = `<span class="spinner"></span>`;
  const LINK = /\[([^\]\n]{1,200})\]\(book:([^)\n]{0,300})\)/g;
  const unquote = (s) => String(s || "").replace(/^[\s«“"„*_]+|[\s»”"*_.,;:!?]+$/g, "").trim();
  // The text as the server read it: no-break spaces as spaces, soft hyphens (renderer.js shyStressed) out.
  const flatChar = (c) => (c === " " || c === " " ? " " : c);

  let book = null; // the e-book open in the reader, by path
  let byChat = new Map(); // explanation id -> [{ q, e }]: the old ones' titles
  let contentsOf = () => [];
  const chapters = new Map(); // spine href -> [{ q, title, author, orig }]
  const asking = new Set();
  const marked = new WeakMap(); // a chapter's document -> [{ range, m }]
  let lit = null; // { doc }: the title whose card is open

  const enabled = () => settings.mentions !== "off";
  const guest = () => document.body.classList.contains("guest");
  const textOk = (name) => !!name && /\.epub$/i.test(name) && !(settings.protectedBooks || []).includes(name);

  // ---------- the book on screen ----------
  // Its explanations' titles found before the links (by explanation id; ids are unique, so a paper book's page adds
  // its own without touching the e-book's).
  async function titlesOf(name) {
    const r = await window.reader.mentions(name);
    let n = 0;
    for (const e of r.books?.[name] || []) {
      for (const c of e.chats || []) {
        if (!c.q) continue;
        if (!byChat.has(c.id)) byChat.set(c.id, []);
        if (!byChat.get(c.id).some((x) => x.e.id === e.id)) byChat.get(c.id).push({ q: c.q, e }), n++;
      }
    }
    return n;
  }
  async function load(name, contentsList) {
    book = name;
    chapters.clear();
    asking.clear();
    contentsOf = contentsList || (() => []);
    if (!name || guest()) return;
    try {
      await titlesOf(name);
    } catch {
      return;
    }
    if (book === name && byChat.size) window.relinkAnswers?.();
  }
  // A paper book's page (paper.js): only its explanations' titles; `done` draws the page again.
  async function loadPaper(name, done) {
    if (!name || guest()) return;
    try {
      if (await titlesOf(name)) done?.();
    } catch {}
  }

  // ---------- explanations ----------
  // Markdown with the book links as links the page can tap: `#bk=<author|title>`; an old explanation (by its id) gets
  // links on the words the server found.
  function prep(text, chatId) {
    let s = String(text || "");
    const old = chatId && byChat.get(chatId);
    if (old && s.search(LINK) < 0) {
      for (const { q, e } of [...old].sort((a, b) => b.q.length - a.q.length)) {
        const spans = [...s.matchAll(LINK)].map((m) => [m.index, m.index + m[0].length]);
        let i = s.indexOf(q);
        while (i >= 0 && spans.some(([a, b]) => i >= a && i < b)) i = s.indexOf(q, i + 1);
        if (i < 0) continue;
        s = `${s.slice(0, i)}[${q}](book:${e.author}|${e.title})${s.slice(i + q.length)}`;
      }
    }
    LINK.lastIndex = 0;
    return s.replace(LINK, (m, label, target) => `[${label}](#bk=${encodeURIComponent(target)})`);
  }
  const post = (html) => html.replace(/<a href="#bk=/g, '<a class="bk" href="#bk=');
  // The words the page shows (a plain excerpt): the link's words only.
  const plain = (text) => String(text || "").replace(LINK, "$1");

  // A tap on a title in an explanation (the panel, the phone's sheet, a paper book's page).
  document.addEventListener(
    "click",
    (e) => {
      const a = e.target.closest?.("a.bk");
      if (!a) return;
      e.preventDefault();
      e.stopPropagation();
      let target = "";
      try {
        target = decodeURIComponent(a.getAttribute("href").slice(4));
      } catch {}
      const [author, title] = target.split("|");
      window.ReadingTime?.count("mention-link");
      open({ title: unquote(title || a.textContent), author: (author || "").trim() }, `Згадано в ${source()} · пояснення`);
    },
    true,
  );
  // The book the reader is in: a paper book's page, else the e-book open.
  function source() {
    const pb = document.querySelector(".pp") && window.Paper?.current?.();
    const t = pb?.title || (typeof current !== "undefined" && current?.title) || "";
    return t ? `«${t}»` : "книжці";
  }

  // ---------- the card ----------
  // m: { title, author, orig, cat? (the catalog's book, when known), id + src (the list's entry and its book) }.
  async function open(m, from) {
    const d = document.querySelector("#paper-found");
    const draw = (data) => {
      const cat = data ? data.cat : m.cat;
      const b = data?.book || null;
      let top = `<p class="mn-from">${esc(from)}</p>`;
      // «Немає на Chytai» under «Про книжку», not above it (Max 2026-11-26, bot №66).
      const none = data && !cat && !b ? `<p class="r-want-none mn-none">Цієї книжки немає на Chytai.</p>` : "";
      if (b) top += window.Want?.where(b) || "";
      else if (!data) top += `<p class="r-want-none mn-wait">${SPIN}Шукаємо, де взяти…</p>`;
      const st = b?.status || "";
      const want = guest() || !data
        ? ""
        : !cat?.href
          ? `<button type="button" class="r-pill pf-add" data-mn-new data-act="mention-want-new">Хочу прочитати</button>`
        : st === "want"
          ? `<p class="mn-on">✓ У «Хочу прочитати»</p>`
          : st
            ? `<p class="mn-on">✓ На вашій полиці</p>`
            : `<button type="button" class="r-pill pf-add" data-mn-want="${esc(cat.href)}" data-act="mention-want">Хочу прочитати</button>`;
      const page = cat?.href ? `<p class="pf-page"><a href="${esc(cat.href)}" target="_blank" rel="noopener">Сторінка книжки на Chytai ↗</a></p>` : "";
      const drop = m.id && m.src ? `<p class="mn-dropp"><button type="button" class="r-link mn-drop" data-mn-drop data-act="mention-drop">Прибрати зі згаданих</button></p>` : "";
      window.Paper.card({ title: cat?.title || m.title, author: cat?.author || m.author, cover: cat?.cover || "", href: cat?.href || "", year: cat?.year || null }, { top, noAdd: true, foot: none + want + page + drop });
      d.mention = m;
    };
    draw(null);
    window.ReadingTime?.count("mention-card");
    let data = { cat: m.cat ?? null, book: null };
    try {
      data = await window.reader.mentionCard(m);
    } catch {}
    if (d.open && d.mention === m) draw(data);
  }
  document.querySelector("#paper-found").addEventListener("click", async (e) => {
    const d = e.currentTarget;
    const w = e.target.closest("[data-mn-want]");
    if (w) {
      w.disabled = true;
      try {
        await window.reader.mentionWant(w.dataset.mnWant);
        w.outerHTML = `<p class="mn-on">✓ У «Хочу прочитати»</p>`;
      } catch (err) {
        w.disabled = false;
        window.showNotice?.(err instanceof TypeError ? "Немає з'єднання." : err.message || "Не вийшло.", false);
      }
      return;
    }
    const nw = e.target.closest("[data-mn-new]");
    if (nw && d.mention) {
      const m = d.mention;
      nw.disabled = true;
      nw.innerHTML = `${SPIN}Шукаємо книжку…`;
      try {
        const r = await window.reader.mentionWantNew(m.title, m.author || "");
        const none = d.querySelector(".mn-none");
        if (none) none.remove();
        nw.outerHTML = `<p class="mn-on">${r.status && r.status !== "want" ? "✓ На вашій полиці" : "✓ У «Хочу прочитати»"}</p>${r.href ? `<p class="pf-page"><a href="${esc(r.href)}" target="_blank" rel="noopener">Сторінка книжки на Chytai ↗</a></p>` : ""}`;
      } catch (err) {
        nw.disabled = false;
        nw.textContent = "Хочу прочитати";
        window.showNotice?.(err instanceof TypeError ? "Немає з'єднання." : err.message || "Не вийшло.", false);
      }
      return;
    }
    if (e.target.closest("[data-mn-drop]") && d.mention?.id) {
      const m = d.mention;
      try {
        await window.reader.mentionDrop(m.src, m.id);
      } catch {}
      d.close();
      document.dispatchEvent(new CustomEvent("mentions-changed"));
    }
  });
  document.querySelector("#paper-found").addEventListener("close", (e) => {
    e.currentTarget.mention = null; // a late answer for a closed card draws nothing over the next one
    unlit();
  });

  // ---------- the book's text ----------
  const hrefOf = (contents) => {
    try {
      return rendition?.book?.spine?.get?.(contents.sectionIndex)?.href || "";
    } catch {
      return "";
    }
  };
  function style(contents) {
    const doc = contents.document;
    let el = doc.getElementById("chytai-mentions");
    if (!el) {
      el = doc.createElement("style");
      el.id = "chytai-mentions";
      doc.head.appendChild(el);
    }
    const css = getComputedStyle(document.body);
    const line = css.getPropertyValue("--m-bar").trim() || "#b5803a";
    const hit = css.getPropertyValue("--m-hit").trim() || "#f0dca9";
    // A solid line (the «Словничок» has dots).
    el.textContent = `::highlight(bk){text-decoration:underline solid ${line};text-decoration-thickness:1.5px;text-underline-offset:0.2em}::highlight(bk-on){background-color:${hit}}`;
  }
  // Called for every chapter drawn (renderer.js content hook) and when its titles come.
  function mark(contents) {
    const doc = contents.document;
    const win = contents.window;
    if (!doc?.body) return;
    win.CSS?.highlights?.delete("bk");
    marked.delete(doc);
    if (!textOk(book)) return;
    const href = hrefOf(contents);
    if (!href) return;
    const books = chapters.get(href);
    if (!books) return ask(href);
    if (!enabled() || !win.CSS?.highlights || !win.Highlight || !books.length) return;
    style(contents);
    // The chapter's text as one string, with where each character is in its text node.
    const nodes = [];
    let text = "";
    const walk = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const map = [];
      let s = "";
      for (let i = 0; i < n.data.length; i++) {
        if (n.data[i] === "­") continue;
        s += flatChar(n.data[i]);
        map.push(i);
      }
      if (!s) continue;
      nodes.push({ n, at: text.length, map });
      text += s;
    }
    const where = (pos) => {
      let lo = 0;
      let hi = nodes.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (nodes[mid].at <= pos) lo = mid;
        else hi = mid - 1;
      }
      return nodes[lo];
    };
    const found = [];
    const taken = [];
    for (const m of [...books].sort((a, b) => b.q.length - a.q.length)) {
      const q = [...m.q].map(flatChar).join("");
      let i = text.indexOf(q);
      while (i >= 0 && taken.some(([a, b]) => i < b && i + q.length > a)) i = text.indexOf(q, i + 1);
      if (i < 0) continue;
      taken.push([i, i + q.length]);
      const a = where(i);
      const b = where(i + q.length - 1);
      const range = doc.createRange();
      range.setStart(a.n, a.map[i - a.at]);
      range.setEnd(b.n, b.map[i + q.length - 1 - b.at] + 1);
      found.push({ range, m });
    }
    marked.set(doc, found);
    if (found.length) win.CSS.highlights.set("bk", new win.Highlight(...found.map((f) => f.range)));
  }
  // The chapter's titles: asked once a chapter while the book is open; Haiku reads a new one in some seconds.
  async function ask(href) {
    if (asking.has(href)) return;
    asking.add(href);
    const name = book;
    let c = "";
    try {
      c = chapterTitle(href);
    } catch {}
    for (let i = 0; i < 12; i++) {
      let r;
      try {
        r = await window.reader.mentionsText(name, href, c);
      } catch {
        return asking.delete(href);
      }
      if (book !== name) return;
      if (r?.books) {
        chapters.set(href, r.books);
        for (const x of contentsOf() || []) if (hrefOf(x) === href) mark(x);
        return;
      }
      if (!r?.building) return;
      await new Promise((ok) => setTimeout(ok, i ? 12000 : 6000));
    }
  }
  function remark() {
    for (const c of contentsOf() || []) mark(c);
  }

  // A tap or a click at (x, y) inside a chapter's frame: the card when it is on an underlined title.
  function tap(x, y, doc) {
    const list = doc && marked.get(doc);
    if (!list?.length) return false;
    const inside = (r) => [...r.getClientRects()].some((b) => x >= b.left - 3 && x <= b.right + 3 && y >= b.top - 4 && y <= b.bottom + 4);
    const hit = list.find((f) => inside(f.range));
    if (!hit) return false;
    const win = doc.defaultView;
    win.CSS.highlights.set("bk-on", new win.Highlight(hit.range));
    lit = { doc };
    window.ReadingTime?.count("mention-text");
    open({ title: hit.m.title, author: hit.m.author, orig: hit.m.orig }, `Згадано в ${source()} · у тексті`);
    return true;
  }
  function unlit() {
    lit?.doc?.defaultView?.CSS?.highlights?.delete("bk-on");
    lit = null;
  }

  return { load, loadPaper, prep, post, plain, mark, remark, style: (c) => enabled() && marked.has(c.document) && style(c), tap, open, has: () => textOk(book) };
})();

// Words ahead (Max, 2026-11-17: «як плейліст… наступний трек завантажує, не чекаючи, щоб не було пауз»). While a
// reader reads, the passage on screen and the next one (~5,000 characters, cut at paragraphs) go to the server
// (server/wordahead.js), which answers the words a reader may select there with their meaning. renderer.js `wordCard`
// looks here before it asks for one word, so such a word shows at once. Only for a reader who has selected a word
// in the last 30 days (most never do), signed in, in their own books (not a publisher's preview). Same passage = same
// text, so the server keeps one answer for every reader of that book.
window.WordAhead = (() => {
  const SIZE = 5000;
  const USED = "chytai:word-used";
  let words = new Map(); // word -> meaning, for the book on screen
  let asked = new Set(); // `${section}:${block}` asked for this book
  let blocks = new Map(); // section index -> [{ start, end, text }]
  let queue = [];
  let busy = false;
  let stopped = false;
  let who = {};

  const norm = (w) =>
    String(w || "")
      .normalize("NFC")
      .replace(/́/g, "")
      .replace(/[’ʼ`]/g, "'")
      .trim()
      .toLowerCase();

  // The reader selected a word: from now on (30 days) passages are asked ahead.
  function used() {
    try {
      localStorage.setItem(USED, String(Date.now()));
    } catch {}
  }
  // Max always (2026-11-17: he tests it on every device, and a phone where he had not selected a word yet asked nothing).
  function wanted() {
    if (settings?.owner) return true;
    try {
      return Date.now() - Number(localStorage.getItem(USED) || 0) < 30 * 864e5;
    } catch {
      return false;
    }
  }

  // Paragraph texts of a chapter, packed into passages of about SIZE characters.
  function cut(doc) {
    const root = doc?.body || doc?.querySelector?.("body") || doc;
    if (!root) return [];
    let paras = [...root.querySelectorAll("p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,dd,dt,td")]
      .filter((e) => !e.querySelector("p,li,blockquote"))
      .map((e) => e.textContent.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    if (!paras.length) paras = [String(root.textContent || "").replace(/\s+/g, " ").trim()].filter(Boolean);
    const out = [];
    let cur = [];
    let n = 0;
    let pos = 0;
    let start = 0;
    for (const p of paras) {
      if (n && n + p.length > SIZE) {
        out.push({ start, end: pos, text: cur.join("\n") });
        cur = [];
        n = 0;
        start = pos;
      }
      cur.push(p);
      n += p.length + 1;
      pos += p.length + 1;
    }
    if (cur.length) {
      const last = { start, end: pos, text: cur.join("\n") };
      // A short tail goes with the passage before it.
      if (out.length && last.text.length < 1500) {
        const prev = out[out.length - 1];
        prev.text = `${prev.text}\n${last.text}`;
        prev.end = last.end;
      } else out.push(last);
    }
    return out.map((b) => ({ ...b, text: b.text.slice(0, 8000) }));
  }

  function ask(section, i, list) {
    const k = `${section}:${i}`;
    const b = list[i];
    if (!b || asked.has(k) || b.text.length < 200) return;
    asked.add(k);
    queue.push({ k, text: b.text });
    pump();
  }
  async function pump() {
    if (busy || stopped || !queue.length) return;
    busy = true;
    const { k, text } = queue.shift();
    const book = who.book;
    try {
      const r = await window.reader.wordAhead({ text, title: who.title || "", author: who.author || "" });
      if (book !== who.book) return;
      if (r?.words) {
        for (const [w, m] of Object.entries(r.words)) words.set(norm(w), m);
        window.Gloss?.addAhead?.(r.words);
      }
      else if (r?.error === "later") stopped = true;
      else asked.delete(k);
    } catch {
      asked.delete(k); // no connection: ask again on the next page
    } finally {
      busy = false;
      pump();
    }
  }

  // A new book: forget the last one's words.
  function open(current) {
    who = { book: current?.posKey || current?.path || "", title: current?.title, author: current?.author };
    words = new Map();
    asked = new Set();
    blocks = new Map();
    queue = [];
    stopped = false;
  }

  // The reader is at `location`: ask for the passage on screen and the one after it (the next chapter's first,
  // at a chapter's end).
  function at(location, rendition, book) {
    if (!wanted() || stopped || !location?.start) return;
    const index = location.start.index;
    const contents = rendition?.getContents?.().find((c) => c.sectionIndex === index);
    if (!contents) return;
    if (!blocks.has(index)) blocks.set(index, cut(contents.document));
    const list = blocks.get(index);
    if (!list.length) return;
    const d = location.start.displayed || {};
    const frac = d.total > 1 ? (d.page - 1) / d.total : 0;
    const len = list[list.length - 1].end;
    let i = list.findIndex((b) => frac * len < b.end);
    if (i < 0) i = list.length - 1;
    ask(index, i, list);
    if (i + 1 < list.length) return ask(index, i + 1, list);
    nextChapter(index + 1, rendition, book);
  }
  function nextChapter(index, rendition, book) {
    if (asked.has(`${index}:0`) || asked.has(`${index}:load`)) return;
    const section = book?.spine?.get(index);
    if (!section) return;
    if (blocks.has(index)) return ask(index, 0, blocks.get(index));
    asked.add(`${index}:load`);
    section
      .load(book.load.bind(book))
      .then((doc) => {
        blocks.set(index, cut(doc));
        if (!rendition?.getContents?.().some((c) => c.sectionIndex === index)) section.unload();
        ask(index, 0, blocks.get(index));
      })
      .catch(() => {});
  }

  function lookup(word) {
    return words.get(norm(word)) || null;
  }

  return { open, at, lookup, used, wanted, cut, norm, size: () => words.size };
})();

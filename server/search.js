// Search in what a reader wrote and asked about (Max, 2026-11-03: «я чатився з Клодом, і він мені щось пояснював
// про якогось генерала, то я хочу його знайти, навіть якщо цього генерала немає в назві книжки»): the notes and
// their thoughts, the questions about paper books and, once they are kept, the explanations in e-books.
// Every word of the query has to be there; the hit comes with a short piece of text around the first word.

// Same length in and out, so positions found in the folded text hold in the original.
const fold = (s) => String(s || "").toLowerCase().replace(/[’ʼ‘`´]/g, "'").replace(/ё/g, "е");
const plain = (s) => String(s || "").replace(/[*_#>`]+/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim();

function words(q) {
  return [...new Set(fold(q).replace(/["«»]/g, " ").split(/\s+/).filter((w) => w.length >= 2))].slice(0, 6);
}

// The piece of text to show: about `size` characters around the first word found, cut at spaces.
function snippet(text, ws, size = 160) {
  const f = fold(text);
  let at = -1;
  for (const w of ws) {
    const i = f.indexOf(w);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return text.length > size ? `${text.slice(0, size).replace(/\s+\S*$/, "")}…` : text;
  let from = Math.max(0, at - Math.round(size / 3));
  let to = Math.min(text.length, from + size);
  if (from > 0) from = text.indexOf(" ", from) + 1 || from;
  if (to < text.length) to = text.lastIndexOf(" ", to) > at ? text.lastIndexOf(" ", to) : to;
  return `${from > 0 ? "…" : ""}${text.slice(from, to).trim()}${to < text.length ? "…" : ""}`;
}

// The parts of one thing found (a note: its passage and the thought; a talk: the passage, each question, each
// answer), the best one first: the one with the most query words, then the reader's own words.
function best(parts, ws) {
  const all = parts.map((p) => ({ ...p, text: plain(p.text) })).filter((p) => p.text);
  const joined = fold(all.map((p) => p.text).join("\n"));
  if (!ws.every((w) => joined.includes(w))) return null;
  let top = null;
  for (const p of all) {
    const f = fold(p.text);
    const n = ws.filter((w) => f.includes(w)).length;
    if (n && (!top || n > top.n)) top = { ...p, n };
  }
  return top && { field: top.field, text: snippet(top.text, ws) };
}

const MAX_HITS = 60;

// u: the reader's state (state.users[id]); books: the names of the reader's books, to leave out what was deleted.
function searchReader(u, query, books) {
  const ws = words(query);
  if (!ws.length) return [];
  const has = (name) => !books || books.has(name);
  const hits = [];
  for (const [book, list] of Object.entries(u.notes || {})) {
    if (!has(book)) continue;
    for (const n of list || []) {
      const m = best([{ field: "comment", text: n.comment }, { field: "text", text: n.text }], ws);
      if (m) hits.push({ kind: "note", book, id: n.id, cfi: n.cfi || "", posKey: n.posKey || "", where: n.chapter || "", at: n.createdAt || 0, quote: plain(n.text).slice(0, 200), ...m });
    }
  }
  // Talks with Claude: u.paperChats for paper books, u.chats for e-books (kept explanations).
  for (const [key, kind] of [["paperChats", "paperChat"], ["chats", "chat"]]) {
    for (const [book, list] of Object.entries(u[key] || {})) {
      if (!has(book) || !Array.isArray(list)) continue;
      for (const c of list) {
        if (!c || typeof c !== "object") continue;
        const turns = Array.isArray(c.turns) ? c.turns : [];
        const parts = [
          { field: "sel", text: c.sel || c.text || c.selection },
          ...turns.flatMap((t) => [{ field: "q", text: t?.q }, { field: "a", text: t?.a }]),
          // An explanation kept without turns: the answer alone.
          { field: "a", text: typeof c.answer === "string" ? c.answer : "" },
        ];
        const m = best(parts, ws);
        if (!m) continue;
        const first = plain(c.sel || c.text || c.selection || turns[0]?.q || "").slice(0, 200);
        hits.push({ kind, book, id: String(c.id || ""), cfi: c.cfi || "", posKey: c.posKey || "", where: c.chapter || (c.page ? `стор. ${c.page}` : ""), at: c.at || c.createdAt || 0, quote: first, ...m });
      }
    }
  }
  hits.sort((x, y) => (y.at || 0) - (x.at || 0));
  return hits.slice(0, MAX_HITS);
}

module.exports = { searchReader, words, fold };

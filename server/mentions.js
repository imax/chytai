// «Згадані книжки» (Max 2026-11-26, variants А + 1 of canvas Tr7MtCsSnwRHxpKUgyDuTS): the books a reader met while
// reading, kept so they don't get lost.
// - In explanations: Opus writes a work's title as a link, [«Уліссі»](book:Джеймс Джойс|Улісс) (src/ai.js); the link
//   text keeps the sentence's case, the target carries the author and the title in the nominative. The page turns
//   it into a tappable title; a kept explanation's links go into the reader's list when it is saved.
//   Explanations from before the links: Haiku finds the titles once (`fromChats`, the backfill) and keeps where they
//   are in the answer (`q`), so the page can make them tappable too without touching the kept text.
// - In the book's text: Haiku reads a chapter once for every reader of the same file (`chapter`, pieces of the
//   «Перед главою» units), kept by the book's text in DATA_DIR/mentions/text/<key>.json; the page underlines the
//   first place of each title in the chapter; a chapter opened = its titles go into the reader's list.
// - The catalog: the site's /api/reader-find by title and author, one answer a title kept for everyone
//   (DATA_DIR/mentions/cat.json, CAT_MAX titles, the oldest go).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Anthropic = require("@anthropic-ai/sdk");
const { measure } = require("./aimeter");

const MODEL = "claude-haiku-5-5";
const TEXT_V = 1; // a chapter read with an older prompt is read again
const CAT_MAX = 20000;
const CAT_DAYS = 30; // a title not in the catalog is asked again after this
const UNUSED_DAYS = 180;

// [label](book:Author|Title) or [label](book:Author): the label, the author, the title (the label without quotes when
// the target has none).
const LINK = /\[([^\]\n]{1,200})\]\(book:([^)\n]{0,300})\)/g;
const unquote = (s) => String(s || "").replace(/^[\s«“"„*_]+|[\s»”"*_.,;:!?]+$/g, "").trim();
function parseLinks(text) {
  const out = [];
  for (const m of String(text || "").matchAll(LINK)) {
    const [author, title] = m[2].split("|");
    const t = unquote(title || m[1]);
    if (t) out.push({ label: m[1], title: t.slice(0, 200), author: String(author || "").trim().slice(0, 120) });
  }
  return out;
}
// The text with the links as their plain words (excerpts, search, what goes to the site).
const strip = (text) => String(text || "").replace(LINK, "$1");

const norm = (s) => String(s || "").normalize("NFC").toLowerCase().replace(/ё/g, "е").replace(/['’ʼ`]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const surname = (a) => norm(a).split(" ").filter((w) => w.length > 1).pop() || "";
// One title by one author: «Улісс» by Джойс and «Улісс» of Joyce's are one; the same title by two authors two.
const keyOf = (title, author) => crypto.createHash("sha1").update(`${norm(title)}|${surname(author)}`).digest("hex").slice(0, 16);

const TEXT_PROMPT = `You read a passage of a book and list the written works it names by their title: books, novels, poems, plays, essays, treatises, scriptures, stories, articles, long poems, collections.
Only works named by their title (with or without quotation marks). Not a work only described («його перший роман»), not authors alone, not characters, places, films, songs, operas, paintings, newspapers or journals, not chapter titles of the book itself. Never the book being read (its title is given).
For each work once:
- "q": the title exactly as the passage writes it the first time, letter for letter, in its case form, without the quotation marks around it («Уліссі» → Уліссі);
- "title": the work's usual title in Ukrainian in the nominative case («Улісс»); the original when there is no Ukrainian one;
- "author": its author in Ukrainian (first name and surname), or "" when you don't know;
- "orig": the original title when the work is not Ukrainian, else "".
Answer with JSON only: {"books": [{"q": "...", "title": "...", "author": "...", "orig": "..."}]}. No works: {"books": []}.`;

const CHATS_PROMPT = `Below are explanations a reading companion gave a reader, numbered. In each, find the written works it names by their title: books, novels, poems, plays, essays, treatises, scriptures, stories, long poems, collections.
Only works named by their title. Not a work only described, not authors alone, not characters, places, films, songs, operas, paintings, newspapers or journals. Never the book the reader is reading (given as <reading>).
For each work once per explanation:
- "q": the title exactly as the explanation writes it the first time, letter for letter, in its case form, without the quotation marks around it;
- "title": the work's usual title in Ukrainian in the nominative case; the original when there is no Ukrainian one;
- "author": its author in Ukrainian, or "";
- "orig": the original title when the work is not Ukrainian, else "".
Answer with JSON only: {"items": [{"n": 1, "books": [{"q": "...", "title": "...", "author": "...", "orig": "..."}]}]}; leave out explanations that name no work.`;

const textOf = (m) => (m.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
const json = (t) => {
  const s = String(t || "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error("no JSON");
  return JSON.parse(s.slice(a, b + 1));
};
const flat = (s) => String(s || "").replace(/[  ]/g, " ").replace(/­/g, "");
const clip = (s, n) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
// A found work as kept: only what the passage really has (`q` in the text), with a title.
function tidy(list, text, skip) {
  const out = [];
  const seen = new Set();
  const f = flat(text);
  for (const x of Array.isArray(list) ? list : []) {
    const q = clip(unquote(x?.q), 200);
    const title = clip(unquote(x?.title || q), 200);
    if (!q || !title || q.length < 2 || !f.includes(q)) continue;
    const k = keyOf(title, x?.author);
    if (seen.has(k) || (skip && norm(title) === norm(skip))) continue;
    seen.add(k);
    out.push({ q, title, author: clip(x?.author, 120), orig: clip(x?.orig, 200) });
  }
  return out;
}

class Mentions {
  constructor({ dir, apiKey, find, guide }) {
    this.dir = dir;
    this.textDir = path.join(dir, "text");
    this.apiKey = apiKey;
    this.find = find; // catalogFind(q) of server/index.js
    this.guide = guide; // server/bookguide.js: the book's key and its chapters' pieces
    fs.mkdirSync(this.textDir, { recursive: true });
    this.catFile = path.join(dir, "cat.json");
    try {
      this.cat = JSON.parse(fs.readFileSync(this.catFile, "utf8"));
    } catch {
      this.cat = {};
    }
    this.asking = new Map(); // key -> promise
    this.running = new Map(); // book key:piece -> true
    this.failed = new Map();
    this.catTimer = 0;
  }
  client() {
    return new Anthropic({ apiKey: this.apiKey });
  }

  // ---- the catalog ----
  saveCat() {
    clearTimeout(this.catTimer);
    this.catTimer = setTimeout(() => {
      const keys = Object.keys(this.cat);
      if (keys.length > CAT_MAX) for (const k of keys.sort((a, b) => this.cat[a].at - this.cat[b].at).slice(0, keys.length - CAT_MAX)) delete this.cat[k];
      const tmp = `${this.catFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.cat));
      fs.renameSync(tmp, this.catFile);
    }, 2000);
  }
  // What the catalog has for a title, if known: { href, title, author, year, cover } | null (not there) | undefined.
  known(title, author) {
    const c = this.cat[keyOf(title, author)];
    if (!c) return undefined;
    if (!c.book && Date.now() - c.at > CAT_DAYS * 86400000) return undefined;
    return c.book || null;
  }
  // The catalog's book for a title and author: the site's search by title and surname, a book whose title starts
  // with ours (or ours with its head before «.»/«:») and whose author has the surname; then by the original title.
  async match(title, author, orig = "") {
    const k = keyOf(title, author);
    const had = this.known(title, author);
    if (had !== undefined) return had;
    if (this.asking.has(k)) return this.asking.get(k);
    const work = (async () => {
      const sn = surname(author);
      const fits = (b, t) => {
        const bt = norm(b.title);
        const head = norm(String(b.title || "").split(/[.:(]/)[0]);
        const nt = norm(t);
        if (!nt || !(bt === nt || head === nt || (nt.length >= 6 && bt.startsWith(nt)))) return false;
        return !sn || norm(b.author).split(" ").some((w) => w === sn || (sn.length > 4 && w.startsWith(sn.slice(0, -2))));
      };
      let book = null;
      for (const t of [title, orig].filter(Boolean)) {
        for (const q of [`${t} ${sn}`.trim(), t]) {
          const r = await this.find(q.slice(0, 100)).catch(() => null);
          book = (r?.books || []).find((b) => fits(b, t)) || null;
          if (book || !r) break;
        }
        if (book) break;
      }
      this.cat[k] = { at: Date.now(), book: book ? { href: book.href, title: book.title, author: book.author || "", year: book.year || null, cover: book.cover || "" } : null };
      this.saveCat();
      return this.cat[k].book;
    })().finally(() => this.asking.delete(k));
    this.asking.set(k, work);
    return work;
  }

  // ---- titles in the book's text ----
  file(key) {
    return path.join(this.textDir, `${key}.json`);
  }
  read(key) {
    try {
      return JSON.parse(fs.readFileSync(this.file(key), "utf8"));
    } catch {
      return null;
    }
  }
  write(g) {
    const tmp = `${this.file(g.key)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(g));
    fs.renameSync(tmp, this.file(g.key));
  }
  // A chapter's titles (spine file `href`): { books: [{q, title, author, orig}] } when every piece of it was read,
  // { building } while Haiku reads, { none } (no such chapter, a publisher's book), { capped }.
  async chapter(file, href, { title = "", allow = () => true, spend = () => {} } = {}) {
    const p = await this.guide.book(file);
    if (!p) return { none: true };
    const all = await this.guide.units(file);
    // The page's href is epub.js's (relative to the OPF, like ours); a different base still ends the same.
    const h = String(href).split("#")[0];
    const units = all.filter((u) => u.href && (u.href === h || h.endsWith(`/${u.href}`) || u.href.endsWith(`/${h}`)));
    if (!units.length) return { none: true };
    const g = this.read(p.key) || { key: p.key, pieces: {} };
    const k = (u) => `${u.ch}:${u.piece}`;
    const missing = units.filter((u) => g.pieces[k(u)]?.v !== TEXT_V);
    if (!missing.length) {
      if (Date.now() - (g.used || 0) > 86400000) (g.used = Date.now()), this.write(g);
      return { books: units.flatMap((u) => g.pieces[k(u)].books) };
    }
    if (!this.apiKey) return { none: true };
    const id = `${p.key}:${k(missing[0])}`;
    if (this.running.has(id)) return { building: true };
    if (Date.now() - (this.failed.get(id) || 0) < 600000) return { none: true };
    if (!allow()) return { capped: true };
    const skip = title || all.meta?.title || "";
    for (const u of missing) {
      const uid = `${p.key}:${k(u)}`;
      if (this.running.has(uid)) continue;
      this.running.set(uid, true);
      this.readPiece(p.key, u, skip, spend)
        .catch((err) => {
          this.failed.set(uid, Date.now());
          if (this.failed.size > 500) this.failed.clear();
          console.error(`mentions text ${uid}: ${err.message}`);
        })
        .finally(() => this.running.delete(uid));
    }
    return { building: true };
  }
  async readPiece(key, u, skip, spend) {
    const m = await this.client().messages.create({
      model: MODEL,
      max_tokens: 6000,
      system: [{ type: "text", text: TEXT_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: `<reading>${skip}</reading>\n\n<passage>\n${u.text}\n</passage>` }],
    });
    spend(measure(m.model, m.usage).cost);
    const books = tidy(json(textOf(m)).books, u.text, skip);
    const g = this.read(key) || { key, pieces: {} };
    g.pieces[`${u.ch}:${u.piece}`] = { v: TEXT_V, at: Date.now(), books };
    g.used = Date.now();
    this.write(g);
  }
  cleanup() {
    let n = 0;
    for (const f of fs.readdirSync(this.textDir)) {
      if (!f.endsWith(".json")) continue;
      const g = this.read(f.slice(0, -5));
      if (!g || Date.now() - (g.used || 0) > UNUSED_DAYS * 86400000) fs.rmSync(path.join(this.textDir, f), { force: true }), n++;
    }
    if (n) console.log(`mentions: ${n} books' titles unused ${UNUSED_DAYS} days, gone`);
  }

  // ---- explanations from before the links (the backfill) ----
  // chats: [{ id, book (its title), turns }] → { id: [{q, title, author, orig}] }, BATCH at a time.
  async fromChats(chats, { spend = () => {} } = {}) {
    const BATCH = 12;
    const out = {};
    for (let i = 0; i < chats.length; i += BATCH) {
      const part = chats.slice(i, i + BATCH);
      const body = part.map((c, j) => `<explanation n="${j + 1}"><reading>${c.book || ""}</reading>\n${c.turns.map((t) => t.a).join("\n\n")}\n</explanation>`).join("\n\n");
      const m = await this.client().messages.create({
        model: MODEL,
        max_tokens: 6000,
        system: [{ type: "text", text: CHATS_PROMPT, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: body }],
      });
      spend(measure(m.model, m.usage).cost);
      for (const it of json(textOf(m)).items || []) {
        const c = part[Number(it?.n) - 1];
        if (!c) continue;
        const books = tidy(it.books, c.turns.map((t) => t.a).join("\n\n"), c.book);
        if (books.length) out[c.id] = books;
      }
    }
    return out;
  }
}

// ---- a reader's list: items kind "mentions", one list a book they were met in ----
// An entry: { id (keyOf), title, author, orig, at, last, chats: [{ id, q, c (chapter) }], text: [{ h (spine href), c, q }],
// gone (taken off by hand) }.
// `q` = the words in the answer or the chapter that name it; an explanation with the link has q "".
const PER_BOOK = 500;
const WHERE_MAX = 20;
function addTo(list, found, where) {
  let changed = false;
  for (const f of found) {
    const id = keyOf(f.title, f.author);
    let e = list.find((x) => x.id === id);
    if (!e) {
      e = { id, title: f.title, author: f.author || "", orig: f.orig || "", at: Date.now(), chats: [], text: [] };
      list.push(e);
      changed = true;
    }
    if (e.gone) continue;
    if (!e.author && f.author) (e.author = f.author), (changed = true);
    const arr = where.chat ? e.chats : e.text;
    const w = where.chat ? { id: where.chat, q: f.q || "", c: where.c || "" } : { h: where.h, c: where.c || "", q: f.q || "" };
    const i = arr.findIndex((x) => (where.chat ? x.id === w.id : x.h === w.h));
    if (i >= 0) {
      if (arr[i].q !== w.q && w.q) (arr[i] = w), (changed = true);
      continue;
    }
    if (arr.length >= WHERE_MAX) continue;
    arr.push(w);
    e.last = Date.now();
    changed = true;
  }
  if (list.length > PER_BOOK) list.splice(0, list.length - PER_BOOK), (changed = true);
  return changed;
}
// An explanation gone: its places go, and an entry with no place left.
function dropChat(list, chatId) {
  let changed = false;
  for (const e of list) {
    const n = e.chats.length;
    e.chats = e.chats.filter((c) => c.id !== chatId);
    if (e.chats.length !== n) changed = true;
  }
  const kept = list.filter((e) => e.chats.length || e.text.length || e.hand);
  return { list: kept, changed: changed || kept.length !== list.length };
}

module.exports = { Mentions, parseLinks, strip, keyOf, norm, addTo, dropChat, LINK };
